#!/usr/bin/env python3
"""Coleta PJe parametrizada.

Esta versão abre a URL do PJe, usa os parâmetros Azure OpenAI quando necessário
e delega a extração/importação para o core de captura PJe da Justra.
"""

import argparse
import asyncio
import base64
import json
import mimetypes
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

import pje_operator_capture_core as pje_capture_core


DEFAULT_PAGE_URL = "https://pje.trt2.jus.br/consultaprocessual/captcha/detalhe-processo/1002578-33.2025.5.02.0204/1"
DEFAULT_OUTPUT_DIR = Path("captcha_output")
DEFAULT_AZURE_OPENAI_ENDPOINT = "https://optti-oa-us.openai.azure.com/"
DEFAULT_AZURE_OPENAI_DEPLOYMENT = "gpt-4.1-mini"
ORIGIN_BLOCK_MARKER = "PJE_ORIGIN_BLOCKED"
ORIGIN_BLOCK_EXIT_CODE = 12


def redact_pje_log_value(value: str) -> str:
    text = str(value or "")
    text = re.sub(r"(?i)(tokenDesafio|tokenCaptcha|resposta)=([^&\\s]+)", r"\1=<redacted>", text)
    text = re.sub(r'(?i)("tokenDesafio"\\s*:\\s*")[^"]+(")', r"\1<redacted>\2", text)
    text = re.sub(r'(?i)("tokenCaptcha"\\s*:\\s*")[^"]+(")', r"\1<redacted>\2", text)
    text = re.sub(r'(?i)("imagem"\\s*:\\s*")[^"]+(")', r"\1<base64-redacted>\2", text)
    text = re.sub(r'(?i)("audio"\\s*:\\s*")[^"]+(")', r"\1<base64-redacted>\2", text)
    return text


class OriginBlockedError(RuntimeError):
    """A origem do worker foi bloqueada antes da página PJe carregar."""


@dataclass(frozen=True)
class Config:
    page_url: str
    cnj: str
    justra_url: str
    job_id: str
    origin: str
    azure_openai_api_key: str
    azure_openai_endpoint: str
    azure_openai_deployment: str
    output_dir: Path
    output: str
    timeout: int
    settle_seconds: float
    min_text_length: int
    min_movements: int
    max_documents: int
    dry_run: bool
    headless: bool
    keep_open: bool


def parse_args() -> Config:
    parser = argparse.ArgumentParser(
        description="Abre a página informada e usa as configurações do Azure OpenAI passadas por argumento ou ambiente."
    )

    parser.add_argument(
        "--page-url",
        default=os.getenv("PAGE_URL", ""),
        help="URL da página. Também pode ser definida via variável de ambiente PAGE_URL.",
    )
    parser.add_argument("--pje-url", default="", help="Alias legado para --page-url.")
    parser.add_argument("--cnj", default="", help="Número CNJ do processo; usado para montar URL se --page-url for omitido.")
    parser.add_argument("--degree", default="1", help="Grau do processo no PJe quando --cnj for usado.")
    parser.add_argument("--justra-url", default=os.getenv("JUSTRA_URL", "https://staging.justra.com.br"), help="Base URL da Justra.")
    parser.add_argument("--job-id", default="", help="ID do job PJe na fila da Justra.")
    parser.add_argument("--origin", default=pje_capture_core.DEFAULT_ORIGIN, help="Origin enviado ao endpoint de importação PJe.")
    parser.add_argument(
        "--azure-openai-api-key",
        default=os.getenv("AZURE_OPENAI_API_KEY", ""),
        help="Chave da API Azure OpenAI. Também pode ser definida via AZURE_OPENAI_API_KEY.",
    )
    parser.add_argument(
        "--azure-openai-endpoint",
        default=os.getenv("AZURE_OPENAI_ENDPOINT", DEFAULT_AZURE_OPENAI_ENDPOINT),
        help="Endpoint do Azure OpenAI. Também pode ser definido via AZURE_OPENAI_ENDPOINT.",
    )
    parser.add_argument(
        "--azure-openai-deployment",
        default=os.getenv("AZURE_OPENAI_DEPLOYMENT", DEFAULT_AZURE_OPENAI_DEPLOYMENT),
        help="Nome do deployment/modelo no Azure OpenAI. Também pode ser definido via AZURE_OPENAI_DEPLOYMENT.",
    )
    parser.add_argument(
        "--output-dir",
        default=os.getenv("OUTPUT_DIR", str(DEFAULT_OUTPUT_DIR)),
        help="Diretório de saída. Também pode ser definido via OUTPUT_DIR.",
    )
    parser.add_argument("--output", default="", help="Arquivo JSON de saída. Se omitido, usa output-dir.")
    parser.add_argument("--timeout", type=int, default=300, help="Tempo máximo aguardando a página liberada ficar pronta.")
    parser.add_argument("--settle-seconds", type=float, default=2.5, help="Espera extra após a página ficar pronta.")
    parser.add_argument("--min-text-length", type=int, default=700, help="Texto mínimo para considerar a página carregada.")
    parser.add_argument("--min-movements", type=int, default=1, help="Quantidade mínima de movimentos para considerar pronto.")
    parser.add_argument("--max-documents", type=int, default=80, help="Máximo de documentos/tentativas de documentos.")
    parser.add_argument("--dry-run", action="store_true", help="Captura e salva JSON, mas não envia para a Justra.")
    parser.add_argument("--headless", action="store_true", help="Executar sem janela.")
    parser.add_argument("--keep-open", action="store_true", help="Manter navegador aberto após captura.")

    args = parser.parse_args()
    page_url = args.page_url or args.pje_url
    cnj = pje_capture_core.format_process_number(args.cnj) if args.cnj else ""
    if not page_url and cnj:
        page_url = pje_capture_core.pje_url_for_process(cnj, args.degree)
    if not page_url:
        page_url = DEFAULT_PAGE_URL

    return Config(
        page_url=page_url,
        cnj=cnj,
        justra_url=args.justra_url,
        job_id=args.job_id,
        origin=args.origin,
        azure_openai_api_key=args.azure_openai_api_key,
        azure_openai_endpoint=args.azure_openai_endpoint,
        azure_openai_deployment=args.azure_openai_deployment,
        output_dir=Path(args.output_dir),
        output=args.output,
        timeout=max(30, int(args.timeout)),
        settle_seconds=max(0.0, float(args.settle_seconds)),
        min_text_length=max(0, int(args.min_text_length)),
        min_movements=max(0, int(args.min_movements)),
        max_documents=max(0, int(args.max_documents)),
        dry_run=bool(args.dry_run),
        headless=bool(args.headless),
        keep_open=bool(args.keep_open),
    )


def clean_base64(value: str) -> str:
    value = value.strip()

    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]

    return value


def save_base64_file(value: str, path: Path) -> None:
    decoded = base64.b64decode(clean_base64(value))
    path.write_bytes(decoded)


def guess_audio_extension(content_type: str, url: str) -> str:
    content_type = (content_type or "").lower()
    url = (url or "").lower()

    if "wav" in content_type or ".wav" in url:
        return ".wav"

    if "mpeg" in content_type or "mp3" in content_type or ".mp3" in url:
        return ".mp3"

    if "ogg" in content_type or ".ogg" in url:
        return ".ogg"

    if "aac" in content_type or ".aac" in url:
        return ".aac"

    return ".bin"


def find_key_recursively(obj: Any, target_key: str) -> Optional[Any]:
    if isinstance(obj, dict):
        if target_key in obj:
            return obj[target_key]

        for value in obj.values():
            found = find_key_recursively(value, target_key)

            if found is not None:
                return found

    elif isinstance(obj, list):
        for item in obj:
            found = find_key_recursively(item, target_key)

            if found is not None:
                return found

    return None


def image_to_data_url(image_path: str | Path) -> str:
    path = Path(image_path)

    if not path.exists():
        raise FileNotFoundError(f"Imagem não encontrada: {path}")

    mime_type, _ = mimetypes.guess_type(path)

    if mime_type is None:
        mime_type = "image/jpeg"

    image_bytes = path.read_bytes()
    image_base64 = base64.b64encode(image_bytes).decode("utf-8")

    return f"data:{mime_type};base64,{image_base64}"


def read_image_text(image_path: str | Path, config: Config) -> str:
    from openai import OpenAI

    if not config.azure_openai_api_key:
        raise ValueError(
            "Defina a chave com --azure-openai-api-key ou com a variável AZURE_OPENAI_API_KEY."
        )

    if not config.azure_openai_endpoint:
        raise ValueError(
            "Defina o endpoint com --azure-openai-endpoint ou com a variável AZURE_OPENAI_ENDPOINT."
        )

    client = OpenAI(
        api_key=config.azure_openai_api_key,
        base_url=f"{config.azure_openai_endpoint.rstrip('/')}/openai/v1/",
    )

    image_data_url = image_to_data_url(image_path)

    response = client.chat.completions.create(
        model=config.azure_openai_deployment,
        messages=[
            {
                "role": "system",
                "content": (
                    "Você é um OCR. Extraia apenas o texto visível da imagem. "
                    "Se houver incerteza em algum caractere, indique com ?."
                ),
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": "Leia o texto desta imagem e retorne somente a transcrição.",
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": image_data_url,
                        },
                    },
                ],
            },
        ],
        temperature=0,
        max_tokens=300,
    )

    texto = response.choices[0].message.content.strip()
    texto_limpo = re.sub(r"\s+", "", texto)

    return texto_limpo


def looks_like_origin_block(status: int, content_type: str, text: str) -> bool:
    lowered = (text or "").lower()
    return (
        int(status or 0) == 403
        and "text/html" in (content_type or "").lower()
        and (
            "the request could not be satisfied" in lowered
            or "request blocked" in lowered
            or "403 error" in lowered
        )
    )


def origin_block_message(status: int, url: str, text: str = "") -> str:
    snippet = re.sub(r"\s+", " ", text or "").strip()[:180]
    suffix = f" · {snippet}" if snippet else ""
    return f"HTTP {status} ao abrir PJe; a origem/IP do worker foi bloqueada antes do CAPTCHA. URL: {url}{suffix}"


async def current_page_origin_block_message(page: Any) -> str:
    try:
        text = await page.evaluate(
            "() => (document.body && document.body.innerText) || document.documentElement.innerText || ''"
        )
    except Exception:
        return ""
    lowered = (text or "").lower()
    if "403 error" in lowered and "the request could not be satisfied" in lowered:
        return origin_block_message(403, page.url, text)
    return ""


async def wait_for_pje_operator_collect_ready(
    page: Any,
    cnj: str,
    timeout_seconds: int = 300,
    min_text_length: int = 700,
    min_movements: int = 1,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    last_reason = ""

    while asyncio.get_running_loop().time() < deadline:
        try:
            state = await page.evaluate(
                pje_capture_core.READY_CHECK_JS,
                {
                    "expectedCnj": cnj,
                    "minTextLength": min_text_length,
                    "minMovements": min_movements,
                },
            )
        except Exception as e:
            state = {
                "ok": False,
                "reason": f"Aguardando navegação/página estabilizar: {repr(e)}",
                "textLength": 0,
                "movementCount": 0,
            }

        reason = str(state.get("reason") or "")
        if reason != last_reason:
            print(f"[pje] {reason} texto={state.get('textLength')} movimentos={state.get('movementCount')}")
            last_reason = reason

        if state.get("ok"):
            return state

        await asyncio.sleep(1.5)

    raise TimeoutError(f"página PJe não ficou pronta em {timeout_seconds}s: {last_reason}")


async def call_pje_operator_collect(page: Any, config: Config) -> None:
    cnj = (
        config.cnj
        or pje_capture_core.extract_process_number(page.url)
        or pje_capture_core.extract_process_number(config.page_url)
    )

    if not cnj:
        raise RuntimeError("não consegui identificar o CNJ para chamar o coletor PJe")

    cnj = pje_capture_core.format_process_number(cnj)

    print("\n[pje] Chamando pje_operator_collect na página já liberada.")
    state = await wait_for_pje_operator_collect_ready(
        page,
        cnj=cnj,
        timeout_seconds=config.timeout,
        min_text_length=config.min_text_length,
        min_movements=config.min_movements,
    )
    print(f"[pje] Página pronta: {state.get('processNumber')} ({state.get('textLength')} caracteres)")
    if config.settle_seconds > 0:
        await asyncio.sleep(config.settle_seconds)

    payload = await page.evaluate(
        pje_capture_core.COLLECTOR_JS,
        {
            "expectedCnj": cnj,
            "maxDocuments": config.max_documents,
        },
    )

    payload["operator_capture"] = {
        "script": "scripts/pje_operator_collect.py",
        "called": "pje_operator_collect",
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "requested_cnj": cnj,
        "requested_url": page.url,
        "justra_url": config.justra_url,
        "job_id": config.job_id,
    }
    if config.job_id:
        payload["job_id"] = config.job_id

    cnj_digits = re.sub(r"\D", "", cnj)
    output_path = Path(config.output) if config.output else config.output_dir / f"pje_operator_collect_{cnj_digits or 'processo'}.json"
    await asyncio.to_thread(pje_capture_core.write_payload, payload, output_path)
    print(
        "[pje] JSON salvo em "
        f"{output_path} | movimentos={len(payload.get('movements') or [])} "
        f"docs={len(payload.get('documents') or [])}"
    )

    if config.dry_run:
        print("[pje] Dry-run ativo: não enviei para a Justra.")
        return

    result = await asyncio.to_thread(
        pje_capture_core.send_to_justra,
        payload,
        config.justra_url,
        config.origin,
    )
    print(f"[pje] Enviado para Justra. Import ID: {result.get('import_id') or 'registrado'}")
    print(json.dumps(result, ensure_ascii=False, indent=2))


async def main(config: Config) -> int:
    from playwright.async_api import async_playwright

    config.output_dir.mkdir(parents=True, exist_ok=True)

    image_future: asyncio.Future[dict[str, Any]] = asyncio.Future()
    audio_future: asyncio.Future[dict[str, Any]] = asyncio.Future()
    origin_block_future: asyncio.Future[str] = asyncio.Future()

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=config.headless)

        context = await browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1400, "height": 900},
        )

        page = await context.new_page()

        async def handle_response(response: Any) -> None:
            try:
                url = response.url
                status = response.status
                content_type = response.headers.get("content-type", "")

                lower_url = url.lower()
                lower_ct = content_type.lower()

                is_relevant = (
                    "captcha" in lower_url
                    or "audio" in lower_url
                    or "desafio" in lower_url
                    or "application/json" in lower_ct
                    or lower_ct.startswith("audio/")
                )

                if not is_relevant:
                    return

                print("\n--- RESPONSE RELEVANTE ---")
                print("URL:", redact_pje_log_value(url))
                print("STATUS:", status)
                print("CONTENT-TYPE:", content_type)

                if lower_ct.startswith("audio/") and not audio_future.done():
                    body = await response.body()
                    ext = guess_audio_extension(content_type, url)

                    audio_path = config.output_dir / f"captcha_audio{ext}"
                    request_url_path = config.output_dir / "captcha_audio_request_url.txt"

                    audio_path.write_bytes(body)
                    request_url_path.write_text(url, encoding="utf-8")

                    print("Áudio binário salvo em:", audio_path)

                    audio_future.set_result(
                        {
                            "type": "binary-audio",
                            "url": url,
                            "path": str(audio_path),
                        }
                    )

                    return

                is_textual = (
                    "application/json" in lower_ct
                    or lower_ct.startswith("text/")
                    or "html" in lower_ct
                    or "xml" in lower_ct
                )
                if not is_textual:
                    print("CORPO: resposta binária omitida do log.")
                    return

                try:
                    text = await response.text()
                except Exception:
                    print("CORPO: não foi possível ler resposta textual.")
                    return

                if looks_like_origin_block(status, content_type, text):
                    message = origin_block_message(status, url, text)
                    if not origin_block_future.done():
                        origin_block_future.set_result(message)
                    print(f"{ORIGIN_BLOCK_MARKER}: {message}")
                    return

                try:
                    data = json.loads(text)
                except Exception:
                    print("TEXTO COMEÇO:", redact_pje_log_value(text[:300].replace("\n", " ")))
                    return

                if isinstance(data, dict):
                    print("JSON keys:", ", ".join(sorted(str(key) for key in data.keys())[:12]))
                elif isinstance(data, list):
                    print("JSON list items:", len(data))

                token = find_key_recursively(data, "tokenDesafio")
                imagem = find_key_recursively(data, "imagem")
                audio = find_key_recursively(data, "audio")

                if token and imagem and not image_future.done():
                    image_path = config.output_dir / "captcha_imagem.jpg"
                    token_path = config.output_dir / "token_desafio.txt"
                    json_path = config.output_dir / "captcha_imagem_payload.json"
                    request_url_path = config.output_dir / "captcha_imagem_request_url.txt"

                    save_base64_file(imagem, image_path)

                    token_path.write_text(token, encoding="utf-8")

                    json_path.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )

                    request_url_path.write_text(url, encoding="utf-8")

                    print("Imagem salva em:", image_path)
                    print("Token salvo em:", token_path)

                    image_future.set_result(
                        {
                            "url": url,
                            "token": token,
                            "image_path": str(image_path),
                        }
                    )

                if audio and not audio_future.done():
                    audio_path = config.output_dir / "captcha_audio.wav"
                    json_path = config.output_dir / "captcha_audio_payload.json"
                    request_url_path = config.output_dir / "captcha_audio_request_url.txt"

                    save_base64_file(audio, audio_path)

                    json_path.write_text(
                        json.dumps(data, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )

                    request_url_path.write_text(url, encoding="utf-8")

                    print("Áudio base64 salvo em:", audio_path)

                    audio_future.set_result(
                        {
                            "type": "json-audio",
                            "url": url,
                            "path": str(audio_path),
                        }
                    )

            except Exception as e:
                print("Erro no handle_response:", repr(e))

        page.on("response", handle_response)

        print("Abrindo página:")
        print(config.page_url)

        try:
            await page.goto(
                config.page_url,
                wait_until="domcontentloaded",
                timeout=60_000,
            )

            print("\nPágina aberta.")
            if origin_block_future.done():
                raise OriginBlockedError(origin_block_future.result())

            page_block_message = await current_page_origin_block_message(page)
            if page_block_message:
                raise OriginBlockedError(page_block_message)

            print("Aguardando captura da imagem do CAPTCHA...")

            try:
                image_result = await asyncio.wait_for(image_future, timeout=30)
                print("\nCaptcha de imagem capturado com sucesso.")
                print("Imagem do CAPTCHA:", image_result.get("image_path"))

                texto = read_image_text(image_result["image_path"], config)
                captcha_texto = re.sub(r"\s+", "", texto).strip()

                print("Texto do CAPTCHA transcrito.")

                campo_captcha = page.locator(
                    "input[name='captcha'], "
                    "input[id*='captcha'], "
                    "input[placeholder*='captcha' i], "
                    "input[type='text']"
                ).first

                await campo_captcha.wait_for(timeout=30000)
                await campo_captcha.fill(captcha_texto)

                botao = page.locator(
                    "button[type='submit'], "
                    "input[type='submit'], "
                    "button:has-text('Consultar'), "
                    "button:has-text('Enviar'), "
                    "button:has-text('Confirmar')"
                ).first

                await botao.wait_for(timeout=30000)
                await botao.click()

                print("Captcha preenchido e enviado.")
            except asyncio.TimeoutError:
                print("\nNão capturei imagem do CAPTCHA em 30s; tentando coletar a página atual diretamente.")

            await call_pje_operator_collect(page, config)
            return 0

        finally:
            if config.keep_open and not config.headless:
                await asyncio.to_thread(input, "[pje] Pressione Enter para fechar o navegador...")
            await browser.close()


if __name__ == "__main__":
    config = parse_args()
    try:
        raise SystemExit(asyncio.run(main(config)))
    except OriginBlockedError as exc:
        print(f"{ORIGIN_BLOCK_MARKER}: {exc}", file=sys.stderr)
        raise SystemExit(ORIGIN_BLOCK_EXIT_CODE)
