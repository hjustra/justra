from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import duckdb

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "mvp" / "trt2" / "trt2_mvp.duckdb"
DEFAULT_INPUT = ROOT / "data" / "mvp" / "trt2" / "full_text_inbox"


FIELDS = [
    "process_number",
    "document_id",
    "document_type",
    "degree",
    "court_unit",
    "judge_name",
    "reporting_judge",
    "decision_date",
    "decision_text",
    "source_url",
    "source_provider",
    "raw_path",
]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def only_digits(value: str) -> str:
    return "".join(ch for ch in str(value or "") if ch.isdigit())


def text_sha256(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def read_json_records(path: Path) -> Iterable[dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        yield from payload
    elif isinstance(payload, dict):
        yield payload


def read_jsonl_records(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                yield json.loads(line)


def read_csv_records(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as file:
        yield from csv.DictReader(file)


def iter_input_records(input_path: Path) -> Iterable[dict[str, Any]]:
    paths = sorted(input_path.iterdir()) if input_path.is_dir() else [input_path]
    for path in paths:
        if path.is_dir():
            continue
        suffix = path.suffix.lower()
        if suffix == ".jsonl":
            yield from read_jsonl_records(path)
        elif suffix == ".json":
            yield from read_json_records(path)
        elif suffix == ".csv":
            yield from read_csv_records(path)
        elif suffix == ".txt":
            yield {
                "process_number": path.stem,
                "document_id": path.stem,
                "document_type": "unknown",
                "decision_text": path.read_text(encoding="utf-8", errors="ignore"),
                "raw_path": str(path),
                "source_provider": "manual_txt",
            }


def normalize_record(record: dict[str, Any]) -> dict[str, Any]:
    normalized = {field: str(record.get(field, "") or "") for field in FIELDS}
    normalized["process_number"] = only_digits(normalized["process_number"])
    if not normalized["document_id"]:
        normalized["document_id"] = text_sha256(
            "|".join([normalized["process_number"], normalized["document_type"], normalized["decision_text"][:1000]])
        )[:24]
    normalized["text_sha256"] = text_sha256(normalized["decision_text"])
    normalized["imported_at"] = now_iso()
    return normalized


def ensure_table(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
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


def main() -> None:
    parser = argparse.ArgumentParser(description="Import user-provided full text documents into the TRT2 MVP DB.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db)
    input_path = Path(args.input)
    if not db_path.exists():
        raise RuntimeError(f"DuckDB nao encontrado: {db_path}")
    if not input_path.exists():
        raise RuntimeError(f"Entrada nao encontrada: {input_path}")

    records = [normalize_record(record) for record in iter_input_records(input_path)]
    records = [record for record in records if record["process_number"] and record["decision_text"]]

    con = duckdb.connect(str(db_path))
    ensure_table(con)
    if args.replace:
        con.execute("DELETE FROM full_text_documents")

    for record in records:
        con.execute(
            """
            INSERT INTO full_text_documents VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                record["process_number"],
                record["document_id"],
                record["document_type"],
                record["degree"],
                record["court_unit"],
                record["judge_name"],
                record["reporting_judge"],
                record["decision_date"],
                record["decision_text"],
                record["source_url"],
                record["source_provider"],
                record["raw_path"],
                record["text_sha256"],
                record["imported_at"],
            ],
        )
    total = con.execute("SELECT COUNT(*) FROM full_text_documents").fetchone()[0]
    con.close()
    print(json.dumps({"imported": len(records), "full_text_total": total, "db": str(db_path)}, indent=2))


if __name__ == "__main__":
    main()
