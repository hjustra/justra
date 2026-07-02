#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import html
import json
import re
import secrets
import unicodedata
import zipfile
from collections import Counter, OrderedDict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
DEFAULT_DATA_DIR = DATA_ROOT
TZ = ZoneInfo("America/Sao_Paulo")
PARSER_VERSION = "0.2"
CNJ_DIGITS_RE = re.compile(r"\D+")
EXPLICIT_DAYS_RE = re.compile(
    r"\b(?:no\s+)?prazo\s+de\s+0*(\d{1,3})\s+dias?\b|\bem\s+0*(\d{1,3})\s+dias?\b",
    re.IGNORECASE,
)
RELATIVE_HOURS_BEFORE_RE = re.compile(
    r"\b(?:prazo\s+de\s+)?(?:ate\s+)?0*(\d{1,3})\s+horas?\s+antes\b",
    re.IGNORECASE,
)
DATE_RE = re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b")
TIME_RE = re.compile(r"\b(\d{1,2})[:h](\d{2})\b")
PJE_ID_RE = re.compile(r"\b(?:ID|Id|id)\s+([a-z0-9]{5,})\b")


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def run_id() -> str:
    return datetime.now(TZ).strftime("deadline_%Y%m%d_%H%M%S")


def date_parts(value: str) -> tuple[str, str, str]:
    year, month, day = value.split("-")
    return year, month, day


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")


def open_jsonl(path: Path):
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def compact_process_number(value: str | None) -> str:
    digits = CNJ_DIGITS_RE.sub("", str(value or ""))
    if len(digits) != 20:
        return ""
    return digits


def format_process_number(value: str | None) -> str:
    digits = compact_process_number(value)
    if not digits:
        return str(value or "")
    return f"{digits[:7]}-{digits[7:9]}.{digits[9:13]}.{digits[13]}.{digits[14:16]}.{digits[16:20]}"


def strip_accents(value: str) -> str:
    return "".join(
        char
        for char in unicodedata.normalize("NFD", value)
        if unicodedata.category(char) != "Mn"
    )


def norm(value: str | None) -> str:
    text = strip_accents(str(value or "")).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_text(value: str | None) -> str:
    text = html.unescape(str(value or ""))
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\r", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def short_text(value: str, limit: int = 1800) -> str:
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "..."


def parse_iso_date(value: str | None) -> date | None:
    raw = str(value or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return date.fromisoformat(raw)
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}", raw):
        day, month, year = raw.split("/")
        return date(int(year), int(month), int(day))
    return None


def is_business_day(day: date) -> bool:
    return day.weekday() < 5


def next_business_day(day: date) -> date:
    current = day + timedelta(days=1)
    while not is_business_day(current):
        current += timedelta(days=1)
    return current


def add_business_days(start: date, days: int) -> date:
    if days <= 0:
        return start
    current = start
    counted = 1
    while counted < days:
        current += timedelta(days=1)
        if is_business_day(current):
            counted += 1
    return current


def due_delta_business_days(due_date: date, today: date) -> int:
    if due_date == today:
        return 0
    sign = 1 if due_date > today else -1
    start = today if sign > 0 else due_date
    end = due_date if sign > 0 else today
    count = 0
    current = start
    while current < end:
        current += timedelta(days=1)
        if is_business_day(current):
            count += 1
    return count * sign


def output_dirs(data_dir: Path, target_date: str) -> Path:
    year, month, day = date_parts(target_date)
    return data_dir / "processed" / "djen_deadlines" / year / month / day


def default_input(data_dir: Path, target_date: str) -> Path:
    year, month, day = date_parts(target_date)
    return data_dir / "processed" / "djen" / year / month / day / "publication_events.jsonl.gz"


def gzip_writer(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    return temporary, gzip.open(temporary, "wt", encoding="utf-8")


def event_id(event: dict[str, Any]) -> str:
    communication_id = event.get("communication_id")
    if communication_id is not None:
        return str(communication_id)
    return str(event.get("communication_hash") or secrets.token_hex(8))


class RawItemCache:
    def __init__(self, max_pages: int = 8) -> None:
        self.max_pages = max_pages
        self.pages: OrderedDict[str, dict[str, dict[str, Any]]] = OrderedDict()

    def get(self, raw_path: str, communication_id: Any) -> dict[str, Any]:
        if not raw_path or "::" not in raw_path:
            return {}
        key = raw_path
        if key not in self.pages:
            self._load_page(key)
        page_items = self.pages.get(key) or {}
        item = page_items.get(str(communication_id)) if communication_id is not None else None
        return item or {}

    def _load_page(self, raw_path: str) -> None:
        zip_label, inner_name = raw_path.split("::", 1)
        zip_path = Path(zip_label)
        if not zip_path.is_absolute():
            zip_path = ROOT / zip_path
        items_by_id: dict[str, dict[str, Any]] = {}
        try:
            with zipfile.ZipFile(zip_path) as archive:
                payload = json.loads(archive.read(inner_name).decode("utf-8"))
                for item in payload.get("items") or []:
                    if item.get("id") is not None:
                        items_by_id[str(item.get("id"))] = item
        except Exception:
            items_by_id = {}
        self.pages[raw_path] = items_by_id
        self.pages.move_to_end(raw_path)
        while len(self.pages) > self.max_pages:
            self.pages.popitem(last=False)


def structured_parties(raw_item: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    role_map = {"A": "active", "P": "passive", "T": "third_party"}
    for item in raw_item.get("destinatarios") or []:
        name = re.sub(r"\s+", " ", str(item.get("nome") or "")).strip()
        if not name:
            continue
        result.append(
            {
                "name": name,
                "role": role_map.get(str(item.get("polo") or "").strip().upper(), "unknown"),
                "source": "destinatarios",
            }
        )
    return result


def structured_attorneys(raw_item: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in raw_item.get("destinatarioadvogados") or []:
        attorney = item.get("advogado") if isinstance(item.get("advogado"), dict) else {}
        name = re.sub(r"\s+", " ", str(attorney.get("nome") or "")).strip()
        oab = re.sub(r"\D", "", str(attorney.get("numero_oab") or ""))
        uf = re.sub(r"[^A-Za-z]", "", str(attorney.get("uf_oab") or "")).upper()[:2]
        if name or oab:
            result.append({"name": name, "oab": oab, "uf": uf, "source": "destinatarioadvogados"})
    return result


def event_parties(event: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in event.get("recipients") or []:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()
        if name:
            result.append({"name": name, "role": item.get("role") or "unknown", "source": "publication_event"})
    return result


def event_attorneys(event: dict[str, Any]) -> list[dict[str, Any]]:
    result = []
    for item in event.get("recipient_attorneys") or []:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip()
        oab = re.sub(r"\D", "", str(item.get("oab") or ""))
        uf = re.sub(r"[^A-Za-z]", "", str(item.get("uf") or "")).upper()[:2]
        if name or oab:
            result.append({"name": name, "oab": oab, "uf": uf, "source": "publication_event"})
    return result


def textual_intimated_parties(text: str) -> list[dict[str, Any]]:
    result = []
    for match in re.finditer(r"(?is)Intimado\(s\)\s*/?\s*Citado\(s\)\s*:?\s*(.+?)(?:\n\n|$)", text):
        block = match.group(1)
        for line in block.splitlines():
            name = re.sub(r"^\s*[-–]\s*", "", line).strip()
            name = re.sub(r"\s+", " ", name)
            if 3 <= len(name) <= 180 and not re.search(r"^(poder judiciario|justica do trabalho)$", norm(name)):
                result.append({"name": name, "role": "unknown", "source": "text"})
    return result


def dedupe_named(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    result = []
    for row in rows:
        key = (norm(row.get("name")), row.get("oab") or "", row.get("role") or "")
        if not key[0] and not key[1]:
            continue
        if key in seen:
            continue
        seen.add(key)
        result.append(row)
    return result


def explicit_deadline_days(normalized_text: str) -> tuple[int | None, str]:
    match = EXPLICIT_DAYS_RE.search(normalized_text)
    if not match:
        return None, ""
    raw = next((group for group in match.groups() if group), "")
    try:
        days = int(raw)
    except ValueError:
        return None, ""
    if days <= 0 or days > 180:
        return None, ""
    return days, match.group(0)


def detect_deadline_kind(normalized_text: str) -> tuple[str, str]:
    checks = [
        ("contrarrazoes", "contrarrazoes", "contrarrazoes"),
        ("embargos de declaracao", "embargos_de_declaracao", "embargos_de_declaracao"),
        ("impugnacao fundamentada", "impugnacao_calculos", "impugnacao_calculos"),
        ("impugnacao aos calculos", "impugnacao_calculos", "impugnacao_calculos"),
        ("art 879", "impugnacao_calculos", "impugnacao_calculos"),
        ("recurso ordinario", "recurso", "recurso_ordinario"),
        ("recurso de revista", "recurso", "recurso_revista"),
        ("agravo de peticao", "recurso", "agravo_peticao"),
        ("agravo de instrumento", "recurso", "agravo_instrumento"),
        ("comprovar pagamento", "despacho_manifestacao", "pagamento"),
        ("efetuar pagamento", "despacho_manifestacao", "pagamento"),
        ("cumprir obrigacao", "despacho_manifestacao", "cumprimento_obrigacao"),
        ("manifestar", "intimacao_manifestacao", "manifestacao"),
        ("impugnar", "intimacao_manifestacao", "manifestacao"),
    ]
    for term, trigger, kind in checks:
        if term in normalized_text:
            return trigger, kind
    return "intimacao_manifestacao", "manifestacao"


def document_trigger(event: dict[str, Any], normalized_text: str) -> tuple[str, str, str] | None:
    document_type = norm(event.get("document_type"))
    communication_type = norm(event.get("communication_type"))
    if "acordao" in document_type or "acordao" in normalized_text:
        return "acordao_publicado", "unknown", "medium"
    if "sentenca" in document_type or "sentenca" in normalized_text:
        return "sentenca_publicada", "unknown", "medium"
    if "decisao" in document_type or "decisao monocratica" in normalized_text:
        return "decisao_publicada", "unknown", "medium"
    if "edital" in document_type or "edital" in communication_type:
        return "edital", "unknown", "medium"
    return None


def is_distribution(event: dict[str, Any], normalized_text: str) -> bool:
    communication_type = norm(event.get("communication_type"))
    document_type = norm(event.get("document_type"))
    return (
        "lista de distribuicao" in communication_type
        or "distribuicao" in document_type
        or "distribuido para" in normalized_text
    )


def has_negative_no_action(normalized_text: str) -> bool:
    return any(
        marker in normalized_text
        for marker in [
            "nao e necessario apresentar resposta",
            "nao ha necessidade de manifestacao",
            "ciencia apenas",
            "mero expediente",
        ]
    )


def detect_calendar_event(text: str, normalized_text: str) -> dict[str, Any] | None:
    if not any(marker in normalized_text for marker in ["audiencia", "pauta", "sessao de julgamento", "julgamento"]):
        return None
    event_type = "audiencia" if "audiencia" in normalized_text else "pauta_julgamento"
    date_match = DATE_RE.search(text)
    event_date = ""
    if date_match:
        day, month, year = [int(item) for item in date_match.groups()]
        try:
            event_date = date(year, month, day).isoformat()
        except ValueError:
            event_date = ""
    time_match = TIME_RE.search(text)
    event_time = ""
    if time_match:
        hour, minute = [int(item) for item in time_match.groups()]
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            event_time = f"{hour:02d}:{minute:02d}"
    event_mode = "presencial" if "presencial" in normalized_text else "telepresencial" if "telepresencial" in normalized_text or "videoconferencia" in normalized_text else ""
    risk_reasons = []
    if any(marker in normalized_text for marker in ["revelia", "confissao", "arquivamento"]):
        risk_reasons.append("texto menciona consequencia de ausencia")
    return {
        "event_type": event_type,
        "event_date": event_date,
        "event_time": event_time,
        "event_mode": event_mode,
        "event_location": "",
        "risk_level": "high" if risk_reasons else "medium",
        "risk_reasons": risk_reasons,
        "confidence": "high" if event_date else "medium",
        "requires_human_review": True,
    }


def related_calendar_deadline(
    event: dict[str, Any],
    calendar_payload: dict[str, Any],
    normalized_text: str,
    parser_run_id: str,
    today: date,
) -> dict[str, Any] | None:
    match = RELATIVE_HOURS_BEFORE_RE.search(normalized_text)
    if not match or not calendar_payload.get("event_date"):
        return None
    if not any(marker in normalized_text for marker in ["sustentacao oral", "inscricao", "inscrito"]):
        return None
    try:
        hours = int(match.group(1))
    except ValueError:
        return None
    event_day = parse_iso_date(calendar_payload.get("event_date"))
    if not event_day:
        return None
    days_before = max(1, (hours + 23) // 24)
    due_day = event_day - timedelta(days=days_before)
    risk_level, risk_reasons = risk_for_deadline(due_day, None, normalized_text, today, explicit=True)
    evidence = calendar_payload.get("evidence") if isinstance(calendar_payload.get("evidence"), dict) else {}
    return {
        "id": f"djen-deadline-{event_id(event)}-sustentacao-oral-001",
        "source": "djen_deadline_parser",
        "source_version": PARSER_VERSION,
        "parser_run_id": parser_run_id,
        **base_publication(event),
        "availability_date": event.get("publication_date") or "",
        "legal_publication_date": event.get("publication_date") or "",
        "start_date": event.get("publication_date") or "",
        "due_date": due_day.isoformat(),
        "deadline_days": None,
        "deadline_day_type": None,
        "deadline_source": f"relative_calendar_{hours}_hours_before",
        "trigger_type": "sustentacao_oral",
        "deadline_kind": "sustentacao_oral",
        "action_required": True,
        "risk_level": risk_level,
        "risk_reasons": risk_reasons,
        "confidence": "high",
        "requires_human_review": True,
        "requires_holiday_validation": True,
        "requires_pje_opening": False,
        "intimated_parties": calendar_payload.get("intimated_parties") or [],
        "attorneys": calendar_payload.get("attorneys") or [],
        "evidence": {
            "matched_terms": ["sustentacao oral", f"{hours} horas antes"],
            "text_excerpt": evidence.get("text_excerpt") or "",
            "related_calendar_event_id": calendar_payload.get("id") or "",
            "related_event_date": calendar_payload.get("event_date") or "",
            "related_event_time": calendar_payload.get("event_time") or "",
        },
        "calculation_notes": [
            f"prazo derivado de {hours} horas antes do evento de calendario",
            "data limite simplificada em dia calendario; validar horario e feriados manualmente",
        ],
        "raw_text": calendar_payload.get("raw_text") or "",
        "created_at": now_iso(),
    }


def risk_for_deadline(due: date | None, days: int | None, normalized_text: str, today: date, explicit: bool) -> tuple[str, list[str]]:
    reasons: list[str] = []
    risk = "medium"
    if explicit:
        risk = "high"
        reasons.append("prazo explicito encontrado")
    if any(marker in normalized_text for marker in ["preclusao", "revelia", "confissao", "arquivamento"]):
        risk = "critical" if days is not None and days <= 2 else "high"
        reasons.append("texto contem consequencia processual expressa")
    if due:
        delta = due_delta_business_days(due, today)
        if delta < 0:
            return "critical", [*reasons, "prazo provavel vencido"]
        if delta == 0:
            return "critical", [*reasons, "prazo provavel vence hoje"]
        if delta <= 2:
            return "critical", [*reasons, "prazo provavel em ate 2 dias uteis"]
        if delta <= 5:
            risk = "high"
            reasons.append("prazo provavel em ate 5 dias uteis")
    if not reasons:
        reasons.append("possivel prazo processual")
    return risk, reasons


def base_publication(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "publication_event_id": event.get("communication_id"),
        "communication_hash": event.get("communication_hash"),
        "process_number": compact_process_number(event.get("process_number") or event.get("process_number_masked")),
        "process_number_masked": event.get("process_number_masked") or format_process_number(event.get("process_number")),
        "court_acronym": event.get("court_acronym") or "",
        "court_unit": event.get("court_unit") or "",
        "medium": event.get("medium") or "",
        "communication_type": event.get("communication_type") or "",
        "document_type": event.get("document_type") or "",
        "class_name": event.get("class_name") or "",
        "source_url": event.get("source_url") or "",
    }


def classify_event(
    event: dict[str, Any],
    raw_cache: RawItemCache,
    parser_run_id: str,
    today: date,
) -> tuple[str, dict[str, Any]]:
    text = clean_text(event.get("text"))
    normalized_text = norm(text)
    base = base_publication(event)
    raw_item: dict[str, Any] = {}

    if event.get("active") is False or str(event.get("status") or "").upper() == "C":
        return "non_deadline", {
            **base,
            "classification": "communication_cancelled",
            "reason": "publicacao inativa ou cancelada",
            "confidence": "high",
            "created_at": now_iso(),
        }

    if is_distribution(event, normalized_text):
        return "non_deadline", {
            **base,
            "classification": "distribution_no_deadline",
            "reason": "lista de distribuicao ou distribuicao sem comando de prazo",
            "confidence": "high",
            "created_at": now_iso(),
        }

    negative = has_negative_no_action(normalized_text)
    days, matched_days = explicit_deadline_days(normalized_text)
    calendar_event = detect_calendar_event(text, normalized_text)
    doc_trigger = document_trigger(event, normalized_text)

    if days is None and negative and not calendar_event and not doc_trigger:
        return "non_deadline", {
            **base,
            "classification": "science_no_action_required",
            "reason": "texto informa que nao ha necessidade de resposta",
            "confidence": "high",
            "created_at": now_iso(),
        }

    if days is None and calendar_event:
        raw_item = raw_cache.get(str(event.get("raw_path") or ""), event.get("communication_id"))
        parties = dedupe_named([*event_parties(event), *structured_parties(raw_item), *textual_intimated_parties(text)])
        attorneys = dedupe_named([*event_attorneys(event), *structured_attorneys(raw_item)])
        return "calendar", {
            "id": f"djen-calendar-{event_id(event)}-001",
            "source": "djen_deadline_parser",
            "source_version": PARSER_VERSION,
            "parser_run_id": parser_run_id,
            **base,
            **calendar_event,
            "intimated_parties": parties,
            "attorneys": attorneys,
            "evidence": {
                "matched_terms": [item for item in ["audiencia", "pauta", "julgamento"] if item in normalized_text],
                "text_excerpt": short_text(text, 1200),
            },
            "raw_text": short_text(text),
            "created_at": now_iso(),
        }

    if days is None and not doc_trigger:
        return "non_deadline", {
            **base,
            "classification": "no_deadline_detected",
            "reason": "sem prazo explicito, ato futuro ou gatilho aprovado",
            "confidence": "medium",
            "created_at": now_iso(),
        }

    raw_item = raw_cache.get(str(event.get("raw_path") or ""), event.get("communication_id"))
    parties = dedupe_named([*event_parties(event), *structured_parties(raw_item), *textual_intimated_parties(text)])
    attorneys = dedupe_named([*event_attorneys(event), *structured_attorneys(raw_item)])
    availability = parse_iso_date(event.get("publication_date"))
    legal_publication_date: date | None = None
    start_date: date | None = None
    due_date: date | None = None
    calculation_notes = []
    requires_holiday_validation = True
    requires_human_review = False
    requires_pje_opening = False
    deadline_source = "explicit_text" if days is not None else "possible_trigger_without_explicit_deadline"
    trigger_type, deadline_kind = detect_deadline_kind(normalized_text)
    confidence = "high" if days is not None and not negative else "medium"
    if doc_trigger and days is None:
        trigger_type, deadline_kind, confidence = doc_trigger
        requires_human_review = True
        requires_pje_opening = True
    if negative and days is not None:
        confidence = "low"
        requires_human_review = True
        deadline_source = "explicit_text_conflicted_by_negative_text"
        calculation_notes.append("texto contem prazo e tambem negacao de necessidade de resposta")
        days = None
    if availability:
        legal_publication_date = next_business_day(availability)
        start_date = next_business_day(legal_publication_date)
        calculation_notes.extend(
            [
                "legal_publication_date calculada como primeiro dia util seguinte a availability_date",
                "start_date calculada como primeiro dia util seguinte a publicacao legal",
                "calendario basico considera apenas segunda a sexta",
            ]
        )
        if days is not None:
            due_date = add_business_days(start_date, days)
    else:
        requires_human_review = True
        calculation_notes.append("publication_date ausente ou invalida")
    if not parties:
        requires_human_review = True
        calculation_notes.append("parte intimada nao identificada com seguranca")
    risk_level, risk_reasons = risk_for_deadline(due_date, days, normalized_text, today, days is not None)
    matched_terms = []
    if matched_days:
        matched_terms.append(matched_days)
    matched_terms.extend(item for item in ["preclusao", "revelia", "confissao", "arquivamento"] if item in normalized_text)
    pje_ids = sorted(set(PJE_ID_RE.findall(text)))[:5]
    return "deadline", {
        "id": f"djen-deadline-{event_id(event)}-001",
        "source": "djen_deadline_parser",
        "source_version": PARSER_VERSION,
        "parser_run_id": parser_run_id,
        **base,
        "availability_date": availability.isoformat() if availability else "",
        "legal_publication_date": legal_publication_date.isoformat() if legal_publication_date else "",
        "start_date": start_date.isoformat() if start_date else "",
        "due_date": due_date.isoformat() if due_date else "",
        "deadline_days": days,
        "deadline_day_type": "business_days" if days is not None else None,
        "deadline_source": deadline_source,
        "trigger_type": trigger_type,
        "deadline_kind": deadline_kind,
        "action_required": days is not None or trigger_type not in {"acordao_publicado", "sentenca_publicada", "decisao_publicada"},
        "intimated_parties": parties,
        "attorneys": attorneys,
        "risk_level": risk_level,
        "risk_reasons": risk_reasons,
        "confidence": confidence,
        "requires_human_review": requires_human_review,
        "requires_holiday_validation": requires_holiday_validation,
        "requires_pje_opening": requires_pje_opening,
        "calendar_used": {
            "kind": "basic_weekdays",
            "court": event.get("court_acronym") or "",
            "municipality": None,
            "validated_until": None,
        },
        "evidence": {
            "matched_terms": matched_terms,
            "matched_rule_ids": ["explicit_deadline_days_v1"] if matched_days else ["possible_document_trigger_v1"] if doc_trigger else [],
            "pje_document_ids": pje_ids,
            "text_excerpt": short_text(text, 1200),
        },
        "calculation_notes": calculation_notes,
        "raw_text": short_text(text),
        "created_at": now_iso(),
    }


def process_file(args: argparse.Namespace) -> dict[str, Any]:
    target_date = args.date
    data_dir = Path(args.data_dir)
    input_path = Path(args.input) if args.input else default_input(data_dir, target_date)
    out_dir = Path(args.out_dir) if args.out_dir else output_dirs(data_dir, target_date)
    parser_run_id = run_id()
    manifest_path = out_dir / "deadline_parser_manifest.json"
    errors_path = out_dir / "errors.jsonl"
    review_path = out_dir / "review_samples.jsonl"
    out_dir.mkdir(parents=True, exist_ok=True)
    errors_path.unlink(missing_ok=True)
    review_path.unlink(missing_ok=True)

    deadline_path = out_dir / "deadline_candidates.jsonl.gz"
    calendar_path = out_dir / "calendar_event_candidates.jsonl.gz"
    non_deadline_path = out_dir / "non_deadline_publications.jsonl.gz"
    temp_deadline, deadline_handle = gzip_writer(deadline_path)
    temp_calendar, calendar_handle = gzip_writer(calendar_path)
    temp_non_deadline, non_deadline_handle = gzip_writer(non_deadline_path)
    counts = Counter()
    risk_counts = Counter()
    trigger_counts = Counter()
    review_written = 0
    raw_cache = RawItemCache(max_pages=12)
    started_at = now_iso()
    today = datetime.now(TZ).date()
    try:
        with open_jsonl(input_path) as input_handle, deadline_handle, calendar_handle, non_deadline_handle:
            for index, line in enumerate(input_handle, start=1):
                if args.limit and index > args.limit:
                    break
                if not line.strip():
                    continue
                try:
                    event = json.loads(line)
                    output_type, payload = classify_event(event, raw_cache, parser_run_id, today)
                    counts["total_publications_read"] += 1
                    if output_type == "deadline":
                        counts["deadline_candidates"] += 1
                        risk_counts[payload.get("risk_level") or "unknown"] += 1
                        trigger_counts[payload.get("trigger_type") or "unknown"] += 1
                        deadline_handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
                    elif output_type == "calendar":
                        counts["calendar_event_candidates"] += 1
                        risk_counts[payload.get("risk_level") or "unknown"] += 1
                        trigger_counts[payload.get("event_type") or "unknown"] += 1
                        calendar_handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
                        related_deadline = related_calendar_deadline(
                            event,
                            payload,
                            norm(clean_text(event.get("text"))),
                            parser_run_id,
                            today,
                        )
                        if related_deadline:
                            counts["deadline_candidates"] += 1
                            risk_counts[related_deadline.get("risk_level") or "unknown"] += 1
                            trigger_counts[related_deadline.get("trigger_type") or "unknown"] += 1
                            deadline_handle.write(json.dumps(related_deadline, ensure_ascii=False, separators=(",", ":")) + "\n")
                            if related_deadline.get("requires_human_review"):
                                counts["requires_human_review"] += 1
                                if review_written < args.review_sample:
                                    append_jsonl(review_path, related_deadline)
                                    review_written += 1
                            if related_deadline.get("requires_holiday_validation"):
                                counts["requires_holiday_validation"] += 1
                    else:
                        counts["non_deadline_publications"] += 1
                        non_deadline_handle.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
                    if payload.get("requires_human_review"):
                        counts["requires_human_review"] += 1
                        if review_written < args.review_sample:
                            append_jsonl(review_path, payload)
                            review_written += 1
                    if payload.get("requires_holiday_validation"):
                        counts["requires_holiday_validation"] += 1
                except Exception as exc:  # noqa: BLE001
                    append_jsonl(errors_path, {"line": index, "error": str(exc), "captured_at": now_iso()})
                    counts["errors"] += 1
        if args.dry_run:
            for path in (temp_deadline, temp_calendar, temp_non_deadline):
                path.unlink(missing_ok=True)
        else:
            temp_deadline.replace(deadline_path)
            temp_calendar.replace(calendar_path)
            temp_non_deadline.replace(non_deadline_path)
    except Exception:
        for path in (temp_deadline, temp_calendar, temp_non_deadline):
            path.unlink(missing_ok=True)
        raise
    manifest = {
        "run_id": parser_run_id,
        "source_publication_path": str(input_path),
        "target_date": target_date,
        "mode": args.mode,
        "parser_version": PARSER_VERSION,
        "rules_version": 2,
        "date_policy": "electronic_diary_next_business_day",
        "count_policy": "start_date_inclusive_business_days",
        "calendar_policy": "basic_weekdays",
        "dry_run": bool(args.dry_run),
        **{key: int(value) for key, value in counts.items()},
        "risk_counts": dict(risk_counts),
        "top_trigger_types": trigger_counts.most_common(20),
        "outputs": {
            "deadline_candidates": str(deadline_path),
            "calendar_event_candidates": str(calendar_path),
            "non_deadline_publications": str(non_deadline_path),
            "review_samples": str(review_path),
        },
        "started_at": started_at,
        "finished_at": now_iso(),
    }
    if not args.dry_run:
        write_json(manifest_path, manifest)
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Extrai candidatos de prazo dos PublicationEvents DJEN.")
    parser.add_argument("--date", required=True, help="Data alvo YYYY-MM-DD")
    parser.add_argument("--input", default="", help="Caminho para publication_events.jsonl(.gz)")
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    parser.add_argument("--out-dir", default="")
    parser.add_argument("--mode", choices=["all-publications", "subscribed-only"], default="all-publications")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--review-sample", type=int, default=200)
    args = parser.parse_args()
    manifest = process_file(args)
    print(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
