#!/usr/bin/env python3
"""Run Falcao collection from an allowed VPS and import the raw batch in Azure."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
from justra_runtime_paths import DATA_ROOT, LOG_ROOT  # noqa: E402


APP_TZ = ZoneInfo("America/Sao_Paulo")
DEFAULT_COLLECTIONS = "acordaos,sentencas,decisoesmonocraticas,recursorevista,precedentes"
DEFAULT_CONTROL = {
    "enabled": True,
    "mode": "d-1",
    "schedule": "08:00,12:00,18:00,23:00",
    "min_delay_ms": 30_000,
    "max_delay_ms": 90_000,
    "page_size": 10,
    "stop_on_block": True,
    "blocked": False,
    "consecutive_429_count": 0,
    "strategy_review_required": False,
    "last_block_at": "",
    "updated_at": "",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def today_local() -> dt.date:
    return dt.datetime.now(APP_TZ).date()


def plan_window(days: int) -> tuple[dt.date, dt.date]:
    end = today_local() - dt.timedelta(days=1)
    start = end - dt.timedelta(days=max(1, days) - 1)
    return start, end


def atomic_json(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def load_json(path: Path) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def ensure_control(path: Path) -> dict[str, object]:
    current = load_json(path)
    merged = {**DEFAULT_CONTROL, **current}
    if merged != current:
        merged["updated_at"] = merged.get("updated_at") or now_iso()
        atomic_json(path, merged)
    return merged


def update_control_policy(path: Path, args: argparse.Namespace) -> dict[str, object]:
    current = ensure_control(path)
    updates: dict[str, object] = {
        "min_delay_ms": args.min_delay_ms,
        "max_delay_ms": args.max_delay_ms,
        "request_budget": args.request_budget,
        "block_free_minutes": args.minimum_block_free_minutes,
        "collections": args.collections.split(","),
    }
    schedule = os.getenv("FALCAO_SCHEDULE", "").strip()
    if schedule:
        updates["schedule"] = schedule
    merged = {**current, **updates, "updated_at": now_iso()}
    if merged != current:
        atomic_json(path, merged)
    return merged


def run(command: list[str], *, env: dict[str, str] | None = None, timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def run_passthrough(command: list[str], *, env: dict[str, str]) -> int:
    with (
        (LOG_ROOT / "falcao-remote-worker.log").open("a", encoding="utf-8") as stdout,
        (LOG_ROOT / "falcao-remote-worker-error.log").open("a", encoding="utf-8") as stderr,
    ):
        completed = subprocess.run(
            command,
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            check=False,
        )
    return completed.returncode


def line_count(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open(encoding="utf-8") as handle:
        return sum(1 for line in handle if line.strip())


def daily_date_from_name(path: Path) -> dt.date | None:
    if not path.name.startswith("daily_"):
        return None
    try:
        return dt.date.fromisoformat(path.name.removeprefix("daily_"))
    except ValueError:
        return None


def choose_target_date(plan_days: int) -> dt.date:
    """Resume the oldest incomplete daily run before opening a new D-1 run."""
    raw_root = DATA_ROOT / "raw" / "falcao"
    start, end = plan_window(plan_days)
    incomplete: list[dt.date] = []
    if raw_root.exists():
        for directory in raw_root.iterdir():
            if not directory.is_dir():
                continue
            day = daily_date_from_name(directory)
            if day is None or day < start or day > end:
                continue
            status = load_json(directory / "status.json")
            checkpoint = load_json(directory / "checkpoint.json")
            has_run_evidence = bool(status or checkpoint or (directory / "requests.jsonl").exists())
            if has_run_evidence and not status.get("complete"):
                incomplete.append(day)
    return min(incomplete) if incomplete else end


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Hostinger Falcao worker with Azure import.")
    parser.add_argument("--start-date", default=os.getenv("FALCAO_START_DATE", ""))
    parser.add_argument("--end-date", default=os.getenv("FALCAO_END_DATE", ""))
    parser.add_argument("--mode", default=os.getenv("FALCAO_MODE", "d-1"))
    parser.add_argument("--output-tag", default=os.getenv("FALCAO_OUTPUT_TAG", ""))
    parser.add_argument("--collections", default=os.getenv("FALCAO_COLLECTIONS", DEFAULT_COLLECTIONS))
    parser.add_argument("--api-mode", default=os.getenv("FALCAO_API_MODE", "no-auth"))
    parser.add_argument("--api-path", default=os.getenv("FALCAO_API_PATH", ""))
    parser.add_argument("--request-budget", type=int, default=int(os.getenv("FALCAO_REQUEST_BUDGET", "0")))
    parser.add_argument("--min-delay-ms", type=int, default=int(os.getenv("FALCAO_MIN_DELAY_MS", "30000")))
    parser.add_argument("--max-delay-ms", type=int, default=int(os.getenv("FALCAO_MAX_DELAY_MS", "90000")))
    parser.add_argument("--minimum-block-free-minutes", type=int, default=int(os.getenv("FALCAO_BLOCK_FREE_MINUTES", "1440")))
    parser.add_argument("--node", default=os.getenv("JUSTRA_NODE_BIN", shutil.which("node") or "node"))
    parser.add_argument("--node-modules", default=os.getenv("JUSTRA_NODE_MODULES", ""))
    parser.add_argument("--playwright-browsers-path", default=os.getenv("PLAYWRIGHT_BROWSERS_PATH", ""))
    parser.add_argument("--control-path", default=os.getenv("FALCAO_CONTROL_PATH", str(DATA_ROOT / "app" / "falcao_control.json")))
    parser.add_argument("--worker-status", default=os.getenv("FALCAO_WORKER_STATUS", str(DATA_ROOT / "app" / "falcao_remote_worker.json")))
    parser.add_argument("--azure-target", default=os.getenv("FALCAO_AZURE_TARGET", ""))
    parser.add_argument("--azure-key", default=os.getenv("FALCAO_AZURE_KEY", ""))
    parser.add_argument("--azure-app-dir", default=os.getenv("FALCAO_AZURE_APP_DIR", "/opt/justra/app"))
    parser.add_argument("--azure-data-dir", default=os.getenv("FALCAO_AZURE_DATA_DIR", "/mnt/justra-data"))
    parser.add_argument("--azure-service", default=os.getenv("FALCAO_AZURE_SERVICE", "justra"))
    parser.add_argument("--plan-days", type=int, default=int(os.getenv("FALCAO_PLAN_DAYS", "90")))
    parser.add_argument("--skip-sync", action="store_true", default=os.getenv("FALCAO_SKIP_SYNC", "0") == "1")
    parser.add_argument("--skip-import", action="store_true", default=os.getenv("FALCAO_SKIP_IMPORT", "0") == "1")
    args = parser.parse_args()
    if not args.start_date and args.mode == "d-1":
        args.start_date = choose_target_date(args.plan_days).isoformat()
    if not args.start_date:
        args.start_date = (today_local() - dt.timedelta(days=1)).isoformat()
    args.end_date = args.end_date or args.start_date
    if not args.output_tag:
      args.output_tag = (
          f"daily_{args.start_date}"
          if args.mode == "d-1" and args.start_date == args.end_date
          else f"backfill_{args.start_date}_{args.end_date}"
      )
    return args


def build_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    env["JUSTRA_DATA_DIR"] = str(DATA_ROOT)
    env["JUSTRA_LOG_DIR"] = str(LOG_ROOT)
    if args.node_modules:
        env["JUSTRA_NODE_MODULES"] = args.node_modules
    if args.playwright_browsers_path:
        env["PLAYWRIGHT_BROWSERS_PATH"] = args.playwright_browsers_path
    return env


def collect(args: argparse.Namespace, env: dict[str, str]) -> tuple[int, Path, dict[str, object]]:
    control_path = Path(args.control_path)
    ensure_control(control_path)
    command = [
        sys.executable,
        "-u",
        str(ROOT / "scripts" / "run_falcao_safe.py"),
        "--node",
        args.node,
        "--script",
        str(ROOT / "scripts" / "collect_falcao_direct.mjs"),
        "--output-tag",
        args.output_tag,
        "--minimum-block-free-minutes",
        str(args.minimum_block_free_minutes),
        "--control-path",
        str(control_path),
        "--",
        "--start-date",
        args.start_date,
        "--end-date",
        args.end_date,
        "--mode",
        args.mode,
        "--page-size",
        "10",
        "--min-delay-ms",
        str(args.min_delay_ms),
        "--max-delay-ms",
        str(args.max_delay_ms),
        "--collections",
        args.collections,
        "--api-mode",
        args.api_mode,
        "--request-budget",
        str(args.request_budget),
        "--non-block-retries",
        "2",
        "--rest-every",
        "0",
        "--rest-ms",
        "0",
        "--block-cooldown-minutes",
        str(args.minimum_block_free_minutes),
        "--headless",
    ]
    if args.api_path:
        command.extend(["--api-path", args.api_path])
    validation = run([*command, "--validate-only"], env=env, timeout=45)
    if validation.returncode != 0:
        raise RuntimeError(f"invalid Falcao collector configuration: {validation.stderr[-2000:]}")
    returncode = run_passthrough(command, env=env)
    output_dir = DATA_ROOT / "raw" / "falcao" / args.output_tag
    return returncode, output_dir, load_json(output_dir / "status.json")


def ssh_base(args: argparse.Namespace) -> list[str]:
    if not args.azure_target or not args.azure_key:
        raise RuntimeError("FALCAO_AZURE_TARGET and FALCAO_AZURE_KEY are required for sync.")
    return [
        "ssh",
        "-i",
        args.azure_key,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        args.azure_target,
    ]


def scp_base(args: argparse.Namespace) -> list[str]:
    if not args.azure_target or not args.azure_key:
        raise RuntimeError("FALCAO_AZURE_TARGET and FALCAO_AZURE_KEY are required for sync.")
    return [
        "scp",
        "-i",
        args.azure_key,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-r",
    ]


def sync_and_import(args: argparse.Namespace, output_dir: Path) -> dict[str, object]:
    documents_path = output_dir / "documents.jsonl"
    expected_count = line_count(documents_path)
    if expected_count <= 0:
        return {"ok": False, "skipped": True, "reason": "documents.jsonl vazio ou ausente"}

    remote_tmp = f"/tmp/{args.output_tag}"
    azure_raw_dir = f"{args.azure_data_dir.rstrip('/')}/raw/falcao/{args.output_tag}"
    cleanup = run([*ssh_base(args), f"rm -rf {shlex.quote(remote_tmp)}"], timeout=60)
    if cleanup.returncode != 0:
        raise RuntimeError(f"Azure tmp cleanup failed: {cleanup.stderr[-2000:]}")
    copied = run([*scp_base(args), str(output_dir), f"{args.azure_target}:{remote_tmp}"], timeout=1800)
    if copied.returncode != 0:
        raise RuntimeError(f"Azure scp failed: {copied.stderr[-2000:]}")

    quoted_tmp = shlex.quote(remote_tmp)
    quoted_raw = shlex.quote(azure_raw_dir)
    quoted_app = shlex.quote(args.azure_app_dir)
    quoted_data = shlex.quote(args.azure_data_dir)
    quoted_service = shlex.quote(args.azure_service)
    remote_lines = [
        "set -e",
        f"sudo rm -rf {quoted_raw}",
        f"sudo mkdir -p {shlex.quote(args.azure_data_dir.rstrip('/') + '/raw/falcao')}",
        f"sudo cp -a {quoted_tmp} {quoted_raw}",
        f"sudo chown -R justra:justra {quoted_raw}",
        f"sudo find {quoted_raw} -type f -exec chmod 0640 {{}} +",
        f"sudo find {quoted_raw} -type d -exec chmod 0750 {{}} +",
    ]
    if not args.skip_import:
        remote_lines.extend(
            [
                f"cd {quoted_app}",
                f"trap 'sudo systemctl start {quoted_service} >/dev/null 2>&1 || true' EXIT",
                f"sudo systemctl stop {quoted_service}",
                (
                    f"sudo -u justra env JUSTRA_DATA_DIR={quoted_data} "
                    ".venv/bin/python scripts/import_falcao_full_text.py "
                    f"--input {quoted_raw}/documents.jsonl "
                    f"--expected-count {expected_count} "
                    "--append --skip-backup"
                ),
                f"sudo systemctl start {quoted_service}",
                "trap - EXIT",
            ]
        )
    remote = run([*ssh_base(args), "\n".join(remote_lines)], timeout=7200)
    if remote.returncode != 0:
        raise RuntimeError(f"Azure import failed: {remote.stderr[-3000:]}")
    payload: dict[str, object] = {
        "ok": True,
        "documents": expected_count,
        "azure_raw_dir": azure_raw_dir,
        "imported": not args.skip_import,
        "stdout": remote.stdout[-4000:],
    }
    return payload


def sync_worker_state(args: argparse.Namespace, status_path: Path, control_path: Path) -> dict[str, object]:
    if args.skip_sync:
        return {"ok": False, "skipped": True, "reason": "sync desabilitado"}
    if not status_path.exists():
        return {"ok": False, "skipped": True, "reason": "worker status ausente"}

    remote_tmp = f"/tmp/falcao_worker_state_{os.getpid()}"
    mkdir = run([*ssh_base(args), f"rm -rf {shlex.quote(remote_tmp)} && mkdir -p {shlex.quote(remote_tmp)}"], timeout=60)
    if mkdir.returncode != 0:
        raise RuntimeError(f"Azure worker state tmp failed: {mkdir.stderr[-2000:]}")

    sources = [str(status_path)]
    if control_path.exists():
        sources.append(str(control_path))
    copied = run([*scp_base(args), *sources, f"{args.azure_target}:{remote_tmp}/"], timeout=120)
    if copied.returncode != 0:
        raise RuntimeError(f"Azure worker state scp failed: {copied.stderr[-2000:]}")

    app_dir = f"{args.azure_data_dir.rstrip('/')}/app"
    remote_lines = [
        "set -e",
        f"sudo mkdir -p {shlex.quote(app_dir)}",
        f"sudo cp {shlex.quote(remote_tmp + '/' + status_path.name)} {shlex.quote(app_dir + '/falcao_remote_worker.json')}",
    ]
    if control_path.exists():
        remote_lines.append(
            f"sudo cp {shlex.quote(remote_tmp + '/' + control_path.name)} {shlex.quote(app_dir + '/falcao_hostinger_control.json')}"
        )
    installed_files = [app_dir + "/falcao_remote_worker.json"]
    if control_path.exists():
        installed_files.append(app_dir + "/falcao_hostinger_control.json")
    quoted_installed = " ".join(shlex.quote(item) for item in installed_files)
    remote_lines.extend(
        [
            f"sudo chown justra:justra {quoted_installed}",
            f"sudo chmod 0600 {quoted_installed}",
            f"rm -rf {shlex.quote(remote_tmp)}",
        ]
    )
    remote = run([*ssh_base(args), "\n".join(remote_lines)], timeout=120)
    if remote.returncode != 0:
        raise RuntimeError(f"Azure worker state install failed: {remote.stderr[-2000:]}")
    return {"ok": True, "azure_app_dir": app_dir}


def sync_worker_state_best_effort(args: argparse.Namespace, status_path: Path, control_path: Path) -> dict[str, object]:
    try:
        return sync_worker_state(args, status_path, control_path)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}


def main() -> int:
    args = parse_args()
    status_path = Path(args.worker_status)
    control_path = Path(args.control_path)
    LOG_ROOT.mkdir(parents=True, exist_ok=True)
    update_control_policy(control_path, args)
    atomic_json(
        status_path,
        {
            "state": "collecting",
            "started_at": now_iso(),
            "output_tag": args.output_tag,
            "start_date": args.start_date,
            "end_date": args.end_date,
            "collections": args.collections.split(","),
        },
    )
    sync_worker_state_best_effort(args, status_path, control_path)
    try:
        env = build_env(args)
        returncode, output_dir, collector_status = collect(args, env)
        documents_count = line_count(output_dir / "documents.jsonl")
        sync_result: dict[str, object] | None = None
        if not args.skip_sync and documents_count:
            atomic_json(
                status_path,
                {
                    "state": "syncing",
                    "updated_at": now_iso(),
                    "output_tag": args.output_tag,
                    "collector_returncode": returncode,
                    "collector_result": collector_status.get("result"),
                    "documents": documents_count,
                },
            )
            sync_result = sync_and_import(args, output_dir)
        final = {
            "state": "finished",
            "finished_at": now_iso(),
            "output_tag": args.output_tag,
            "output_dir": str(output_dir),
            "collector_returncode": returncode,
            "collector_result": collector_status.get("result"),
            "collector_complete": bool(collector_status.get("complete")),
            "documents": documents_count,
            "sync": sync_result,
        }
        atomic_json(status_path, final)
        sync_worker_state_best_effort(args, status_path, control_path)
        print(json.dumps(final, ensure_ascii=False, indent=2))
        return 0 if returncode in {0, 2} else returncode
    except Exception as exc:  # noqa: BLE001
        atomic_json(
            status_path,
            {
                "state": "failed",
                "finished_at": now_iso(),
                "output_tag": args.output_tag,
                "error": str(exc),
            },
        )
        sync_worker_state_best_effort(args, status_path, control_path)
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
