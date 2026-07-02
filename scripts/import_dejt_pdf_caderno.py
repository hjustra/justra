#!/usr/bin/env python3
"""Importa cadernos PDF do DEJT como eventos DJEN normalizados.

O crawler principal usa o Comunica PJe. Alguns atos, especialmente pautas de
turmas em PDF do diario.jt.jus.br, podem nao aparecer nessa API. Este script
extrai blocos "Processo Nº ..." do PDF e os adiciona ao publication_events do
dia como fonte explicita dejt_pdf.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATA_DIR = ROOT / "data"
TZ_LABEL = "America/Sao_Paulo"

PROCESS_RE = re.compile(r"Processo\s+N[ºo]\s+([A-Za-zÀ-ÿ]+)-(\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4})")
OAB_RE = re.compile(r"\(OAB:\s*([0-9.]+)\s*/\s*([A-Z]{2})\)", re.IGNORECASE)

CLASS_NAMES = {
    "AP": "Agravo de Petição",
    "ROT": "Recurso Ordinário Trabalhista",
    "RORSum": "Recurso Ordinário - Rito Sumaríssimo",
    "RRAg": "Recurso de Revista com Agravo",
    "AIRR": "Agravo de Instrumento em Recurso de Revista",
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def date_parts(target_date: str) -> tuple[str, str, str]:
    year, month, day = target_date.split("-")
    return year, month, day


def compact_process_number(value: str | None) -> str:
    return re.sub(r"\D", "", str(value or ""))


def open_jsonl(path: Path):
    if not path.exists():
        return []
    opener = gzip.open if path.suffix == ".gz" else open
    rows = []
    with opener(path, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return rows


def write_jsonl_gz(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(temporary, "wt", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def download_pdf(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    response = requests.get(url, timeout=60)
    response.raise_for_status()
    target.write_bytes(response.content)


def pdf_to_text(pdf_path: Path, text_path: Path) -> None:
    binary = shutil.which("pdftotext")
    if not binary:
        raise RuntimeError("pdftotext não encontrado; instale poppler-utils ou use --text-input")
    text_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([binary, "-raw", str(pdf_path), str(text_path)], check=True)


def extract_court_unit(context: str) -> str:
    candidates: list[str] = []
    for line in context.splitlines():
        clean = re.sub(r"\s+", " ", line).strip()
        if re.fullmatch(r"\d+ª\s+Turma", clean, flags=re.IGNORECASE):
            candidates.append(clean)
        elif re.fullmatch(r"(?:SDI|SBDI|Seção|Secao).{0,80}", clean, flags=re.IGNORECASE):
            candidates.append(clean)
    return candidates[-1] if candidates else ""


def extract_pauta_context(context: str) -> str:
    lines = [re.sub(r"\s+", " ", line).strip() for line in context.splitlines()]
    lines = [line for line in lines if line]
    tail = lines[-40:]
    start = -1
    for index, line in enumerate(tail):
        normalized = line.lower()
        if "pauta da" in normalized or "pauta de julgamento" in normalized:
            start = index
    if start == -1:
        for index, line in enumerate(tail):
            if re.fullmatch(r"\d+ª\s+Turma", line, flags=re.IGNORECASE):
                start = index
    if start == -1:
        return ""
    context = "\n".join(tail[start:])
    return re.split(r"\n\s*Processo\s+N[ºo]\s+", context, maxsplit=1)[0].strip()


def parse_recipients(block: str) -> list[dict[str, str]]:
    recipients: list[dict[str, str]] = []
    match = re.search(r"(?is)Intimado\(s\)/Citado\(s\):(.+)", block)
    if not match:
        return recipients
    for line in match.group(1).splitlines():
        clean = re.sub(r"^\s*[-–]\s*", "", line).strip()
        clean = re.sub(r"\s+", " ", clean)
        if not clean or clean.lower().startswith("processo nº"):
            break
        if 3 <= len(clean) <= 180:
            recipients.append({"name": clean, "role": "unknown"})
    return recipients


def parse_attorneys(block: str) -> list[dict[str, str]]:
    attorneys: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    lines = [re.sub(r"\s+", " ", line).strip() for line in block.splitlines()]
    for index, line in enumerate(lines):
        if not line.startswith("ADVOGADO"):
            continue
        parts: list[str] = []
        match = None
        combined = ""
        for candidate in lines[index : index + 4]:
            parts.append(candidate)
            combined = " ".join(parts)
            match = OAB_RE.search(combined)
            if match:
                break
        if not match:
            continue
        name = combined[: match.start()].replace("ADVOGADO", "", 1)
        name = re.sub(r"\s+", " ", name).strip(" -")
        row = {"name": name[:160], "oab": re.sub(r"\D", "", match.group(1)), "uf": match.group(2).upper()}
        key = (row["name"], row["oab"], row["uf"])
        if key in seen:
            continue
        seen.add(key)
        attorneys.append(row)
    return attorneys


def extract_events(text: str, *, target_date: str, court: str, source_url: str, raw_path: str) -> list[dict[str, Any]]:
    matches = list(PROCESS_RE.finditer(text))
    events: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    current_pauta_context = ""
    current_court_unit = ""
    previous_start = 0
    for index, match in enumerate(matches):
        start = match.start()
        end = matches[index + 1].start() if index + 1 < len(matches) else min(len(text), start + 5000)
        class_abbrev = match.group(1)
        process_masked = match.group(2)
        process_digits = compact_process_number(process_masked)
        block = text[start:end].strip()
        context = text[max(0, min(previous_start, start - 5000)) : start]
        pauta_context = extract_pauta_context(context)
        if pauta_context:
            current_pauta_context = pauta_context
        court_unit = extract_court_unit(context)
        if court_unit:
            current_court_unit = court_unit
        previous_start = start
        event_text = "\n\n".join(part for part in [current_pauta_context, block] if part).strip()
        if not event_text:
            continue
        digest = hashlib.sha1(f"{source_url}:{process_digits}:{event_text}".encode("utf-8")).hexdigest()
        key = (process_digits, digest)
        if key in seen:
            continue
        seen.add(key)
        events.append(
            {
                "source": "dejt_pdf",
                "source_run_id": f"dejt_pdf_{target_date.replace('-', '')}",
                "communication_id": f"dejt-pdf-{digest[:18]}",
                "communication_hash": digest[:30],
                "numero_comunicacao": "",
                "process_number": process_digits,
                "process_number_masked": process_masked,
                "court_acronym": court.upper(),
                "court_unit": current_court_unit,
                "court_unit_id": None,
                "publication_date": target_date,
                "sent_date": "",
                "communication_type": "Pauta de julgamento",
                "document_type": "Pauta",
                "class_name": CLASS_NAMES.get(class_abbrev, class_abbrev),
                "class_code": class_abbrev,
                "medium": "J",
                "medium_full": "DEJT Caderno Judiciário PDF",
                "status": "P",
                "active": True,
                "text": event_text,
                "recipients": parse_recipients(block),
                "recipient_attorneys": parse_attorneys(block),
                "source_url": source_url,
                "raw_path": raw_path,
                "first_seen_at": now_iso(),
            }
        )
    return events


def import_events(args: argparse.Namespace) -> dict[str, Any]:
    data_dir = Path(args.out_dir).resolve()
    year, month, day = date_parts(args.date)
    raw_dir = data_dir / "raw" / "dejt_pdf" / year / month / day / args.court.upper()
    raw_dir.mkdir(parents=True, exist_ok=True)
    pdf_name = Path(args.pdf_url.split("?")[0]).name or f"{args.court}_{args.date}.pdf"
    pdf_path = Path(args.pdf_input).resolve() if args.pdf_input else raw_dir / pdf_name
    text_path = Path(args.text_input).resolve() if args.text_input else raw_dir / f"{pdf_path.stem}.txt"
    if args.pdf_url and not args.text_input and (args.force or not pdf_path.exists()):
        download_pdf(args.pdf_url, pdf_path)
    if not text_path.exists():
        pdf_to_text(pdf_path, text_path)
    text = text_path.read_text(encoding="utf-8", errors="replace")
    raw_path = str(text_path.relative_to(data_dir)) if text_path.is_relative_to(data_dir) else str(text_path)
    events = extract_events(text, target_date=args.date, court=args.court, source_url=args.pdf_url, raw_path=raw_path)
    if args.process:
        wanted = compact_process_number(args.process)
        events = [event for event in events if event.get("process_number") == wanted]

    publication_path = data_dir / "processed" / "djen" / year / month / day / "publication_events.jsonl.gz"
    existing = open_jsonl(publication_path)
    source_key = args.pdf_url or str(pdf_path)
    kept = [
        row
        for row in existing
        if not (row.get("source") == "dejt_pdf" and str(row.get("source_url") or "") == source_key)
    ]
    rows = [*kept, *events]
    if not args.dry_run:
        write_jsonl_gz(publication_path, rows)
        manifest_path = publication_path.parent / "crawler_manifest.json"
        manifest = load_json(manifest_path, {})
        manifest.update(
            {
                "target_date": args.date,
                "source": manifest.get("source") or "comunicaapi.pje.jus.br",
                "total_publications": len(rows),
                "dejt_pdf_imported": True,
            }
        )
        sources = [item for item in manifest.get("dejt_pdf_sources") or [] if item.get("source_url") != source_key]
        sources.append({"source_url": source_key, "event_count": len(events), "imported_at": now_iso()})
        manifest["dejt_pdf_sources"] = sources
        write_json(manifest_path, manifest)
        write_json(
            raw_dir / "manifest.json",
            {
                "source": "dejt_pdf",
                "source_url": source_key,
                "target_date": args.date,
                "court": args.court.upper(),
                "pdf_path": str(pdf_path),
                "text_path": str(text_path),
                "event_count": len(events),
                "imported_at": now_iso(),
            },
        )
    return {
        "ok": True,
        "dry_run": bool(args.dry_run),
        "date": args.date,
        "court": args.court.upper(),
        "source_url": source_key,
        "events": len(events),
        "publication_events": len(rows),
        "publication_path": str(publication_path),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Importa caderno PDF do DEJT para publication_events.")
    parser.add_argument("--date", required=True, help="Data de disponibilização YYYY-MM-DD")
    parser.add_argument("--court", required=True, help="Sigla do tribunal, ex.: TRT2")
    parser.add_argument("--pdf-url", required=True, help="URL oficial do PDF")
    parser.add_argument("--out-dir", default=str(DEFAULT_DATA_DIR), help="Diretório base de dados")
    parser.add_argument("--pdf-input", default="", help="PDF local já baixado")
    parser.add_argument("--text-input", default="", help="Texto extraído por pdftotext -raw")
    parser.add_argument("--process", default="", help="Opcional: importar apenas um CNJ")
    parser.add_argument("--force", action="store_true", help="Baixa o PDF novamente")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(import_events(args), ensure_ascii=False, separators=(",", ":")))
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, separators=(",", ":")), file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
