from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import asdict
from html import unescape
from pathlib import Path
from typing import Any

import fitz
import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from collectors.basis_trt2 import (  # noqa: E402
    BASIS_BASE_URL,
    USER_AGENT,
    BasisDocument,
    document_key,
    make_session,
    merge_records,
    parse_search_results,
)

TST_PDF_URL = "https://www.tst.jus.br/documents/10157/63003/Livro-Internet.pdf"
TST_JURIS_URL = "https://jurisprudencia.tst.jus.br"
TST_JURIS_CONFIG_URL = f"{TST_JURIS_URL}/config.json"
TST_DEFAULT_BACKEND_URL = "https://jurisprudencia-backend2.tst.jus.br"
TST_CONSULTA_ACORDAO_URL = "https://consultadocumento.tst.jus.br/consultaDocumento/acordao.do"
PLANALTO_CLT_URL = "https://www.planalto.gov.br/ccivil_03/decreto-lei/Del5452.htm"
TST_PDF_PATH = ROOT / "data" / "raw" / "pdf" / "tst_sumulas_ojs_precedentes.pdf"
KNOWLEDGE_DIR = ROOT / "data" / "knowledge"
TST_DIR = KNOWLEDGE_DIR / "tst"
TRT2_DIR = KNOWLEDGE_DIR / "trt2_basis"
PLANALTO_DIR = KNOWLEDGE_DIR / "planalto"
STATUS_PATH = KNOWLEDGE_DIR / "knowledge_status.json"
TST_SITE_TYPES = ["SUM", "OJ", "PN"]
TST_SITE_TYPE_LABELS = {
    "SUM": ("sumula", "Súmulas"),
    "OJ": ("orientacao_jurisprudencial", "Orientações Jurisprudenciais"),
    "PN": ("precedente_normativo", "Precedentes Normativos"),
}
TRT2_TARGET_QUERIES = [
    "Jurisprudência trabalhista",
    "jurisprudência",
    "súmula",
    "precedente",
    "doutrina",
    "artigo",
    "revista",
]
TRT2_OAI_URL = f"{BASIS_BASE_URL}/oai/request"
TRT2_OAI_LEGAL_SETS = {
    "col_123456789_7": {
        "collection": "Informativos e Boletins de Jurisprudência",
        "source_layer": "jurisprudencia",
        "kind": "informativo_boletim_jurisprudencia",
    },
    "col_123456789_8": {
        "collection": "JurisConsolidada",
        "source_layer": "jurisprudencia",
        "kind": "jurisconsolidada",
    },
    "col_123456789_9": {
        "collection": "Revista do Tribunal",
        "source_layer": "doutrina",
        "kind": "revista_do_tribunal",
    },
}
TRT2_LEGAL_COLLECTIONS = {
    "123456789/16181": {
        "collection": "Informativos e Boletins de Jurisprudência",
        "source_layer": "jurisprudencia",
        "kind": "informativo_boletim_jurisprudencia",
    },
    "123456789/14018": {
        "collection": "Artigos de Periódicos",
        "source_layer": "doutrina",
        "kind": "artigo_periodico",
    },
    "123456789/14017": {
        "collection": "Periódicos",
        "source_layer": "doutrina",
        "kind": "periodico",
    },
    "123456789/9": {
        "collection": "Revista do Tribunal",
        "source_layer": "doutrina",
        "kind": "revista_do_tribunal",
    },
    "123456789/14016": {
        "collection": "Doutrina",
        "source_layer": "doutrina",
        "kind": "doutrina",
    },
}


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    with path.open("w", encoding="utf-8") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False) + "\n")


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    ensure_dir(path.parent)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fields = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as file:
        writer = csv.DictWriter(file, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def normalize_space(value: str) -> str:
    value = unescape(value or "")
    value = value.replace("\u00ad", "")
    value = value.replace("\x00", "")
    value = re.sub(r"[\u2010-\u2015]", "-", value)
    return re.sub(r"\s+", " ", value).strip()


def normalize_key(value: str) -> str:
    table = str.maketrans(
        {
            "á": "a",
            "à": "a",
            "ã": "a",
            "â": "a",
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
    text = value.translate(table).lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", text)).strip()


def download_tst_pdf(force: bool = False) -> dict[str, Any]:
    ensure_dir(TST_PDF_PATH.parent)
    if TST_PDF_PATH.exists() and not force:
        return {"downloaded": False, "path": str(TST_PDF_PATH), "url": TST_PDF_URL}
    response = requests.get(TST_PDF_URL, headers={"User-Agent": USER_AGENT}, timeout=90)
    response.raise_for_status()
    TST_PDF_PATH.write_bytes(response.content)
    return {"downloaded": True, "path": str(TST_PDF_PATH), "url": TST_PDF_URL}


def tst_kind(code: str) -> str:
    if code.startswith("SUM-"):
        return "sumula"
    if code.startswith("OJ-"):
        return "orientacao_jurisprudencial"
    if code.startswith("PN-"):
        return "precedente_normativo"
    return "jurisprudencia"


def tst_body_title(code: str, chunk: str) -> str:
    lines = [normalize_space(line) for line in chunk.splitlines() if normalize_space(line)]
    if not lines:
        return code
    first = normalize_space(re.sub(rf"^{re.escape(code)}\s*", "", lines[0]))
    if first:
        title = first
    elif len(lines) > 1:
        title = lines[1]
    else:
        title = code
    return title[:240]


def parse_tst_pdf() -> dict[str, Any]:
    download = download_tst_pdf()
    doc = fitz.open(TST_PDF_PATH)
    pages: list[str] = []
    for index, page in enumerate(doc):
        page_no = index + 1
        text = page.get_text()
        if page_no >= 371 and "Índice Remissivo" in text:
            break
        pages.append(text)
    text = "\n".join(pages)
    pattern = re.compile(r"(?m)^(SUM-\d+|OJ-[A-Z0-9/]+-\d+|OJ-SDI1T-\d+|PN-\d+)\s*(.*)$")
    matches = list(pattern.finditer(text))
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, match in enumerate(matches):
        code = match.group(1)
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        chunk = normalize_space(text[start:end])
        if not chunk or code in seen:
            continue
        seen.add(code)
        rows.append(
            {
                "source": "tst",
                "source_layer": "sumulas_oj_precedentes",
                "kind": tst_kind(code),
                "code": code,
                "title": tst_body_title(code, text[start : match.end() + 500]),
                "status": "cancelada" if "cancelad" in normalize_key(chunk[:800]) else "vigente_ou_historica",
                "text": chunk,
                "source_url": TST_PDF_URL,
                "raw_pdf_path": str(TST_PDF_PATH.relative_to(ROOT)),
            }
        )
    rows.sort(key=lambda item: (item["kind"], item["code"]))
    jsonl_path = TST_DIR / "tst_sumulas_oj_precedentes.jsonl"
    csv_path = TST_DIR / "tst_sumulas_oj_precedentes.csv"
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {key: value for key, value in row.items() if key != "text"}
            for row in rows
        ],
    )
    counts = Counter(row["kind"] for row in rows)
    status_counts = Counter(row["status"] for row in rows)
    summary = {
        "source": "tst",
        "source_url": TST_PDF_URL,
        "download": download,
        "items": len(rows),
        "by_kind": dict(counts),
        "by_status": dict(status_counts),
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
    }
    write_json(TST_DIR / "summary_pdf.json", summary)
    return summary


def tst_site_config(session: requests.Session) -> dict[str, Any]:
    response = session.get(TST_JURIS_CONFIG_URL, headers={"User-Agent": USER_AGENT}, timeout=30)
    response.raise_for_status()
    return response.json()


def tst_site_payload(tipo: str) -> dict[str, Any]:
    return {
        "ou": "",
        "e": "",
        "termoExato": "",
        "naoContem": "",
        "ementa": "",
        "dispositivo": "",
        "numeracaoUnica": {"numero": "", "ano": "", "digito": "", "orgao": "5", "tribunal": "", "vara": ""},
        "orgaosJudicantes": [],
        "ministros": [],
        "convocados": [],
        "classesProcessuais": [],
        "indicadores": [],
        "assuntos": [],
        "tipos": [tipo],
        "orgao": "TST",
        "publicacaoInicial": "",
        "publicacaoFinal": "",
        "julgamentoInicial": "",
        "julgamentoFinal": "",
        "ordenacao": "numero",
    }


def tst_site_source_url(tipo: str) -> str:
    return f"{TST_JURIS_URL}/?tipoJuris={tipo}&orgao=TST&pesquisar=1"


def tst_site_code(tipo: str, record: dict[str, Any]) -> str:
    numero = record.get("numero")
    if numero is None:
        return tipo
    return f"{tipo}-{numero}"


def flatten_tst_precedents(record: dict[str, Any]) -> list[dict[str, Any]]:
    precedents = []
    for item in record.get("precedentes") or []:
        acordao = item.get("acordao") or {}
        relator = item.get("relator") or {}
        orgao = item.get("orgaoJudicante") or {}
        precedents.append(
            {
                "numeracao": item.get("numeracao", ""),
                "relator": relator.get("nome", ""),
                "orgao_judicante": orgao.get("descricao", ""),
                "data_publicacao": item.get("dtaPublicacao") or acordao.get("dtaPubl", ""),
                "num_int_acordao": acordao.get("numIntAcordao", ""),
            }
        )
    return precedents


def parse_tst_site_record(tipo: str, wrapper: dict[str, Any]) -> dict[str, Any]:
    record = wrapper.get("registro") or wrapper
    kind, label = TST_SITE_TYPE_LABELS.get(tipo, ("jurisprudencia", tipo))
    code = tst_site_code(tipo, record)
    situacao = record.get("situacao") or {}
    title = normalize_space(record.get("titulo") or code)
    text = normalize_space(record.get("textoPesquisavel") or record.get("tese") or "")
    observation = normalize_space(record.get("observacao") or "")
    history = normalize_space(record.get("historico") or "")
    status_description = normalize_space(situacao.get("descricao") or "")
    return {
        "key": f"tst_site:{tipo}:{record.get('id') or record.get('numero') or code}",
        "source": "tst",
        "source_layer": "jurisprudencia_tst_site",
        "kind": kind,
        "type_code": tipo,
        "type_label": label,
        "code": code,
        "number": record.get("numero"),
        "title": title,
        "status": "cancelada" if "cancelad" in normalize_key(" ".join([status_description, observation, text[:500]])) else "vigente_ou_historica",
        "status_description": status_description,
        "text": text,
        "observation": observation,
        "history": history,
        "publication_date": record.get("dtaPublicacao") or record.get("dataUltimaPublicacao") or "",
        "updated_at_source": record.get("dtaAtualizacao") or "",
        "source_url": tst_site_source_url(tipo),
        "source_api_url": TST_DEFAULT_BACKEND_URL,
        "precedents_count": len(record.get("precedentes") or []),
        "precedents": flatten_tst_precedents(record),
    }


def collect_tst_jurisprudencia_site(types: list[str], sleep_seconds: float = 0.5) -> dict[str, Any]:
    ensure_dir(TST_DIR)
    jsonl_path = TST_DIR / "tst_jurisprudencia_site.jsonl"
    csv_path = TST_DIR / "tst_jurisprudencia_site.csv"
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Origin": TST_JURIS_URL,
            "Referer": f"{TST_JURIS_URL}/",
            "Content-Type": "application/json",
        }
    )
    config = tst_site_config(session)
    backend_url = config.get("base_url") or TST_DEFAULT_BACKEND_URL
    rows: list[dict[str, Any]] = []
    reported_totals: dict[str, int] = {}
    for tipo in types:
        endpoint = f"{backend_url}/rest/pesquisa-textual/1/1000"
        response = session.post(endpoint, params={"a": str(time.time())}, json=tst_site_payload(tipo), timeout=90)
        response.raise_for_status()
        payload = response.json()
        reported_totals[tipo] = int(payload.get("totalRegistros") or 0)
        for wrapper in payload.get("registros") or []:
            row = parse_tst_site_record(tipo, wrapper)
            row["source_api_url"] = endpoint
            rows.append(row)
        time.sleep(sleep_seconds)
    rows.sort(key=lambda item: (item.get("type_code") or "", int(item.get("number") or 0), item.get("code") or ""))
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {key: value for key, value in row.items() if key not in {"text", "precedents"}}
            for row in rows
        ],
    )
    counts = Counter(row["kind"] for row in rows)
    status_counts = Counter(row["status"] for row in rows)
    summary = {
        "source": "tst",
        "mode": "jurisprudencia_site",
        "source_url": TST_JURIS_URL,
        "config_url": TST_JURIS_CONFIG_URL,
        "backend_url": backend_url,
        "types": types,
        "reported_totals": reported_totals,
        "items": len(rows),
        "by_kind": dict(counts),
        "by_status": dict(status_counts),
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
    }
    write_json(TST_DIR / "summary_site.json", summary)
    return summary


def html_to_text(html: str) -> str:
    if not html:
        return ""
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return normalize_space(soup.get_text(" "))


def process_number_from_tst(record: dict[str, Any]) -> str:
    numbering = record.get("numeracaoUnica") or {}
    required = ["numero", "digito", "ano", "orgao", "tribunal", "vara"]
    if not all(numbering.get(key) not in {None, ""} for key in required):
        return ""
    return (
        f"{int(numbering['numero']):07d}-"
        f"{int(numbering['digito']):02d}."
        f"{int(numbering['ano']):04d}."
        f"{int(numbering['orgao']):01d}."
        f"{int(numbering['tribunal']):02d}."
        f"{int(numbering['vara']):04d}"
    )


def first_string(record: dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return normalize_space(value)
    return ""


def nested_name(value: Any) -> str:
    if isinstance(value, dict):
        return normalize_space(value.get("nome") or value.get("descricao") or value.get("sigla") or "")
    return normalize_space(str(value or ""))


def relator_from_text(text: str) -> str:
    clean = normalize_space(text)
    matches = re.findall(r"([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-ZÁÉÍÓÚÂÊÔÃÕÇ\s.'-]{4,80})\s+Ministr[ao]\s+Relator[ao]", clean)
    if not matches:
        return ""
    return normalize_space(matches[-1]).title()


def tst_acordao_payload() -> dict[str, Any]:
    return {
        "ou": "",
        "e": "",
        "termoExato": "",
        "naoContem": "",
        "ementa": "",
        "dispositivo": "",
        "numeracaoUnica": {"numero": "", "ano": "", "digito": "", "orgao": "5", "tribunal": "", "vara": ""},
        "orgaosJudicantes": [],
        "ministros": [],
        "convocados": [],
        "classesProcessuais": [],
        "indicadores": [],
        "assuntos": [],
        "tipos": ["ACORDAO"],
        "orgao": "TST",
        "publicacaoInicial": "",
        "publicacaoFinal": "",
        "julgamentoInicial": "",
        "julgamentoFinal": "",
        "ordenacao": "data",
    }


def tst_acordao_source_url() -> str:
    return f"{TST_JURIS_URL}/?tipoJuris=ACORDAO&orgao=TST&pesquisar=1&ordenacao=data"


def parse_tst_acordao_record(wrapper: dict[str, Any], raw_html_dir: Path) -> dict[str, Any]:
    record = wrapper.get("registro") or wrapper
    process_number = process_number_from_tst(record)
    num_proc_documento = str(record.get("numProcDocumento") or "")
    num_int_acordao = str(record.get("numIntAcordao") or record.get("numIntDocumento") or "")
    key_suffix = num_int_acordao or num_proc_documento or process_number or str(abs(hash(json.dumps(record, sort_keys=True, default=str))))
    key = f"tst_acordao:{key_suffix}"
    html = first_string(record, "inteiroTeorHTMLHighlight", "inteiroTeorHtml", "inteiroTeor")
    ementa_html = first_string(record, "txtEmentaHighlight", "txtEmenta")
    text = html_to_text(html or ementa_html)
    ementa = html_to_text(ementa_html)
    raw_html_path = ""
    if html:
        ensure_dir(raw_html_dir)
        file_name = re.sub(r"[^a-zA-Z0-9_.-]+", "_", key_suffix)[:120] + ".html"
        html_path = raw_html_dir / file_name
        html_path.write_text(html, encoding="utf-8")
        raw_html_path = str(html_path.relative_to(ROOT))
    relator = nested_name(record.get("relator") or record.get("ministro") or record.get("relatorProcesso")) or relator_from_text(text)
    orgao = nested_name(record.get("orgaoJudicante"))
    subjects = [
        normalize_space(item.get("desTemaProc") or item.get("sigTemaProc") or "")
        for item in record.get("temaProcs") or []
        if isinstance(item, dict)
    ]
    title_seed = ementa or text
    title = make_title_from_text(title_seed, process_number or key_suffix)
    return {
        "key": key,
        "source": "tst",
        "source_layer": "tst_acordaos",
        "kind": "acordao",
        "code": process_number or key_suffix,
        "title": title,
        "process_number": process_number,
        "court_unit": orgao,
        "reporting_judge": relator,
        "publication_date": first_string(record, "dtaPublicacao", "dtaPubl", "dataPublicacao"),
        "judgment_date": first_string(record, "dtaJulgamento", "dataJulgamento"),
        "case_class": nested_name(record.get("classeProcessual")),
        "subjects": subjects,
        "source_url": tst_acordao_source_url(),
        "document_url": TST_CONSULTA_ACORDAO_URL,
        "source_api_url": TST_DEFAULT_BACKEND_URL,
        "raw_html_path": raw_html_path,
        "num_proc_documento": num_proc_documento,
        "num_int_acordao": num_int_acordao,
        "dispositivo": normalize_space(record.get("dispositivo") or ""),
        "summary": ementa[:3000],
        "text": text,
        "text_length": len(text),
        "metadata": {
            "indicadores": record.get("indicadores") or [],
            "temaProcs": record.get("temaProcs") or [],
            "numeracaoUnica": record.get("numeracaoUnica") or {},
        },
    }


def make_title_from_text(text: str, fallback: str) -> str:
    clean = normalize_space(text)
    if not clean:
        return f"Acórdão TST {fallback}".strip()
    clean = re.sub(r"^A C Ó R D Ã O\s+", "", clean, flags=re.I)
    return clean[:220]


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def collect_tst_acordaos_recentes(limit: int, page_size: int, sleep_seconds: float, reset: bool = False) -> dict[str, Any]:
    ensure_dir(TST_DIR)
    jsonl_path = TST_DIR / "tst_acordaos_recentes.jsonl"
    csv_path = TST_DIR / "tst_acordaos_recentes.csv"
    checkpoint_path = TST_DIR / "tst_acordaos_checkpoint.json"
    raw_html_dir = ROOT / "data" / "raw" / "html" / "tst_acordaos"
    if reset:
        jsonl_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
        checkpoint_path.unlink(missing_ok=True)
    existing_rows = load_jsonl(jsonl_path)
    by_key = {row["key"]: row for row in existing_rows if row.get("key")}
    checkpoint = read_json(checkpoint_path, {"next_start": 1, "reported_total": None})
    start = int(checkpoint.get("next_start") or 1)
    reported_total = checkpoint.get("reported_total")
    fetched_this_run = 0
    pages_this_run = 0
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Origin": TST_JURIS_URL,
            "Referer": f"{TST_JURIS_URL}/",
            "Content-Type": "application/json",
        }
    )
    config = tst_site_config(session)
    backend_url = config.get("base_url") or TST_DEFAULT_BACKEND_URL
    endpoint_base = f"{backend_url}/rest/pesquisa-textual"
    while True:
        if limit and fetched_this_run >= limit:
            break
        current_size = min(page_size, max(limit - fetched_this_run, 1)) if limit else page_size
        endpoint = f"{endpoint_base}/{start}/{current_size}"
        response = session.post(endpoint, params={"a": str(time.time())}, json=tst_acordao_payload(), timeout=120)
        response.raise_for_status()
        payload = response.json()
        reported_total = int(payload.get("totalRegistros") or reported_total or 0)
        wrappers = payload.get("registros") or []
        if not wrappers:
            break
        for wrapper in wrappers:
            row = parse_tst_acordao_record(wrapper, raw_html_dir)
            row["source_api_url"] = endpoint
            if row["key"] in by_key:
                continue
            by_key[row["key"]] = row
            fetched_this_run += 1
            if limit and fetched_this_run >= limit:
                break
        pages_this_run += 1
        start += current_size
        write_json(
            checkpoint_path,
            {
                "next_start": start,
                "page_size": page_size,
                "reported_total": reported_total,
                "seen_count": len(by_key),
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            },
        )
        if reported_total and start > reported_total:
            break
        time.sleep(sleep_seconds)
    rows = sorted(
        by_key.values(),
        key=lambda item: (item.get("publication_date") or "", item.get("judgment_date") or "", item.get("key") or ""),
        reverse=True,
    )
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {key: value for key, value in row.items() if key not in {"text", "summary", "metadata", "subjects"}}
            | {"subjects": "; ".join(row.get("subjects") or [])}
            for row in rows
        ],
    )
    summary = {
        "source": "tst",
        "mode": "acordaos_recentes",
        "source_url": tst_acordao_source_url(),
        "backend_url": backend_url,
        "items": len(rows),
        "reported_total": reported_total,
        "fetched_this_run": fetched_this_run,
        "pages_this_run": pages_this_run,
        "next_start": start,
        "complete": bool(reported_total and len(rows) >= reported_total),
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
        "checkpoint_path": str(checkpoint_path.relative_to(ROOT)),
        "raw_html_dir": str(raw_html_dir.relative_to(ROOT)),
        "notes": [
            "Coleta incremental por blocos, ordenada por data no backend público do TST.",
            "O retorno público já contém inteiro teor HTML; endpoint de exportação PDF em lote ainda fica como camada opcional.",
        ],
    }
    write_json(TST_DIR / "summary_acordaos.json", summary)
    return summary


def collect_planalto_clt() -> dict[str, Any]:
    ensure_dir(PLANALTO_DIR)
    raw_path = ROOT / "data" / "raw" / "html" / "planalto_clt_del5452.html"
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    response = session.get(PLANALTO_CLT_URL, timeout=90)
    response.raise_for_status()
    html = response.content.decode("windows-1252", errors="replace")
    ensure_dir(raw_path.parent)
    raw_path.write_text(html, encoding="utf-8")
    soup = BeautifulSoup(html, "html.parser")
    rows: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    in_clt_body = False
    for tag in soup.find_all(["p", "li"]):
        text = normalize_space(tag.get_text(" "))
        if not text:
            continue
        if not in_clt_body:
            if "consolidacao das leis do trabalho" in normalize_key(text):
                in_clt_body = True
            continue
        match = re.search(r"^\s*(?:[^\wÀ-ÿ]{0,12})?Art\.?\s*(\d{1,4})(?:\s*[-º°o]\s*([A-Z]))?", text, flags=re.I)
        if match:
            if current:
                rows.append(current)
            article = match.group(1)
            suffix = match.group(2) or ""
            anchor = ""
            anchor_node = tag.find("a", attrs={"name": re.compile(rf"^art{article}", re.I)})
            if anchor_node and anchor_node.get("name"):
                anchor = str(anchor_node["name"])
            code = f"art{article}{suffix.lower()}"
            current = {
                "key": f"planalto_clt:{code}:{anchor or len(rows)}",
                "source": "planalto",
                "source_layer": "clt",
                "kind": "lei",
                "code": f"CLT Art. {article}{('-' + suffix) if suffix else ''}",
                "title": f"CLT Art. {article}{('-' + suffix) if suffix else ''}",
                "status": "vigente_ou_historica",
                "publication_date": "1943-05-01",
                "source_url": f"{PLANALTO_CLT_URL}#{anchor}" if anchor else PLANALTO_CLT_URL,
                "raw_html_path": str(raw_path.relative_to(ROOT)),
                "text": text,
            }
        elif current:
            combined = normalize_space(f"{current['text']} {text}")
            current["text"] = combined[:12000]
    if current:
        rows.append(current)
    jsonl_path = PLANALTO_DIR / "clt_artigos.jsonl"
    csv_path = PLANALTO_DIR / "clt_artigos.csv"
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {key: value for key, value in row.items() if key != "text"}
            | {"snippet": row.get("text", "")[:500]}
            for row in rows
        ],
    )
    summary = {
        "source": "planalto",
        "mode": "clt_artigos",
        "source_url": PLANALTO_CLT_URL,
        "items": len(rows),
        "by_kind": {"lei": len(rows)},
        "complete": True,
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
        "raw_html_path": str(raw_path.relative_to(ROOT)),
    }
    write_json(PLANALTO_DIR / "summary_clt.json", summary)
    return summary


def combine_tst_summaries(
    pdf_summary: dict[str, Any] | None,
    site_summary: dict[str, Any] | None,
    acordaos_summary: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if pdf_summary is None:
        pdf_summary = read_json(TST_DIR / "summary_pdf.json", None)
    if site_summary is None:
        site_summary = read_json(TST_DIR / "summary_site.json", None)
    if acordaos_summary is None:
        acordaos_summary = read_json(TST_DIR / "summary_acordaos.json", None)
    if not pdf_summary and not site_summary and not acordaos_summary:
        return None
    authoritative = site_summary or pdf_summary or {}
    by_kind = dict(authoritative.get("by_kind", {}))
    if acordaos_summary:
        by_kind["acordao"] = acordaos_summary.get("items", 0)
    combined = {
        "source": "tst",
        "source_url": authoritative.get("source_url") or TST_JURIS_URL,
        "items": int(authoritative.get("items", 0) or 0) + int((acordaos_summary or {}).get("items", 0) or 0),
        "by_kind": by_kind,
        "by_status": authoritative.get("by_status", {}),
        "current_site": site_summary,
        "pdf_snapshot": pdf_summary,
        "acordaos": acordaos_summary,
        "notes": [
            "A fonte dinâmica do TST é priorizada quando disponível.",
            "O PDF oficial pode ficar defasado em relação à tela atual de pesquisa.",
            "Acórdãos recentes são coletados incrementalmente da pesquisa pública do TST.",
        ],
    }
    write_json(TST_DIR / "summary.json", combined)
    return combined


def classify_trt2_basis(record: BasisDocument) -> str:
    haystack = normalize_key(
        " ".join(
            [
                record.title or "",
                record.document_type or "",
                record.metadata.get("raw_info_text", "") if record.metadata else "",
                record.metadata.get("abstract", "") if record.metadata else "",
            ]
        )
    )
    if any(term in haystack for term in ["jurisprudencia", "acordao", "sumula", "precedente"]):
        return "jurisprudencia"
    if any(term in haystack for term in ["doutrina", "artigo", "revista", "monografia", "tese", "dissertacao", "livro"]):
        return "doutrina"
    if any(term in haystack for term in ["ato ", "portaria", "resolucao", "provimento", "edital", "ordem de servico"]):
        return "ato_normativo"
    return "repositorio_institucional"


def basis_discover_url(page: int, rpp: int) -> str:
    return f"{BASIS_BASE_URL}/discover?rpp={rpp}&etal=0&group_by=none&page={page}"


def parse_total_items(html: str) -> int | None:
    match = re.search(r"Mostrando os itens\s+\d+\s+a\s+\d+\s+de\s+(\d+)", html)
    return int(match.group(1)) if match else None


def load_basis_rows(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def collect_trt2_basis_all(max_pages: int, rpp: int, sleep_seconds: float, reset: bool = False) -> dict[str, Any]:
    ensure_dir(TRT2_DIR)
    jsonl_path = TRT2_DIR / "trt2_basis_items.jsonl"
    csv_path = TRT2_DIR / "trt2_basis_items.csv"
    checkpoint_path = TRT2_DIR / "checkpoint.json"
    if reset:
        jsonl_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
        checkpoint_path.unlink(missing_ok=True)

    existing_rows = load_basis_rows(jsonl_path)
    seen = {row["key"] for row in existing_rows if row.get("key")}
    checkpoint = read_json(checkpoint_path, {"next_page": 1, "reported_total": None})
    next_page = int(checkpoint.get("next_page") or 1)
    session = make_session()
    fetched_this_run = 0
    pages_this_run = 0
    reported_total = checkpoint.get("reported_total")
    source_exhausted = False

    with jsonl_path.open("a", encoding="utf-8") as file:
        page = next_page
        while True:
            if max_pages and pages_this_run >= max_pages:
                break
            url = basis_discover_url(page, rpp)
            response = session.get(url, timeout=45)
            response.raise_for_status()
            page_total = parse_total_items(response.text)
            reported_total = page_total or reported_total
            records = parse_search_results(response.text, response.url, BASIS_BASE_URL)
            if not records:
                source_exhausted = True
                break
            for record in records:
                key = document_key(record.url, record.pdf_url, record.title)
                if key in seen:
                    continue
                seen.add(key)
                layer = classify_trt2_basis(record)
                row = {
                    "key": key,
                    "source": "trt2_basis",
                    "source_layer": layer,
                    "title": record.title,
                    "document_type": record.document_type,
                    "date": record.date,
                    "url": record.url,
                    "pdf_url": record.pdf_url,
                    "metadata": record.metadata,
                }
                file.write(json.dumps(row, ensure_ascii=False) + "\n")
                existing_rows.append(row)
                fetched_this_run += 1
            pages_this_run += 1
            page += 1
            write_json(
                checkpoint_path,
                {
                    "next_page": page,
                    "reported_total": reported_total,
                    "seen_count": len(seen),
                    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "rpp": rpp,
                },
            )
            if reported_total and len(seen) >= int(reported_total):
                break
            time.sleep(sleep_seconds)

    counts = Counter(row.get("source_layer", "outros") for row in existing_rows)
    write_csv(
        csv_path,
        [
            {
                "key": row.get("key", ""),
                "source": row.get("source", ""),
                "source_layer": row.get("source_layer", ""),
                "title": row.get("title", ""),
                "document_type": row.get("document_type", ""),
                "date": row.get("date", ""),
                "url": row.get("url", ""),
                "pdf_url": row.get("pdf_url", ""),
            }
            for row in existing_rows
        ],
    )
    summary = {
        "source": "trt2_basis",
        "source_url": BASIS_BASE_URL,
        "items": len(existing_rows),
        "reported_total": reported_total,
        "reported_total_minus_unique_items": max(int(reported_total or 0) - len(existing_rows), 0),
        "fetched_this_run": fetched_this_run,
        "pages_this_run": pages_this_run,
        "by_layer": dict(counts),
        "source_exhausted": source_exhausted,
        "complete": bool(source_exhausted or (reported_total and len(seen) >= int(reported_total))),
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
        "checkpoint_path": str(checkpoint_path.relative_to(ROOT)),
    }
    write_json(TRT2_DIR / "summary.json", summary)
    return summary


def opensearch_url(query: str, rpp: int, start: int) -> str:
    return f"{BASIS_BASE_URL}/open-search/discover"


def parse_opensearch_entries(xml_text: str, query: str) -> tuple[int, list[dict[str, Any]]]:
    ns = {
        "atom": "http://www.w3.org/2005/Atom",
        "opensearch": "http://a9.com/-/spec/opensearch/1.1/",
        "dc": "http://purl.org/dc/elements/1.1/",
    }
    root = ET.fromstring(xml_text)
    total_node = root.find("opensearch:totalResults", ns)
    total = int(total_node.text or "0") if total_node is not None else 0
    rows: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", ns):
        title = normalize_space(entry.findtext("atom:title", default="", namespaces=ns))
        link_node = entry.find("atom:link", ns)
        url = link_node.get("href", "") if link_node is not None else ""
        author = normalize_space(entry.findtext("atom:author/atom:name", default="", namespaces=ns))
        published = normalize_space(entry.findtext("atom:published", default="", namespaces=ns))[:10]
        updated = normalize_space(entry.findtext("atom:updated", default="", namespaces=ns))
        summary = normalize_space(entry.findtext("atom:summary", default="", namespaces=ns))
        fake_record = BasisDocument(title=title, url=url, date=published, metadata={"abstract": summary})
        layer = classify_trt2_basis(fake_record)
        key = document_key(url, "", title)
        rows.append(
            {
                "key": key,
                "source": "trt2_basis",
                "source_layer": layer,
                "query": query,
                "title": title,
                "author": author,
                "date": published,
                "updated": updated,
                "url": url,
                "summary": summary,
            }
        )
    return total, rows


def collect_trt2_basis_targets(queries: list[str], rpp: int, sleep_seconds: float, reset: bool = False) -> dict[str, Any]:
    ensure_dir(TRT2_DIR)
    jsonl_path = TRT2_DIR / "trt2_basis_target_items.jsonl"
    csv_path = TRT2_DIR / "trt2_basis_target_items.csv"
    if reset:
        jsonl_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
    existing = load_basis_rows(jsonl_path)
    by_key = {row["key"]: row for row in existing if row.get("key")}
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})
    query_totals: dict[str, int] = {}
    fetched_this_run = 0
    for query in queries:
        start = 0
        total = None
        while total is None or start < total:
            response = session.get(
                opensearch_url(query, rpp, start),
                params={"query": query, "format": "atom", "rpp": rpp, "start": start},
                timeout=45,
            )
            response.raise_for_status()
            total, rows = parse_opensearch_entries(response.text, query)
            query_totals[query] = total
            if not rows:
                break
            for row in rows:
                if row["key"] in by_key:
                    previous = by_key[row["key"]]
                    queries_seen = set(previous.get("queries", []))
                    queries_seen.add(query)
                    previous["queries"] = sorted(queries_seen)
                    continue
                row["queries"] = [query]
                by_key[row["key"]] = row
                fetched_this_run += 1
            start += rpp
            time.sleep(sleep_seconds)
    rows = sorted(by_key.values(), key=lambda item: (item.get("date") or "", item.get("title") or ""), reverse=True)
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {key: value for key, value in row.items() if key not in {"summary", "queries"}}
            | {"queries": "; ".join(row.get("queries", []))}
            for row in rows
        ],
    )
    counts = Counter(row.get("source_layer", "outros") for row in rows)
    summary = {
        "source": "trt2_basis",
        "mode": "targeted_opensearch",
        "source_url": BASIS_BASE_URL,
        "queries": queries,
        "query_totals": query_totals,
        "items": len(rows),
        "fetched_this_run": fetched_this_run,
        "by_layer": dict(counts),
        "complete": True,
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
    }
    write_json(TRT2_DIR / "summary_targets.json", summary)
    return summary


def oai_text_values(record: ET.Element, field_name: str) -> list[str]:
    values: list[str] = []
    for element in record.iter():
        if element.tag.endswith(f"}}{field_name}") and element.text:
            value = normalize_space(element.text)
            if value:
                values.append(value)
    return values


def oai_first(record: ET.Element, field_name: str) -> str:
    values = oai_text_values(record, field_name)
    return values[0] if values else ""


def trt2_oai_record_key(record: ET.Element, identifiers: list[str], title: str) -> str:
    for value in identifiers:
        match = re.search(r"(?:handle/|oai:[^:]+:)(123456789/\d+)", value)
        if match:
            return f"handle:{match.group(1)}"
    header_identifier = oai_first(record, "identifier")
    if header_identifier:
        match = re.search(r"(123456789/\d+)", header_identifier)
        if match:
            return f"handle:{match.group(1)}"
    return document_key("", "", title)


def trt2_oai_urls(identifiers: list[str], key: str) -> tuple[str, str]:
    source_url = ""
    pdf_url = ""
    for value in identifiers:
        if "/bitstream/" in value or value.lower().endswith(".pdf"):
            pdf_url = pdf_url or value
        if "/handle/" in value:
            source_url = source_url or value
    if not source_url and key.startswith("handle:"):
        source_url = f"{BASIS_BASE_URL}/handle/{key.removeprefix('handle:')}"
    return source_url, pdf_url


def parse_trt2_oai_records(xml_text: str, set_spec: str) -> tuple[list[dict[str, Any]], str]:
    ns = {"oai": "http://www.openarchives.org/OAI/2.0/"}
    root = ET.fromstring(xml_text)
    config = TRT2_OAI_LEGAL_SETS[set_spec]
    rows: list[dict[str, Any]] = []
    for record in root.findall(".//oai:record", ns):
        header = record.find("oai:header", ns)
        if header is not None and header.get("status") == "deleted":
            continue
        titles = oai_text_values(record, "title")
        title = titles[0] if titles else ""
        identifiers = oai_text_values(record, "identifier")
        key = trt2_oai_record_key(record, identifiers, title)
        source_url, pdf_url = trt2_oai_urls(identifiers, key)
        descriptions = oai_text_values(record, "description")
        subjects = oai_text_values(record, "subject")
        creators = oai_text_values(record, "creator")
        contributors = oai_text_values(record, "contributor")
        dates = oai_text_values(record, "date")
        types = oai_text_values(record, "type")
        text = " ".join([*titles, *descriptions, *subjects])
        rows.append(
            {
                "key": key,
                "source": "trt2_basis",
                "source_layer": config["source_layer"],
                "kind": config["kind"],
                "collection": config["collection"],
                "set_spec": set_spec,
                "title": title,
                "date": dates[0][:10] if dates else "",
                "document_type": "; ".join(types),
                "author": "; ".join(creators or contributors),
                "subjects": subjects,
                "summary": " ".join(descriptions),
                "text": text,
                "url": source_url,
                "source_url": source_url,
                "pdf_url": pdf_url,
                "identifiers": identifiers,
            }
        )
    token_node = root.find(".//oai:resumptionToken", ns)
    token = normalize_space(token_node.text or "") if token_node is not None else ""
    return rows, token


def collect_trt2_oai_legal(sleep_seconds: float, reset: bool = False) -> dict[str, Any]:
    ensure_dir(TRT2_DIR)
    jsonl_path = TRT2_DIR / "trt2_oai_legal_items.jsonl"
    csv_path = TRT2_DIR / "trt2_oai_legal_items.csv"
    if reset:
        jsonl_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
    session = make_session()
    by_key: dict[str, dict[str, Any]] = {}
    pages = 0
    for set_spec in TRT2_OAI_LEGAL_SETS:
        token = ""
        while True:
            params = (
                {"verb": "ListRecords", "resumptionToken": token}
                if token
                else {"verb": "ListRecords", "metadataPrefix": "oai_dc", "set": set_spec}
            )
            response = session.get(TRT2_OAI_URL, params=params, timeout=60)
            response.raise_for_status()
            rows, token = parse_trt2_oai_records(response.text, set_spec)
            pages += 1
            for row in rows:
                by_key[row["key"]] = row
            if not token:
                break
            time.sleep(sleep_seconds)
        time.sleep(sleep_seconds)
    rows = sorted(by_key.values(), key=lambda item: (item.get("date") or "", item.get("title") or ""), reverse=True)
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {
                "key": row.get("key", ""),
                "source": row.get("source", ""),
                "source_layer": row.get("source_layer", ""),
                "kind": row.get("kind", ""),
                "collection": row.get("collection", ""),
                "title": row.get("title", ""),
                "date": row.get("date", ""),
                "document_type": row.get("document_type", ""),
                "author": row.get("author", ""),
                "url": row.get("url", ""),
                "pdf_url": row.get("pdf_url", ""),
                "subjects": "; ".join(row.get("subjects") or []),
            }
            for row in rows
        ],
    )
    counts = Counter(row.get("source_layer", "outros") for row in rows)
    collections = Counter(row.get("collection", "outros") for row in rows)
    summary = {
        "source": "trt2_basis",
        "mode": "oai_legal_sets",
        "source_url": TRT2_OAI_URL,
        "sets": TRT2_OAI_LEGAL_SETS,
        "items": len(rows),
        "by_layer": dict(counts),
        "by_collection": dict(collections),
        "pages": pages,
        "complete": True,
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
    }
    write_json(TRT2_DIR / "summary_oai_legal.json", summary)
    return summary


def trt2_collection_discover_url(handle: str, page: int, rpp: int) -> str:
    return f"{BASIS_BASE_URL}/handle/{handle}/discover?rpp={rpp}&etal=0&group_by=none&page={page}"


def collect_trt2_legal_collections(rpp: int, sleep_seconds: float, reset: bool = False) -> dict[str, Any]:
    ensure_dir(TRT2_DIR)
    jsonl_path = TRT2_DIR / "trt2_legal_collection_items.jsonl"
    csv_path = TRT2_DIR / "trt2_legal_collection_items.csv"
    if reset:
        jsonl_path.unlink(missing_ok=True)
        csv_path.unlink(missing_ok=True)
    session = make_session()
    by_key: dict[str, dict[str, Any]] = {}
    reported_totals: dict[str, int] = {}
    pages_by_collection: dict[str, int] = {}
    for handle, config in TRT2_LEGAL_COLLECTIONS.items():
        page = 1
        pages = 0
        while True:
            url = trt2_collection_discover_url(handle, page, rpp)
            response = session.get(url, timeout=45)
            response.raise_for_status()
            page_total = parse_total_items(response.text)
            if page_total is not None:
                reported_totals[config["collection"]] = page_total
            records = parse_search_results(response.text, response.url, BASIS_BASE_URL)
            if not records:
                break
            for record in records:
                key = document_key(record.url, record.pdf_url, record.title)
                row = {
                    "key": key,
                    "source": "trt2_basis",
                    "source_layer": config["source_layer"],
                    "kind": config["kind"],
                    "collection": config["collection"],
                    "collection_handle": handle,
                    "title": record.title,
                    "document_type": record.document_type,
                    "date": record.date,
                    "url": record.url,
                    "source_url": record.url,
                    "pdf_url": record.pdf_url,
                    "metadata": record.metadata,
                }
                if key not in by_key:
                    by_key[key] = row
                else:
                    collections = set(by_key[key].get("collections", []))
                    collections.add(config["collection"])
                    by_key[key]["collections"] = sorted(collections)
            pages += 1
            page += 1
            if page_total and len([row for row in by_key.values() if row.get("collection") == config["collection"]]) >= page_total:
                break
            time.sleep(sleep_seconds)
        pages_by_collection[config["collection"]] = pages
    rows = sorted(by_key.values(), key=lambda item: (item.get("date") or "", item.get("title") or ""), reverse=True)
    write_jsonl(jsonl_path, rows)
    write_csv(
        csv_path,
        [
            {
                "key": row.get("key", ""),
                "source": row.get("source", ""),
                "source_layer": row.get("source_layer", ""),
                "kind": row.get("kind", ""),
                "collection": row.get("collection", ""),
                "collection_handle": row.get("collection_handle", ""),
                "title": row.get("title", ""),
                "document_type": row.get("document_type", ""),
                "date": row.get("date", ""),
                "url": row.get("url", ""),
                "pdf_url": row.get("pdf_url", ""),
            }
            for row in rows
        ],
    )
    counts = Counter(row.get("source_layer", "outros") for row in rows)
    collections = Counter(row.get("collection", "outros") for row in rows)
    summary = {
        "source": "trt2_basis",
        "mode": "web_legal_collections",
        "source_url": BASIS_BASE_URL,
        "collections": TRT2_LEGAL_COLLECTIONS,
        "items": len(rows),
        "reported_totals": reported_totals,
        "by_layer": dict(counts),
        "by_collection": dict(collections),
        "pages_by_collection": pages_by_collection,
        "complete": True,
        "jsonl_path": str(jsonl_path.relative_to(ROOT)),
        "csv_path": str(csv_path.relative_to(ROOT)),
        "notes": [
            "O OAI-PMH lista alguns sets, mas retornou noRecordsMatch para ListRecords.",
            "Esta coleta usa as páginas oficiais /handle/{id}/discover das coleções visíveis no Basis.",
        ],
    }
    write_json(TRT2_DIR / "summary_legal_collections.json", summary)
    return summary


def build_status(
    tst_summary: dict[str, Any] | None,
    trt2_summary: dict[str, Any] | None,
    trt2_oai_legal_summary: dict[str, Any] | None,
    trt2_legal_collections_summary: dict[str, Any] | None,
    planalto_summary: dict[str, Any] | None,
) -> dict[str, Any]:
    current = read_json(STATUS_PATH, {})
    if tst_summary:
        current["tst"] = tst_summary
    if trt2_summary:
        current["trt2_basis"] = trt2_summary
    if trt2_oai_legal_summary:
        current["trt2_oai_legal"] = trt2_oai_legal_summary
    if trt2_legal_collections_summary:
        current["trt2_legal_collections"] = trt2_legal_collections_summary
        current.pop("trt2_oai_legal", None)
    if planalto_summary:
        current["planalto_clt"] = planalto_summary
    current["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_json(STATUS_PATH, current)
    return current


def main() -> None:
    parser = argparse.ArgumentParser(description="Coleta e estrutura fontes públicas de conhecimento trabalhista.")
    parser.add_argument("--skip-tst", action="store_true")
    parser.add_argument("--skip-tst-pdf", action="store_true")
    parser.add_argument("--skip-tst-site", action="store_true")
    parser.add_argument("--tst-types", default=",".join(TST_SITE_TYPES), help="Tipos do TST separados por vírgula. Ex.: SUM,OJ,PN")
    parser.add_argument("--include-tst-acordaos", action="store_true", help="Coleta acórdãos recentes do TST em blocos incrementais.")
    parser.add_argument("--tst-acordaos-limit", type=int, default=20, help="Quantidade máxima de acórdãos novos nesta execução.")
    parser.add_argument("--tst-acordaos-page-size", type=int, default=20, help="Tamanho do bloco de consulta dos acórdãos.")
    parser.add_argument("--reset-tst-acordaos", action="store_true")
    parser.add_argument("--include-clt", action="store_true", help="Coleta a CLT no Planalto e fatia por artigos.")
    parser.add_argument("--skip-trt2-basis", action="store_true")
    parser.add_argument("--include-trt2-oai-legal", action="store_true", help="Coleta coleções oficiais OAI de jurisprudência/doutrina do TRT2.")
    parser.add_argument("--reset-trt2-oai-legal", action="store_true")
    parser.add_argument("--include-trt2-legal-collections", action="store_true", help="Coleta coleções web oficiais de jurisprudência/doutrina do TRT2.")
    parser.add_argument("--reset-trt2-legal-collections", action="store_true")
    parser.add_argument("--basis-max-pages", type=int, default=0, help="0 tenta ir até o fim com checkpoint.")
    parser.add_argument("--basis-rpp", type=int, default=20)
    parser.add_argument("--sleep", type=float, default=0.7)
    parser.add_argument("--reset-basis", action="store_true")
    parser.add_argument("--basis-mode", choices=["all", "targets"], default="targets")
    parser.add_argument("--basis-queries", default="", help="Consultas alvo separadas por vírgula.")
    args = parser.parse_args()

    tst_summary = None
    if not args.skip_tst:
        pdf_summary = None if args.skip_tst_pdf else parse_tst_pdf()
        site_types = [item.strip().upper() for item in args.tst_types.split(",") if item.strip()]
        site_summary = None if args.skip_tst_site else collect_tst_jurisprudencia_site(site_types, sleep_seconds=args.sleep)
        acordaos_summary = (
            collect_tst_acordaos_recentes(
                limit=args.tst_acordaos_limit,
                page_size=args.tst_acordaos_page_size,
                sleep_seconds=args.sleep,
                reset=args.reset_tst_acordaos,
            )
            if args.include_tst_acordaos
            else None
        )
        tst_summary = combine_tst_summaries(pdf_summary, site_summary, acordaos_summary)
    planalto_summary = collect_planalto_clt() if args.include_clt else None
    trt2_summary = None
    if not args.skip_trt2_basis:
        if args.basis_mode == "all":
            trt2_summary = collect_trt2_basis_all(
                max_pages=args.basis_max_pages,
                rpp=args.basis_rpp,
                sleep_seconds=args.sleep,
                reset=args.reset_basis,
            )
        else:
            queries = [item.strip() for item in args.basis_queries.split(",") if item.strip()] or TRT2_TARGET_QUERIES
            trt2_summary = collect_trt2_basis_targets(
                queries=queries,
                rpp=args.basis_rpp,
                sleep_seconds=args.sleep,
                reset=args.reset_basis,
            )
    trt2_oai_legal_summary = (
        collect_trt2_oai_legal(sleep_seconds=args.sleep, reset=args.reset_trt2_oai_legal)
        if args.include_trt2_oai_legal
        else None
    )
    trt2_legal_collections_summary = (
        collect_trt2_legal_collections(rpp=args.basis_rpp, sleep_seconds=args.sleep, reset=args.reset_trt2_legal_collections)
        if args.include_trt2_legal_collections
        else None
    )
    status = build_status(tst_summary, trt2_summary, trt2_oai_legal_summary, trt2_legal_collections_summary, planalto_summary)
    print(json.dumps(status, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
