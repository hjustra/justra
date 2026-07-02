#!/usr/bin/env python3
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import sys
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402
DEFAULT_OUT_DIR = DATA_ROOT
TRIBUNAL_URL = "https://comunicaapi.pje.jus.br/api/v1/comunicacao/tribunal"
CADERNO_URL = "https://comunicaapi.pje.jus.br/api/v1/caderno/{court}/{date}/{medium}"
TZ = ZoneInfo("America/Sao_Paulo")
KNOWN_STATUSES = {"Processado", "Sem comunicacoes", "Sem comunica\u00e7\u00f5es", "Nao Processado", "N\u00e3o Processado", "Em processamento", "Cancelado"}
COURT_ORDER = ["TST"] + [f"TRT{index}" for index in range(1, 25)]


def now_iso() -> str:
    return datetime.now(TZ).isoformat(timespec="seconds")


def utcish_run_id() -> str:
    return datetime.now(TZ).strftime("djen_%Y%m%d_%H%M%S")


def parse_br_date(value: str | None) -> str:
    if not value:
        return ""
    value = value.strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return value
    if re.fullmatch(r"\d{2}/\d{2}/\d{4}", value):
        day, month, year = value.split("/")
        return f"{year}-{month}-{day}"
    return ""


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


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


class DjenClient:
    def __init__(self, request_log: Path, timeout: int = 120) -> None:
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": "JustraDjenLaborCrawler/0.1 (+https://comunica.pje.jus.br/)",
                "Accept": "application/json,*/*",
            }
        )
        self.request_log = request_log
        self.timeout = timeout

    def request_json(self, url: str, *, stage: str, court: str = "", medium: str = "") -> dict[str, Any]:
        started = time.perf_counter()
        response = self.session.get(url, timeout=self.timeout)
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        self.log_request(stage, url, response.status_code, elapsed_ms, len(response.content), court, medium)
        if response.status_code == 429:
            retry_after = response.headers.get("retry-after")
            if retry_after and retry_after.isdigit():
                time.sleep(min(int(retry_after), 120))
        response.raise_for_status()
        return response.json()

    def download(self, url: str, path: Path, *, court: str, medium: str) -> None:
        started = time.perf_counter()
        with self.session.get(url, timeout=self.timeout, stream=True) as response:
            elapsed_ms = round((time.perf_counter() - started) * 1000)
            size = int(response.headers.get("content-length") or 0)
            self.log_request("download_zip", url, response.status_code, elapsed_ms, size, court, medium)
            if response.status_code == 429:
                retry_after = response.headers.get("retry-after")
                if retry_after and retry_after.isdigit():
                    time.sleep(min(int(retry_after), 120))
            response.raise_for_status()
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            with temporary.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        handle.write(chunk)
            temporary.replace(path)

    def log_request(self, stage: str, url: str, status: int, elapsed_ms: int, response_bytes: int, court: str, medium: str) -> None:
        append_jsonl(
            self.request_log,
            {
                "captured_at": now_iso(),
                "stage": stage,
                "court": court,
                "medium": medium,
                "status": status,
                "elapsed_ms": elapsed_ms,
                "response_bytes": response_bytes,
                "url": url.split("?")[0],
            },
        )


def expected_courts() -> list[str]:
    return COURT_ORDER[:]


def flatten_labor_courts(groups: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    courts: dict[str, dict[str, Any]] = {}
    for group in groups:
        for item in group.get("instituicoes") or []:
            acronym = str(item.get("sigla") or "").strip()
            if not re.fullmatch(r"TST|TRT\d{1,2}", acronym):
                continue
            current = courts.get(acronym, {})
            published_date = parse_br_date(str(item.get("dataUltimoEnvio") or ""))
            ufs = set(current.get("ufs") or [])
            if group.get("uf"):
                ufs.add(str(group.get("uf")))
            courts[acronym] = {
                "sigla": acronym,
                "nome": item.get("nome") or current.get("nome") or "",
                "dataUltimoEnvio": item.get("dataUltimoEnvio") or current.get("dataUltimoEnvio") or "",
                "published_date": published_date or current.get("published_date") or "",
                "ufs": sorted(ufs),
            }
    return courts


def selected_courts(all_courts: dict[str, dict[str, Any]], courts_arg: str) -> list[dict[str, Any]]:
    if courts_arg:
        requested = [item.strip().upper() for item in courts_arg.split(",") if item.strip()]
    else:
        requested = expected_courts()
    result = []
    for acronym in requested:
        if acronym not in all_courts:
            result.append({"sigla": acronym, "missing": True, "published_date": ""})
        else:
            result.append(all_courts[acronym])
    return result


def normalize_recipients(items: Any) -> list[dict[str, Any]]:
    role_map = {"A": "active", "P": "passive", "T": "third_party"}
    rows = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("nome") or "")).strip()
        if not name:
            continue
        rows.append(
            {
                "name": name,
                "role": role_map.get(str(item.get("polo") or "").strip().upper(), "unknown"),
            }
        )
    return rows[:24]


def normalize_recipient_attorneys(items: Any) -> list[dict[str, Any]]:
    rows = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        attorney = item.get("advogado") if isinstance(item.get("advogado"), dict) else {}
        name = re.sub(r"\s+", " ", str(attorney.get("nome") or "")).strip()
        oab = re.sub(r"\D", "", str(attorney.get("numero_oab") or ""))
        uf = re.sub(r"[^A-Za-z]", "", str(attorney.get("uf_oab") or "")).upper()[:2]
        if name or oab:
            rows.append({"name": name, "oab": oab, "uf": uf})
    return rows[:40]


def normalize_item(item: dict[str, Any], *, run_id: str, raw_path: str) -> dict[str, Any]:
    return {
        "source": "djen_comunica_pje",
        "source_run_id": run_id,
        "communication_id": item.get("id"),
        "communication_hash": item.get("hash"),
        "numero_comunicacao": item.get("numeroComunicacao"),
        "process_number": item.get("numero_processo"),
        "process_number_masked": item.get("numeroprocessocommascara"),
        "court_acronym": item.get("siglaTribunal"),
        "court_unit": item.get("nomeOrgao"),
        "court_unit_id": item.get("idOrgao"),
        "publication_date": item.get("data_disponibilizacao"),
        "sent_date": item.get("dataenvio"),
        "communication_type": item.get("tipoComunicacao"),
        "document_type": item.get("tipoDocumento"),
        "class_name": item.get("nomeClasse"),
        "class_code": item.get("codigoClasse"),
        "medium": item.get("meio"),
        "medium_full": item.get("meiocompleto"),
        "status": item.get("status"),
        "active": item.get("ativo"),
        "text": item.get("texto"),
        "recipients": normalize_recipients(item.get("destinatarios")),
        "recipient_attorneys": normalize_recipient_attorneys(item.get("destinatarioadvogados")),
        "source_url": item.get("link"),
        "raw_path": raw_path,
        "first_seen_at": now_iso(),
    }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def version_dir(raw_day_dir: Path, court: str, medium: str, version: str | int | None) -> Path:
    label = str(version or "1").strip() or "1"
    label = re.sub(r"[^A-Za-z0-9_.-]+", "_", label)
    return raw_day_dir / court / medium / f"v{label}"


def extract_and_normalize(zip_path: Path, caderno_dir: Path, run_id: str) -> int:
    normalized_path = caderno_dir / "normalized_events.jsonl.gz"
    temporary = normalized_path.with_suffix(".jsonl.gz.tmp")
    total = 0
    with zipfile.ZipFile(zip_path) as archive, gzip.open(temporary, "wt", encoding="utf-8") as output:
        names = [name for name in archive.namelist() if name.lower().endswith(".json")]
        for name in sorted(names):
            payload = archive.read(name)
            page = json.loads(payload.decode("utf-8"))
            for item in page.get("items") or []:
                normalized = normalize_item(item, run_id=run_id, raw_path=f"{zip_path.relative_to(ROOT)}::{name}")
                output.write(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")) + "\n")
                total += 1
    temporary.replace(normalized_path)
    return total


def aggregate_day(raw_day_dir: Path, processed_day_dir: Path) -> int:
    target = processed_day_dir / "publication_events.jsonl.gz"
    temporary = target.with_suffix(".jsonl.gz.tmp")
    total = 0
    try:
        with gzip.open(temporary, "wt", encoding="utf-8") as output:
            paths = sorted(raw_day_dir.glob("*/*/v*/normalized_events.jsonl")) + sorted(raw_day_dir.glob("*/*/v*/normalized_events.jsonl.gz"))
            for normalized in paths:
                opener = gzip.open if normalized.suffix == ".gz" else open
                with opener(normalized, "rt", encoding="utf-8") as handle:
                    for line in handle:
                        if line.strip():
                            output.write(line)
                            total += 1
        temporary.replace(target)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise
    return total


def read_pending(processed_day_dir: Path) -> set[tuple[str, str]]:
    payload = load_json(processed_day_dir / "pending_cadernos.json", [])
    pending = set()
    for item in payload if isinstance(payload, list) else []:
        court = str(item.get("court_acronym") or item.get("sigla") or "").strip().upper()
        medium = str(item.get("medium") or item.get("meio") or "").strip().upper()
        if court and medium:
            pending.add((court, medium))
    return pending


def run(args: argparse.Namespace) -> dict[str, Any]:
    out_dir = Path(args.out_dir).resolve()
    run_id = utcish_run_id()
    run_date = datetime.now(TZ).date().isoformat()
    requested_date = str(args.date or "").strip()
    target_date_hint = requested_date or run_date
    year, month, day = date_parts(target_date_hint)
    processed_day_dir = out_dir / "processed" / "djen" / year / month / day
    raw_day_dir = out_dir / "raw" / "djen" / year / month / day
    processed_day_dir.mkdir(parents=True, exist_ok=True)
    request_log = processed_day_dir / "requests.jsonl"
    client = DjenClient(request_log)
    errors: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []
    courts_summary: list[dict[str, Any]] = []
    totals = {
        "expected": 0,
        "processed": 0,
        "empty": 0,
        "pending": 0,
        "errors": 0,
        "publications": 0,
    }

    def record_error(court: str, medium: str, stage: str, exc: Exception, retryable: bool = True) -> None:
        error = {
            "run_id": run_id,
            "timestamp": now_iso(),
            "court_acronym": court,
            "medium": medium,
            "published_date": requested_date or "",
            "stage": stage,
            "error_type": exc.__class__.__name__,
            "message": str(exc),
            "retryable": retryable,
        }
        errors.append(error)
        append_jsonl(processed_day_dir / "errors.jsonl", error)

    tribunal_groups = client.request_json(TRIBUNAL_URL, stage="tribunals")
    all_labor = flatten_labor_courts(tribunal_groups)
    courts = selected_courts(all_labor, args.courts)
    mediums = [item.strip().upper() for item in args.mediums.split(",") if item.strip()] or ["D", "E"]
    retry_only = read_pending(processed_day_dir) if args.retry_pending else set()

    for court_payload in courts:
        court = str(court_payload.get("sigla") or "").strip().upper()
        published_date = requested_date or str(court_payload.get("published_date") or "")
        court_summary = {
            "sigla": court,
            "nome": court_payload.get("nome") or "",
            "published_date": published_date,
            "missing_from_tribunals": bool(court_payload.get("missing")),
            "meios": {},
        }
        courts_summary.append(court_summary)
        if court_payload.get("missing"):
            pending.append({"court_acronym": court, "medium": "", "reason": "missing_from_tribunals", "published_date": ""})
            continue
        if not published_date:
            pending.append({"court_acronym": court, "medium": "", "reason": "missing_published_date", "published_date": ""})
            continue
        if not requested_date and published_date != run_date:
            for medium in mediums:
                if retry_only and (court, medium) not in retry_only:
                    continue
                totals["expected"] += 1
                court_summary["meios"][medium] = {"state": "waiting_for_publication", "published_date": published_date}
                pending.append({"court_acronym": court, "medium": medium, "reason": "waiting_for_publication", "published_date": published_date})
            continue
        if requested_date and published_date != requested_date:
            published_date = requested_date

        for medium in mediums:
            if medium not in {"D", "E"}:
                record_error(court, medium, "validate_medium", ValueError("meio deve ser D ou E"), retryable=False)
                continue
            if retry_only and (court, medium) not in retry_only:
                continue
            totals["expected"] += 1
            try:
                meta = client.request_json(CADERNO_URL.format(court=court, date=published_date, medium=medium), stage="caderno_meta", court=court, medium=medium)
                caderno_dir = version_dir(raw_day_dir, court, medium, meta.get("versao"))
                caderno_dir.mkdir(parents=True, exist_ok=True)
                write_json(caderno_dir / "caderno_meta.json", meta)
                status = str(meta.get("status") or "")
                total_comunicacoes = int(meta.get("total_comunicacoes") or 0)
                medium_summary = {
                    "status": status,
                    "versao": meta.get("versao"),
                    "total_comunicacoes": total_comunicacoes,
                    "numero_paginas": int(meta.get("numero_paginas") or 0),
                    "hash": meta.get("hash") or "",
                    "downloaded": False,
                    "normalized_count": 0,
                }
                court_summary["meios"][medium] = medium_summary
                if status not in KNOWN_STATUSES:
                    pending.append({"court_acronym": court, "medium": medium, "reason": f"unknown_status:{status}", "published_date": published_date})
                    continue
                if status in {"Sem comunicacoes", "Sem comunica\u00e7\u00f5es"} or total_comunicacoes == 0:
                    totals["empty"] += 1
                    write_json(caderno_dir / "manifest.json", {**medium_summary, "state": "empty", "run_id": run_id})
                    continue
                if status != "Processado":
                    totals["pending"] += 1
                    pending.append({"court_acronym": court, "medium": medium, "reason": status, "published_date": published_date})
                    continue
                if args.dry_run:
                    totals["pending"] += 1
                    pending.append({"court_acronym": court, "medium": medium, "reason": "dry_run_not_downloaded", "published_date": published_date})
                    continue

                zip_path = caderno_dir / "caderno.zip"
                existing_manifest = load_json(caderno_dir / "manifest.json", {})
                same_file = (
                    zip_path.exists()
                    and existing_manifest.get("hash") == medium_summary["hash"]
                    and existing_manifest.get("versao") == medium_summary["versao"]
                    and ((caderno_dir / "normalized_events.jsonl.gz").exists() or (caderno_dir / "normalized_events.jsonl").exists())
                )
                if same_file:
                    normalized_count = int(existing_manifest.get("normalized_count") or 0)
                else:
                    url = str(meta.get("url") or "")
                    if not url:
                        raise RuntimeError("caderno processado sem URL temporaria")
                    client.download(url, zip_path, court=court, medium=medium)
                    expected_size = int(meta.get("tamanho_bytes") or 0)
                    if expected_size and zip_path.stat().st_size != expected_size:
                        raise RuntimeError(f"tamanho do ZIP diverge: {zip_path.stat().st_size} != {expected_size}")
                    expected_hash = str(meta.get("hash") or "")
                    if expected_hash:
                        actual_hash = sha256_file(zip_path)
                        if actual_hash != expected_hash:
                            raise RuntimeError(f"hash do ZIP diverge: {actual_hash} != {expected_hash}")
                    normalized_count = extract_and_normalize(zip_path, caderno_dir, run_id)
                if normalized_count != total_comunicacoes:
                    raise RuntimeError(f"contagem normalizada diverge: {normalized_count} != {total_comunicacoes}")
                medium_summary["downloaded"] = True
                medium_summary["normalized_count"] = normalized_count
                write_json(caderno_dir / "manifest.json", {**medium_summary, "state": "complete", "run_id": run_id})
                totals["processed"] += 1
                totals["publications"] += normalized_count
            except Exception as exc:  # noqa: BLE001
                totals["errors"] += 1
                totals["pending"] += 1
                pending.append({"court_acronym": court, "medium": medium, "reason": "error", "published_date": published_date})
                record_error(court, medium, "caderno", exc)
            time.sleep(max(float(args.sleep), 0.0))

    if not args.dry_run:
        aggregate_date = requested_date or target_date_hint
        year, month, day = date_parts(aggregate_date)
        aggregate_raw_dir = out_dir / "raw" / "djen" / year / month / day
        aggregate_processed_dir = out_dir / "processed" / "djen" / year / month / day
        if aggregate_raw_dir.exists():
            totals["publications"] = aggregate_day(aggregate_raw_dir, aggregate_processed_dir)

    totals["pending"] = len(pending)
    totals["errors"] = len(errors)
    manifest = {
        "run_id": run_id,
        "started_at": getattr(args, "started_at", now_iso()),
        "finished_at": now_iso(),
        "timezone": "America/Sao_Paulo",
        "target_date": requested_date or target_date_hint,
        "source": "comunicaapi.pje.jus.br",
        "dry_run": bool(args.dry_run),
        "retry_pending": bool(args.retry_pending),
        "total_courts": len(courts),
        "total_cadernos_expected": totals["expected"],
        "total_cadernos_processed": totals["processed"],
        "total_cadernos_empty": totals["empty"],
        "total_cadernos_pending": totals["pending"],
        "total_publications": totals["publications"],
        "courts": courts_summary,
        "errors": errors,
    }
    write_json(processed_day_dir / "pending_cadernos.json", pending)
    write_json(processed_day_dir / "crawler_manifest.json", manifest)
    return manifest


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Baixa cadernos diarios do DJEN/Comunica para TST e TRTs.")
    parser.add_argument("--date", default="", help="Data alvo em YYYY-MM-DD. Padrao: data publicada no Comunica.")
    parser.add_argument("--courts", default="", help="Lista separada por virgula. Ex.: TST,TRT2")
    parser.add_argument("--mediums", default="D,E", help="Meios separados por virgula. Padrao: D,E")
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR), help="Diretorio base de saida. Padrao: JUSTRA_DATA_DIR ou ./data")
    parser.add_argument("--retry-pending", action="store_true", help="Processa apenas cadernos pendentes da data alvo.")
    parser.add_argument("--dry-run", action="store_true", help="Consulta metadados sem baixar ZIPs.")
    parser.add_argument("--sleep", type=float, default=0.25, help="Pausa entre cadernos, em segundos.")
    args = parser.parse_args(argv)
    args.started_at = now_iso()
    if args.date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.date):
        parser.error("--date deve usar YYYY-MM-DD")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    manifest = run(args)
    print(
        json.dumps(
            {
                "run_id": manifest["run_id"],
                "target_date": manifest["target_date"],
                "processed": manifest["total_cadernos_processed"],
                "empty": manifest["total_cadernos_empty"],
                "pending": manifest["total_cadernos_pending"],
                "publications": manifest["total_publications"],
                "dry_run": manifest["dry_run"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if not manifest["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
