from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from reports.generate_report import generate_report


def main() -> None:
    parser = argparse.ArgumentParser(description="Gera relatorio HTML local.")
    parser.add_argument("--output", type=Path, default=ROOT / "reports/trt2_v0_report.html")
    args = parser.parse_args()

    output = generate_report(ROOT, output_path=args.output)
    print(f"salvo: {output}")


if __name__ == "__main__":
    main()
