from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pandas as pd

from parsers.html_parser import extract_html_file_text
from parsers.pdf_parser import extract_pdf_text


PROCESS_RE = re.compile(r"\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b")
COURT_UNIT_PATTERNS = [
    re.compile(r"\b\d{1,3}[ªa]?\s+Vara do Trabalho de\s+[A-ZÁÂÃÉÊÍÓÔÕÚÇ][A-Za-zÁÂÃÉÊÍÓÔÕÚÇáâãéêíóôõúç\s.-]+"),
    re.compile(r"\b\d{1,2}[ªa]?\s+Turma\b", re.IGNORECASE),
    re.compile(r"\bTribunal Pleno\b", re.IGNORECASE),
]
JUDGE_PATTERNS = [
    re.compile(r"Relator(?:a)?\s*[:\-]\s*([A-ZÁÂÃÉÊÍÓÔÕÚÇ][A-Za-zÁÂÃÉÊÍÓÔÕÚÇáâãéêíóôõúç\s.-]{3,120})"),
    re.compile(r"Desembargador(?:a)?\s+Relator(?:a)?\s+([A-ZÁÂÃÉÊÍÓÔÕÚÇ][A-Za-zÁÂÃÉÊÍÓÔÕÚÇáâãéêíóôõúç\s.-]{3,120})"),
    re.compile(r"Juiz(?:a)?\s+do Trabalho\s+([A-ZÁÂÃÉÊÍÓÔÕÚÇ][A-Za-zÁÂÃÉÊÍÓÔÕÚÇáâãéêíóôõúç\s.-]{3,120})"),
    re.compile(r"Magistrado(?:a)?\s*[:\-]\s*([A-ZÁÂÃÉÊÍÓÔÕÚÇ][A-Za-zÁÂÃÉÊÍÓÔÕÚÇáâãéêíóôõúç\s.-]{3,120})"),
]
CASE_CLASSES = [
    "Recurso Ordinario",
    "Recurso Ordinário",
    "Agravo de Peticao",
    "Agravo de Petição",
    "Embargos de Declaracao",
    "Embargos de Declaração",
    "Mandado de Seguranca",
    "Mandado de Segurança",
    "Acao Rescisoria",
    "Ação Rescisória",
    "Dissidio Coletivo",
    "Dissídio Coletivo",
]


def first_match(patterns: list[re.Pattern[str]], text: str) -> str:
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            value = match.group(1) if match.lastindex else match.group(0)
            return re.sub(r"\s+", " ", value).strip(" .,-")
    return ""


def extract_case_class(text: str, title: str = "") -> str:
    haystack = f"{title}\n{text[:5000]}"
    lower = haystack.lower()
    for case_class in CASE_CLASSES:
        if case_class.lower() in lower:
            return case_class
    return ""


def read_index(index_path: Path) -> list[dict[str, Any]]:
    if not index_path.exists():
        raise FileNotFoundError(f"Indice nao encontrado: {index_path}")
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    if isinstance(payload, dict):
        return [payload]
    return payload


def load_document_text(project_root: Path, item: dict[str, Any]) -> tuple[str, str]:
    pdf_rel = item.get("raw_pdf_path") or ""
    html_rel = item.get("raw_html_path") or ""

    if pdf_rel:
        pdf_text = extract_pdf_text(project_root / pdf_rel)
        if pdf_text:
            return pdf_text, "pdf"

    if html_rel:
        html_text = extract_html_file_text(project_root / html_rel)
        if html_text:
            return html_text, "html"

    return "", ""


def parse_record(project_root: Path, item: dict[str, Any]) -> dict[str, Any]:
    text, extraction_source = load_document_text(project_root, item)
    metadata = item.get("metadata") or {}
    subjects = metadata.get("subjects") or []
    if isinstance(subjects, str):
        subjects = [subjects]

    process_match = PROCESS_RE.search(text)
    title = item.get("title", "")
    court_unit = first_match(COURT_UNIT_PATTERNS, text)
    judge_name = first_match(JUDGE_PATTERNS, text)

    return {
        "process_number": process_match.group(0) if process_match else "",
        "tribunal": "TRT2",
        "court_unit": court_unit,
        "judge_name": judge_name,
        "reporting_judge": judge_name if "relator" in text[:2000].lower() else "",
        "decision_date": item.get("date", ""),
        "filing_date": "",
        "case_class": extract_case_class(text, title),
        "subjects": "; ".join(subjects),
        "claims": "",
        "outcome": "",
        "decision_text": text,
        "source_url": item.get("url", ""),
        "raw_html": item.get("raw_html_path", ""),
        "raw_pdf_path": item.get("raw_pdf_path", ""),
        "title": title,
        "document_type": item.get("document_type", ""),
        "text_length": len(text),
        "text_extraction_source": extraction_source,
        "text_extraction_ok": bool(text and len(text) >= 200),
    }


def parse_document_index(
    project_root: Path,
    index_path: Path | None = None,
    output_path: Path | None = None,
) -> pd.DataFrame:
    index_path = index_path or project_root / "data/raw/json/document_index.json"
    output_path = output_path or project_root / "data/processed/decisions.csv"
    records = [parse_record(project_root, item) for item in read_index(index_path)]
    df = pd.DataFrame(records)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_path, index=False)
    return df
