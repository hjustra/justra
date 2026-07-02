# Justra v0 - TRT2 Local

Experimento inicial de jurimetria trabalhista usando dados publicos do TRT2.

## Objetivo

Construir uma versao local da Justra focada em uma pergunta simples:

> Conseguimos coletar decisoes publicas do TRT2, estruturar os dados e gerar estatisticas uteis por vara, juiz, assunto e tipo de pedido?

Este v0 nao tem objetivo comercial imediato. O objetivo e validar a viabilidade tecnica e a utilidade juridica da base.

## Escopo do v0

Tribunal inicial: `TRT2 - Tribunal Regional do Trabalho da 2a Regiao`

Fontes-alvo:

1. Basis TRT2
2. Pesquisa jurisprudencial publica do TRT2
3. DataJud apenas como fonte auxiliar, se necessario

Observacao importante: o Basis TRT2 e um repositorio DSpace institucional. A busca por `Jurisprudência trabalhista` retorna itens e PDFs uteis para descoberta inicial, mas nem todos sao decisoes/acordaos individuais. O pipeline foi deixado modular para trocar ou combinar a fonte quando a pesquisa jurisprudencial publica estiver mapeada.

## Estrutura

```text
data/
  raw/
    html/
    pdf/
    json/
  processed/
    decisions.csv
    claims.csv
    jurimetrics.csv
notebooks/
src/
  collectors/
  parsers/
  classifiers/
  jurimetrics/
  reports/
scripts/
reports/
```

Por padrao, `data/` e `logs/` ficam dentro do checkout local. Em servidor, defina `JUSTRA_DATA_DIR` e `JUSTRA_LOG_DIR` para manter dados e logs fora do repositorio:

```text
JUSTRA_DATA_DIR=/mnt/justra-data
JUSTRA_LOG_DIR=/mnt/justra-logs
```

Os coletores Falcao tambem aceitam `JUSTRA_NODE_BIN`, `JUSTRA_NODE_MODULES` e `JUSTRA_CHROME_PATH` quando rodarem em servidor.

## Setup

```bash
cd pesquisa
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

## Planos e Stripe

O app inclui um plano Grátis com 100 mil tokens e uma conversa por ciclo mensal, além do Premium com 3 milhões de tokens e conversas ilimitadas. O checkout e o portal de cobrança usam páginas hospedadas pela Stripe.

Para ativar pagamentos, preencha no `.env`:

```bash
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
JUSTRA_PUBLIC_URL=http://127.0.0.1:8787
```

O webhook deve apontar para `POST /api/stripe/webhook`. Se `STRIPE_PREMIUM_PRICE_ID` ficar vazio, o produto **Justra Premium** e o preço mensal configurado em `JUSTRA_PREMIUM_PRICE_CENTS` são criados automaticamente na primeira tentativa de assinatura.

## Login com Google

Crie um cliente OAuth do tipo **Web application** no Google Auth Platform e cadastre exatamente esta URI de redirecionamento:

```text
http://127.0.0.1:8787/api/auth/google/callback
```

Depois preencha:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://127.0.0.1:8787/api/auth/google/callback
```

O fluxo pede somente `openid`, `email` e `profile`, valida o parâmetro `state`, não persiste tokens do Google e troca o retorno OAuth por um código de login Justra de uso único.

## Pipeline local

### 1. Descobrir e baixar documentos do Basis

```bash
python scripts/crawl_basis_trt2.py --limit 50
```

Saida principal:

```text
data/raw/json/document_index.json
data/raw/html/
data/raw/pdf/
```

Para descobrir sem baixar HTML/PDF:

```bash
python scripts/crawl_basis_trt2.py --limit 50 --no-download
```

Para tentar uma coleta ampla com varias buscas e deduplicacao persistente:

```bash
python scripts/crawl_basis_trt2.py --all --sleep 1.2
```

O crawler mantem:

```text
data/raw/json/document_index.json
data/raw/json/download_manifest.json
```

O `download_manifest.json` evita baixar novamente o mesmo item entre execucoes. A chave principal e o `handle` do Basis/TRT2; quando ha PDF, o SHA-256 do arquivo tambem e registrado para identificar PDFs repetidos mesmo quando a URL muda. Se o site retornar erro temporario, como `403`, a coleta para a busca atual, preserva o indice existente e pode ser retomada com o mesmo comando depois.

### 2. Parsear documentos

```bash
python scripts/parse_documents.py
```

Saida:

```text
data/processed/decisions.csv
```

### 3. Classificar pedidos e resultados

```bash
python scripts/classify_outcomes.py
```

Saidas:

```text
data/processed/decisions.csv
data/processed/claims.csv
```

### 4. Gerar relatorio HTML

```bash
python scripts/generate_report.py
```

Saida:

```text
reports/trt2_v0_report.html
```

### 5. Gerar caso completo: horas extras em Guarulhos

```bash
DATAJUD_API_KEY=... python scripts/build_horas_extras_guarulhos_case.py
```

Saidas principais:

```text
reports/guarulhos_horas_extras_case.html
data/cases/guarulhos_horas_extras/processed/processes.csv
data/cases/guarulhos_horas_extras/processed/summary.json
data/cases/guarulhos_horas_extras/processed/knowledge_graph.json
```

### 6. Coleta PJe publica com limite e captcha manual

```bash
python scripts/crawl_pje_public_documents.py \
  --max-processes 10 \
  --max-per-minute 5 \
  --max-per-hour 60
```

O script salva dados basicos publicos, respeita limite persistente por minuto/hora e para no primeiro captcha por padrao. Quando o PJe devolve `tokenDesafio` + imagem, ele cria uma fila manual em:

```text
data/cases/guarulhos_horas_extras/pje_public/captcha_queue/
```

Este projeto nao automatiza OCR, bypass ou servico de quebra de captcha. A coleta deve usar apenas fluxo publico/autorizado, backoff, deduplicacao e resolucao humana quando a fonte exigir desafio.

## MVP geral TRT2

Para gerar a base local geral do TRT2 a partir do DataJud:

```bash
DATAJUD_API_KEY=... python scripts/build_trt2_mvp.py \
  --max-processes 5000 \
  --page-size 500 \
  --sleep 0.25
```

Saidas:

```text
data/mvp/trt2/raw/datajud_trt2_processes.jsonl
data/mvp/trt2/processed/processes.csv
data/mvp/trt2/processed/subjects.csv
data/mvp/trt2/processed/movements.csv
data/mvp/trt2/processed/decision_events.csv
data/mvp/trt2/processed/claims.csv
data/mvp/trt2/trt2_mvp.duckdb
reports/trt2_mvp_report.html
```

Para rodar sem limite, usar `--max-processes 0`. Use com cuidado: o TRT2 tem milhoes de processos e a coleta deve ser pausavel, deduplicada e respeitosa.

O MVP geral responde, com metadados e movimentos:

```text
volume por vara/orgao
assuntos mais frequentes
pedidos classificados por assunto
desfecho aproximado por movimento
pedido x desfecho aproximado
tempo/funil processual a partir de movimentos
```

O MVP geral ainda nao responde com seguranca:

```text
fundamentos vencedores
teses rejeitadas
precedentes citados no inteiro teor
tipo de prova valorizada por juiz
linha argumentativa com melhor historico
```

Essas perguntas dependem da tabela `full_text_documents`.

## Espaco para inteiro teor

Quando houver uma fonte propria/autorizada de inteiro teor, colocar arquivos em:

```text
data/mvp/trt2/full_text_inbox/
```

Contrato de campos:

```text
docs/full_text_import_contract.md
```

Importar para o DuckDB:

```bash
python scripts/import_full_text_documents.py
```

Isso preenche a tabela:

```text
full_text_documents
```

### Importação do Falcão

O painel administrativo usa o motor direto e particionado do Falcão para as
cinco coleções públicas (acórdãos, sentenças, decisões monocráticas,
admissibilidade de recurso de revista e precedentes), em todos os tribunais
disponíveis. A aba `D-1` executa a data anterior; a aba `Janelas` mantém um
plano móvel de 90 dias e permite executar um dia ou um intervalo.

As chamadas usam páginas de 10 itens e espera uniforme aleatória entre os
limites inferior e superior configurados no painel. D-1 e backfill são
serializados, compartilham checkpoints por data/coleção/página e interrompem a
execução imediatamente em HTTP 403 ou 429, desabilitando a coleta até o
reconhecimento manual do bloqueio.

HTTP 400, 408 e falhas 5xx não são classificados como bloqueio: o coletor faz
duas novas tentativas e, se o erro persistir, registra somente aquela partição
como pendente e continua as demais. Quando o erro ocorre em uma página, ele
tenta subdividir a partição por outra faceta para contornar o documento/lote
problemático. Páginas e partições concluídas permanecem no checkpoint. Ao reiniciar a aplicação, um D-1 interrompido é retomado
automaticamente; resultados parciais válidos também são importados.

Para validar a configuração sem acessar a rede:

```bash
node scripts/collect_falcao_direct.mjs --validate-only
```

Para importar de forma idempotente os acórdãos coletados do Falcão, preservando outras fontes e criando backup do DuckDB:

```bash
python scripts/import_falcao_full_text.py
```

O importador valida IDs, processos, texto integral e links; substitui apenas os registros com `source_provider = 'falcao'`; e grava o resultado em `data/knowledge/falcao/import_status.json`. O mapa de cobertura lê essa camada diretamente do DuckDB e mostra as contagens por tribunal.

## App local unificado

O MVP navegavel roda em uma unica aplicacao local:

```bash
python scripts/serve_justra_app.py
```

Abrir:

```text
http://127.0.0.1:8787
```

Paginas:

```text
/jurimetria   jurimetria com filtros, desfechos, pedidos, assuntos, varas e tabela de processos
/chat         chat com memoria curta de conversa e auditoria por graders
/admin/bot    saude do bot, guardrails, graders e configuracao editavel
/admin/mapa   mapa de cobertura por fonte, TRT e TST
```

O app consulta primeiro o DuckDB local. Com `OPENAI_API_KEY` no `.env`, o modelo explica o resultado deterministico; sem chave, a resposta textual deterministica continua funcionando.

Login local de desenvolvimento:

```text
admin@justra.local
defina JUSTRA_ADMIN_PASSWORD no .env
```

Para trocar o admin inicial antes do primeiro uso:

```text
JUSTRA_ADMIN_EMAIL=
JUSTRA_ADMIN_PASSWORD=
```

O login com Google nesta versao e um modo local de teste: ele cria/entra com o e-mail informado, mas ainda nao valida OAuth real com Google Identity.

Conversas do chat ficam salvas por `conversation_id` em:

```text
data/app/conversations.json
```

Configuracao editavel do bot:

```text
config/bot_controls.json
```

## Fontes de conhecimento TST/TRT2

Para estruturar as sumulas, OJs e precedentes normativos do TST e o indice-alvo de jurisprudencia/doutrina do Basis TRT2:

```bash
python scripts/collect_knowledge_sources.py \
  --basis-mode targets \
  --basis-rpp 50 \
  --sleep 0.2 \
  --basis-queries 'Jurisprudência trabalhista,súmula,precedente,doutrina'
```

Saidas:

```text
data/knowledge/tst/tst_sumulas_oj_precedentes.jsonl
data/knowledge/tst/tst_sumulas_oj_precedentes.csv
data/knowledge/trt2_basis/trt2_basis_target_items.jsonl
data/knowledge/trt2_basis/trt2_basis_target_items.csv
data/knowledge/knowledge_status.json
```

Para adicionar a CLT do Planalto e iniciar a coleta incremental dos acórdãos mais recentes do TST:

```bash
python scripts/collect_knowledge_sources.py \
  --skip-tst-pdf \
  --skip-tst-site \
  --skip-trt2-basis \
  --include-clt \
  --include-tst-acordaos \
  --tst-acordaos-limit 20 \
  --tst-acordaos-page-size 20 \
  --sleep 0.5
```

Saidas novas:

```text
data/knowledge/planalto/clt_artigos.jsonl
data/knowledge/tst/tst_acordaos_recentes.jsonl
data/raw/html/tst_acordaos/
data/knowledge/tst/tst_acordaos_checkpoint.json
```

## Chat antigo sobre o acervo

Configurar `.env`:

```text
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.5
```

Subir o chat local:

```bash
python scripts/serve_acervo_chat.py
```

Abrir:

```text
http://127.0.0.1:8787
```

O chat consulta o DuckDB local primeiro e usa o modelo apenas para explicar os resultados. Sem `OPENAI_API_KEY`, ele continua respondendo com texto deterministico.

## Campos extraidos

```text
process_number
tribunal
court_unit
judge_name
reporting_judge
decision_date
filing_date
case_class
subjects
claims
outcome
decision_text
source_url
raw_html
raw_pdf_path
```

## Classes iniciais de pedidos

```text
horas_extras
dano_moral
verbas_rescisorias
adicional_insalubridade
adicional_periculosidade
vinculo_empregaticio
equiparacao_salarial
intervalo_intrajornada
acumulo_de_funcao
desvio_de_funcao
multa_477
multa_467
fgts
outros
```

## Classes iniciais de resultado

```text
procedente
procedente_parcial
improcedente
acordo
extinto
nao_identificado
```

## Politica de dados

Este v0 deve respeitar termos de uso das fontes, limites de requisicao, dados publicos, privacidade, LGPD e nao redistribuicao indevida de documentos. O valor da Justra deve estar na analise, estruturacao, classificacao e jurimetria, nao na revenda de acesso bruto aos documentos.
