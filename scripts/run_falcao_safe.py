#!/usr/bin/env python3
"""Fail-closed launch wrapper for the cautious Falcão collector."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_timestamp(value: object) -> dt.datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def last_block_at(requests_paths: list[Path]) -> dt.datetime | None:
    latest = None
    for requests_path in requests_paths:
        if not requests_path.exists():
            continue
        with requests_path.open("r", encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    continue
                if int(row.get("status") or 0) not in {403, 429}:
                    continue
                captured = parse_timestamp(row.get("captured_at"))
                if captured and (latest is None or captured > latest):
                    latest = captured
    return latest


def read_control(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload if isinstance(payload, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def checkpoint_cooldown(checkpoint_path: Path) -> dt.datetime | None:
    if not checkpoint_path.exists():
        return None
    try:
        checkpoint = json.loads(checkpoint_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return parse_timestamp(checkpoint.get("cooldown_until"))


def iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--node", required=True)
    parser.add_argument("--script", required=True)
    parser.add_argument("--output-tag", required=True)
    parser.add_argument("--minimum-block-free-minutes", type=int, required=True)
    parser.add_argument("--control-path", required=True)
    parser.add_argument("collector_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()

    output_dir = DATA_ROOT / "raw" / "falcao" / args.output_tag
    output_dir.mkdir(parents=True, exist_ok=True)
    scheduler_status = output_dir / "scheduler_status.json"
    lock_path = output_dir / "scheduler.lock"
    lock_stream = lock_path.open("a+", encoding="utf-8")
    os.chmod(lock_path, 0o600)
    try:
        fcntl.flock(lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        atomic_json(
            scheduler_status,
            {"event": "already_running", "checked_at": iso(utc_now())},
        )
        print(json.dumps({"event": "already_running"}), flush=True)
        return 0


    control_path = Path(args.control_path).resolve()
    control = read_control(control_path)
    if not control.get("enabled", False) or control.get("blocked", False):
        payload = {
            "event": "paused_by_control",
            "checked_at": iso(utc_now()),
            "network_requests": 0,
            "control_path": str(control_path),
        }
        atomic_json(scheduler_status, payload)
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        return 0

    requests_path = output_dir / "requests.jsonl"
    checkpoint_path = output_dir / "checkpoint.json"
    request_histories = list((DATA_ROOT / "raw" / "falcao").glob("**/requests.jsonl"))
    blocked_at = last_block_at(request_histories)
    control_blocked_at = parse_timestamp(control.get("last_block_at"))
    if control_blocked_at and (blocked_at is None or control_blocked_at > blocked_at):
        blocked_at = control_blocked_at
    safe_after = (
        blocked_at
        + dt.timedelta(minutes=max(0, args.minimum_block_free_minutes))
        if blocked_at
        else None
    )
    stored_cooldown = checkpoint_cooldown(checkpoint_path)
    candidates = [value for value in (safe_after, stored_cooldown) if value]
    not_before = max(candidates) if candidates else None
    now = utc_now()
    common = {
        "checked_at": iso(now),
        "last_block_at": iso(blocked_at),
        "not_before": iso(not_before),
        "minimum_block_free_minutes": args.minimum_block_free_minutes,
    }
    if not_before and now < not_before:
        payload = {"event": "cooldown", **common, "network_requests": 0}
        atomic_json(scheduler_status, payload)
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        return 0

    collector_args = [value for value in args.collector_args if value != "--"]
    command = [
        args.node,
        args.script,
        "--output-tag",
        args.output_tag,
        "--minimum-block-free-minutes",
        str(args.minimum_block_free_minutes),
        "--control-path",
        str(control_path),
        *collector_args,
    ]
    validation = subprocess.run(
        [*command, "--validate-only"],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=45,
        check=False,
    )
    if validation.returncode != 0:
        payload = {
            "event": "configuration_rejected",
            **common,
            "network_requests": 0,
            "returncode": validation.returncode,
            "stderr": validation.stderr[-2000:],
        }
        atomic_json(scheduler_status, payload)
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        return 1

    atomic_json(
        scheduler_status,
        {"event": "collector_started", **common, "command_validated": True},
    )
    completed = subprocess.run(
        command,
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        check=False,
    )
    atomic_json(
        scheduler_status,
        {
            "event": "collector_finished",
            **common,
            "finished_at": iso(utc_now()),
            "returncode": completed.returncode,
        },
    )
    return completed.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.TimeoutExpired as error:
        output = {
            "event": "configuration_timeout",
            "checked_at": iso(utc_now()),
            "network_requests": 0,
            "timeout_seconds": error.timeout,
        }
        print(json.dumps(output), flush=True)
        raise SystemExit(1)
