from __future__ import annotations

import html
from pathlib import Path

import pandas as pd

from jurimetrics.by_claim import summarize_by_claim
from jurimetrics.by_court_unit import summarize_by_court_unit
from jurimetrics.by_judge import summarize_by_judge
try:
    from src.justra_paths import DATA_ROOT
except ModuleNotFoundError:  # scripts antigos adicionam ROOT/src ao sys.path
    from justra_paths import DATA_ROOT


def pct(value: float) -> str:
    return f"{value * 100:.1f}%"


def table_html(df: pd.DataFrame, max_rows: int = 20) -> str:
    if df.empty:
        return "<p>Sem dados.</p>"
    return df.head(max_rows).to_html(index=False, escape=True, border=0, classes="data-table")


def metric_card(label: str, value: str) -> str:
    return f"<div class='metric'><span>{html.escape(label)}</span><strong>{html.escape(value)}</strong></div>"


def generate_report(
    project_root: Path,
    decisions_path: Path | None = None,
    claims_path: Path | None = None,
    output_path: Path | None = None,
) -> Path:
    decisions_path = decisions_path or DATA_ROOT / "processed" / "decisions.csv"
    claims_path = claims_path or DATA_ROOT / "processed" / "claims.csv"
    output_path = output_path or project_root / "reports/trt2_v0_report.html"

    decisions = pd.read_csv(decisions_path) if decisions_path.exists() else pd.DataFrame()
    claims = pd.read_csv(claims_path) if claims_path.exists() else pd.DataFrame()

    total_docs = len(decisions)
    extraction_rate = decisions.get("text_extraction_ok", pd.Series(dtype=bool)).fillna(False).mean() if total_docs else 0
    process_rate = decisions.get("process_number", pd.Series(dtype=str)).fillna("").astype(str).ne("").mean() if total_docs else 0
    judge_rate = decisions.get("judge_name", pd.Series(dtype=str)).fillna("").astype(str).ne("").mean() if total_docs else 0

    top_claims = claims.groupby("claim_type").size().reset_index(name="total").sort_values("total", ascending=False) if not claims.empty else pd.DataFrame()
    claim_summary = summarize_by_claim(claims)
    court_summary = summarize_by_court_unit(decisions)
    judge_summary = summarize_by_judge(decisions)

    examples_cols = ["title", "process_number", "judge_name", "outcome", "claims", "source_url"]
    examples = decisions[[col for col in examples_cols if col in decisions.columns]].head(10) if not decisions.empty else pd.DataFrame()

    html_doc = f"""<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Justra v0 - TRT2 Local</title>
  <style>
    body {{ font-family: Arial, sans-serif; margin: 32px; color: #1f2933; background: #f7f8fa; }}
    main {{ max-width: 1180px; margin: 0 auto; }}
    h1, h2 {{ color: #102a43; }}
    .metrics {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin: 24px 0; }}
    .metric {{ background: white; border: 1px solid #d9e2ec; border-radius: 8px; padding: 16px; }}
    .metric span {{ display: block; color: #52606d; font-size: 13px; margin-bottom: 8px; }}
    .metric strong {{ font-size: 24px; }}
    section {{ background: white; border: 1px solid #d9e2ec; border-radius: 8px; padding: 20px; margin: 16px 0; }}
    table.data-table {{ width: 100%; border-collapse: collapse; font-size: 14px; }}
    .data-table th, .data-table td {{ border-bottom: 1px solid #e4e7eb; padding: 8px; vertical-align: top; }}
    .data-table th {{ text-align: left; color: #334e68; background: #f0f4f8; }}
    .limitations li {{ margin-bottom: 8px; }}
  </style>
</head>
<body>
<main>
  <h1>Justra v0 - TRT2 Local</h1>
  <p>Relatorio local gerado a partir dos documentos coletados e classificados no pipeline.</p>
  <div class="metrics">
    {metric_card("Documentos processados", str(total_docs))}
    {metric_card("Texto limpo extraido", pct(float(extraction_rate)))}
    {metric_card("Numero do processo", pct(float(process_rate)))}
    {metric_card("Juiz/relator identificado", pct(float(judge_rate)))}
  </div>

  <section>
    <h2>Top pedidos</h2>
    {table_html(top_claims)}
  </section>

  <section>
    <h2>Resultados por pedido</h2>
    {table_html(claim_summary)}
  </section>

  <section>
    <h2>Top varas/unidades</h2>
    {table_html(court_summary)}
  </section>

  <section>
    <h2>Resultados por juiz/relator</h2>
    {table_html(judge_summary)}
  </section>

  <section>
    <h2>Exemplos de decisoes/documentos</h2>
    {table_html(examples, max_rows=10)}
  </section>

  <section>
    <h2>Limitacoes da coleta</h2>
    <ul class="limitations">
      <li>O Basis TRT2 e uma fonte institucional DSpace; nem todo item encontrado e decisao individual.</li>
      <li>Campos como juiz de 1o grau e resultado por pedido dependem de texto estruturado ou validacao posterior por LLM.</li>
      <li>As classificacoes atuais sao heuristicas e devem ser auditadas por amostragem juridica.</li>
      <li>Antes de escalar para 500+ documentos, validar termos de uso, limites de requisicao e cobertura da fonte jurisprudencial publica.</li>
    </ul>
  </section>
</main>
</body>
</html>
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html_doc, encoding="utf-8")
    return output_path
