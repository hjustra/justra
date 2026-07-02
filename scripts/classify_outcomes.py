from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from classifiers.claim_classifier import build_claim_rows
from classifiers.outcome_classifier import apply_outcome_classification


def main() -> None:
    parser = argparse.ArgumentParser(description="Classifica pedidos e resultados.")
    parser.add_argument("--decisions", type=Path, default=ROOT / "data/processed/decisions.csv")
    parser.add_argument("--claims", type=Path, default=ROOT / "data/processed/claims.csv")
    args = parser.parse_args()

    decisions = pd.read_csv(args.decisions)
    decisions = apply_outcome_classification(decisions)
    claims = build_claim_rows(decisions)

    decisions.to_csv(args.decisions, index=False)
    args.claims.parent.mkdir(parents=True, exist_ok=True)
    claims.to_csv(args.claims, index=False)

    print(f"salvo: {args.decisions}")
    print(f"salvo: {args.claims}")
    print(f"pedidos classificados: {len(claims)}")


if __name__ == "__main__":
    main()
