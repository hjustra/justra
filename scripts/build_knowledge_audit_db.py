from __future__ import annotations

import argparse
import html
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import duckdb

ROOT = Path(__file__).resolve().parents[1]
KNOWLEDGE_DIR = ROOT / "data" / "knowledge"
TRT2_DIR = KNOWLEDGE_DIR / "trt2_basis"
DEFAULT_DB = KNOWLEDGE_DIR / "knowledge.duckdb"
DEFAULT_REPORT = ROOT / "reports" / "data_audit_trt2.html"


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def read_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                yield json.loads(line)


def as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def normalize_row(row: dict[str, Any], source_file: str) -> dict[str, Any]:
    metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    return {
        "key": as_text(row.get("key")),
        "source": as_text(row.get("source")),
        "source_layer": as_text(row.get("source_layer")),
        "kind": as_text(row.get("kind")),
        "collection": as_text(row.get("collection")),
        "collection_handle": as_text(row.get("collection_handle")),
        "title": as_text(row.get("title")),
        "document_type": as_text(row.get("document_type")),
        "date": as_text(row.get("date")),
        "url": as_text(row.get("url") or row.get("source_url")),
        "pdf_url": as_text(row.get("pdf_url")),
        "has_pdf": bool(row.get("pdf_url")),
        "summary": as_text(row.get("summary") or metadata.get("abstract")),
        "metadata_json": as_text(row.get("metadata")),
        "source_file": source_file,
    }


def html_escape(value: Any) -> str:
    return html.escape(str(value if value is not None else ""))


def render_table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    head = "".join(f"<th>{html_escape(column)}</th>" for column in columns)
    body = []
    for row in rows:
        cells = []
        for column in columns:
            value = row.get(column, "")
            if column in {"url", "pdf_url"} and value:
                label = "abrir PDF" if column == "pdf_url" else "abrir fonte"
                cells.append(f'<td><a href="{html_escape(value)}" target="_blank" rel="noreferrer">{label}</a></td>')
            else:
                cells.append(f"<td>{html_escape(value)}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def ensure_tables(con: duckdb.DuckDBPyConnection) -> None:
    schema = """
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
        has_pdf BOOLEAN,
        summary VARCHAR,
        metadata_json VARCHAR,
        source_file VARCHAR
    """
    con.execute(f"CREATE OR REPLACE TABLE trt2_basis_all ({schema})")
    con.execute(f"CREATE OR REPLACE TABLE trt2_legal_collections ({schema})")
    con.execute(
        """
        CREATE OR REPLACE VIEW trt2_legal_verified AS
        SELECT
            legal.key,
            legal.source_layer AS official_layer,
            legal.kind,
            legal.collection,
            legal.collection_handle,
            legal.title,
            legal.document_type,
            legal.date,
            legal.url,
            legal.pdf_url,
            legal.has_pdf,
            legal.summary,
            basis.source_layer AS full_index_layer,
            CASE WHEN basis.key IS NOT NULL THEN true ELSE false END AS present_in_full_basis
        FROM trt2_legal_collections legal
        LEFT JOIN trt2_basis_all basis USING (key)
        """
    )


def insert_rows(con: duckdb.DuckDBPyConnection, table: str, rows: list[dict[str, Any]]) -> None:
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
        "has_pdf",
        "summary",
        "metadata_json",
        "source_file",
    ]
    con.executemany(
        f"INSERT INTO {table} VALUES ({', '.join(['?'] * len(fields))})",
        [[row[field] for field in fields] for row in rows],
    )


def fetch_dicts(con: duckdb.DuckDBPyConnection, sql: str) -> list[dict[str, Any]]:
    cursor = con.execute(sql)
    columns = [item[0] for item in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def build_report(con: duckdb.DuckDBPyConnection, report_path: Path, db_path: Path) -> None:
    summary_rows = [
        {
            "camada": "TRT2 Basis completo",
            "itens": con.execute("SELECT COUNT(*) FROM trt2_basis_all").fetchone()[0],
            "detalhe": f"{con.execute('SELECT SUM(has_pdf::INT) FROM trt2_basis_all').fetchone()[0]} com PDF",
        },
        {
            "camada": "TRT2 coleções jurídicas oficiais",
            "itens": con.execute("SELECT COUNT(*) FROM trt2_legal_collections").fetchone()[0],
            "detalhe": f"{con.execute('SELECT SUM(has_pdf::INT) FROM trt2_legal_collections').fetchone()[0]} com PDF",
        },
        {
            "camada": "TRT2 jurídico verificado no índice full",
            "itens": con.execute("SELECT COUNT(*) FROM trt2_legal_verified").fetchone()[0],
            "detalhe": f"{con.execute('SELECT SUM(present_in_full_basis::INT) FROM trt2_legal_verified').fetchone()[0]} presentes no índice full",
        },
    ]
    by_layer = fetch_dicts(
        con,
        """
        SELECT official_layer AS camada, COUNT(*) AS itens, SUM(has_pdf::INT) AS com_pdf
        FROM trt2_legal_verified
        GROUP BY 1
        ORDER BY itens DESC
        """,
    )
    by_collection = fetch_dicts(
        con,
        """
        SELECT collection AS colecao, official_layer AS camada, COUNT(*) AS itens, SUM(has_pdf::INT) AS com_pdf
        FROM trt2_legal_verified
        GROUP BY 1, 2
        ORDER BY itens DESC
        """,
    )
    samples = fetch_dicts(
        con,
        """
        SELECT official_layer AS camada, collection AS colecao, date AS data, document_type AS tipo, title AS titulo, url, pdf_url
        FROM trt2_legal_verified
        ORDER BY COALESCE(date, '') DESC, title
        LIMIT 50
        """,
    )
    sql_examples = f"""
.venv/bin/python -c "import duckdb; con=duckdb.connect('{db_path.relative_to(ROOT)}', read_only=True); print(con.execute('SELECT official_layer, COUNT(*) AS itens FROM trt2_legal_verified GROUP BY 1 ORDER BY 2 DESC').fetchall())"

.venv/bin/python -c "import duckdb; con=duckdb.connect('{db_path.relative_to(ROOT)}', read_only=True); print(con.execute('SELECT collection, COUNT(*) AS itens, SUM(has_pdf::INT) AS com_pdf FROM trt2_legal_verified GROUP BY 1 ORDER BY itens DESC').fetchall())"

.venv/bin/python -c "import duckdb; con=duckdb.connect('{db_path.relative_to(ROOT)}', read_only=True); print(con.execute(\\"SELECT title, url, pdf_url FROM trt2_legal_verified WHERE official_layer = 'jurisprudencia' ORDER BY date DESC LIMIT 20\\").fetchall())"
"""
    html_doc = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Justra - Auditoria TRT2</title>
  <style>
    :root {{ color-scheme: light; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    body {{ margin: 0; background: #f6f7f9; color: #17202a; }}
    main {{ max-width: 1180px; margin: 0 auto; padding: 32px 20px 56px; }}
    h1 {{ margin: 0 0 6px; font-size: 30px; letter-spacing: 0; }}
    h2 {{ margin: 28px 0 12px; font-size: 18px; }}
    p {{ color: #4e5d6c; }}
    code, pre {{ background: #eef1f5; border: 1px solid #d9e0e8; border-radius: 6px; }}
    code {{ padding: 2px 5px; }}
    pre {{ padding: 14px; overflow: auto; }}
    .cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-top: 18px; }}
    .card {{ background: #fff; border: 1px solid #dfe5ec; border-radius: 8px; padding: 16px; }}
    .card span {{ display: block; color: #5d6d7e; font-size: 13px; }}
    .card strong {{ display: block; margin-top: 8px; font-size: 28px; }}
    table {{ width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dfe5ec; border-radius: 8px; overflow: hidden; }}
    th, td {{ padding: 10px 12px; border-bottom: 1px solid #edf0f4; text-align: left; vertical-align: top; font-size: 13px; }}
    th {{ background: #eef2f6; font-size: 12px; text-transform: uppercase; color: #526172; }}
    tr:last-child td {{ border-bottom: 0; }}
    a {{ color: #185abc; }}
  </style>
</head>
<body>
<main>
  <h1>Auditoria dos Dados TRT2</h1>
  <p>Gerado em {html_escape(now_iso())}. Banco DuckDB: <code>{html_escape(db_path.relative_to(ROOT))}</code>.</p>
  <div class="cards">
    {''.join(f'<div class="card"><span>{html_escape(row["camada"])}</span><strong>{html_escape(row["itens"])}</strong><span>{html_escape(row["detalhe"])}</span></div>' for row in summary_rows)}
  </div>
  <h2>Camadas Jurídicas Oficiais</h2>
  {render_table(by_layer, ["camada", "itens", "com_pdf"])}
  <h2>Coleções Oficiais</h2>
  {render_table(by_collection, ["colecao", "camada", "itens", "com_pdf"])}
  <h2>Como Verificar Via SQL</h2>
  <pre>{html_escape(sql_examples.strip())}</pre>
  <h2>Amostra Dos 50 Itens Mais Recentes</h2>
  {render_table(samples, ["camada", "colecao", "data", "tipo", "titulo", "url", "pdf_url"])}
</main>
</body>
</html>
"""
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(html_doc, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Cria DuckDB e relatório de auditoria das fontes jurídicas TRT2.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--report", default=str(DEFAULT_REPORT))
    args = parser.parse_args()

    full_path = TRT2_DIR / "trt2_basis_items.jsonl"
    legal_path = TRT2_DIR / "trt2_legal_collection_items.jsonl"
    if not full_path.exists():
        raise RuntimeError(f"Arquivo não encontrado: {full_path}")
    if not legal_path.exists():
        raise RuntimeError(f"Arquivo não encontrado: {legal_path}")

    full_rows = [normalize_row(row, str(full_path.relative_to(ROOT))) for row in read_jsonl(full_path)]
    legal_rows = [normalize_row(row, str(legal_path.relative_to(ROOT))) for row in read_jsonl(legal_path)]

    db_path = Path(args.db)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(db_path))
    ensure_tables(con)
    insert_rows(con, "trt2_basis_all", full_rows)
    insert_rows(con, "trt2_legal_collections", legal_rows)
    con.execute("CHECKPOINT")

    summary = {
        "db_path": str(db_path),
        "report_path": str(Path(args.report)),
        "trt2_basis_all": len(full_rows),
        "trt2_legal_collections": len(legal_rows),
        "trt2_legal_by_layer": dict(Counter(row["source_layer"] for row in legal_rows)),
        "trt2_legal_with_pdf": sum(1 for row in legal_rows if row["has_pdf"]),
    }
    build_report(con, Path(args.report), db_path)
    con.close()
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
