from __future__ import annotations

import re

import pandas as pd

from classifiers.claim_classifier import classify_claims, unique_claims


OUTCOME_PATTERNS: list[tuple[str, list[str]]] = [
    (
        "procedente_parcial",
        [
            r"procedente em parte",
            r"parcialmente procedente",
            r"procedencia parcial",
            r"dar parcial provimento",
            r"provimento parcial",
        ],
    ),
    (
        "improcedente",
        [
            r"\bimprocedente\b",
            r"julgo improcedentes?",
            r"nego provimento",
            r"negar provimento",
        ],
    ),
    (
        "procedente",
        [
            r"julgo procedentes?",
            r"\bprocedente\b",
            r"dar provimento",
            r"conhecer e prover",
        ],
    ),
    (
        "acordo",
        [
            r"homologo o acordo",
            r"acordo homologado",
            r"termo de conciliacao",
        ],
    ),
    (
        "extinto",
        [
            r"extinto sem resolucao",
            r"extingo sem resolucao",
            r"extincao do processo",
        ],
    ),
]


def classify_outcome(text: str) -> tuple[str, str]:
    normalized = text.lower()
    for label, patterns in OUTCOME_PATTERNS:
        for pattern in patterns:
            match = re.search(pattern, normalized)
            if match:
                return label, match.group(0)
    return "nao_identificado", ""


def apply_outcome_classification(decisions: pd.DataFrame) -> pd.DataFrame:
    outcomes = decisions["decision_text"].fillna("").apply(classify_outcome)
    decisions = decisions.copy()
    decisions["outcome"] = outcomes.apply(lambda item: item[0])
    decisions["outcome_evidence"] = outcomes.apply(lambda item: item[1])
    decisions["claims"] = decisions["decision_text"].fillna("").apply(lambda text: unique_claims(classify_claims(text)))
    decisions["decision_year"] = decisions["decision_date"].fillna("").astype(str).str[:4]
    return decisions
