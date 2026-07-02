from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import duckdb


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.serve_justra_app import DEFAULT_DB, KNOWLEDGE_DB, JustraApp, legal_source_url  # noqa: E402


def court_for(row: dict[str, Any]) -> str:
    source = str(row.get("source") or "")
    if source == "tst":
        return "TST"
    if source == "trt2_basis":
        return "TRT2"
    if source == "planalto":
        return "Planalto"
    return source.upper()


def main() -> None:
    parser = argparse.ArgumentParser(description="Sincroniza fontes jurídicas em uma tabela DuckDB pesquisável.")
    parser.add_argument("--db", default=str(KNOWLEDGE_DB))
    args = parser.parse_args()

    target = Path(args.db).resolve()
    app = JustraApp(DEFAULT_DB)
    indexed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows: list[list[Any]] = []
    try:
        for row in app.legal_sources:
            source = str(row.get("source") or "")
            source_layer = str(row.get("source_layer") or "")
            kind = str(row.get("kind") or "")
            code = str(row.get("code") or "")
            title = app._source_display_title(row)
            url = legal_source_url(row)
            raw_path = str(row.get("_path") or "")
            source_key = hashlib.sha256(
                "|".join([source, source_layer, kind, code, title, url, raw_path]).encode("utf-8")
            ).hexdigest()
            rows.append(
                [
                    source_key,
                    source,
                    source_layer,
                    kind,
                    code,
                    title,
                    court_for(row),
                    str(row.get("status") or row.get("status_description") or ""),
                    str(row.get("publication_date") or row.get("date") or ""),
                    url,
                    raw_path,
                    json.dumps(row, ensure_ascii=False, separators=(",", ":")),
                    indexed_at,
                ]
            )
    finally:
        app.close()

    connection = duckdb.connect(str(target))
    try:
        connection.execute("BEGIN TRANSACTION")
        connection.execute(
            """
            CREATE OR REPLACE TABLE legal_sources (
                source_key VARCHAR,
                source VARCHAR,
                source_layer VARCHAR,
                kind VARCHAR,
                code VARCHAR,
                title VARCHAR,
                court VARCHAR,
                status VARCHAR,
                publication_date VARCHAR,
                source_url VARCHAR,
                raw_path VARCHAR,
                payload_json VARCHAR,
                indexed_at VARCHAR
            )
            """
        )
        connection.executemany(
            "INSERT INTO legal_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rows,
        )
        connection.execute("COMMIT")
        total = connection.execute("SELECT COUNT(*) FROM legal_sources").fetchone()[0]
        sumulas = connection.execute(
            "SELECT COUNT(*) FROM legal_sources WHERE court = 'TST' AND kind = 'sumula'"
        ).fetchone()[0]
        by_layer = connection.execute(
            "SELECT source, source_layer, COUNT(*) FROM legal_sources GROUP BY 1, 2 ORDER BY 1, 2"
        ).fetchall()
    except Exception:
        connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()
    target.chmod(0o600)
    print(json.dumps({"ok": True, "rows": total, "tst_sumulas": sumulas, "by_layer": by_layer}, ensure_ascii=False))


if __name__ == "__main__":
    main()
