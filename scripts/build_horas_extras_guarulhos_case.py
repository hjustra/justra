from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.collectors.datajud_trt2 import DataJudClient
from src.collectors.pje_trt2 import (
    PJE_TRT2_BASE_URL,
    PjePublicClient,
    format_cnj_number,
    is_captcha_challenge,
    only_digits,
)


COURT_UNIT = "1\u00aa Vara do Trabalho de Guarulhos"
DATAJUD_FROM_DATE = "20240614000000"
TST_JURISPRUDENCE_PDF_URL = "https://www.tst.jus.br/documents/10157/63003/Livro-Internet.pdf"
BASIS_PROBE_URL = "https://basis.trt2.jus.br/server/api/discover/search/objects?query=horas%20extras&size=1"

CLAIM_PHRASES = [
    "Horas Extras",
    "Adicional de Horas Extras",
    "Adicional de Hora Extra",
    "Banco de Horas",
    "Divisor de Horas Extras",
    "Hora Extra",
    "Hora Extra/Intervalo",
    "Hora Extra/Adicional",
    "Hora Noturna/Hora Extra",
    "Horas in Itinere",
    "Supressao/Reducao de Horas Extras",
]

TOPIC_PATTERNS = {
    "horas_extras": [
        r"\bhoras? extras?\b",
        r"\bsobrejornada\b",
        r"servico suplementar",
        r"labor extraordin",
    ],
    "jornada_trabalho": [
        r"jornada de trabalho",
        r"duracao do trabalho",
        r"controle de jornada",
    ],
    "banco_horas_compensacao": [
        r"banco de horas",
        r"compensacao de jornada",
        r"regime compensatorio",
        r"compensacao horaria",
    ],
    "cartao_ponto_onus_prova": [
        r"cart[aã]o de ponto",
        r"cartoes de ponto",
        r"registro de ponto",
        r"controles? de ponto",
        r"onus da prova.{0,80}jornada",
        r"jornada.{0,80}onus da prova",
    ],
    "intervalo_intrajornada": [
        r"intervalo intrajornada",
        r"art\\. 71",
    ],
    "intervalo_interjornada": [
        r"intervalo interjornadas?",
        r"intervalo entre jornadas",
        r"art\\. 66",
    ],
    "reflexos_dsr_fgts": [
        r"horas? extras?.{0,100}repouso",
        r"repouso.{0,100}horas? extras?",
        r"reflexos?.{0,100}horas? extras?",
        r"horas? extras?.{0,100}fgts",
    ],
    "calculo_adicional": [
        r"adicional de horas? extras?",
        r"divisor.{0,80}horas? extras?",
        r"base de calculo.{0,100}horas? extras?",
        r"remuneracao do servico suplementar",
    ],
}

DECISION_MOVEMENT_PATTERNS = [
    "julg",
    "senten",
    "proced",
    "improced",
    "homolog",
    "acordo",
    "extin",
    "merito",
    "decis",
]


def normalize_text(value: str) -> str:
    value = value.replace("\u00ad", "")
    value = value.replace("\x00", "")
    value = re.sub(r"[\u2010-\u2015]", "-", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def normalize_ascii_key(value: str) -> str:
    replacements = {
        "ç": "c",
        "Ç": "C",
        "ã": "a",
        "Ã": "A",
        "á": "a",
        "Á": "A",
        "à": "a",
        "À": "A",
        "â": "a",
        "Â": "A",
        "é": "e",
        "É": "E",
        "ê": "e",
        "Ê": "E",
        "í": "i",
        "Í": "I",
        "ó": "o",
        "Ó": "O",
        "ô": "o",
        "Ô": "O",
        "õ": "o",
        "Õ": "O",
        "ú": "u",
        "Ú": "U",
    }
    for src, dst in replacements.items():
        value = value.replace(src, dst)
    return value


def classify_topics(text: str) -> list[str]:
    lowered = normalize_ascii_key(text).lower()
    topics = []
    for topic, patterns in TOPIC_PATTERNS.items():
        if any(re.search(pattern, lowered) for pattern in patterns):
            topics.append(topic)
    return sorted(topics)


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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


def datajud_query(court_unit: str, from_date: str, page_size: int, offset: int) -> dict[str, Any]:
    should = [{"match_phrase": {"assuntos.nome": phrase}} for phrase in CLAIM_PHRASES]
    return {
        "size": page_size,
        "from": offset,
        "track_total_hits": True,
        "query": {
            "bool": {
                "filter": [
                    {"term": {"orgaoJulgador.nome.keyword": court_unit}},
                    {"range": {"dataAjuizamento": {"gte": from_date}}},
                ],
                "should": should,
                "minimum_should_match": 1,
            }
        },
        "_source": [
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
        ],
        "sort": [{"dataAjuizamento": {"order": "desc"}}],
    }


def fetch_datajud_processes(
    api_key: str,
    court_unit: str,
    from_date: str,
    page_size: int,
    limit: int | None,
    sleep_seconds: float,
) -> list[dict[str, Any]]:
    client = DataJudClient(api_key=api_key, tribunal="trt2")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    offset = 0
    total = None

    while total is None or offset < total:
        query = datajud_query(court_unit, from_date, page_size, offset)
        payload = client.search(query)
        total = int(payload["hits"]["total"]["value"])
        for hit in payload["hits"]["hits"]:
            source = hit.get("_source", {})
            number = only_digits(source.get("numeroProcesso", ""))
            if not number or number in seen:
                continue
            seen.add(number)
            output.append(source)
            if limit and len(output) >= limit:
                return output
        offset += page_size
        if offset >= total:
            break
        time.sleep(sleep_seconds)
    return output


def movement_matches_decision(name: str) -> bool:
    lowered = normalize_ascii_key(name).lower()
    return any(pattern in lowered for pattern in DECISION_MOVEMENT_PATTERNS)


def process_rows(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for record in records:
        number = only_digits(record.get("numeroProcesso", ""))
        movements = flatten_dict_list(record.get("movimentos"))
        subjects = [item.get("nome", "").strip() for item in flatten_dict_list(record.get("assuntos")) if item.get("nome")]
        decision_movements = [
            movement
            for movement in movements
            if movement_matches_decision(movement.get("nome", ""))
        ]
        last_movement_at = ""
        if movements:
            last_movement_at = max((m.get("dataHora", "") for m in movements), default="")
        rows.append(
            {
                "numero_processo": number,
                "numero_processo_formatado": format_cnj_number(number),
                "grau": record.get("grau", ""),
                "classe": (record.get("classe") or {}).get("nome", ""),
                "orgao_julgador": (record.get("orgaoJulgador") or {}).get("nome", ""),
                "data_ajuizamento": record.get("dataAjuizamento", ""),
                "assuntos": "; ".join(subjects),
                "qtd_movimentos": len(movements),
                "qtd_movimentos_decisorios": len(decision_movements),
                "movimentos_decisorios": "; ".join(sorted({m.get("nome", "") for m in decision_movements})),
                "ultimo_movimento": last_movement_at,
                "pje_url": f"{PJE_TRT2_BASE_URL}/consultaprocessual/detalhe-processo/{number}/1",
            }
        )
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    fieldnames = list(rows[0].keys()) if rows else []
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def build_summary(rows: list[dict[str, Any]], raw_records: list[dict[str, Any]]) -> dict[str, Any]:
    subject_counts = Counter()
    class_counts = Counter()
    movement_counts = Counter()
    for record in raw_records:
        class_counts.update([(record.get("classe") or {}).get("nome", "")])
        for subject in flatten_dict_list(record.get("assuntos")):
            name = subject.get("nome", "").strip()
            if name:
                subject_counts.update([name])
        for movement in flatten_dict_list(record.get("movimentos")):
            name = movement.get("nome", "").strip()
            if name and movement_matches_decision(name):
                movement_counts.update([name])

    return {
        "court_unit": COURT_UNIT,
        "claim": "horas_extras",
        "from_date": DATAJUD_FROM_DATE,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "process_count": len(rows),
        "with_decision_like_movements": sum(1 for row in rows if int(row["qtd_movimentos_decisorios"]) > 0),
        "top_subjects": subject_counts.most_common(20),
        "top_classes": class_counts.most_common(10),
        "top_decision_like_movements": movement_counts.most_common(20),
    }


def collect_pje_basic(
    rows: list[dict[str, Any]],
    limit: int,
    sleep_seconds: float,
) -> dict[str, Any]:
    client = PjePublicClient()
    collected = []
    errors = []
    for row in rows[:limit]:
        number = row["numero_processo"]
        try:
            basic = client.get_basic_data(number, instance=1)
            collected.append({"numero_processo": number, "pje_basic": basic})
        except Exception as exc:  # noqa: BLE001
            errors.append({"numero_processo": number, "error": str(exc)})
        time.sleep(sleep_seconds)

    probe = {}
    if collected and collected[0]["pje_basic"]:
        first = collected[0]["pje_basic"][0]
        try:
            details = client.get_details(first["id"], instance=1)
            probe = {
                "numero_processo": collected[0]["numero_processo"],
                "process_id": first["id"],
                "requires_captcha": is_captcha_challenge(details),
                "response_keys": sorted(details.keys()) if isinstance(details, dict) else [],
            }
        except Exception as exc:  # noqa: BLE001
            probe = {
                "numero_processo": collected[0]["numero_processo"],
                "process_id": first.get("id"),
                "error": str(exc),
            }

    return {
        "collected": collected,
        "errors": errors,
        "detail_probe": probe,
        "note": (
            "Dados basicos publicos vieram sem captcha. Detalhes/documentos/integra "
            "podem exigir desafio captcha ou token de terceiro, conforme resposta do PJe."
        ),
    }


def download_file(url: str, path: Path, sleep_seconds: float = 0) -> dict[str, Any]:
    ensure_dir(path.parent)
    if path.exists() and path.stat().st_size > 0:
        return {
            "url": url,
            "path": str(path),
            "status": "cached",
            "bytes": path.stat().st_size,
            "sha256": sha256_file(path),
        }
    response = requests.get(url, timeout=60, headers={"User-Agent": "JustraV0ResearchBot/0.1"})
    response.raise_for_status()
    path.write_bytes(response.content)
    if sleep_seconds:
        time.sleep(sleep_seconds)
    return {
        "url": url,
        "path": str(path),
        "status": "downloaded",
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def parse_tst_pdf(path: Path) -> list[dict[str, Any]]:
    import fitz  # PyMuPDF

    document = fitz.open(path)
    full_text_parts = []
    page_offsets = []
    offset = 0
    for page_index, page in enumerate(document, start=1):
        page_offsets.append((offset, page_index))
        text = page.get_text("text")
        full_text_parts.append(text)
        offset += len(text) + 1
    full_text = "\n".join(full_text_parts).replace("\u00ad", "")
    full_text = re.sub(r"(?<=\w)-\s+(?=\w)", "", full_text)

    entry_re = re.compile(r"\b(?P<kind>SUM|OJ-SDI1T|OJ-SDI1|OJ-SDI2|OJ-SDC|OJ-TP|PN)-\s*(?P<number>\d+)")
    matches = list(entry_re.finditer(full_text))
    entries = []
    seen: set[str] = set()

    def page_for_pos(position: int) -> int:
        current = 1
        for offset_value, page_number in page_offsets:
            if offset_value > position:
                break
            current = page_number
        return current

    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else min(len(full_text), start + 5000)
        raw = full_text[start:end]
        text = normalize_text(raw)
        if len(text) < 60:
            continue
        kind = match.group("kind")
        number = match.group("number")
        entry_id = f"{kind}-{number}"
        # Prefer the first complete occurrence; later index-remissivo occurrences are short.
        if entry_id in seen:
            continue
        seen.add(entry_id)
        header = text[:220]
        lowered = normalize_ascii_key(text).lower()
        header_lowered = normalize_ascii_key(header).lower()
        status = "ativa_a_validar"
        if "cancelada" in header_lowered:
            status = "ultrapassada_cancelada"
        elif (
            "nova redacao" in header_lowered
            or "alterada" in header_lowered
            or "conversao" in header_lowered
            or "incorporada" in header_lowered
            or "inserido" in header_lowered
        ):
            status = "ativa_revisada"
        elif "mantida" in header_lowered:
            status = "ativa_mantida"

        topics = classify_topics(text)

        entries.append(
            {
                "id": entry_id,
                "kind": kind,
                "number": number,
                "title": header,
                "status": status,
                "topics": sorted(topics),
                "page": page_for_pos(start),
                "source": "tst_jurisprudence_pdf",
                "source_url": TST_JURISPRUDENCE_PDF_URL,
                "snippet": text[:520],
                "is_hours_extra_related": bool(topics),
            }
        )
    return entries


def build_knowledge_graph(entries: list[dict[str, Any]], subject_counts: list[list[Any]]) -> dict[str, Any]:
    related = [entry for entry in entries if entry.get("is_hours_extra_related")]
    nodes: list[dict[str, Any]] = [
        {
            "id": "claim:horas_extras",
            "label": "Horas extras",
            "type": "claim",
            "status": "tema_do_caso",
            "weight": 12,
        }
    ]
    edges: list[dict[str, Any]] = []

    subject_weight = defaultdict(int)
    for subject, count in subject_counts:
        for topic in classify_topics(str(subject)):
            subject_weight[topic] += int(count)

    for topic in TOPIC_PATTERNS:
        if any(topic in entry.get("topics", []) for entry in related):
            nodes.append(
                {
                    "id": f"topic:{topic}",
                    "label": topic.replace("_", " "),
                    "type": "topic",
                    "status": "ativo_no_filtro",
                    "weight": max(3, min(10, int(math.log10(subject_weight[topic] + 10) * 3))),
                    "case_subject_count": subject_weight[topic],
                }
            )
            edges.append({"source": "claim:horas_extras", "target": f"topic:{topic}", "relation": "subtema"})

    id_set = {entry["id"] for entry in related}
    for entry in related:
        usage_status = "vigente_a_validar_no_trt2"
        if entry["status"].startswith("ultrapassada"):
            usage_status = "ultrapassada_no_tst_pdf"
        nodes.append(
            {
                "id": entry["id"],
                "label": entry["id"],
                "title": entry["title"],
                "type": "jurisprudence",
                "status": entry["status"],
                "usage_status": usage_status,
                "source_url": entry["source_url"],
                "page": entry["page"],
                "weight": 5 if usage_status.startswith("vigente") else 3,
            }
        )
        for topic in entry["topics"]:
            edges.append({"source": f"topic:{topic}", "target": entry["id"], "relation": "fundamento"})

        text = normalize_ascii_key(entry.get("snippet", "")).lower()
        for cited in sorted(id_set):
            if cited == entry["id"]:
                continue
            kind, number = cited.split("-", 1)
            candidates = [
                cited.lower(),
                f"{kind.lower()} {number}",
                f"{kind.lower()} n {number}",
                f"sumula no {number}" if kind == "SUM" else "",
            ]
            if any(candidate and candidate in text for candidate in candidates):
                edges.append({"source": entry["id"], "target": cited, "relation": "cita"})

    return {"nodes": nodes, "edges": edges}


def probe_basis() -> dict[str, Any]:
    try:
        response = requests.get(
            BASIS_PROBE_URL,
            timeout=20,
            headers={"User-Agent": "JustraV0ResearchBot/0.1"},
        )
        return {
            "url": BASIS_PROBE_URL,
            "status_code": response.status_code,
            "ok": response.ok,
            "content_type": response.headers.get("content-type", ""),
            "blocked": response.status_code in {403, 429},
            "available": response.ok,
            "note": "Probe simples para registrar disponibilidade da fonte publica Basis TRT2.",
        }
    except Exception as exc:  # noqa: BLE001
        return {"url": BASIS_PROBE_URL, "ok": False, "error": str(exc), "blocked": True}


def graph_svg(graph: dict[str, Any]) -> str:
    nodes = graph["nodes"]
    edges = graph["edges"]
    width, height = 1000, 620
    center = (width / 2, height / 2)
    topic_nodes = [node for node in nodes if node["type"] == "topic"]
    jurisprudence_nodes = [node for node in nodes if node["type"] == "jurisprudence"]
    positions: dict[str, tuple[float, float]] = {"claim:horas_extras": center}

    for idx, node in enumerate(topic_nodes):
        angle = 2 * math.pi * idx / max(1, len(topic_nodes)) - math.pi / 2
        positions[node["id"]] = (center[0] + 210 * math.cos(angle), center[1] + 180 * math.sin(angle))

    for idx, node in enumerate(jurisprudence_nodes):
        angle = 2 * math.pi * idx / max(1, len(jurisprudence_nodes)) - math.pi / 2
        positions[node["id"]] = (center[0] + 405 * math.cos(angle), center[1] + 270 * math.sin(angle))

    out = [
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="Grafo de fundamentos de horas extras">',
        "<defs><marker id=\"arrow\" markerWidth=\"7\" markerHeight=\"7\" refX=\"6\" refY=\"3.5\" orient=\"auto\"><path d=\"M0,0 L7,3.5 L0,7 Z\" fill=\"#8b9894\" /></marker></defs>",
    ]
    for edge in edges:
        source = positions.get(edge["source"])
        target = positions.get(edge["target"])
        if not source or not target:
            continue
        out.append(
            f'<line x1="{source[0]:.1f}" y1="{source[1]:.1f}" x2="{target[0]:.1f}" y2="{target[1]:.1f}" '
            'stroke="#c7d0cc" stroke-width="1.2" marker-end="url(#arrow)" />'
        )
    for node in nodes:
        x, y = positions.get(node["id"], center)
        node_type = node["type"]
        status = node.get("usage_status") or node.get("status", "")
        css_class = f"node {node_type} {'old' if 'ultrapassada' in status else 'active'}"
        radius = 18 + min(16, int(node.get("weight", 4)) * 1.2)
        label = html.escape(node.get("label", node["id"]))
        out.append(f'<g class="{css_class}">')
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{radius:.1f}"></circle>')
        out.append(f'<text x="{x:.1f}" y="{y + radius + 14:.1f}" text-anchor="middle">{label}</text>')
        out.append("</g>")
    out.append("</svg>")
    return "\n".join(out)


def render_html_report(
    output_path: Path,
    summary: dict[str, Any],
    rows: list[dict[str, Any]],
    graph: dict[str, Any],
    entries: list[dict[str, Any]],
    pje_payload: dict[str, Any],
    basis_probe: dict[str, Any],
    tst_download: dict[str, Any],
) -> None:
    ensure_dir(output_path.parent)
    active_count = sum(1 for entry in entries if entry.get("is_hours_extra_related") and not entry["status"].startswith("ultrapassada"))
    old_count = sum(1 for entry in entries if entry.get("is_hours_extra_related") and entry["status"].startswith("ultrapassada"))
    decision_count = summary["with_decision_like_movements"]
    latest = rows[:12]
    related_entries = [entry for entry in entries if entry.get("is_hours_extra_related")]

    def table_rows(items: list[tuple[str, int]]) -> str:
        return "\n".join(
            f"<tr><td>{html.escape(str(name))}</td><td>{count}</td></tr>"
            for name, count in items
            if name
        )

    latest_rows = "\n".join(
        "<tr>"
        f"<td><a href=\"{html.escape(row['pje_url'])}\">{html.escape(row['numero_processo_formatado'])}</a></td>"
        f"<td>{html.escape(row['classe'])}</td>"
        f"<td>{html.escape(row['assuntos'][:180])}</td>"
        f"<td>{row['qtd_movimentos_decisorios']}</td>"
        "</tr>"
        for row in latest
    )

    entry_rows = "\n".join(
        "<tr>"
        f"<td>{html.escape(entry['id'])}</td>"
        f"<td>{html.escape(entry['status'])}</td>"
        f"<td>{html.escape(', '.join(entry['topics']))}</td>"
        f"<td>{entry['page']}</td>"
        f"<td>{html.escape(entry['snippet'][:240])}</td>"
        "</tr>"
        for entry in related_entries[:40]
    )

    detail_probe = pje_payload.get("detail_probe") or {}
    pje_status = (
        "exige captcha para detalhes/inteiro teor"
        if detail_probe.get("requires_captcha")
        else "detalhe nao bloqueou no probe" if detail_probe else "nao testado"
    )
    if basis_probe.get("blocked"):
        basis_status = "bloqueado"
    elif not basis_probe.get("ok"):
        basis_status = f"indisponivel_{basis_probe.get('status_code', 'erro')}"
    else:
        basis_status = "disponivel"

    output_path.write_text(
        f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Justra - Caso Horas Extras Guarulhos</title>
  <style>
    :root {{
      --ink: #202a28;
      --muted: #63716d;
      --line: #d8e0dc;
      --page: #f4f6f5;
      --surface: #fff;
      --green: #0b6b5a;
      --blue: #315f86;
      --amber: #8a620f;
      --red: #a64235;
      --shadow: 0 12px 28px rgba(32,42,40,.08);
    }}
    * {{ box-sizing: border-box; }}
    body {{
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--page);
      letter-spacing: 0;
    }}
    header {{
      padding: 26px 32px 18px;
      color: #eef7f4;
      background: #253431;
    }}
    header h1 {{ margin: 0; font-size: 28px; line-height: 1.15; }}
    header p {{ max-width: 980px; margin: 10px 0 0; color: #bfd0cb; line-height: 1.5; }}
    main {{ padding: 24px 32px 40px; }}
    section {{ max-width: 1180px; margin: 0 auto 22px; }}
    .grid {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }}
    .card, .panel {{
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
      box-shadow: var(--shadow);
    }}
    .card {{ padding: 16px; min-height: 100px; }}
    .card span {{ display: block; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }}
    .card strong {{ display: block; margin-top: 8px; font-size: 26px; }}
    .panel {{ padding: 18px; }}
    h2 {{ margin: 0 0 12px; font-size: 18px; }}
    h3 {{ margin: 18px 0 8px; font-size: 15px; }}
    p, li {{ color: var(--muted); line-height: 1.55; }}
    table {{ width: 100%; border-collapse: collapse; font-size: 13px; }}
    th, td {{ padding: 9px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ color: var(--muted); font-size: 12px; text-transform: uppercase; }}
    a {{ color: var(--blue); }}
    .two {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }}
    .status {{ display: flex; gap: 8px; flex-wrap: wrap; }}
    .pill {{ padding: 5px 8px; border-radius: 999px; background: #ecf2ef; color: var(--ink); font-size: 12px; font-weight: 700; }}
    .pill.warn {{ background: #f5ead0; color: var(--amber); }}
    .pill.bad {{ background: #f2dfdc; color: var(--red); }}
    .graph-wrap {{ overflow-x: auto; }}
    svg {{ width: 100%; min-width: 900px; height: auto; background: #fbfcfb; border: 1px solid var(--line); border-radius: 8px; }}
    .node circle {{ fill: #eff5f2; stroke: #7f918b; stroke-width: 1.4; }}
    .node.claim circle {{ fill: #d9eee9; stroke: var(--green); stroke-width: 2; }}
    .node.topic circle {{ fill: #e7eef6; stroke: var(--blue); }}
    .node.jurisprudence.active circle {{ fill: #f7f1df; stroke: var(--amber); }}
    .node.jurisprudence.old circle {{ fill: #f2dfdc; stroke: var(--red); }}
    .node text {{ fill: var(--ink); font-size: 11px; font-weight: 700; }}
    .note {{ padding: 12px; border-left: 4px solid var(--amber); background: #fff8e8; color: #624606; }}
    @media (max-width: 900px) {{
      main, header {{ padding-left: 18px; padding-right: 18px; }}
      .grid, .two {{ grid-template-columns: 1fr; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>Exemplo Justra: horas extras na 1ª VT de Guarulhos</h1>
    <p>Relatorio local gerado com fontes publicas. DataJud monta o funil processual; PJe publico valida dados basicos e indica quando inteiro teor exige captcha; TST fornece o grafo inicial de jurisprudencia trabalhista; Basis/TRT2 fica registrado como fonte bloqueada neste ambiente.</p>
  </header>
  <main>
    <section class="grid">
      <div class="card"><span>Processos candidatos</span><strong>{summary['process_count']}</strong></div>
      <div class="card"><span>Com movimento decisorio</span><strong>{decision_count}</strong></div>
      <div class="card"><span>Fundamentos TST ligados</span><strong>{active_count}</strong></div>
      <div class="card"><span>Cancelados/ultrapassados</span><strong>{old_count}</strong></div>
    </section>

    <section class="panel">
      <h2>Status da coleta</h2>
      <div class="status">
        <span class="pill">DataJud: ok</span>
        <span class="pill warn">PJe: {html.escape(pje_status)}</span>
        <span class="pill {'bad' if basis_status != 'disponivel' else ''}">Basis TRT2: {html.escape(basis_status)}</span>
        <span class="pill">TST PDF: {html.escape(tst_download['status'])}</span>
      </div>
      <p class="note">Importante: este relatorio ainda nao afirma a taxa de procedencia de horas extras, porque isso depende do inteiro teor das sentencas/acordaos. O que ja temos e o funil completo de processos e o mapa de fundamentos a validar contra os textos integrais.</p>
    </section>

    <section class="panel">
      <h2>Grafo de fundamentos</h2>
      <div class="graph-wrap">{graph_svg(graph)}</div>
    </section>

    <section class="two">
      <div class="panel">
        <h2>Top assuntos no funil</h2>
        <table><thead><tr><th>Assunto</th><th>Qtd.</th></tr></thead><tbody>{table_rows(summary['top_subjects'][:12])}</tbody></table>
      </div>
      <div class="panel">
        <h2>Movimentos decisorios</h2>
        <table><thead><tr><th>Movimento</th><th>Qtd.</th></tr></thead><tbody>{table_rows(summary['top_decision_like_movements'][:12])}</tbody></table>
      </div>
    </section>

    <section class="panel">
      <h2>Ultimos processos candidatos</h2>
      <table>
        <thead><tr><th>Processo</th><th>Classe</th><th>Assuntos</th><th>Mov. decisorios</th></tr></thead>
        <tbody>{latest_rows}</tbody>
      </table>
    </section>

    <section class="panel">
      <h2>Jurisprudencia trabalhista ligada a horas extras</h2>
      <table>
        <thead><tr><th>ID</th><th>Status</th><th>Topicos</th><th>Pag.</th><th>Trecho curto</th></tr></thead>
        <tbody>{entry_rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
""",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build a public-source Justra example for horas extras in 1st Labor Court of Guarulhos."
    )
    parser.add_argument("--court-unit", default=COURT_UNIT)
    parser.add_argument("--from-date", default=DATAJUD_FROM_DATE)
    parser.add_argument("--limit", type=int, default=0, help="Optional DataJud limit. 0 means all under 10k window.")
    parser.add_argument("--page-size", type=int, default=500)
    parser.add_argument("--sleep", type=float, default=0.4)
    parser.add_argument("--pje-basic-limit", type=int, default=25)
    parser.add_argument(
        "--output-dir",
        default=str(ROOT / "data" / "cases" / "guarulhos_horas_extras"),
    )
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    api_key = os.getenv("DATAJUD_API_KEY")
    if not api_key:
        raise RuntimeError("DATAJUD_API_KEY nao configurada no ambiente.")

    output_dir = Path(args.output_dir)
    raw_dir = output_dir / "raw"
    processed_dir = output_dir / "processed"
    report_dir = ROOT / "reports"
    ensure_dir(raw_dir)
    ensure_dir(processed_dir)
    ensure_dir(report_dir)

    records_path = raw_dir / "datajud_processes.json"
    if records_path.exists():
        records = read_json(records_path, [])
    else:
        records = fetch_datajud_processes(
            api_key=api_key,
            court_unit=args.court_unit,
            from_date=args.from_date,
            page_size=args.page_size,
            limit=args.limit or None,
            sleep_seconds=args.sleep,
        )
        write_json(records_path, records)

    rows = process_rows(records)
    write_csv(processed_dir / "processes.csv", rows)
    summary = build_summary(rows, records)
    write_json(processed_dir / "summary.json", summary)

    pje_path = raw_dir / "pje_basic_data.json"
    if pje_path.exists():
        pje_payload = read_json(pje_path, {})
    else:
        pje_payload = collect_pje_basic(rows, args.pje_basic_limit, args.sleep)
        write_json(pje_path, pje_payload)

    tst_pdf_path = ROOT / "data" / "raw" / "pdf" / "tst_sumulas_ojs_precedentes.pdf"
    tst_download = download_file(TST_JURISPRUDENCE_PDF_URL, tst_pdf_path, args.sleep)
    write_json(raw_dir / "tst_pdf_download.json", tst_download)

    entries_path = processed_dir / "tst_jurisprudence_entries.json"
    entries = parse_tst_pdf(tst_pdf_path)
    write_json(entries_path, entries)

    graph = build_knowledge_graph(entries, summary["top_subjects"])
    write_json(processed_dir / "knowledge_graph.json", graph)

    basis_probe = probe_basis()
    write_json(raw_dir / "basis_probe.json", basis_probe)

    report_path = report_dir / "guarulhos_horas_extras_case.html"
    render_html_report(
        report_path,
        summary=summary,
        rows=rows,
        graph=graph,
        entries=entries,
        pje_payload=pje_payload,
        basis_probe=basis_probe,
        tst_download=tst_download,
    )

    print(json.dumps(
        {
            "report": str(report_path),
            "process_count": summary["process_count"],
            "with_decision_like_movements": summary["with_decision_like_movements"],
            "pje_detail_probe": pje_payload.get("detail_probe"),
            "basis_probe": basis_probe,
            "graph_nodes": len(graph["nodes"]),
            "graph_edges": len(graph["edges"]),
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
