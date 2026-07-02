from __future__ import annotations

import pandas as pd


def summarize_by_judge(decisions: pd.DataFrame) -> pd.DataFrame:
    if decisions.empty or "judge_name" not in decisions:
        return pd.DataFrame(columns=["judge_name", "outcome", "total"])
    data = decisions.copy()
    data["judge_name"] = data["judge_name"].fillna("").replace("", "nao_identificado")
    data["outcome"] = data["outcome"].fillna("").replace("", "nao_identificado")
    return (
        data.groupby(["judge_name", "outcome"])
        .size()
        .reset_index(name="total")
        .sort_values(["judge_name", "total"], ascending=[True, False])
    )
