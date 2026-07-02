from __future__ import annotations

import argparse
import base64
import csv
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.collectors.pje_trt2 import PjePublicClient, format_cnj_number, is_captcha_challenge, only_digits


DEFAULT_INPUT = ROOT / "data" / "cases" / "guarulhos_horas_extras" / "processed" / "processes.csv"
DEFAULT_OUTPUT = ROOT / "data" / "cases" / "guarulhos_horas_extras" / "pje_public"


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


@dataclass
class PersistentRateLimiter:
    state_path: Path
    max_per_minute: int = 5
    max_per_hour: int = 120

    def __post_init__(self) -> None:
        self.events = read_json(self.state_path, {"events": []}).get("events", [])

    def _save(self) -> None:
        write_json(self.state_path, {"updated_at": now_iso(), "events": self.events})

    def _prune(self, current: float) -> None:
        self.events = [event for event in self.events if current - float(event["ts"]) < 3600]

    def wait(self, label: str) -> None:
        while True:
            current = time.time()
            self._prune(current)
            minute_count = sum(1 for event in self.events if current - float(event["ts"]) < 60)
            hour_count = len(self.events)
            waits = []
            if minute_count >= self.max_per_minute:
                oldest_minute = min(float(event["ts"]) for event in self.events if current - float(event["ts"]) < 60)
                waits.append(60 - (current - oldest_minute) + 0.25)
            if hour_count >= self.max_per_hour:
                oldest_hour = min(float(event["ts"]) for event in self.events)
                waits.append(3600 - (current - oldest_hour) + 0.25)
            if not waits:
                self.events.append({"ts": current, "label": label})
                self._save()
                return
            time.sleep(max(0.25, max(waits)))


def read_process_rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8") as file:
        return list(csv.DictReader(file))


def save_captcha_challenge(
    output_dir: Path,
    process_number: str,
    process_id: int | str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    challenge_dir = output_dir / "captcha_queue"
    ensure_dir(challenge_dir)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = f"{timestamp}_{only_digits(process_number)}_{process_id}"
    image_payload = str(payload.get("imagem", ""))
    if "," in image_payload and image_payload.startswith("data:"):
        image_payload = image_payload.split(",", 1)[1]
    image_path = challenge_dir / f"{stem}.jpg"
    image_path.write_bytes(base64.b64decode(image_payload))

    job = {
        "created_at": now_iso(),
        "status": "requires_manual_captcha",
        "process_number": only_digits(process_number),
        "process_number_formatted": format_cnj_number(process_number),
        "process_id": process_id,
        "tokenDesafio": payload.get("tokenDesafio"),
        "captcha_image_path": str(image_path),
        "instruction": (
            "Resolver manualmente no fluxo publico/autorizado. "
            "Este projeto nao automatiza OCR, bypass ou servico de quebra de captcha."
        ),
    }
    job_path = challenge_dir / f"{stem}.json"
    write_json(job_path, job)
    return {"job_path": str(job_path), "image_path": str(image_path), "tokenDesafio": payload.get("tokenDesafio")}


def should_skip(manifest: dict[str, Any], process_number: str, force: bool) -> bool:
    if force:
        return False
    status = manifest.get("processes", {}).get(process_number, {}).get("status")
    return status in {"details_saved", "requires_manual_captcha", "no_public_basic_data"}


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Coleta publica segura do PJe TRT2: rate limit persistente, dedupe e fila manual de captcha. "
            "Nao automatiza bypass de captcha."
        )
    )
    parser.add_argument("--input", default=str(DEFAULT_INPUT))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT))
    parser.add_argument("--max-processes", type=int, default=10)
    parser.add_argument("--max-per-minute", type=int, default=5)
    parser.add_argument("--max-per-hour", type=int, default=120)
    parser.add_argument("--instance", type=int, default=1)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--continue-after-captcha", action="store_true")
    parser.add_argument("--continue-after-rate-limit", action="store_true")
    parser.add_argument("--rate-limit-backoff-seconds", type=int, default=900)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_dir = Path(args.output_dir)
    ensure_dir(output_dir)
    ensure_dir(output_dir / "basic")
    ensure_dir(output_dir / "details")
    ensure_dir(output_dir / "errors")

    manifest_path = output_dir / "manifest.json"
    manifest = read_json(manifest_path, {"created_at": now_iso(), "processes": {}})
    manifest.setdefault("processes", {})
    manifest["updated_at"] = now_iso()
    manifest["policy"] = {
        "max_per_minute": args.max_per_minute,
        "max_per_hour": args.max_per_hour,
        "captcha": "manual_only_no_bypass",
    }

    rows = read_process_rows(input_path)
    rows = rows[: args.max_processes] if args.max_processes else rows
    if args.dry_run:
        print(json.dumps({"input": str(input_path), "output_dir": str(output_dir), "planned_rows": len(rows)}, indent=2))
        return

    limiter = PersistentRateLimiter(
        state_path=output_dir / "rate_limit_state.json",
        max_per_minute=args.max_per_minute,
        max_per_hour=args.max_per_hour,
    )
    client = PjePublicClient()

    summary = {
        "processed": 0,
        "skipped": 0,
        "basic_saved": 0,
        "details_saved": 0,
        "captcha_jobs": 0,
        "errors": 0,
        "rate_limited_or_blocked": 0,
        "stopped_on_captcha": False,
        "stopped_on_rate_limit": False,
    }

    for row in rows:
        process_number = only_digits(row.get("numero_processo", ""))
        if not process_number:
            continue
        if should_skip(manifest, process_number, args.force):
            summary["skipped"] += 1
            continue

        entry = {
            "updated_at": now_iso(),
            "process_number": process_number,
            "process_number_formatted": format_cnj_number(process_number),
            "source_csv_url": row.get("pje_url", ""),
            "status": "started",
        }
        try:
            limiter.wait("pje_basic_data")
            basic = client.get_basic_data(process_number, instance=args.instance)
            basic_path = output_dir / "basic" / f"{process_number}.json"
            write_json(basic_path, basic)
            summary["basic_saved"] += 1
            entry["basic_path"] = str(basic_path)

            if not basic:
                entry["status"] = "no_public_basic_data"
                manifest["processes"][process_number] = entry
                write_json(manifest_path, manifest)
                summary["processed"] += 1
                continue

            process_id = basic[0]["id"]
            entry["process_id"] = process_id
            limiter.wait("pje_detail")
            details = client.get_details(process_id, instance=args.instance)

            if is_captcha_challenge(details):
                challenge = save_captcha_challenge(output_dir, process_number, process_id, details)
                entry.update(challenge)
                entry["status"] = "requires_manual_captcha"
                manifest["processes"][process_number] = entry
                write_json(manifest_path, manifest)
                summary["captcha_jobs"] += 1
                summary["processed"] += 1
                if not args.continue_after_captcha:
                    summary["stopped_on_captcha"] = True
                    break
                continue

            detail_path = output_dir / "details" / f"{process_number}.json"
            write_json(detail_path, details)
            entry["detail_path"] = str(detail_path)
            entry["status"] = "details_saved"
            entry["document_count"] = len(details.get("itensProcesso", []) or []) if isinstance(details, dict) else 0
            summary["details_saved"] += 1
            summary["processed"] += 1
        except requests.HTTPError as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if status_code in {403, 429, 503}:
                entry["status"] = "rate_limited_or_blocked"
                entry["http_status"] = status_code
                entry["backoff_seconds"] = args.rate_limit_backoff_seconds
                summary["rate_limited_or_blocked"] += 1
                summary["processed"] += 1
                if not args.continue_after_rate_limit:
                    summary["stopped_on_rate_limit"] = True
                    manifest["processes"][process_number] = entry
                    manifest["updated_at"] = now_iso()
                    write_json(manifest_path, manifest)
                    break
                time.sleep(args.rate_limit_backoff_seconds)
                continue
            error_path = output_dir / "errors" / f"{process_number}.json"
            write_json(error_path, {"created_at": now_iso(), "process_number": process_number, "error": str(exc)})
            entry["status"] = "error"
            entry["error_path"] = str(error_path)
            entry["error"] = str(exc)
            summary["errors"] += 1
            summary["processed"] += 1
        except Exception as exc:  # noqa: BLE001
            error_path = output_dir / "errors" / f"{process_number}.json"
            write_json(error_path, {"created_at": now_iso(), "process_number": process_number, "error": str(exc)})
            entry["status"] = "error"
            entry["error_path"] = str(error_path)
            entry["error"] = str(exc)
            summary["errors"] += 1
            summary["processed"] += 1
        finally:
            manifest["processes"][process_number] = entry
            manifest["updated_at"] = now_iso()
            write_json(manifest_path, manifest)

    summary["manifest_path"] = str(manifest_path)
    summary["output_dir"] = str(output_dir)
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
