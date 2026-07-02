from __future__ import annotations

from dataclasses import dataclass


@dataclass
class JurisprudenciaSearchResult:
    title: str
    url: str
    date: str = ""
    metadata: dict | None = None


def discover_documents(*_args, **_kwargs) -> list[JurisprudenciaSearchResult]:
    """Placeholder para a pesquisa jurisprudencial publica do TRT2.

    A pagina institucional de jurisprudencia existe em
    https://ww2.trt2.jus.br/jurisprudencia/, mas o endpoint de busca publica
    precisa ser mapeado com cuidado antes de automatizar requisicoes em massa.
    """

    raise NotImplementedError(
        "Fonte de jurisprudencia publica do TRT2 ainda nao mapeada para coleta automatica."
    )
