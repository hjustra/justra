from __future__ import annotations

import pandas as pd


def summarize_by_claim(claims: pd.DataFrame) -> pd.DataFrame:
    if claims.empty:
        return pd.DataFrame(columns=["claim_type", "outcome", "total", "share"])
    grouped = claims.groupby(["claim_type", "outcome"], dropna=False).size().reset_index(name="total")
    grouped["claim_total"] = grouped.groupby("claim_type")["total"].transform("sum")
    grouped["share"] = (grouped["total"] / grouped["claim_total"]).round(4)
    return grouped.sort_values(["claim_total", "claim_type", "total"], ascending=[False, True, False])
