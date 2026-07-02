from __future__ import annotations

import pandas as pd


def summarize_by_court_unit(decisions: pd.DataFrame) -> pd.DataFrame:
    if decisions.empty or "court_unit" not in decisions:
        return pd.DataFrame(columns=["court_unit", "total"])
    data = decisions.copy()
    data["court_unit"] = data["court_unit"].fillna("").replace("", "nao_identificado")
    return data.groupby("court_unit").size().reset_index(name="total").sort_values("total", ascending=False)
