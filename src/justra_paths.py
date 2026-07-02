from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

try:
    from dotenv import load_dotenv
except ModuleNotFoundError:
    load_dotenv = None

if load_dotenv:
    load_dotenv(PROJECT_ROOT / ".env")


def configured_dir(env_name: str, default: Path) -> Path:
    raw = os.getenv(env_name, "").strip()
    if not raw:
        return default
    return Path(raw).expanduser().resolve()


DATA_ROOT = configured_dir("JUSTRA_DATA_DIR", PROJECT_ROOT / "data")
LOG_ROOT = configured_dir("JUSTRA_LOG_DIR", PROJECT_ROOT / "logs")
