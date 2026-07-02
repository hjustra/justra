from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

import duckdb


ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
DEFAULT_DB = DATA_ROOT / "mvp" / "trt2" / "trt2_mvp.duckdb"
DEFAULT_INPUT = DATA_ROOT / "raw" / "falcao" / "2026-06-11_2026-06-18" / "documents.jsonl"
DEFAULT_STATUS = DATA_ROOT / "knowledge" / "falcao" / "import_status.json"
SOURCE_PROVIDER = "falcao"

STYLE_RE = re.compile(r"<(style|script)\b[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def only_digits(value: Any) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def clean_html_text(value: Any) -> str:
    text = str(value or "")
    text = STYLE_RE.sub(" ", text)
    text = TAG_RE.sub(" ", text)
    text = html.unescape(text).replace("\xa0", " ")
    return SPACE_RE.sub(" ", text).strip()


def parse_date(value: Any) -> str:
    raw = str(value or "").strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            pass
    return raw


def iter_documents(path: Path) -> Iterator[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"JSON inválido na linha {line_number}") from exc
            if not isinstance(payload, dict):
                raise RuntimeError(f"registro inválido na linha {line_number}")
            yield payload


def document_identity(document: dict[str, Any]) -> tuple[str, str, str, str]:
    metadata = document.get("_justra") or {}
    collection = str(metadata.get("collection") or "acordaos")
    tribunal = str(document.get("tribunal") or "").strip().upper()
    id_fields = {
        "acordaos": "idDocumentoAcordao",
        "decisoesmonocraticas": "idDocumento",
        "sentencas": "idSentenca",
        "recursorevista": "idRecursoRevista",
        "precedentes": "idTema",
    }
    raw_id = str(
        document.get(id_fields.get(collection, "id"))
        or document.get("id")
        or document.get("idTema")
        or ""
    ).strip()
    document_id = raw_id if collection == "acordaos" else f"{collection}:{raw_id}"
    document_key = str(metadata.get("document_key") or f"{collection}:{tribunal}:{raw_id}")
    return document_id, document_key, tribunal, collection


def document_text(document: dict[str, Any], collection: str) -> str:
    preferred = {
        "acordaos": ["textoAcordao", "ementa"],
        "decisoesmonocraticas": ["textoDecisao", "textoDocumento", "ementa"],
        "sentencas": ["textoSentenca", "textoDocumento", "ementa"],
        "recursorevista": ["textoRecursoRevista", "textoDecisao", "textoDocumento", "ementa"],
        "precedentes": ["textoTema", "textoPrecedente", "tese", "ementa"],
    }
    for field in preferred.get(collection, []):
        value = str(document.get(field) or "")
        if value.strip():
            return value
    candidates = [
        str(value)
        for key, value in document.items()
        if key.lower().startswith(("texto", "ementa")) and value
    ]
    return max(candidates, key=len, default="")


def preflight(path: Path, expected_count: int) -> dict[str, Any]:
    document_ids: set[str] = set()
    document_keys: set[str] = set()
    process_numbers: set[str] = set()
    by_court: Counter[str] = Counter()
    total = 0
    text_bytes = 0
    for document in iter_documents(path):
        total += 1
        document_id, document_key, tribunal, collection = document_identity(document)
        process_number = only_digits(document.get("numeroProcesso"))
        decision_text = document_text(document, collection)
        process_required = collection != "precedentes"
        if (
            not document_id
            or not document_key
            or not tribunal
            or (process_required and not process_number)
            or not decision_text.strip()
        ):
            raise RuntimeError(f"registro Falcão incompleto na posição {total}")
        if document_id in document_ids or document_key in document_keys:
            raise RuntimeError(f"documento Falcão duplicado: {document_key}")
        document_ids.add(document_id)
        document_keys.add(document_key)
        process_numbers.add(process_number)
        by_court[tribunal] += 1
        text_bytes += len(decision_text.encode("utf-8"))
    if expected_count > 0 and total != expected_count:
        raise RuntimeError(f"esperados {expected_count} documentos; encontrados {total}")
    return {
        "documents": total,
        "unique_document_ids": len(document_ids),
        "unique_processes": len(process_numbers),
        "source_text_bytes": text_bytes,
        "by_court": dict(sorted(by_court.items())),
    }


def normalize_document(document: dict[str, Any], raw_path: str, imported_at: str) -> list[str]:
    metadata = document.get("_justra") or {}
    document_id, _document_key, tribunal, collection = document_identity(document)
    process_number = only_digits(document.get("numeroProcesso"))
    court_body = str(
        document.get("turma")
        or document.get("gabinete")
        or document.get("orgaoJulgador")
        or document.get("nomeOrgaoJulgador")
        or ""
    ).strip()
    court_unit = f"{tribunal} - {court_body}" if court_body else tribunal
    reporting_judge = SPACE_RE.sub(
        " ",
        str(
            document.get("relator")
            or document.get("nomeRelator")
            or document.get("magistrado")
            or ""
        ),
    ).strip()
    decision_text = clean_html_text(document_text(document, collection))
    if not decision_text:
        raise RuntimeError(f"texto vazio após normalização: {document_id}")
    source_url = str(metadata.get("citation_url") or "").strip()
    degree = "superior" if tribunal == "TST" else "2"
    return [
        process_number,
        document_id,
        "acordao" if collection == "acordaos" else collection,
        degree,
        court_unit,
        reporting_judge,
        reporting_judge,
        parse_date(
            document.get("dataJulgamento")
            or document.get("dataDecisao")
            or document.get("dataSentenca")
            or document.get("dataJuntada")
            or document.get("dataPublicacao")
        ),
        decision_text,
        source_url,
        SOURCE_PROVIDER,
        raw_path,
        hashlib.sha256(decision_text.encode("utf-8")).hexdigest(),
        imported_at,
    ]


def ensure_table(connection: duckdb.DuckDBPyConnection) -> None:
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS full_text_documents (
            process_number VARCHAR,
            document_id VARCHAR,
            document_type VARCHAR,
            degree VARCHAR,
            court_unit VARCHAR,
            judge_name VARCHAR,
            reporting_judge VARCHAR,
            decision_date VARCHAR,
            decision_text VARCHAR,
            source_url VARCHAR,
            source_provider VARCHAR,
            raw_path VARCHAR,
            text_sha256 VARCHAR,
            imported_at VARCHAR
        )
        """
    )


def write_status(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Importa acórdãos do Falcão em full_text_documents.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--expected-count", type=int, default=0)
    parser.add_argument("--status", default=str(DEFAULT_STATUS))
    parser.add_argument("--skip-backup", action="store_true")
    parser.add_argument("--append", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    input_path = Path(args.input).resolve()
    status_path = Path(args.status).resolve()
    if not db_path.exists() or not input_path.exists():
        raise RuntimeError("DuckDB ou arquivo Falcão não encontrado")

    source_summary = preflight(input_path, args.expected_count)
    backup_path: Path | None = None
    if not args.skip_backup:
        backup_dir = db_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = backup_dir / f"{db_path.stem}_before_falcao_{stamp}{db_path.suffix}"
        shutil.copy2(db_path, backup_path)
        backup_path.chmod(0o600)

    imported_at = now_iso()
    raw_path = str(input_path.relative_to(ROOT)) if input_path.is_relative_to(ROOT) else str(input_path)
    connection = duckdb.connect(str(db_path))
    ensure_table(connection)
    try:
        connection.execute("BEGIN TRANSACTION")
        if not args.append:
            connection.execute("DELETE FROM full_text_documents WHERE source_provider = ?", [SOURCE_PROVIDER])
        existing_ids = {
            row[0]
            for row in connection.execute(
                "SELECT document_id FROM full_text_documents WHERE source_provider = ?",
                [SOURCE_PROVIDER],
            ).fetchall()
        }
        before_ids = len(existing_ids)
        batch: list[list[str]] = []
        for document in iter_documents(input_path):
            normalized = normalize_document(document, raw_path, imported_at)
            if normalized[1] in existing_ids:
                continue
            existing_ids.add(normalized[1])
            batch.append(normalized)
            if len(batch) >= 100:
                connection.executemany("INSERT INTO full_text_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
                batch.clear()
        if batch:
            connection.executemany("INSERT INTO full_text_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", batch)
        imported = connection.execute(
            "SELECT COUNT(*) FROM full_text_documents WHERE source_provider = ?", [SOURCE_PROVIDER]
        ).fetchone()[0]
        inserted_count = len(existing_ids) - before_ids
        unique_ids = connection.execute(
            "SELECT COUNT(DISTINCT document_id) FROM full_text_documents WHERE source_provider = ?", [SOURCE_PROVIDER]
        ).fetchone()[0]
        empty_text = connection.execute(
            "SELECT COUNT(*) FROM full_text_documents WHERE source_provider = ? AND COALESCE(decision_text, '') = ''",
            [SOURCE_PROVIDER],
        ).fetchone()[0]
        if imported != unique_ids or empty_text:
            raise RuntimeError(
                f"validação pós-importação falhou: imported={imported}, unique={unique_ids}, empty={empty_text}"
            )
        connection.execute("COMMIT")
    except Exception:
        connection.execute("ROLLBACK")
        raise

    total = connection.execute("SELECT COUNT(*) FROM full_text_documents").fetchone()[0]
    matched_mvp = connection.execute(
        """
        SELECT COUNT(DISTINCT f.process_number)
        FROM full_text_documents f
        JOIN processes p ON p.process_number = f.process_number
        WHERE f.source_provider = ?
        """,
        [SOURCE_PROVIDER],
    ).fetchone()[0]
    normalized_chars = connection.execute(
        "SELECT SUM(LENGTH(decision_text)) FROM full_text_documents WHERE source_provider = ?", [SOURCE_PROVIDER]
    ).fetchone()[0]
    connection.close()
    db_path.chmod(0o600)

    result = {
        "ok": True,
        "source": SOURCE_PROVIDER,
        "imported_at": imported_at,
        "input": raw_path,
        "backup": str(backup_path) if backup_path else None,
        "input_documents": source_summary["documents"],
        "imported": inserted_count,
        "full_text_total": total,
        "matched_mvp_processes": matched_mvp,
        "normalized_text_chars": normalized_chars,
        **source_summary,
    }
    write_status(status_path, result)
    status_path.chmod(0o600)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
