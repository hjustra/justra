from __future__ import annotations

import os
from dataclasses import dataclass

import requests


DATAJUD_ENDPOINTS = {
    **{
        f"trt{number}": f"https://api-publica.datajud.cnj.jus.br/api_publica_trt{number}/_search"
        for number in range(1, 25)
    },
    "tst": "https://api-publica.datajud.cnj.jus.br/api_publica_tst/_search",
}

DATAJUD_TRABALHISTA_URL = DATAJUD_ENDPOINTS["trt2"]


@dataclass
class DataJudClient:
    api_key: str | None = None
    tribunal: str = "trt2"

    def __post_init__(self) -> None:
        self.api_key = self.api_key or os.getenv("DATAJUD_API_KEY")
        tribunal_key = self.tribunal.lower()
        if tribunal_key not in DATAJUD_ENDPOINTS:
            raise ValueError(f"Tribunal DataJud nao suportado: {self.tribunal}")
        self.endpoint = DATAJUD_ENDPOINTS[tribunal_key]

    def search(self, query: dict, timeout: int = 30) -> dict:
        if not self.api_key:
            raise RuntimeError("DATAJUD_API_KEY nao configurada.")
        response = requests.post(
            self.endpoint,
            json=query,
            headers={"Authorization": f"APIKey {self.api_key}"},
            timeout=timeout,
        )
        response.raise_for_status()
        return response.json()
