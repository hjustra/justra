from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from parsers.decision_parser import parse_document_index


def main() -> None:
    parser = argparse.ArgumentParser(description="Parseia HTML/PDFs coletados para decisions.csv.")
    parser.add_argument("--index", type=Path, default=ROOT / "data/raw/json/document_index.json")
    parser.add_argument("--output", type=Path, default=ROOT / "data/processed/decisions.csv")
    args = parser.parse_args()

    df = parse_document_index(ROOT, args.index, args.output)
    print(f"salvo: {args.output}")
    print(f"documentos parseados: {len(df)}")


if __name__ == "__main__":
    main()
