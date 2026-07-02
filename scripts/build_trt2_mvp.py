from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import duckdb
import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.collectors.datajud_trt2 import DataJudClient
from src.collectors.pje_trt2 import PJE_TRT2_BASE_URL, format_cnj_number, only_digits
from src.classifiers.claim_classifier import classify_claims


DEFAULT_OUTPUT_DIR = DATA_ROOT / "mvp" / "trt2"
DEFAULT_REPORT_PATH = ROOT / "reports" / "trt2_mvp_report.html"

SOURCE_FIELDS = [
    "numeroProcesso",
    "tribunal",
    "grau",
    "classe",
    "assuntos",
    "orgaoJulgador",
    "dataAjuizamento",
    "movimentos.codigo",
    "movimentos.nome",
    "movimentos.dataHora",
    "movimentos.complementosTabelados",
    "movimentos.orgaoJulgador",
]


OUTCOME_BY_MOVEMENT = [
    ("procedente_parcial", [r"procedencia em parte", r"parcial"]),
    ("improcedente", [r"improcedencia"]),
    ("procedente", [r"procedencia$"]),
    ("acordo", [r"homologacao de transacao", r"acordo"]),
    ("extinto", [r"extincao"]),
    ("julgamento", [r"julgamento", r"sentenca"]),
    ("transito", [r"transito em julgado"]),
]


def now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def normalize_ascii(value: str) -> str:
    table = str.maketrans(
        {
            "á": "a",
            "à": "a",
            "ã": "a",
            "â": "a",
            "ä": "a",
            "é": "e",
            "ê": "e",
            "í": "i",
            "ó": "o",
            "ô": "o",
            "õ": "o",
            "ú": "u",
            "ç": "c",
            "Á": "A",
            "À": "A",
            "Ã": "A",
            "Â": "A",
            "Ä": "A",
            "É": "E",
            "Ê": "E",
            "Í": "I",
            "Ó": "O",
            "Ô": "O",
            "Õ": "O",
            "Ú": "U",
            "Ç": "C",
        }
    )
    return value.translate(table)


def normalize_space(value: str | None) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def flatten_dict_list(value: Any) -> list[dict[str, Any]]:
    if not value:
        return []
    if isinstance(value, dict):
        return [value]
    if not isinstance(value, list):
        return []
    output: list[dict[str, Any]] = []
    for item in value:
        output.extend(flatten_dict_list(item))
    return output


def iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    if not path.exists():
        return
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                yield json.loads(line)


def load_seen_numbers(path: Path) -> set[str]:
    if not path.exists():
        return set()
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def append_seen_number(path: Path, process_number: str) -> None:
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as file:
        file.write(f"{process_number}\n")


def checkpoint_name(degree: str, since: str) -> str:
    safe_degree = re.sub(r"[^A-Za-z0-9_-]+", "_", degree or "all")
    safe_since = re.sub(r"[^0-9]+", "", since or "all")
    return f"datajud_checkpoint_{safe_degree}_{safe_since}.json"


def datajud_query(page_size: int, search_after: list[Any] | None, degree: str, since: str) -> dict[str, Any]:
    filters: list[dict[str, Any]] = []
    if degree != "all":
        filters.append({"term": {"grau.keyword": degree}})
    if since:
        filters.append({"range": {"dataAjuizamento": {"gte": since}}})

    query: dict[str, Any] = {"match_all": {}}
    if filters:
        query = {"bool": {"filter": filters}}

    payload: dict[str, Any] = {
        "size": page_size,
        "track_total_hits": True,
        "query": query,
        "_source": SOURCE_FIELDS,
        "sort": [
            {"dataAjuizamento": {"order": "asc", "missing": "_last"}},
            {"numeroProcesso.keyword": {"order": "asc", "missing": "_last"}},
        ],
    }
    if search_after:
        payload["search_after"] = search_after
    return payload


def fetch_datajud_trt2(
    output_dir: Path,
    api_key: str,
    max_processes: int,
    page_size: int,
    sleep_seconds: float,
    degree: str,
    since: str,
    max_retries: int,
    backoff_seconds: int,
    request_timeout: int,
    reset: bool = False,
) -> dict[str, Any]:
    raw_path = output_dir / "raw" / "datajud_trt2_processes.jsonl"
    checkpoint_path = output_dir / "raw" / checkpoint_name(degree, since)
    seen_path = output_dir / "raw" / "seen_process_numbers.txt"
    ensure_dir(raw_path.parent)

    if reset:
        raw_path.unlink(missing_ok=True)
        checkpoint_path.unlink(missing_ok=True)
        seen_path.unlink(missing_ok=True)

    checkpoint = read_json(checkpoint_path, {})
    seen = load_seen_numbers(seen_path)
    search_after = checkpoint.get("search_after")
    client = DataJudClient(api_key=api_key, tribunal="trt2")

    fetched = 0
    pages = 0
    total = None
    stopped_reason = "completed"
    rate_limit_events = 0

    with raw_path.open("a", encoding="utf-8") as raw_file:
        while True:
            if max_processes and fetched >= max_processes:
                stopped_reason = "max_processes"
                break
            payload = datajud_query(page_size, search_after, degree, since)
            for attempt in range(max_retries + 1):
                try:
                    response = client.search(payload, timeout=request_timeout)
                    break
                except requests.HTTPError as exc:
                    status_code = exc.response.status_code if exc.response is not None else None
                    if status_code not in {403, 429, 500, 502, 503, 504} or attempt >= max_retries:
                        stopped_reason = f"http_error_{status_code or 'unknown'}"
                        raise
                    rate_limit_events += 1
                    wait_seconds = backoff_seconds * (attempt + 1)
                    write_json(
                        checkpoint_path,
                        {
                            "updated_at": now_iso(),
                            "search_after": search_after,
                            "seen_count": len(seen),
                            "reported_total": total,
                            "degree": degree,
                            "since": since,
                            "last_rate_limit_status": status_code,
                            "backoff_seconds": wait_seconds,
                        },
                    )
                    time.sleep(wait_seconds)
                except (requests.ReadTimeout, requests.ConnectTimeout, requests.ConnectionError) as exc:
                    if attempt >= max_retries:
                        stopped_reason = exc.__class__.__name__.lower()
                        raise
                    wait_seconds = backoff_seconds * (attempt + 1)
                    write_json(
                        checkpoint_path,
                        {
                            "updated_at": now_iso(),
                            "search_after": search_after,
                            "seen_count": len(seen),
                            "reported_total": total,
                            "degree": degree,
                            "since": since,
                            "last_transient_error": exc.__class__.__name__,
                            "backoff_seconds": wait_seconds,
                        },
                    )
                    time.sleep(wait_seconds)
            hits = response.get("hits", {}).get("hits", [])
            total = response.get("hits", {}).get("total", {}).get("value", total)
            if not hits:
                break

            for hit in hits:
                source = hit.get("_source", {})
                process_number = only_digits(source.get("numeroProcesso", ""))
                if not process_number or process_number in seen:
                    continue
                raw_record = {
                    "_id": hit.get("_id"),
                    "_index": hit.get("_index"),
                    "_sort": hit.get("sort"),
                    "_source": source,
                }
                raw_file.write(json.dumps(raw_record, ensure_ascii=False) + "\n")
                seen.add(process_number)
                append_seen_number(seen_path, process_number)
                fetched += 1
                if max_processes and fetched >= max_processes:
                    break

            pages += 1
            search_after = hits[-1].get("sort")
            write_json(
                checkpoint_path,
                {
                    "updated_at": now_iso(),
                    "search_after": search_after,
                    "seen_count": len(seen),
                    "last_page_hits": len(hits),
                    "reported_total": total,
                    "degree": degree,
                    "since": since,
                },
            )
            if len(hits) < page_size:
                break
            time.sleep(sleep_seconds)

    return {
        "raw_path": str(raw_path),
        "checkpoint_path": str(checkpoint_path),
        "seen_count": len(seen),
        "fetched_this_run": fetched,
        "pages_this_run": pages,
        "reported_total": total,
        "stopped_reason": stopped_reason,
        "rate_limit_events": rate_limit_events,
    }


def classify_outcome_from_movement(name: str) -> str:
    normalized = normalize_ascii(name).lower()
    for label, patterns in OUTCOME_BY_MOVEMENT:
        if any(re.search(pattern, normalized) for pattern in patterns):
            return label
    return "outro"


def classify_claims_from_subjects(subjects: list[str]) -> list[str]:
    text = " ; ".join(subjects)
    claims = [match.claim_type for match in classify_claims(text)]
    return sorted(set(claims))


def pje_url(process_number: str, degree: str) -> str:
    instance = "2" if degree == "G2" else "1"
    return f"{PJE_TRT2_BASE_URL}/consultaprocessual/detalhe-processo/{only_digits(process_number)}/{instance}"


def transform_raw_to_csv(output_dir: Path) -> dict[str, Any]:
    raw_path = output_dir / "raw" / "datajud_trt2_processes.jsonl"
    processed_dir = output_dir / "processed"
    ensure_dir(processed_dir)

    process_rows: list[dict[str, Any]] = []
    subject_rows: list[dict[str, Any]] = []
    movement_rows: list[dict[str, Any]] = []
    decision_rows: list[dict[str, Any]] = []
    claim_rows: list[dict[str, Any]] = []

    seen_processes: set[str] = set()
    for raw in iter_jsonl(raw_path):
        source = raw.get("_source", {})
        process_number = only_digits(source.get("numeroProcesso", ""))
        if not process_number or process_number in seen_processes:
            continue
        seen_processes.add(process_number)

        subjects = flatten_dict_list(source.get("assuntos"))
        movements = flatten_dict_list(source.get("movimentos"))
        class_data = source.get("classe") or {}
        court_data = source.get("orgaoJulgador") or {}
        degree = source.get("grau", "")
        subject_names = [normalize_space(item.get("nome", "")) for item in subjects if item.get("nome")]
        claims = classify_claims_from_subjects(subject_names)

        process_rows.append(
            {
                "process_number": process_number,
                "process_number_formatted": format_cnj_number(process_number),
                "tribunal": source.get("tribunal", "TRT2"),
                "degree": degree,
                "case_class_code": class_data.get("codigo", ""),
                "case_class": class_data.get("nome", ""),
                "court_unit_code": court_data.get("codigo", ""),
                "court_unit": court_data.get("nome", ""),
                "municipality_ibge": court_data.get("codigoMunicipioIBGE", ""),
                "filing_date": source.get("dataAjuizamento", ""),
                "filing_year": str(source.get("dataAjuizamento", ""))[:4],
                "subjects": "; ".join(subject_names),
                "claims": "; ".join(claims),
                "movement_count": len(movements),
                "pje_url": pje_url(process_number, degree),
            }
        )

        for subject in subjects:
            subject_name = normalize_space(subject.get("nome", ""))
            if not subject_name:
                continue
            subject_rows.append(
                {
                    "process_number": process_number,
                    "degree": degree,
                    "court_unit": court_data.get("nome", ""),
                    "subject_code": subject.get("codigo", ""),
                    "subject_name": subject_name,
                    "filing_year": str(source.get("dataAjuizamento", ""))[:4],
                }
            )

        for claim_type in claims:
            claim_rows.append(
                {
                    "process_number": process_number,
                    "degree": degree,
                    "court_unit": court_data.get("nome", ""),
                    "claim_type": claim_type,
                    "filing_year": str(source.get("dataAjuizamento", ""))[:4],
                }
            )

        for movement_index, movement in enumerate(movements):
            movement_name = normalize_space(movement.get("nome", ""))
            movement_date = movement.get("dataHora", "")
            movement_rows.append(
                {
                    "process_number": process_number,
                    "degree": degree,
                    "court_unit": court_data.get("nome", ""),
                    "movement_index": movement_index,
                    "movement_code": movement.get("codigo", ""),
                    "movement_name": movement_name,
                    "movement_date": movement_date,
                    "movement_year": str(movement_date)[:4],
                    "complements_json": json.dumps(movement.get("complementosTabelados", []), ensure_ascii=False),
                }
            )
            outcome = classify_outcome_from_movement(movement_name)
            if outcome == "outro":
                continue
            decision_rows.append(
                {
                    "process_number": process_number,
                    "degree": degree,
                    "court_unit": court_data.get("nome", ""),
                    "movement_code": movement.get("codigo", ""),
                    "movement_name": movement_name,
                    "movement_date": movement_date,
                    "movement_year": str(movement_date)[:4],
                    "outcome_proxy": outcome,
                }
            )

    paths = {
        "processes": processed_dir / "processes.csv",
        "subjects": processed_dir / "subjects.csv",
        "movements": processed_dir / "movements.csv",
        "decision_events": processed_dir / "decision_events.csv",
        "claims": processed_dir / "claims.csv",
    }
    write_csv(paths["processes"], process_rows)
    write_csv(paths["subjects"], subject_rows)
    write_csv(paths["movements"], movement_rows)
    write_csv(paths["decision_events"], decision_rows)
    write_csv(paths["claims"], claim_rows)

    return {
        "rows": {
            "processes": len(process_rows),
            "subjects": len(subject_rows),
            "movements": len(movement_rows),
            "decision_events": len(decision_rows),
            "claims": len(claim_rows),
        },
        "paths": {key: str(value) for key, value in paths.items()},
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fieldnames = list(rows[0].keys()) if rows else ["empty"]
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        if rows:
            writer.writerows(rows)


def build_duckdb(output_dir: Path, db_path: Path | None = None) -> dict[str, Any]:
    processed_dir = output_dir / "processed"
    db_path = db_path or (output_dir / "trt2_mvp.duckdb")
    con = duckdb.connect(str(db_path))
    tables = ["processes", "subjects", "movements", "decision_events", "claims"]
    for table in tables:
        csv_path = processed_dir / f"{table}.csv"
        con.execute(
            f"CREATE OR REPLACE TABLE {table} AS "
            "SELECT * FROM read_csv_auto(?, header=true, ignore_errors=true)",
            [str(csv_path)],
        )

    # Empty shell for future full text imports.
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

    stats = {
        "process_count": con.execute("SELECT COUNT(*) FROM processes").fetchone()[0],
        "movement_count": con.execute("SELECT COUNT(*) FROM movements").fetchone()[0],
        "decision_event_count": con.execute("SELECT COUNT(*) FROM decision_events").fetchone()[0],
        "full_text_count": con.execute("SELECT COUNT(*) FROM full_text_documents").fetchone()[0],
    }
    con.close()
    return {"db_path": str(db_path), "stats": stats}


def query_report_data(db_path: Path) -> dict[str, Any]:
    con = duckdb.connect(str(db_path), read_only=True)
    data = {
        "summary": con.execute(
            """
            SELECT
              COUNT(*) AS process_count,
              COUNT(DISTINCT court_unit) AS court_units,
              COUNT(DISTINCT case_class) AS case_classes,
              COUNT(DISTINCT process_number) FILTER (WHERE claims <> 'outros') AS classified_processes
            FROM processes
            """
        ).fetchdf().to_dict("records")[0],
        "top_court_units": con.execute(
            """
            SELECT court_unit, COUNT(*) AS total
            FROM processes
            WHERE court_unit IS NOT NULL AND court_unit <> ''
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 20
            """
        ).fetchdf().to_dict("records"),
        "top_subjects": con.execute(
            """
            SELECT subject_name, COUNT(*) AS total
            FROM subjects
            WHERE subject_name IS NOT NULL AND subject_name <> ''
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 20
            """
        ).fetchdf().to_dict("records"),
        "top_claims": con.execute(
            """
            SELECT claim_type, COUNT(DISTINCT process_number) AS total
            FROM claims
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 20
            """
        ).fetchdf().to_dict("records"),
        "outcome_proxy": con.execute(
            """
            SELECT outcome_proxy, COUNT(DISTINCT process_number) AS total
            FROM decision_events
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 20
            """
        ).fetchdf().to_dict("records"),
        "claim_outcomes": con.execute(
            """
            SELECT c.claim_type, d.outcome_proxy, COUNT(DISTINCT c.process_number) AS total
            FROM claims c
            JOIN decision_events d USING (process_number)
            WHERE d.outcome_proxy IN ('procedente_parcial', 'procedente', 'improcedente', 'acordo', 'extinto')
            GROUP BY 1, 2
            ORDER BY c.claim_type, total DESC
            LIMIT 60
            """
        ).fetchdf().to_dict("records"),
        "full_text_count": con.execute("SELECT COUNT(*) FROM full_text_documents").fetchone()[0],
    }
    con.close()
    return data


def html_escape(value: Any) -> str:
    import html

    return html.escape("" if value is None else str(value))


def table_rows(rows: list[dict[str, Any]], key_col: str, total_col: str = "total") -> str:
    return "\n".join(
        f"<tr><td>{html_escape(row.get(key_col))}</td><td>{html_escape(row.get(total_col))}</td></tr>"
        for row in rows
    )


def render_report(report_path: Path, output_dir: Path, report_data: dict[str, Any], run_info: dict[str, Any]) -> None:
    ensure_dir(report_path.parent)
    summary = report_data["summary"]
    full_text_count = report_data["full_text_count"]
    claim_outcome_rows = "\n".join(
        "<tr>"
        f"<td>{html_escape(row.get('claim_type'))}</td>"
        f"<td>{html_escape(row.get('outcome_proxy'))}</td>"
        f"<td>{html_escape(row.get('total'))}</td>"
        "</tr>"
        for row in report_data["claim_outcomes"]
    )
    report_path.write_text(
        f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Justra MVP - TRT2</title>
  <style>
    :root {{
      --ink: #202a28;
      --muted: #66736f;
      --line: #d7dedb;
      --page: #f5f7f6;
      --surface: #fff;
      --nav: #253431;
      --teal: #0b6b5a;
      --amber: #8a620f;
      --red: #a64235;
      --shadow: 0 10px 24px rgba(32,42,40,.08);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      color: var(--ink);
      background: var(--page);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }}
    header {{ padding: 26px 32px; color: #f4faf8; background: var(--nav); }}
    header h1 {{ margin: 0; font-size: 30px; line-height: 1.12; }}
    header p {{ max-width: 1020px; color: #bed0cb; line-height: 1.5; }}
    main {{ padding: 24px 32px 44px; }}
    section {{ max-width: 1180px; margin: 0 auto 18px; }}
    .grid {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }}
    .two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
    .card, .panel {{
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }}
    .card {{ min-height: 96px; padding: 16px; }}
    .card span {{ color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; }}
    .card strong {{ display: block; margin-top: 8px; font-size: 28px; }}
    .panel {{ padding: 18px; }}
    h2 {{ margin: 0 0 12px; font-size: 18px; }}
    p, li {{ color: var(--muted); line-height: 1.55; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ color: var(--muted); font-size: 12px; text-transform: uppercase; }}
    .notice {{ padding: 12px; border-left: 4px solid var(--amber); background: #fff8e8; color: #604606; }}
    .ok {{ color: var(--teal); font-weight: 800; }}
    .warn {{ color: var(--amber); font-weight: 800; }}
    @media (max-width: 900px) {{
      header, main {{ padding-left: 18px; padding-right: 18px; }}
      .grid, .two {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Justra MVP - TRT2</h1>
    <p>Base local de metadados, movimentos e jurimetria aproximada do TRT2. O inteiro teor fica como camada plugavel: quando voce trouxer a fonte, ela entra em <code>full_text_documents</code> sem alterar o restante do produto.</p>
  </header>
  <main>
    <section class="grid">
      <div class="card"><span>Processos</span><strong>{html_escape(summary.get('process_count'))}</strong></div>
      <div class="card"><span>Varas/orgaos</span><strong>{html_escape(summary.get('court_units'))}</strong></div>
      <div class="card"><span>Eventos decisorios</span><strong>{html_escape(run_info.get('duckdb', {}).get('stats', {}).get('decision_event_count'))}</strong></div>
      <div class="card"><span>Inteiros teores</span><strong>{html_escape(full_text_count)}</strong></div>
    </section>

    <section class="panel">
      <h2>Escopo real do MVP</h2>
      <p class="notice">Esta versao responde volume, assunto, vara, classe, tempo e desfecho aproximado por movimento. Perguntas sobre fundamentos, provas, teses rejeitadas e precedentes citados dependem da tabela futura <code>full_text_documents</code>.</p>
      <p><span class="ok">Pronto agora:</span> DataJud TRT2, CSV, DuckDB, relatorio HTML, funil por pedido/desfecho aproximado.</p>
      <p><span class="warn">Espaco aberto:</span> importacao de inteiro teor por arquivo/fornecedor proprio em <code>{html_escape(output_dir / 'full_text_inbox')}</code>.</p>
    </section>

    <section class="two">
      <div class="panel">
        <h2>Top varas/orgaos</h2>
        <table><thead><tr><th>Unidade</th><th>Total</th></tr></thead><tbody>{table_rows(report_data['top_court_units'], 'court_unit')}</tbody></table>
      </div>
      <div class="panel">
        <h2>Top assuntos</h2>
        <table><thead><tr><th>Assunto</th><th>Total</th></tr></thead><tbody>{table_rows(report_data['top_subjects'], 'subject_name')}</tbody></table>
      </div>
    </section>

    <section class="two">
      <div class="panel">
        <h2>Pedidos classificados</h2>
        <table><thead><tr><th>Pedido</th><th>Processos</th></tr></thead><tbody>{table_rows(report_data['top_claims'], 'claim_type')}</tbody></table>
      </div>
      <div class="panel">
        <h2>Desfecho aproximado</h2>
        <table><thead><tr><th>Movimento</th><th>Processos</th></tr></thead><tbody>{table_rows(report_data['outcome_proxy'], 'outcome_proxy')}</tbody></table>
      </div>
    </section>

    <section class="panel">
      <h2>Pedido x desfecho aproximado</h2>
      <table>
        <thead><tr><th>Pedido</th><th>Desfecho por movimento</th><th>Processos</th></tr></thead>
        <tbody>{claim_outcome_rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
""",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the general TRT2 MVP from public DataJud metadata.")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--report-path", default=str(DEFAULT_REPORT_PATH))
    parser.add_argument("--max-processes", type=int, default=5000, help="0 means unlimited. Use carefully.")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--sleep", type=float, default=0.25)
    parser.add_argument("--degree", choices=["all", "G1", "G2"], default="all")
    parser.add_argument("--since", default="", help="DataJud YYYYMMDDHHMMSS lower bound for dataAjuizamento.")
    parser.add_argument("--max-retries", type=int, default=3)
    parser.add_argument("--backoff-seconds", type=int, default=60)
    parser.add_argument("--request-timeout", type=int, default=60)
    parser.add_argument("--db-path", default="")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--skip-fetch", action="store_true")
    parser.add_argument("--skip-duckdb", action="store_true")
    parser.add_argument("--skip-report", action="store_true")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    api_key = os.getenv("DATAJUD_API_KEY")
    if not api_key and not args.skip_fetch:
        raise RuntimeError("DATAJUD_API_KEY nao configurada.")

    output_dir = Path(args.output_dir)
    ensure_dir(output_dir / "raw")
    ensure_dir(output_dir / "processed")
    ensure_dir(output_dir / "full_text_inbox")

    fetch_info: dict[str, Any] = {"skipped": True}
    if not args.skip_fetch:
        fetch_info = fetch_datajud_trt2(
            output_dir=output_dir,
            api_key=api_key or "",
            max_processes=args.max_processes,
            page_size=args.page_size,
            sleep_seconds=args.sleep,
            degree=args.degree,
            since=args.since,
            max_retries=args.max_retries,
            backoff_seconds=args.backoff_seconds,
            request_timeout=args.request_timeout,
            reset=args.reset,
        )

    csv_info = transform_raw_to_csv(output_dir)
    duckdb_info: dict[str, Any] = {"skipped": True}
    report_data: dict[str, Any] | None = None
    db_path = Path(args.db_path) if args.db_path else (output_dir / "trt2_mvp.duckdb")
    if not args.skip_duckdb:
        duckdb_info = build_duckdb(output_dir, db_path=db_path)
        if not args.skip_report:
            report_data = query_report_data(Path(duckdb_info["db_path"]))
    run_info = {
        "generated_at": now_iso(),
        "fetch": fetch_info,
        "csv": csv_info,
        "duckdb": duckdb_info,
        "args": vars(args),
    }
    write_json(output_dir / "mvp_run_summary.json", run_info)
    if report_data is not None:
        render_report(Path(args.report_path), output_dir, report_data, run_info)
        run_info["report_path"] = str(Path(args.report_path))
    print(json.dumps(run_info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
