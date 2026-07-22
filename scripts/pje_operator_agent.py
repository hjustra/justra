#!/usr/bin/env python3
"""Worker da fila PJe.

O worker busca jobs PJe no backend da Justra, executa `pje_operator_collect.py`
e reporta o resultado. Em staging/prod ele deve rodar headless como serviço.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
ORIGIN_BLOCK_MARKER = "PJE_ORIGIN_BLOCKED"
ORIGIN_BLOCK_EXIT_CODE = 12
PJE_JOB_TYPE_PUBLIC_COLLECT = "pje_collect_public_process"
PJE_JOB_TYPE_LOGIN_SESSION = "pje_login_session"
PJE_JOB_TYPE_SYNC_ACCOUNT = "pje_sync_account_processes"
PJE_JOB_TYPE_AUTH_COLLECT = "pje_collect_authenticated_process"
PJE_PUBLIC_JOB_TYPES = {"", PJE_JOB_TYPE_PUBLIC_COLLECT, "process_collect"}
PJE_ACCOUNT_JOB_TYPES = {
    PJE_JOB_TYPE_LOGIN_SESSION,
    PJE_JOB_TYPE_SYNC_ACCOUNT,
    PJE_JOB_TYPE_AUTH_COLLECT,
}


def short_tail(value: str, limit: int = 12_000) -> str:
    text = str(value or "")
    return text[-limit:]


def post_json(base_url: str, path: str, token: str, payload: dict[str, Any], timeout: int = 60) -> dict[str, Any]:
    response = requests.post(
        base_url.rstrip("/") + path,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "Justra PJe Operator Agent/0.1",
        },
        timeout=timeout,
    )
    try:
        data = response.json()
    except ValueError:
        data = {"raw": response.text}
    if not response.ok:
        raise RuntimeError(f"Justra respondeu HTTP {response.status_code}: {data}")
    return data


def claim_next_job(base_url: str, token: str, operator_id: str) -> dict[str, Any] | None:
    data = post_json(base_url, "/api/operator/pje/jobs/next", token, {"operator_id": operator_id})
    job = data.get("job")
    return job if isinstance(job, dict) else None


def finish_job(base_url: str, token: str, job_id: str, ok: bool, *, error: str = "", result: dict[str, Any] | None = None) -> None:
    post_json(
        base_url,
        "/api/operator/pje/jobs/finish",
        token,
        {
            "job_id": job_id,
            "ok": ok,
            "error": error,
            "result": result or {},
        },
    )


def run_collector(job: dict[str, Any], justra_url: str, extra_args: list[str]) -> subprocess.CompletedProcess[str]:
    cnj = str(job.get("process_number") or "")
    page_url = str(job.get("page_url") or "")
    job_id = str(job.get("id") or "")
    if not cnj or not job_id:
        raise RuntimeError("job sem CNJ ou ID")
    command = [
        sys.executable,
        str(ROOT / "scripts" / "pje_operator_collect.py"),
        "--page-url",
        page_url,
        "--justra-url",
        justra_url,
        "--job-id",
        job_id,
        "--cnj",
        cnj,
    ]
    command.extend(extra_args)
    print(f"[agent] Executando job {job_id} · {cnj}")
    print(f"[agent] Comando: {' '.join(command)}")
    return subprocess.run(
        command,
        cwd=str(ROOT),
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def account_job_manual_result(job: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
    job_type = str(job.get("job_type") or "")
    account_label = " · ".join(
        value
        for value in [
            str(job.get("trt") or job.get("tribunal") or "").strip(),
            f"OAB {job.get('oab')}" if job.get("oab") else "",
        ]
        if value
    )
    if job_type == PJE_JOB_TYPE_LOGIN_SESSION:
        message = (
            "Sessão assistida PJe ainda precisa da ponte interativa do worker; "
            "nenhuma senha, certificado ou credencial foi solicitada nem armazenada."
        )
    elif job_type == PJE_JOB_TYPE_SYNC_ACCOUNT:
        message = "Sincronização PJe autenticada aguardando sessão interativa válida para esta conta."
    elif job_type == PJE_JOB_TYPE_AUTH_COLLECT:
        message = "Coleta PJe autenticada aguardando sessão interativa válida para esta conta."
    else:
        message = f"Tipo de job PJe não suportado pelo worker: {job_type or 'vazio'}."
    if account_label:
        message = f"{message} ({account_label})"
    return False, message, {
        "failure_kind": "manual_required",
        "job_type": job_type,
        "account_id": str(job.get("account_id") or ""),
        "session_dir": str(job.get("session_dir") or ""),
    }


def collector_failure_kind(completed: subprocess.CompletedProcess[str]) -> str:
    output = f"{completed.stdout or ''}\n{completed.stderr or ''}"
    if completed.returncode == ORIGIN_BLOCK_EXIT_CODE or ORIGIN_BLOCK_MARKER in output:
        return "blocked_by_origin"
    return ""


def collector_error_message(completed: subprocess.CompletedProcess[str], failure_kind: str) -> str:
    if failure_kind == "blocked_by_origin":
        return "PJe bloqueou a origem/IP do worker antes do CAPTCHA (HTTP 403/CloudFront)."
    return short_tail(completed.stderr or completed.stdout or "coletor retornou erro", 1000)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Busca jobs PJe na Justra e executa a coleta automática.")
    parser.add_argument("--justra-url", default="https://staging.justra.com.br", help="Base URL da Justra.")
    parser.add_argument("--token", default=os.getenv("JUSTRA_PJE_OPERATOR_TOKEN", ""), help="Token de operador ou token admin.")
    parser.add_argument("--operator-id", default=os.getenv("JUSTRA_PJE_OPERATOR_ID", socket.gethostname()), help="Identificador do worker.")
    parser.add_argument("--poll-seconds", type=float, default=10.0, help="Intervalo de polling quando não houver job.")
    parser.add_argument("--once", action="store_true", help="Executa no máximo um job e sai.")
    parser.add_argument("--idle-exit-after", type=int, default=0, help="Sair após N segundos sem job. 0 mantém rodando.")
    parser.add_argument("--collector-timeout", type=int, default=300, help="Timeout repassado ao pje_operator_collect.py.")
    parser.add_argument("--headless", action="store_true", help="Executar o navegador do coletor sem interface.")
    parser.add_argument("--keep-open", action="store_true", help="Manter Chrome aberto após a coleta.")
    parser.add_argument("--azure-openai-endpoint", default=os.getenv("AZURE_OPENAI_ENDPOINT", ""), help="Endpoint Azure OpenAI repassado ao coletor.")
    parser.add_argument("--azure-openai-deployment", default=os.getenv("AZURE_OPENAI_DEPLOYMENT", ""), help="Deployment Azure OpenAI repassado ao coletor.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    token = str(args.token or "").strip()
    if not token:
        print("[agent] Informe --token ou JUSTRA_PJE_OPERATOR_TOKEN.", file=sys.stderr)
        return 2
    extra_args = ["--timeout", str(max(30, int(args.collector_timeout)))]
    if args.headless:
        extra_args.append("--headless")
    if args.keep_open:
        extra_args.append("--keep-open")
    if args.azure_openai_endpoint:
        extra_args.extend(["--azure-openai-endpoint", str(args.azure_openai_endpoint)])
    if args.azure_openai_deployment:
        extra_args.extend(["--azure-openai-deployment", str(args.azure_openai_deployment)])
    idle_since = time.monotonic()
    while True:
        try:
            job = claim_next_job(args.justra_url, token, args.operator_id)
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] Falha ao consultar fila: {exc}", file=sys.stderr)
            if args.once:
                return 1
            time.sleep(max(1.0, float(args.poll_seconds)))
            continue
        if not job:
            if args.once:
                print("[agent] Nenhum job disponível.")
                return 0
            if args.idle_exit_after and time.monotonic() - idle_since >= args.idle_exit_after:
                print("[agent] Sem jobs no período configurado; encerrando.")
                return 0
            time.sleep(max(1.0, float(args.poll_seconds)))
            continue
        idle_since = time.monotonic()
        job_id = str(job.get("id") or "")
        try:
            job_type = str(job.get("job_type") or PJE_JOB_TYPE_PUBLIC_COLLECT)
            if job_type in PJE_ACCOUNT_JOB_TYPES:
                ok, error, result = account_job_manual_result(job)
                print(f"[agent] Job {job_id} requer etapa interativa: {error}")
                finish_job(args.justra_url, token, job_id, ok, error=error, result=result)
                if args.once:
                    return 1
                continue
            if job_type not in PJE_PUBLIC_JOB_TYPES:
                ok, error, result = account_job_manual_result(job)
                print(f"[agent] Job {job_id} ignorado: {error}")
                finish_job(args.justra_url, token, job_id, ok, error=error, result=result)
                if args.once:
                    return 1
                continue
            completed = run_collector(job, args.justra_url, extra_args)
            if completed.stdout:
                print(completed.stdout)
            if completed.stderr:
                print(completed.stderr, file=sys.stderr)
            ok = completed.returncode == 0
            failure_kind = "" if ok else collector_failure_kind(completed)
            result = {
                "returncode": completed.returncode,
                "stdout_tail": short_tail(completed.stdout),
                "stderr_tail": short_tail(completed.stderr),
                "failure_kind": failure_kind,
            }
            finish_job(
                args.justra_url,
                token,
                job_id,
                ok,
                error="" if ok else collector_error_message(completed, failure_kind),
                result=result,
            )
            if not ok and args.once:
                return completed.returncode or 1
        except Exception as exc:  # noqa: BLE001
            print(f"[agent] Job {job_id} falhou: {exc}", file=sys.stderr)
            try:
                finish_job(args.justra_url, token, job_id, False, error=str(exc))
            except Exception as finish_exc:  # noqa: BLE001
                print(f"[agent] Também falhei ao reportar erro: {finish_exc}", file=sys.stderr)
            if args.once:
                return 1
        if args.once:
            return 0


if __name__ == "__main__":
    raise SystemExit(main())
