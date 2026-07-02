from __future__ import annotations

import argparse
import json
import os
import re
import sys
import traceback
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import duckdb
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "data" / "mvp" / "trt2" / "trt2_mvp.duckdb"


CLAIM_ALIASES = {
    "horas_extras": [
        "hora extra",
        "horas extras",
        "extraordinaria",
        "extraordinario",
        "sobrejornada",
        "cartao de ponto",
    ],
    "dano_moral": ["dano moral", "assedio moral"],
    "verbas_rescisorias": ["verbas rescisorias", "rescisorias", "aviso previo", "ferias proporcionais"],
    "adicional_insalubridade": ["insalubridade", "adicional de insalubridade"],
    "adicional_periculosidade": ["periculosidade", "adicional de periculosidade"],
    "vinculo_empregaticio": ["vinculo", "relacao de emprego", "reconhecimento de vinculo"],
    "intervalo_intrajornada": ["intervalo intrajornada", "intervalo para refeicao"],
    "multa_477": ["477"],
    "multa_467": ["467"],
    "fgts": ["fgts", "fundo de garantia"],
}

FINAL_OUTCOMES = ["procedente", "procedente_parcial", "improcedente", "acordo", "extinto"]
JUDGED_OUTCOMES = FINAL_OUTCOMES + ["julgamento"]


def normalize(value: str) -> str:
    table = str.maketrans(
        {
            "á": "a",
            "à": "a",
            "ã": "a",
            "â": "a",
            "é": "e",
            "ê": "e",
            "í": "i",
            "ó": "o",
            "ô": "o",
            "õ": "o",
            "ú": "u",
            "ç": "c",
            "Á": "A",
            "À": "A",
            "Ã": "A",
            "Â": "A",
            "É": "E",
            "Ê": "E",
            "Í": "I",
            "Ó": "O",
            "Ô": "O",
            "Õ": "O",
            "Ú": "U",
            "Ç": "C",
            "ª": "a",
            "º": "o",
        }
    )
    text = value.translate(table).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def today() -> date:
    return date.today()


def parse_period(question: str) -> dict[str, str]:
    q = normalize(question)
    current = today()
    if "ultimo mes" in q or "ultimos 30 dias" in q or "ultimos trinta dias" in q:
        start = current - timedelta(days=31)
        return {"label": "último mês", "start": start.isoformat(), "end": (current + timedelta(days=1)).isoformat()}

    days_match = re.search(r"ultimos? (\d{1,3}) dias", q)
    if days_match:
        days = int(days_match.group(1))
        start = current - timedelta(days=days)
        return {"label": f"últimos {days} dias", "start": start.isoformat(), "end": (current + timedelta(days=1)).isoformat()}

    year_match = re.search(r"\b(20\d{2})\b", q)
    if year_match:
        year = int(year_match.group(1))
        return {"label": str(year), "start": f"{year}-01-01", "end": f"{year + 1}-01-01"}

    return {
        "label": "todo o acervo carregado",
        "start": "1900-01-01",
        "end": "2999-01-01",
    }


def date_to_datajud_int(value: str) -> int:
    return int(value.replace("-", "") + "000000")


def extract_claim(question: str) -> str | None:
    q = normalize(question)
    for claim_type, aliases in CLAIM_ALIASES.items():
        if any(normalize(alias) in q for alias in aliases):
            return claim_type
    return None


def extract_vara_number(question: str) -> str | None:
    q = normalize(question)
    patterns = [
        r"\bvara\s+(\d{1,2})\b",
        r"\bvt\s+(\d{1,2})\b",
        r"\b(\d{1,2})a?\s+vara\b",
    ]
    for pattern in patterns:
        match = re.search(pattern, q)
        if match:
            return match.group(1)
    return None


def wants_judgment_metric(question: str) -> bool:
    q = normalize(question)
    return any(
        term in q
        for term in [
            "julgad",
            "procedente",
            "improcedente",
            "desfecho",
            "resultado",
            "favorav",
            "favorab",
        ]
    )


def wants_top_subjects(question: str) -> bool:
    q = normalize(question)
    return "assunto" in q or "tema" in q


def wants_top_claims(question: str) -> bool:
    q = normalize(question)
    return "pedido" in q or "claim" in q


@dataclass
class CourtResolution:
    selected: str | None
    ambiguous: bool
    candidates: list[dict[str, Any]]
    note: str = ""


class AcervoChatEngine:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.con = duckdb.connect(str(db_path), read_only=True)
        self.courts = self._load_courts()

    def close(self) -> None:
        self.con.close()

    def _load_courts(self) -> list[dict[str, Any]]:
        rows = self.con.execute(
            """
            SELECT court_unit, COUNT(*) AS total
            FROM processes
            WHERE court_unit IS NOT NULL AND court_unit <> ''
            GROUP BY 1
            ORDER BY total DESC
            """
        ).fetchall()
        return [{"court_unit": row[0], "total": row[1], "norm": normalize(row[0])} for row in rows]

    def resolve_court(self, question: str) -> CourtResolution:
        q = normalize(question)
        if not any(term in q for term in ["vara", "vt", "turma", "sdi", "pleno", "cadeira", "guarulhos", "sao paulo"]):
            return CourtResolution(None, False, [], "sem filtro de unidade")

        exact = [court for court in self.courts if court["norm"] and court["norm"] in q]
        if len(exact) == 1:
            return CourtResolution(exact[0]["court_unit"], False, exact[:1])
        if len(exact) > 1:
            return CourtResolution(None, True, exact[:12], "mais de uma unidade mencionada")

        vara_number = extract_vara_number(question)
        scored: list[dict[str, Any]] = []
        q_tokens = set(q.split())
        for court in self.courts:
            cn = court["norm"]
            score = 0
            if vara_number and re.search(rf"\b{re.escape(vara_number)}a vara\b", cn):
                score += 5
            for token in q_tokens:
                if len(token) >= 4 and token in cn:
                    score += 1
            if "trabalho" in q and "trabalho" in cn:
                score += 1
            if score:
                scored.append({**court, "score": score})

        scored.sort(key=lambda item: (item["score"], item["total"]), reverse=True)
        if not scored:
            return CourtResolution(None, False, [], "unidade não encontrada")

        if scored[0]["score"] >= 7 and (len(scored) == 1 or scored[0]["score"] >= scored[1]["score"] + 2):
            return CourtResolution(scored[0]["court_unit"], False, scored[:5])

        if vara_number and len(scored) > 1:
            return CourtResolution(None, True, scored[:12], "vara ambígua; informe a cidade/unidade")

        if scored[0]["score"] >= 4:
            return CourtResolution(scored[0]["court_unit"], False, scored[:5])

        return CourtResolution(None, True, scored[:12], "unidade ambígua")

    def answer(self, question: str) -> dict[str, Any]:
        period = parse_period(question)
        claim = extract_claim(question)
        court = self.resolve_court(question)
        if court.ambiguous:
            return self._ambiguous_court_answer(question, period, claim, court)

        if wants_judgment_metric(question) or claim:
            return self._judgment_metrics(question, period, claim, court.selected)
        if wants_top_subjects(question):
            return self._top_subjects(question, period, court.selected)
        if wants_top_claims(question):
            return self._top_claims(question, period, court.selected)
        return self._overview(question, period, court.selected)

    def _where_process_scope(self, period: dict[str, str], court_unit: str | None) -> tuple[str, list[Any]]:
        clauses = ["p.filing_date >= ?", "p.filing_date < ?"]
        params: list[Any] = [date_to_datajud_int(period["start"]), date_to_datajud_int(period["end"])]
        if court_unit:
            clauses.append("p.court_unit = ?")
            params.append(court_unit)
        return " AND ".join(clauses), params

    def _where_decision_scope(self, period: dict[str, str], court_unit: str | None) -> tuple[str, list[Any]]:
        clauses = ["CAST(d.movement_date AS DATE) >= CAST(? AS DATE)", "CAST(d.movement_date AS DATE) < CAST(? AS DATE)"]
        params: list[Any] = [period["start"], period["end"]]
        if court_unit:
            clauses.append("d.court_unit = ?")
            params.append(court_unit)
        return " AND ".join(clauses), params

    def _judgment_metrics(
        self,
        question: str,
        period: dict[str, str],
        claim: str | None,
        court_unit: str | None,
    ) -> dict[str, Any]:
        decision_where, decision_params = self._where_decision_scope(period, court_unit)
        claim_join = ""
        claim_where = ""
        params = list(decision_params)
        if claim:
            claim_join = "JOIN claims c ON c.process_number = d.process_number"
            claim_where = "AND c.claim_type = ?"
            params.append(claim)

        judged_sql = f"""
            SELECT COUNT(DISTINCT d.process_number) AS total
            FROM decision_events d
            {claim_join}
            WHERE {decision_where}
              AND d.outcome_proxy IN ({",".join(["?"] * len(JUDGED_OUTCOMES))})
              {claim_where}
        """
        judged_params = list(decision_params) + JUDGED_OUTCOMES
        if claim:
            judged_params.append(claim)
        judged_total = self.con.execute(judged_sql, judged_params).fetchone()[0]

        outcome_sql = f"""
            SELECT d.outcome_proxy, COUNT(DISTINCT d.process_number) AS total
            FROM decision_events d
            {claim_join}
            WHERE {decision_where}
              AND d.outcome_proxy IN ({",".join(["?"] * len(FINAL_OUTCOMES))})
              {claim_where}
            GROUP BY 1
            ORDER BY total DESC
        """
        outcome_params = list(decision_params) + FINAL_OUTCOMES
        if claim:
            outcome_params.append(claim)
        outcome_rows = [
            {"outcome": row[0], "total": row[1]}
            for row in self.con.execute(outcome_sql, outcome_params).fetchall()
        ]

        final_outcome_sql = f"""
            SELECT COUNT(DISTINCT d.process_number) AS total
            FROM decision_events d
            {claim_join}
            WHERE {decision_where}
              AND d.outcome_proxy IN ({",".join(["?"] * len(FINAL_OUTCOMES))})
              {claim_where}
        """
        final_outcome_params = list(decision_params) + FINAL_OUTCOMES
        if claim:
            final_outcome_params.append(claim)
        final_outcome_total = self.con.execute(final_outcome_sql, final_outcome_params).fetchone()[0]

        favorable_sql = f"""
            SELECT COUNT(DISTINCT d.process_number) AS total
            FROM decision_events d
            {claim_join}
            WHERE {decision_where}
              AND d.outcome_proxy IN ('procedente', 'procedente_parcial')
              {claim_where}
        """
        favorable_params = list(decision_params)
        if claim:
            favorable_params.append(claim)
        favorable_total = self.con.execute(favorable_sql, favorable_params).fetchone()[0]

        process_where, process_params = self._where_process_scope(period, court_unit)
        filed_claim_total = None
        if claim:
            filed_claim_total = self.con.execute(
                f"""
                SELECT COUNT(DISTINCT p.process_number)
                FROM processes p
                JOIN claims c USING(process_number)
                WHERE {process_where} AND c.claim_type = ?
                """,
                process_params + [claim],
            ).fetchone()[0]

        sample_sql = f"""
            SELECT DISTINCT
                d.process_number,
                p.process_number_formatted,
                d.outcome_proxy,
                d.movement_name,
                CAST(d.movement_date AS VARCHAR) AS movement_date
            FROM decision_events d
            JOIN processes p USING(process_number)
            {claim_join}
            WHERE {decision_where}
              AND d.outcome_proxy IN ({",".join(["?"] * len(FINAL_OUTCOMES))})
              {claim_where}
            ORDER BY d.movement_date DESC
            LIMIT 8
        """
        sample_params = list(decision_params) + FINAL_OUTCOMES
        if claim:
            sample_params.append(claim)
        samples = [
            {
                "process_number": row[0],
                "formatted": row[1],
                "outcome": row[2],
                "movement": row[3],
                "date": str(row[4]),
            }
            for row in self.con.execute(sample_sql, sample_params).fetchall()
        ]

        data = {
            "kind": "judgment_metrics",
            "question": question,
            "period": period,
            "court_unit": court_unit,
            "claim_type": claim,
            "judged_processes": judged_total,
            "final_outcome_processes": final_outcome_total,
            "favorable_to_employee_proxy": favorable_total,
            "filed_claim_processes_in_period": filed_claim_total,
            "outcomes": outcome_rows,
            "samples": samples,
            "limits": [
                "Desfecho é aproximado por movimentos do DataJud, não por leitura do inteiro teor.",
                "Favorável ao trabalhador é proxy: procedente ou procedente_parcial para o pedido filtrado.",
                "Fundamentos, prova valorizada e precedentes citados dependem da tabela full_text_documents.",
                "Processos julgados usam data do movimento; processos ajuizados usam dataAjuizamento.",
            ],
        }
        data["deterministic_answer"] = self._format_judgment_answer(data)
        return data

    def _top_subjects(self, question: str, period: dict[str, str], court_unit: str | None) -> dict[str, Any]:
        where, params = self._where_process_scope(period, court_unit)
        rows = self.con.execute(
            f"""
            SELECT s.subject_name, COUNT(DISTINCT s.process_number) AS total
            FROM subjects s
            JOIN processes p USING(process_number)
            WHERE {where}
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 15
            """,
            params,
        ).fetchall()
        data = {
            "kind": "top_subjects",
            "question": question,
            "period": period,
            "court_unit": court_unit,
            "rows": [{"subject": row[0], "total": row[1]} for row in rows],
            "limits": ["Assuntos vêm do DataJud; podem ser incompletos ou inconsistentes."],
        }
        data["deterministic_answer"] = self._format_rank_answer(data, "subject")
        return data

    def _top_claims(self, question: str, period: dict[str, str], court_unit: str | None) -> dict[str, Any]:
        where, params = self._where_process_scope(period, court_unit)
        rows = self.con.execute(
            f"""
            SELECT c.claim_type, COUNT(DISTINCT c.process_number) AS total
            FROM claims c
            JOIN processes p USING(process_number)
            WHERE {where}
            GROUP BY 1
            ORDER BY total DESC
            LIMIT 15
            """,
            params,
        ).fetchall()
        data = {
            "kind": "top_claims",
            "question": question,
            "period": period,
            "court_unit": court_unit,
            "rows": [{"claim_type": row[0], "total": row[1]} for row in rows],
            "limits": ["Pedidos são classificados por assunto/termos, ainda sem inteiro teor."],
        }
        data["deterministic_answer"] = self._format_rank_answer(data, "claim_type")
        return data

    def _overview(self, question: str, period: dict[str, str], court_unit: str | None) -> dict[str, Any]:
        where, params = self._where_process_scope(period, court_unit)
        total = self.con.execute(f"SELECT COUNT(DISTINCT p.process_number) FROM processes p WHERE {where}", params).fetchone()[0]
        movements = self.con.execute(
            f"""
            SELECT COUNT(*)
            FROM movements m
            JOIN processes p USING(process_number)
            WHERE {where}
            """,
            params,
        ).fetchone()[0]
        data = {
            "kind": "overview",
            "question": question,
            "period": period,
            "court_unit": court_unit,
            "processes": total,
            "movements": movements,
            "limits": ["Visão geral do acervo DataJud carregado localmente."],
        }
        data["deterministic_answer"] = (
            f"No recorte {period['label']}"
            f"{' em ' + court_unit if court_unit else ' no TRT2'}, há {total} processos e {movements} movimentos no acervo local."
        )
        return data

    def _ambiguous_court_answer(
        self,
        question: str,
        period: dict[str, str],
        claim: str | None,
        court: CourtResolution,
    ) -> dict[str, Any]:
        candidates = [{"court_unit": item["court_unit"], "total": item["total"]} for item in court.candidates]
        lines = [
            "A unidade está ambígua. Informe a cidade ou copie exatamente uma das opções abaixo:",
            *[f"- {item['court_unit']} ({item['total']} processos no acervo local)" for item in candidates[:8]],
        ]
        data = {
            "kind": "ambiguous_court",
            "question": question,
            "period": period,
            "claim_type": claim,
            "candidates": candidates,
            "limits": ["Sem a unidade exata, eu posso misturar varas diferentes."],
            "deterministic_answer": "\n".join(lines),
        }
        return data

    def _format_judgment_answer(self, data: dict[str, Any]) -> str:
        claim = data.get("claim_type") or "todos os pedidos"
        scope = data.get("court_unit") or "TRT2 inteiro"
        lines = [
            f"No recorte {data['period']['label']}, em {scope}, encontrei {data['judged_processes']} processos com movimento de julgamento/decisão para {claim}.",
        ]
        if data.get("final_outcome_processes") != data.get("judged_processes"):
            lines.append(f"Com desfecho final identificado pela heurística: {data['final_outcome_processes']}.")
        if data.get("filed_claim_processes_in_period") is not None:
            lines.append(f"No mesmo período, há {data['filed_claim_processes_in_period']} processos ajuizados/classificados com esse pedido.")
        if data.get("favorable_to_employee_proxy") is not None:
            lines.append(
                "Favoráveis ao trabalhador "
                f"(proxy: procedente + procedente_parcial): {data['favorable_to_employee_proxy']}."
            )
        if data.get("outcomes"):
            lines.append("Desfechos aproximados por movimento:")
            for row in data["outcomes"]:
                lines.append(f"- {row['outcome']}: {row['total']}")
        else:
            lines.append("Não encontrei movimentos de procedência/improcedência/acordo/extinção nesse recorte.")
        lines.append("Observação: isso ainda não lê fundamentos do inteiro teor.")
        return "\n".join(lines)

    def _format_rank_answer(self, data: dict[str, Any], key: str) -> str:
        scope = data.get("court_unit") or "TRT2 inteiro"
        lines = [f"Top resultados no recorte {data['period']['label']} em {scope}:"]
        for row in data.get("rows", [])[:10]:
            lines.append(f"- {row[key]}: {row['total']}")
        return "\n".join(lines)


def build_llm_answer(question: str, tool_result: dict[str, Any]) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    model = os.getenv("OPENAI_MODEL", "gpt-5.5").strip() or "gpt-5.5"
    if not api_key:
        return {"answer": tool_result["deterministic_answer"], "model_used": None, "llm_error": "OPENAI_API_KEY ausente"}

    try:
        from openai import OpenAI

        client = OpenAI(api_key=api_key)
        system = (
            "Você é o chat jurimétrico da Justra. Responda em português brasileiro, com números exatos "
            "vindos do JSON. Não invente dados, não afirme fundamento/prova/precedente se full_text_documents "
            "estiver vazio ou se o resultado disser que depende de inteiro teor. Seja direto e útil para advogado trabalhista."
        )
        response = client.responses.create(
            model=model,
            input=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": (
                        "Pergunta do usuário:\n"
                        f"{question}\n\n"
                        "Resultado determinístico do acervo local em JSON:\n"
                        f"{json.dumps(tool_result, ensure_ascii=False, indent=2)}"
                    ),
                },
            ],
        )
        answer = getattr(response, "output_text", "") or tool_result["deterministic_answer"]
        return {"answer": answer, "model_used": model, "llm_error": None}
    except Exception as exc:  # noqa: BLE001
        return {"answer": tool_result["deterministic_answer"], "model_used": model, "llm_error": str(exc)}


CHAT_HTML = r"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Justra Chat - Acervo TRT2</title>
  <style>
    :root {
      --ink: #202a28;
      --muted: #66736f;
      --line: #d7dedb;
      --page: #f5f7f6;
      --surface: #fff;
      --nav: #253431;
      --teal: #0b6b5a;
      --amber: #8a620f;
      --red: #a64235;
      --shadow: 0 10px 24px rgba(32, 42, 40, .08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background: var(--page);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .shell { display: grid; grid-template-columns: 320px 1fr; min-height: 100vh; }
    aside { padding: 22px; color: #eef7f4; background: var(--nav); }
    aside h1 { margin: 0 0 10px; font-size: 25px; line-height: 1.1; }
    aside p { color: #bed0cb; line-height: 1.5; }
    .examples { display: grid; gap: 8px; margin-top: 18px; }
    .examples button {
      padding: 10px;
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 8px;
      color: #eef7f4;
      background: rgba(255,255,255,.06);
      text-align: left;
      cursor: pointer;
    }
    main { display: grid; grid-template-rows: 1fr auto; min-width: 0; }
    .messages { padding: 22px; overflow: auto; }
    .msg { max-width: 900px; margin: 0 0 14px; padding: 14px; border-radius: 8px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); white-space: pre-wrap; line-height: 1.5; }
    .msg.user { margin-left: auto; background: #e4f1ed; border-color: #c3ddd5; }
    .meta { margin-top: 8px; color: var(--muted); font-size: 12px; }
    form { display: grid; grid-template-columns: 1fr auto; gap: 10px; padding: 16px 22px; border-top: 1px solid var(--line); background: var(--surface); }
    textarea { width: 100%; min-height: 48px; max-height: 160px; padding: 12px; border: 1px solid var(--line); border-radius: 8px; resize: vertical; font: inherit; }
    button.primary { min-width: 110px; border: 0; border-radius: 8px; color: white; background: var(--teal); font-weight: 800; cursor: pointer; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width: 860px) {
      .shell { grid-template-columns: 1fr; }
      aside { min-height: auto; }
      form { grid-template-columns: 1fr; }
      button.primary { min-height: 42px; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside>
      <h1>Justra Chat</h1>
      <p>Consulta o DuckDB local do TRT2 e responde com contagens reais. Quando houver inteiro teor, a tabela <code>full_text_documents</code> entra na mesma conversa.</p>
      <div class="examples">
        <button type="button">Na 1ª Vara do Trabalho de Guarulhos, no último mês, quantos processos de horas extras foram julgados? Quantos foram procedentes?</button>
        <button type="button">Quais foram os pedidos mais frequentes no TRT2 no último mês?</button>
        <button type="button">Quais assuntos aparecem mais na 1ª Vara do Trabalho de Guarulhos no último mês?</button>
        <button type="button">No TRT2 no último mês, qual foi o desfecho mais comum em dano moral?</button>
      </div>
    </aside>
    <main>
      <div class="messages" id="messages">
        <div class="msg">Pronto. Pergunte sobre vara, pedido, período e desfecho. Ex.: <code>Na 1ª Vara do Trabalho de Guarulhos, no último mês, quantos processos de horas extras foram julgados?</code></div>
      </div>
      <form id="chat-form">
        <textarea id="question" placeholder="Digite sua pergunta sobre o acervo TRT2..."></textarea>
        <button class="primary" type="submit">Perguntar</button>
      </form>
    </main>
  </div>
  <script>
    const messages = document.getElementById('messages');
    const form = document.getElementById('chat-form');
    const question = document.getElementById('question');
    function addMessage(text, kind = 'assistant', meta = '') {
      const div = document.createElement('div');
      div.className = `msg ${kind}`;
      div.textContent = text;
      if (meta) {
        const m = document.createElement('div');
        m.className = 'meta';
        m.textContent = meta;
        div.appendChild(m);
      }
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }
    async function ask(text) {
      addMessage(text, 'user');
      const pending = addMessage('Consultando acervo...', 'assistant');
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      const data = await res.json();
      pending.textContent = data.answer || data.error || 'Sem resposta.';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `Fonte: DuckDB local${data.model_used ? ' + ' + data.model_used : ''}${data.llm_error ? ' | LLM: ' + data.llm_error : ''}`;
      pending.appendChild(meta);
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = question.value.trim();
      if (!text) return;
      question.value = '';
      ask(text).catch((err) => addMessage(String(err), 'assistant'));
    });
    document.querySelectorAll('.examples button').forEach((btn) => {
      btn.addEventListener('click', () => {
        question.value = btn.textContent.trim();
        question.focus();
      });
    });
  </script>
</body>
</html>
"""


def make_handler(engine: AcervoChatEngine):
    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_html(self, html: str) -> None:
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/" or path == "/chat":
                self._send_html(CHAT_HTML)
                return
            if path == "/api/health":
                counts = {
                    table: engine.con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                    for table in ["processes", "subjects", "movements", "decision_events", "claims", "full_text_documents"]
                }
                self._send_json({"ok": True, "counts": counts})
                return
            self.send_error(404)

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path != "/api/chat":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                message = str(payload.get("message", "")).strip()
                if not message:
                    self._send_json({"error": "message vazio"}, status=400)
                    return
                tool_result = engine.answer(message)
                llm = build_llm_answer(message, tool_result)
                self._send_json({**llm, "tool_result": tool_result})
            except Exception as exc:  # noqa: BLE001
                self._send_json({"error": str(exc), "traceback": traceback.format_exc()}, status=500)

        def log_message(self, fmt: str, *args: Any) -> None:
            print(f"[chat] {self.address_string()} - {fmt % args}")

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve a local chat over the TRT2 DuckDB acervo.")
    parser.add_argument("--db", default=str(DEFAULT_DB))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    db_path = Path(args.db)
    if not db_path.exists():
        raise RuntimeError(f"DuckDB não encontrado: {db_path}")

    engine = AcervoChatEngine(db_path)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(engine))
    print(f"Justra Chat em http://{args.host}:{args.port}")
    print(f"DuckDB: {db_path}")
    try:
        server.serve_forever()
    finally:
        engine.close()


if __name__ == "__main__":
    main()
