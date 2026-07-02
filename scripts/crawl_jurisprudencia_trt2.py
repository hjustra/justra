from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from collectors.jurisprudencia_trt2 import discover_documents


def main() -> None:
    discover_documents()


if __name__ == "__main__":
    main()
