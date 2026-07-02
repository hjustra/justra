from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable

import pandas as pd


@dataclass(frozen=True)
class ClaimMatch:
    claim_type: str
    matched_terms: list[str]
    confidence: float


CLAIM_PATTERNS: dict[str, list[str]] = {
    "horas_extras": [
        r"hora[s]? extra[s]?",
        r"sobrejornada",
        r"jornada extraordinaria",
        r"labor extraordinario",
        r"cartao de ponto",
    ],
    "dano_moral": [
        r"dano moral",
        r"ass[eé]dio moral",
        r"indeniza[cç][aã]o por dano",
    ],
    "verbas_rescisorias": [
        r"verbas rescisorias",
        r"saldo de salario",
        r"aviso previo",
        r"ferias proporcionais",
        r"decimo terceiro proporcional",
    ],
    "adicional_insalubridade": [
        r"adicional de insalubridade",
        r"insalubridade",
    ],
    "adicional_periculosidade": [
        r"adicional de periculosidade",
        r"periculosidade",
    ],
    "vinculo_empregaticio": [
        r"vinculo empregaticio",
        r"reconhecimento de vinculo",
        r"relacao de emprego",
    ],
    "equiparacao_salarial": [
        r"equiparacao salarial",
        r"paradigma salarial",
    ],
    "intervalo_intrajornada": [
        r"intervalo intrajornada",
        r"intervalo para refeicao",
        r"art\.?\s*71",
    ],
    "acumulo_de_funcao": [
        r"acumulo de funcao",
        r"acumulo funcional",
    ],
    "desvio_de_funcao": [
        r"desvio de funcao",
        r"desvio funcional",
    ],
    "multa_477": [
        r"multa do art\.?\s*477",
        r"multa do artigo\s*477",
        r"multa 477",
    ],
    "multa_467": [
        r"multa do art\.?\s*467",
        r"multa do artigo\s*467",
        r"multa 467",
    ],
    "fgts": [
        r"\bfgts\b",
        r"fundo de garantia",
    ],
}


def normalize_text(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text or "")
    ascii_text = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return ascii_text.lower()


def classify_claims(text: str) -> list[ClaimMatch]:
    normalized = normalize_text(text)
    matches: list[ClaimMatch] = []
    for claim_type, patterns in CLAIM_PATTERNS.items():
        found_terms: list[str] = []
        for pattern in patterns:
            if re.search(pattern, normalized):
                found_terms.append(pattern)
        if found_terms:
            confidence = min(0.95, 0.55 + 0.1 * len(found_terms))
            matches.append(ClaimMatch(claim_type, found_terms, confidence))

    if not matches:
        return [ClaimMatch("outros", [], 0.25)]
    return matches


def build_claim_rows(decisions: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for _, decision in decisions.iterrows():
        text = str(decision.get("decision_text", ""))
        for match in classify_claims(text):
            rows.append(
                {
                    "process_number": decision.get("process_number", ""),
                    "source_url": decision.get("source_url", ""),
                    "decision_date": decision.get("decision_date", ""),
                    "decision_year": str(decision.get("decision_date", ""))[:4],
                    "court_unit": decision.get("court_unit", ""),
                    "judge_name": decision.get("judge_name", ""),
                    "claim_type": match.claim_type,
                    "outcome": decision.get("outcome", ""),
                    "confidence": match.confidence,
                    "matched_terms": "; ".join(match.matched_terms),
                }
            )
    return pd.DataFrame(rows)


def unique_claims(matches: Iterable[ClaimMatch]) -> str:
    return "; ".join(match.claim_type for match in matches)
