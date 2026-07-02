#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from serve_justra_app import _run_djen_collection  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    args = set(argv or sys.argv[1:])
    dry_run = "--dry-run" in args
    retry_pending = "--retry-pending" in args
    mode = "dry-run" if dry_run else ("retry-pending" if retry_pending else "daily")
    _run_djen_collection(mode=mode, dry_run=dry_run, retry_pending=retry_pending)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
