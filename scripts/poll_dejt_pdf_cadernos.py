#!/usr/bin/env python3
"""Poll fixed DEJT PDF caderno URLs and import only new editions.

The diario.jt.jus.br/cadernos URLs point to the latest available PDF for each
court, not necessarily to today's edition. This poller treats the first old PDF
as a baseline, then imports future changes after reading the real issue date
from the PDF header.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests

from import_dejt_pdf_caderno import import_events, pdf_to_text
from justra_runtime_paths import DATA_ROOT, LOG_ROOT

APP_TZ = ZoneInfo("America/Sao_Paulo")
BASE_URL = "https://diario.jt.jus.br/cadernos"
USER_AGENT = "Justra DJEN PDF poller/1.0 (+https://justra.com.br)"
STATE_PATH = DATA_ROOT / "app" / "dejt_pdf_poll_state.json"
MONTHS = {
    "janeiro": 1,
    "fevereiro": 2,
    "marco": 3,
    "março": 3,
    "abril": 4,
    "maio": 5,
    "junho": 6,
    "julho": 7,
    "agosto": 8,
    "setembro": 9,
    "outubro": 10,
    "novembro": 11,
    "dezembro": 12,
}


def now_iso() -> str:
    return datetime.now(APP_TZ).isoformat(timespec="seconds")


def atomic_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def normalize_key(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.lower())
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


def parse_date(value: str) -> date:
    return date.fromisoformat(value)


def date_parts(value: date | str) -> tuple[str, str, str]:
    raw = value.isoformat() if isinstance(value, date) else str(value)
    year, month, day = raw.split("-")
    return year, month, day


def poll_manifest_path(run_date: date) -> Path:
    year, month, day = date_parts(run_date)
    return DATA_ROOT / "processed" / "dejt_pdf_poll" / year / month / day / "poll_manifest.json"


def caderno_sources(mediums: list[str]) -> list[dict[str, str]]:
    courts = [{"court": "CSJT", "code": "CSJT"}, {"court": "TST", "code": "TST"}]
    courts.extend({"court": f"TRT{index}", "code": f"{index:02d}"} for index in range(1, 25))
    rows: list[dict[str, str]] = []
    for medium in mediums:
        medium = medium.upper()
        for court in courts:
            filename = f"Diario_{medium}_{court['code']}.pdf"
            rows.append(
                {
                    "key": f"{medium}:{court['court']}",
                    "medium": medium,
                    "court": court["court"],
                    "code": court["code"],
                    "filename": filename,
                    "url": f"{BASE_URL}/{filename}",
                }
            )
    return rows


def source_filter(raw: str) -> set[str]:
    values = {item.strip().upper() for item in raw.split(",") if item.strip()}
    return values


def parse_total_from_content_range(value: str) -> str:
    match = re.search(r"/(\d+)\s*$", value or "")
    return match.group(1) if match else ""


def remote_metadata(session: requests.Session, url: str) -> dict[str, Any]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"}
    response: requests.Response | None = None
    try:
        response = session.head(url, headers=headers, allow_redirects=True, timeout=20)
    except requests.RequestException:
        response = None
    if response is None or response.status_code >= 400 or "pdf" not in response.headers.get("content-type", "").lower():
        response = session.get(
            url,
            headers={**headers, "Range": "bytes=0-0"},
            allow_redirects=True,
            timeout=25,
            stream=True,
        )
        response.close()
    content_length = response.headers.get("content-length", "")
    content_range = response.headers.get("content-range", "")
    if content_range:
        content_length = parse_total_from_content_range(content_range) or content_length
    etag = response.headers.get("etag", "")
    last_modified = response.headers.get("last-modified", "")
    content_type = response.headers.get("content-type", "")
    signature_raw = "|".join([url, etag, last_modified, content_length, content_type])
    return {
        "ok": response.status_code in {200, 206} and "pdf" in content_type.lower(),
        "status_code": response.status_code,
        "content_type": content_type,
        "content_length": content_length,
        "etag": etag,
        "last_modified": last_modified,
        "signature": hashlib.sha256(signature_raw.encode("utf-8")).hexdigest(),
        "final_url": response.url,
    }


def download_pdf(session: requests.Session, url: str, target: Path) -> dict[str, Any]:
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    total = 0
    with session.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/pdf,*/*"},
        timeout=120,
        stream=True,
    ) as response:
        response.raise_for_status()
        content_type = response.headers.get("content-type", "")
        if "pdf" not in content_type.lower():
            raise RuntimeError(f"resposta não é PDF: {content_type or 'sem content-type'}")
        temporary = target.with_suffix(target.suffix + ".tmp")
        with temporary.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                digest.update(chunk)
                total += len(chunk)
                handle.write(chunk)
        temporary.replace(target)
    return {"sha256": digest.hexdigest(), "bytes": total}


def extract_issue_date(text: str) -> str:
    head = text[:12000]
    patterns = [
        r"Data\s+da\s+disponibiliza(?:ç|c)[aã]o:\s*(?:[A-Za-zÀ-ÿ-]+,\s*)?(\d{1,2})\s+de\s+([A-Za-zÀ-ÿçÇ]+)\s+de\s+(\d{4})",
        r"Data\s+da\s+Disponibiliza(?:ç|c)[aã]o:\s*(?:[A-Za-zÀ-ÿ-]+,\s*)?(\d{1,2})\s+de\s+([A-Za-zÀ-ÿçÇ]+)\s+de\s+(\d{4})",
    ]
    for pattern in patterns:
        match = re.search(pattern, head, flags=re.IGNORECASE)
        if not match:
            continue
        day = int(match.group(1))
        month_key = normalize_key(match.group(2))
        month = MONTHS.get(month_key)
        if not month:
            continue
        year = int(match.group(3))
        return date(year, month, day).isoformat()
    return ""


def raw_paths(issue_date: str, source: dict[str, str]) -> tuple[Path, Path]:
    year, month, day = date_parts(issue_date)
    raw_dir = DATA_ROOT / "raw" / "dejt_pdf" / year / month / day / source["court"]
    pdf_path = raw_dir / source["filename"]
    text_path = raw_dir / f"{pdf_path.stem}.txt"
    return pdf_path, text_path


def scratch_paths(run_id: str, source: dict[str, str]) -> tuple[Path, Path]:
    run_dir = DATA_ROOT / "raw" / "dejt_pdf_poll" / run_id / source["court"]
    pdf_path = run_dir / source["filename"]
    text_path = run_dir / f"{pdf_path.stem}.txt"
    return pdf_path, text_path


def copy_into_raw(issue_date: str, source: dict[str, str], scratch_pdf: Path, scratch_text: Path) -> tuple[Path, Path]:
    pdf_path, text_path = raw_paths(issue_date, source)
    pdf_path.parent.mkdir(parents=True, exist_ok=True)
    if scratch_pdf.resolve() != pdf_path.resolve():
        shutil.copy2(scratch_pdf, pdf_path)
    if scratch_text.resolve() != text_path.resolve():
        shutil.copy2(scratch_text, text_path)
    return pdf_path, text_path


def run_deadline_parser(target_date: str) -> dict[str, Any]:
    command = [
        sys.executable,
        "-u",
        str(Path(__file__).resolve().parent / "extract_djen_deadline_candidates.py"),
        "--date",
        target_date,
    ]
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    with (
        (LOG_ROOT / "djen-pdf-deadline-parser.log").open("a", encoding="utf-8") as stdout,
        (LOG_ROOT / "djen-pdf-deadline-parser-error.log").open("a", encoding="utf-8") as stderr,
    ):
        process = subprocess.Popen(command, cwd=Path(__file__).resolve().parents[1], stdout=stdout, stderr=stderr)
        returncode = process.wait()
    year, month, day = date_parts(target_date)
    manifest_path = DATA_ROOT / "processed" / "djen_deadlines" / year / month / day / "deadline_parser_manifest.json"
    manifest = load_json(manifest_path, {}) if manifest_path.exists() else {}
    return {
        "date": target_date,
        "returncode": returncode,
        "manifest_path": str(manifest_path) if manifest_path.exists() else "",
        "deadline_candidates": int(manifest.get("deadline_candidates") or 0),
        "calendar_event_candidates": int(manifest.get("calendar_event_candidates") or 0),
    }


def should_baseline_without_import(previous: dict[str, Any], issue_date: str, run_date: date) -> bool:
    if previous:
        return False
    parsed = parse_date(issue_date)
    return parsed < run_date


def process_source(
    session: requests.Session,
    source: dict[str, str],
    *,
    state: dict[str, Any],
    run_date: date,
    run_id: str,
    force: bool,
    dry_run: bool,
    max_age_days: int,
) -> dict[str, Any]:
    previous = (state.get("sources") or {}).get(source["key"]) or {}
    row: dict[str, Any] = {**source, "checked_at": now_iso()}
    meta = remote_metadata(session, source["url"])
    row["remote"] = meta
    if not meta.get("ok"):
        row["status"] = "remote_error"
        row["error"] = f"HTTP {meta.get('status_code')} {meta.get('content_type') or ''}".strip()
        return row
    if previous and not force and previous.get("signature") == meta.get("signature"):
        row["status"] = "unchanged"
        row["issue_date"] = previous.get("issue_date") or ""
        row["event_count"] = int(previous.get("event_count") or 0)
        return row

    scratch_pdf, scratch_text = scratch_paths(run_id, source)
    download = download_pdf(session, source["url"], scratch_pdf)
    if not scratch_text.exists() or force:
        pdf_to_text(scratch_pdf, scratch_text)
    text = scratch_text.read_text(encoding="utf-8", errors="replace")
    issue_date = extract_issue_date(text)
    row["issue_date"] = issue_date
    row["download"] = download
    if not issue_date:
        row["status"] = "missing_issue_date"
        row["error"] = "não encontrei Data da disponibilização no PDF"
        return row
    if previous and previous.get("sha256") == download.get("sha256") and not force:
        row["status"] = "unchanged_hash"
        row["event_count"] = int(previous.get("event_count") or 0)
        row["signature"] = meta.get("signature")
        row["sha256"] = download.get("sha256")
        return row

    issue = parse_date(issue_date)
    if should_baseline_without_import(previous, issue_date, run_date) and not force:
        row["status"] = "baseline_old"
        row["signature"] = meta.get("signature")
        row["sha256"] = download.get("sha256")
        row["event_count"] = 0
        return row
    if issue < run_date - timedelta(days=max(0, max_age_days)) and not force:
        row["status"] = "stale_changed_skip"
        row["signature"] = meta.get("signature")
        row["sha256"] = download.get("sha256")
        row["event_count"] = 0
        return row

    if dry_run:
        pdf_path, text_path = scratch_pdf, scratch_text
    else:
        pdf_path, text_path = copy_into_raw(issue_date, source, scratch_pdf, scratch_text)
    args = argparse.Namespace(
        date=issue_date,
        court=source["court"],
        pdf_url=source["url"],
        out_dir=str(DATA_ROOT),
        pdf_input=str(pdf_path),
        text_input=str(text_path),
        process="",
        force=force,
        dry_run=dry_run,
    )
    result = import_events(args)
    row["status"] = "imported" if not dry_run else "dry_run_importable"
    row["import"] = result
    row["event_count"] = int(result.get("events") or 0)
    row["signature"] = meta.get("signature")
    row["sha256"] = download.get("sha256")
    row["pdf_path"] = str(pdf_path)
    row["text_path"] = str(text_path)
    return row


def poll(args: argparse.Namespace) -> dict[str, Any]:
    run_date = parse_date(args.run_date) if args.run_date else datetime.now(APP_TZ).date()
    run_id = f"poll_{datetime.now(APP_TZ).strftime('%Y%m%d_%H%M%S')}"
    mediums = [item.strip().upper() for item in args.mediums.split(",") if item.strip()]
    wanted_courts = source_filter(args.courts)
    sources = [
        source
        for source in caderno_sources(mediums)
        if not wanted_courts or source["court"] in wanted_courts or source["code"] in wanted_courts
    ]
    state = load_json(STATE_PATH, {"sources": {}})
    state.setdefault("sources", {})
    rows: list[dict[str, Any]] = []
    session = requests.Session()
    for source in sources:
        try:
            row = process_source(
                session,
                source,
                state=state,
                run_date=run_date,
                run_id=run_id,
                force=args.force,
                dry_run=args.dry_run,
                max_age_days=args.max_age_days,
            )
        except Exception as exc:  # noqa: BLE001
            row = {**source, "checked_at": now_iso(), "status": "error", "error": str(exc)}
        rows.append(row)
        if row.get("signature") or row.get("sha256") or row.get("issue_date"):
            state["sources"][source["key"]] = {
                **(state.get("sources", {}).get(source["key"]) or {}),
                "url": source["url"],
                "court": source["court"],
                "medium": source["medium"],
                "signature": row.get("signature") or row.get("remote", {}).get("signature") or "",
                "sha256": row.get("sha256") or row.get("download", {}).get("sha256") or "",
                "issue_date": row.get("issue_date") or "",
                "event_count": int(row.get("event_count") or 0),
                "status": row.get("status") or "",
                "checked_at": row.get("checked_at") or now_iso(),
                "imported_at": now_iso() if row.get("status") == "imported" else (state.get("sources", {}).get(source["key"]) or {}).get("imported_at", ""),
            }
        if args.sleep:
            import time

            time.sleep(max(0.0, float(args.sleep)))
    imported_dates = sorted({row.get("issue_date") for row in rows if row.get("status") == "imported" and row.get("issue_date")})
    deadline_runs: list[dict[str, Any]] = []
    if imported_dates and not args.dry_run and not args.skip_deadlines:
        for target in imported_dates:
            deadline_runs.append(run_deadline_parser(str(target)))
    summary = {
        "ok": True,
        "dry_run": bool(args.dry_run),
        "run_id": run_id,
        "run_date": run_date.isoformat(),
        "started_at": now_iso(),
        "source": "diario.jt.jus.br/cadernos",
        "mediums": mediums,
        "total_sources": len(sources),
        "status_counts": {},
        "imported_dates": imported_dates,
        "events_imported": sum(int(row.get("event_count") or 0) for row in rows if row.get("status") == "imported"),
        "deadline_parser": deadline_runs,
        "sources": rows,
        "state_path": str(STATE_PATH),
    }
    counts: dict[str, int] = {}
    for row in rows:
        key = str(row.get("status") or "unknown")
        counts[key] = counts.get(key, 0) + 1
    summary["status_counts"] = counts
    summary["finished_at"] = now_iso()
    if not args.dry_run:
        state["updated_at"] = now_iso()
        atomic_json(STATE_PATH, state)
    manifest_path = poll_manifest_path(run_date)
    atomic_json(manifest_path, summary)
    summary["manifest_path"] = str(manifest_path)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description="Verifica PDFs fixos do DEJT e importa apenas edições novas.")
    parser.add_argument("--run-date", default="", help="Data local da execução YYYY-MM-DD; padrão: hoje.")
    parser.add_argument("--mediums", default="J", help="Cadernos a verificar. Use J ou J,A.")
    parser.add_argument("--courts", default="", help="Filtro opcional: TRT2,TST,CSJT ou códigos 02,TST.")
    parser.add_argument("--max-age-days", type=int, default=7, help="Importa mudanças recentes até N dias para trás.")
    parser.add_argument("--sleep", type=float, default=0.2, help="Pausa entre fontes.")
    parser.add_argument("--force", action="store_true", help="Baixa e reimporta mesmo se a assinatura não mudou.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-deadlines", action="store_true")
    args = parser.parse_args()
    result = poll(args)
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
