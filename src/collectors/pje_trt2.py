from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import requests


PJE_TRT2_BASE_URL = "https://pje.trt2.jus.br"
PJE_TRT2_API_URL = f"{PJE_TRT2_BASE_URL}/pje-consulta-api/api"
PJE_TRT2_DETAIL_URL = f"{PJE_TRT2_BASE_URL}/consultaprocessual/detalhe-processo"


USER_AGENT = (
    "JustraV0ResearchBot/0.1 "
    "(local public-source research; respectful requests)"
)


def only_digits(value: str) -> str:
    return re.sub(r"\D+", "", value or "")


def format_cnj_number(value: str) -> str:
    digits = only_digits(value)
    if len(digits) != 20:
        return value
    return (
        f"{digits[:7]}-{digits[7:9]}.{digits[9:13]}."
        f"{digits[13]}.{digits[14:16]}.{digits[16:]}"
    )


def is_captcha_challenge(payload: Any) -> bool:
    return isinstance(payload, dict) and bool(payload.get("tokenDesafio") and payload.get("imagem"))


@dataclass
class PjePublicClient:
    base_url: str = PJE_TRT2_BASE_URL
    timeout: int = 30

    def __post_init__(self) -> None:
        self.api_url = f"{self.base_url.rstrip('/')}/pje-consulta-api/api"
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
            }
        )

    def _headers(
        self,
        instance: int,
        bearer_token: str | None = None,
        third_party_token: str | None = None,
    ) -> dict[str, str]:
        headers = {
            "Content-type": "application/json",
            "X-Grau-Instancia": str(instance),
        }
        if bearer_token:
            headers["Authorization"] = f"Bearer {bearer_token}"
        if third_party_token:
            headers["acessoTerceirosToken"] = third_party_token
        return headers

    def get_basic_data(self, process_number: str, instance: int = 1) -> list[dict[str, Any]]:
        digits = only_digits(process_number)
        response = self.session.get(
            f"{self.api_url}/processos/dadosbasicos/{digits}",
            headers=self._headers(instance),
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def get_details(
        self,
        process_id: int | str,
        instance: int = 1,
        captcha_token: str | None = None,
        challenge_token: str | None = None,
        challenge_answer: str | None = None,
        bearer_token: str | None = None,
        third_party_token: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, str] = {}
        if captcha_token:
            params["tokenCaptcha"] = captcha_token
        if challenge_token and challenge_answer:
            params["tokenDesafio"] = challenge_token
            params["resposta"] = challenge_answer

        response = self.session.get(
            f"{self.api_url}/processos/{process_id}",
            headers=self._headers(instance, bearer_token, third_party_token),
            params=params,
            timeout=self.timeout,
        )
        response.raise_for_status()
        return response.json()

    def public_detail_url(self, process_number: str, instance: int = 1) -> str:
        return f"{PJE_TRT2_DETAIL_URL}/{only_digits(process_number)}/{instance}"
