from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlparse

import duckdb
import requests

ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = ROOT / "src"
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from collectors.basis_trt2 import (  # noqa: E402
    document_key,
    make_session,
    sha256_file,
    stable_id,
)

TRT2_BASIS_DIR = ROOT / "data" / "knowledge" / "trt2_basis"
RAW_JSON_DIR = ROOT / "data" / "raw" / "json"
DEFAULT_MANIFEST = RAW_JSON_DIR / "trt2_basis_pdf_downloads.jsonl"
DEFAULT_SUMMARY = RAW_JSON_DIR / "trt2_basis_pdf_summary.json"
DEFAULT_OUTPUT_DIR = ROOT / "data" / "raw" / "pdf" / "trt2_basis"
LEGACY_PDF_DIR = ROOT / "data" / "raw" / "pdf"
DEFAULT_DUCKDB = ROOT / "data" / "knowledge" / "knowledge.duckdb"

SOURCE_FILES = {
    "all": TRT2_BASIS_DIR / "trt2_basis_items.jsonl",
    "legal": TRT2_BASIS_DIR / "trt2_legal_collection_items.jsonl",
}


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                yield json.loads(line)


def append_jsonl(path: Path, row: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")


def safe_filename(value: str, fallback: str = "document.pdf") -> str:
    name = unquote(Path(urlparse(value).path).name) if value else ""
    name = name or fallback
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    name = re.sub(r"\s+", "_", name)
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    name = name or fallback
    if not name.lower().endswith(".pdf"):
        name = f"{name}.pdf"
    stem = Path(name).stem[:150].strip("._") or "document"
    return f"{stem}.pdf"


def rel(path: Path) -> str:
    return str(path.relative_to(ROOT))


def build_candidate(row: dict[str, Any]) -> dict[str, Any] | None:
    pdf_url = (row.get("pdf_url") or "").strip()
    if not pdf_url:
        return None
    url = row.get("url") or row.get("source_url") or ""
    title = row.get("title") or ""
    key = row.get("key") or document_key(url, pdf_url, title)
    doc_id = stable_id(pdf_url, title)
    filename = f"{doc_id}_{safe_filename(pdf_url)}"
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    return {
        "key": key,
        "source": row.get("source") or "trt2_basis",
        "source_layer": row.get("source_layer") or "",
        "kind": row.get("kind") or "",
        "collection": row.get("collection") or "",
        "collection_handle": row.get("collection_handle") or "",
        "title": title,
        "document_type": row.get("document_type") or "",
        "date": row.get("date") or "",
        "url": url,
        "pdf_url": pdf_url,
        "filename": filename,
        "summary": row.get("summary") or metadata.get("abstract") or "",
    }


def load_candidates(source: str, limit: int) -> list[dict[str, Any]]:
    source_path = SOURCE_FILES[source]
    if not source_path.exists():
        raise RuntimeError(f"Arquivo de origem não encontrado: {source_path}")

    seen_urls: set[str] = set()
    candidates: list[dict[str, Any]] = []
    for row in read_jsonl(source_path):
        candidate = build_candidate(row)
        if not candidate:
            continue
        pdf_url = candidate["pdf_url"]
        if pdf_url in seen_urls:
            continue
        seen_urls.add(pdf_url)
        candidates.append(candidate)
        if limit and len(candidates) >= limit:
            break
    return candidates


def load_latest_manifest(path: Path) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    if not path.exists():
        return latest
    for row in read_jsonl(path):
        pdf_url = row.get("pdf_url") or ""
        if pdf_url:
            latest[pdf_url] = row
    return latest


def local_file_ok(row: dict[str, Any]) -> bool:
    raw_pdf_path = row.get("raw_pdf_path") or ""
    status = row.get("status") or ""
    if not raw_pdf_path or not status.startswith("ok"):
        return False
    path = ROOT / raw_pdf_path
    return path.exists() and path.is_file() and path.stat().st_size > 0


def existing_local_path(candidate: dict[str, Any], output_dir: Path) -> Path | None:
    target = output_dir / candidate["filename"]
    legacy = LEGACY_PDF_DIR / candidate["filename"]
    for path in (target, legacy):
        if path.exists() and path.is_file() and path.stat().st_size > 0:
            return path
    return None


def seed_hash_index() -> dict[str, str]:
    hashes: dict[str, str] = {}
    if not LEGACY_PDF_DIR.exists():
        return hashes
    for path in LEGACY_PDF_DIR.rglob("*.pdf"):
        if ".part" in path.name or not path.is_file():
            continue
        try:
            hashes[sha256_file(path)] = rel(path)
        except OSError:
            continue
    return hashes


def manifest_hash_index(latest: dict[str, dict[str, Any]]) -> dict[str, str]:
    hashes = seed_hash_index()
    for row in latest.values():
        digest = row.get("sha256") or ""
        raw_pdf_path = row.get("raw_pdf_path") or ""
        if digest and raw_pdf_path and (ROOT / raw_pdf_path).exists():
            hashes.setdefault(digest, raw_pdf_path)
    return hashes


def base_record(candidate: dict[str, Any]) -> dict[str, Any]:
    return {
        "key": candidate["key"],
        "source": candidate["source"],
        "source_layer": candidate["source_layer"],
        "kind": candidate["kind"],
        "collection": candidate["collection"],
        "collection_handle": candidate["collection_handle"],
        "title": candidate["title"],
        "document_type": candidate["document_type"],
        "date": candidate["date"],
        "url": candidate["url"],
        "pdf_url": candidate["pdf_url"],
        "summary": candidate["summary"],
    }


def record_existing(candidate: dict[str, Any], path: Path, status: str) -> dict[str, Any]:
    size = path.stat().st_size
    return {
        **base_record(candidate),
        "status": status,
        "raw_pdf_path": rel(path),
        "bytes": size,
        "sha256": sha256_file(path),
        "http_status": None,
        "content_type": "",
        "duplicate_pdf_of": "",
        "downloaded_at": now_iso(),
        "error": "",
    }


def download_pdf(
    session: requests.Session,
    candidate: dict[str, Any],
    output_dir: Path,
    timeout: int,
    hash_to_path: dict[str, str],
) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    target = output_dir / candidate["filename"]
    part = target.with_name(f"{target.name}.part")
    if part.exists():
        part.unlink()

    response = session.get(
        candidate["pdf_url"],
        stream=True,
        timeout=timeout,
        headers={"Accept": "application/pdf,*/*;q=0.8"},
    )
    http_status = response.status_code
    content_type = response.headers.get("Content-Type", "")
    response.raise_for_status()

    total = 0
    with part.open("wb") as file:
        for chunk in response.iter_content(chunk_size=1024 * 256):
            if not chunk:
                continue
            file.write(chunk)
            total += len(chunk)
    part.replace(target)

    with target.open("rb") as file:
        header = file.read(5)
    if header != b"%PDF-":
        target.unlink(missing_ok=True)
        return {
            **base_record(candidate),
            "status": "error_not_pdf",
            "raw_pdf_path": "",
            "bytes": total,
            "sha256": "",
            "http_status": http_status,
            "content_type": content_type,
            "duplicate_pdf_of": "",
            "downloaded_at": now_iso(),
            "error": "Resposta baixada não começa com %PDF-",
        }

    digest = sha256_file(target)
    duplicate_pdf_of = hash_to_path.get(digest, "")
    raw_pdf_path = rel(target)
    status = "ok_downloaded"
    if duplicate_pdf_of and duplicate_pdf_of != raw_pdf_path:
        target.unlink(missing_ok=True)
        raw_pdf_path = duplicate_pdf_of
        status = "ok_duplicate_content"
    else:
        hash_to_path[digest] = raw_pdf_path

    return {
        **base_record(candidate),
        "status": status,
        "raw_pdf_path": raw_pdf_path,
        "bytes": total,
        "sha256": digest,
        "http_status": http_status,
        "content_type": content_type,
        "duplicate_pdf_of": duplicate_pdf_of,
        "downloaded_at": now_iso(),
        "error": "",
    }


def error_record(candidate: dict[str, Any], status: str, error: str, http_status: int | None = None) -> dict[str, Any]:
    return {
        **base_record(candidate),
        "status": status,
        "raw_pdf_path": "",
        "bytes": 0,
        "sha256": "",
        "http_status": http_status,
        "content_type": "",
        "duplicate_pdf_of": "",
        "downloaded_at": now_iso(),
        "error": error,
    }


def write_summary(path: Path, summary: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")


def latest_after_run(manifest_path: Path) -> list[dict[str, Any]]:
    latest = load_latest_manifest(manifest_path)
    return list(latest.values())


def normalized_status(row: dict[str, Any]) -> str:
    status = row.get("status") or ""
    if status == "error_request" and row.get("http_status") == 403:
        return "error_403_rate_limited"
    return status


def update_duckdb(db_path: Path, manifest_path: Path) -> dict[str, Any]:
    rows = latest_after_run(manifest_path)
    fields = [
        "key",
        "source",
        "source_layer",
        "kind",
        "collection",
        "collection_handle",
        "title",
        "document_type",
        "date",
        "url",
        "pdf_url",
        "summary",
        "status",
        "raw_pdf_path",
        "bytes",
        "sha256",
        "http_status",
        "content_type",
        "duplicate_pdf_of",
        "downloaded_at",
        "error",
    ]
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    con.execute(
        """
        CREATE OR REPLACE TABLE trt2_pdf_downloads (
            key VARCHAR,
            source VARCHAR,
            source_layer VARCHAR,
            kind VARCHAR,
            collection VARCHAR,
            collection_handle VARCHAR,
            title VARCHAR,
            document_type VARCHAR,
            date VARCHAR,
            url VARCHAR,
            pdf_url VARCHAR,
            summary VARCHAR,
            status VARCHAR,
            raw_pdf_path VARCHAR,
            bytes BIGINT,
            sha256 VARCHAR,
            http_status INTEGER,
            content_type VARCHAR,
            duplicate_pdf_of VARCHAR,
            downloaded_at VARCHAR,
            error VARCHAR
        )
        """
    )
    if rows:
        con.executemany(
            f"INSERT INTO trt2_pdf_downloads VALUES ({', '.join(['?'] * len(fields))})",
            [
                [normalized_status(row) if field == "status" else row.get(field) for field in fields]
                for row in rows
            ],
        )
    table_names = {row[0] for row in con.execute("SHOW TABLES").fetchall()}
    if "trt2_basis_all" in table_names:
        con.execute(
            """
            CREATE OR REPLACE VIEW trt2_basis_pdf_status AS
            SELECT
                basis.*,
                downloads.status AS pdf_download_status,
                downloads.raw_pdf_path,
                downloads.bytes AS pdf_bytes,
                downloads.sha256 AS pdf_sha256,
                downloads.downloaded_at AS pdf_downloaded_at,
                downloads.error AS pdf_download_error
            FROM trt2_basis_all basis
            LEFT JOIN trt2_pdf_downloads downloads USING (pdf_url)
            """
        )
    con.execute("CHECKPOINT")
    ok_count = con.execute("SELECT COUNT(*) FROM trt2_pdf_downloads WHERE status LIKE 'ok%'").fetchone()[0]
    error_count = con.execute("SELECT COUNT(*) FROM trt2_pdf_downloads WHERE status NOT LIKE 'ok%'").fetchone()[0]
    con.close()
    return {
        "duckdb_path": str(db_path),
        "duckdb_rows": len(rows),
        "duckdb_ok": ok_count,
        "duckdb_errors": error_count,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Baixa PDFs públicos do índice Basis TRT2 com resume e deduplicação.")
    parser.add_argument("--source", choices=sorted(SOURCE_FILES), default="all")
    parser.add_argument("--limit", type=int, default=0, help="0 baixa todos os candidatos.")
    parser.add_argument("--sleep", type=float, default=0.25)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST))
    parser.add_argument("--summary", default=str(DEFAULT_SUMMARY))
    parser.add_argument("--duckdb", default=str(DEFAULT_DUCKDB))
    parser.add_argument("--skip-duckdb", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--progress-every", type=int, default=25)
    parser.add_argument("--http-403-retries", type=int, default=1)
    parser.add_argument("--http-403-cooldown", type=float, default=300)
    parser.add_argument("--stop-after-consecutive-403", type=int, default=3)
    parser.add_argument("--update-duckdb-only", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    output_dir = Path(args.output_dir)
    manifest_path = Path(args.manifest)
    summary_path = Path(args.summary)
    duckdb_path = Path(args.duckdb)

    if args.update_duckdb_only:
        summary = update_duckdb(duckdb_path, manifest_path)
        write_summary(summary_path, {"finished_at": now_iso(), "duckdb": summary})
        print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
        return

    candidates = load_candidates(args.source, args.limit)
    latest = load_latest_manifest(manifest_path)
    hash_to_path = manifest_hash_index(latest)
    session = make_session()

    counters: dict[str, int] = {
        "total_candidates": len(candidates),
        "ok_manifest_skipped": 0,
        "ok_existing_recorded": 0,
        "ok_downloaded": 0,
        "ok_duplicate_content": 0,
        "errors": 0,
    }
    started_at = now_iso()
    stopped_reason = ""
    consecutive_403 = 0

    print(
        json.dumps(
            {
                "event": "start",
                "source": args.source,
                "candidates": len(candidates),
                "output_dir": rel(output_dir) if output_dir.is_relative_to(ROOT) else str(output_dir),
                "manifest": rel(manifest_path) if manifest_path.is_relative_to(ROOT) else str(manifest_path),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )

    for index, candidate in enumerate(candidates, start=1):
        pdf_url = candidate["pdf_url"]
        previous = latest.get(pdf_url)
        if previous and local_file_ok(previous) and not args.overwrite:
            counters["ok_manifest_skipped"] += 1
            if index % args.progress_every == 0:
                print(json.dumps({"event": "progress", "index": index, **counters}, ensure_ascii=False), flush=True)
            continue

        existing = existing_local_path(candidate, output_dir)
        if existing and not args.overwrite:
            row = record_existing(candidate, existing, "ok_existing")
            append_jsonl(manifest_path, row)
            latest[pdf_url] = row
            hash_to_path[row["sha256"]] = row["raw_pdf_path"]
            counters["ok_existing_recorded"] += 1
            if index % args.progress_every == 0:
                print(json.dumps({"event": "progress", "index": index, **counters}, ensure_ascii=False), flush=True)
            continue

        for attempt in range(args.http_403_retries + 1):
            try:
                row = download_pdf(session, candidate, output_dir, args.timeout, hash_to_path)
            except requests.RequestException as exc:
                row = error_record(
                    candidate,
                    "error_request",
                    str(exc),
                    getattr(getattr(exc, "response", None), "status_code", None),
                )
            except OSError as exc:
                row = error_record(candidate, "error_io", str(exc))

            if row.get("http_status") != 403 or attempt >= args.http_403_retries:
                break

            print(
                json.dumps(
                    {
                        "event": "rate_limit_403",
                        "index": index,
                        "attempt": attempt + 1,
                        "cooldown_seconds": args.http_403_cooldown,
                        "pdf_url": pdf_url,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            time.sleep(args.http_403_cooldown)

        append_jsonl(manifest_path, row)
        latest[pdf_url] = row
        status = row["status"]
        if status in counters:
            counters[status] += 1
        elif status.startswith("ok"):
            counters["ok_downloaded"] += 1
        else:
            counters["errors"] += 1

        if index % args.progress_every == 0 or index == len(candidates):
            print(json.dumps({"event": "progress", "index": index, **counters}, ensure_ascii=False), flush=True)

        if row.get("http_status") == 403:
            consecutive_403 += 1
            if consecutive_403 >= args.stop_after_consecutive_403:
                stopped_reason = f"consecutive_403:{consecutive_403}"
                print(
                    json.dumps(
                        {
                            "event": "stopping",
                            "index": index,
                            "reason": stopped_reason,
                            "message": "Servidor retornou 403 em sequência; encerrando para retomar depois sem insistir.",
                        },
                        ensure_ascii=False,
                    ),
                    flush=True,
                )
                break
        else:
            consecutive_403 = 0

        if args.sleep > 0:
            time.sleep(args.sleep)

    final_rows = latest_after_run(manifest_path)
    final_ok = sum(1 for row in final_rows if (row.get("status") or "").startswith("ok") and local_file_ok(row))
    final_errors = sum(1 for row in final_rows if not (row.get("status") or "").startswith("ok"))
    summary: dict[str, Any] = {
        **counters,
        "source": args.source,
        "started_at": started_at,
        "finished_at": now_iso(),
        "manifest_path": str(manifest_path),
        "summary_path": str(summary_path),
        "output_dir": str(output_dir),
        "latest_manifest_rows": len(final_rows),
        "latest_ok_files": final_ok,
        "latest_errors": final_errors,
        "stopped_reason": stopped_reason,
    }
    if not args.skip_duckdb:
        try:
            summary["duckdb"] = update_duckdb(duckdb_path, manifest_path)
        except Exception as exc:  # noqa: BLE001
            summary["duckdb_error"] = str(exc)
    write_summary(summary_path, summary)
    print(json.dumps({"event": "finish", **summary}, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
