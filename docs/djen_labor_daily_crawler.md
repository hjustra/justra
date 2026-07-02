# Crawler Diario DJEN Trabalhista

Status: especificacao do crawler
Data: 2026-06-30
Escopo: TST e TRT1 a TRT24
Produto relacionado: Justra Monitor Trabalhista

## 1. Objetivo

Baixar diariamente todos os cadernos do DJEN/Comunica PJe da Justica do Trabalho, cobrindo:

- TST
- TRT1 a TRT24
- meio `D`: Diario de Justica Eletronico Nacional
- meio `E`: Plataforma Nacional de Editais

O crawler deve rodar 1 hora depois do horario informado pela propria API do DJEN para disponibilizacao dos cadernos do dia.

A especificacao oficial do DJEN informa:

```text
Os cadernos do dia atual sao disponibilizados a partir das 03:00.
```

Portanto, o agendamento padrao do crawler deve ser:

```text
04:00 America/Sao_Paulo
```

Mesmo rodando as 04:00, o crawler nao deve assumir cegamente a data local. Ele deve consultar o site/API para descobrir a data de publicacao efetivamente disponivel.

## 2. Fontes Oficiais

### 2.1. Lista de tribunais e data de ultimo envio

Endpoint:

```text
GET https://comunicaapi.pje.jus.br/api/v1/comunicacao/tribunal
```

Uso no crawler:

- descobrir quais tribunais estao ativos
- filtrar `TST` e `TRT*`
- deduplicar siglas repetidas por UF
- ler `dataUltimoEnvio`
- usar essa data como data publicada pelo tribunal

Observacao: alguns TRTs aparecem em mais de uma UF porque possuem jurisdicao em mais de um estado. O crawler deve deduplicar por sigla.

Exemplos:

```text
TRT8 aparece em AP e PA
TRT10 aparece em DF e TO
TRT11 aparece em AM e RR
TRT14 aparece em AC e RO
```

### 2.2. Metadados e download do caderno

Endpoint:

```text
GET https://comunicaapi.pje.jus.br/api/v1/caderno/{sigla_tribunal}/{data}/{meio}
```

Parametros:

```text
sigla_tribunal = TST, TRT1, TRT2, ..., TRT24
data           = yyyy-mm-dd
meio           = D ou E
```

Campos relevantes da resposta:

```text
tribunal
sigla_tribunal
meio
status
versao
data
total_comunicacoes
numero_paginas
tamanho_bytes
hash
url
```

Status esperados:

```text
Processado
Sem comunicacoes
Nao Processado
Em processamento
Cancelado
```

O campo `url` e uma URL temporaria de download, com validade curta. O crawler deve baixar o ZIP imediatamente apos receber a URL.

## 3. Escopo de Tribunais

Lista final deduplicada:

```text
TST
TRT1
TRT2
TRT3
TRT4
TRT5
TRT6
TRT7
TRT8
TRT9
TRT10
TRT11
TRT12
TRT13
TRT14
TRT15
TRT16
TRT17
TRT18
TRT19
TRT20
TRT21
TRT22
TRT23
TRT24
```

Total:

```text
25 tribunais
2 meios por tribunal
50 cadernos possiveis por dia
```

## 4. Politica de Agendamento

### 4.1. Horario padrao

Rodar diariamente:

```text
04:00 America/Sao_Paulo
```

Justificativa:

- a API informa que os cadernos do dia atual sao disponibilizados a partir das 03:00
- o crawler roda 1 hora depois para reduzir chance de pegar caderno ainda em processamento

### 4.2. Descoberta da data publicada

No inicio de cada execucao:

1. chamar `/api/v1/comunicacao/tribunal`
2. filtrar TST/TRTs
3. coletar `dataUltimoEnvio`
4. converter `DD/MM/YYYY` para `YYYY-MM-DD`
5. usar essa data como `published_date` por tribunal

Regra:

```text
published_date = dataUltimoEnvio do tribunal no Comunica PJe
```

Nao usar apenas `date.today()` como fonte de verdade.

### 4.3. Quando a data publicada nao for hoje

Se `dataUltimoEnvio` do tribunal nao for a data corrente:

1. registrar status `waiting_for_publication`
2. nao forcar download de caderno inexistente
3. tentar novamente no ciclo de retry

Isso evita baixar caderno errado em feriados, finais de semana, atrasos de processamento ou indisponibilidade parcial.

### 4.4. Retry

Depois da execucao principal das 04:00:

```text
04:15
04:30
04:45
05:00
05:30
06:00
07:00
08:00
```

O retry deve rodar apenas para cadernos pendentes:

- data ainda nao publicada
- status `Nao Processado`
- status `Em processamento`
- erro HTTP temporario
- URL expirada antes do download
- ZIP baixado com erro

Depois de 08:00, pendencias devem gerar alerta operacional, nao loop infinito.

## 5. Fluxo do Crawler

### 5.1. Fluxo geral

```text
start
  -> carregar tribunais trabalhistas publicados
  -> deduplicar siglas
  -> para cada tribunal:
       -> descobrir dataUltimoEnvio
       -> para meio D e E:
            -> consultar metadados do caderno
            -> avaliar status
            -> se Processado e total_comunicacoes > 0:
                 -> baixar ZIP imediatamente
                 -> validar tamanho/hash
                 -> extrair JSONs internos
                 -> normalizar itens
                 -> persistir raw + normalized
            -> se Sem comunicacoes:
                 -> salvar metadado e marcar completo
            -> se pendente:
                 -> agendar retry
  -> emitir manifesto diario
end
```

### 5.2. Pseudocodigo

```text
run_date = now(America/Sao_Paulo).date()

tribunals = fetch_comunicacao_tribunal()
labor_courts = unique siglas matching TST or TRT[0-9]+

for court in labor_courts:
    published_date = parse(court.dataUltimoEnvio)

    if published_date != run_date:
        mark_waiting(court, published_date)
        continue

    for medium in ["D", "E"]:
        meta = fetch_caderno(court.sigla, published_date, medium)

        save_meta(meta)

        if meta.status == "Sem comunicacoes":
            mark_complete_empty(court, medium)
            continue

        if meta.status != "Processado":
            mark_pending(court, medium, meta.status)
            continue

        if meta.total_comunicacoes == 0:
            mark_complete_empty(court, medium)
            continue

        zip_file = download_immediately(meta.url)
        validate_zip(zip_file, meta)
        pages = extract_json_pages(zip_file)
        items = normalize_items(pages)
        save_raw_and_normalized(court, medium, published_date, meta, pages, items)
        mark_complete(court, medium, count(items))
```

## 6. Estrutura de Arquivos

Base:

```text
pesquisa/data/raw/djen/
pesquisa/data/processed/djen/
```

Raw por data:

```text
pesquisa/data/raw/djen/YYYY/MM/DD/{SIGLA}/{MEIO}/
  caderno_meta.json
  caderno.zip
  pages/
    page_001.json
    page_002.json
  manifest.json
```

Normalizado por data:

```text
pesquisa/data/processed/djen/YYYY/MM/DD/
  publication_events.jsonl.gz
  crawler_manifest.json
  pending_cadernos.json
  errors.jsonl
```

Exemplo:

```text
pesquisa/data/raw/djen/2026/06/30/TRT2/D/caderno_meta.json
pesquisa/data/raw/djen/2026/06/30/TRT2/D/caderno.zip
pesquisa/data/raw/djen/2026/06/30/TRT2/D/v1/normalized_events.jsonl.gz
pesquisa/data/processed/djen/2026/06/30/publication_events.jsonl.gz
```

## 7. Manifesto Diario

Todo ciclo deve gerar um manifesto.

Arquivo:

```text
pesquisa/data/processed/djen/YYYY/MM/DD/crawler_manifest.json
```

Campos:

```text
run_id
started_at
finished_at
timezone
target_date
source
total_courts
total_cadernos_expected
total_cadernos_processed
total_cadernos_empty
total_cadernos_pending
total_publications
courts
errors
```

Exemplo de item em `courts`:

```json
{
  "sigla": "TRT2",
  "published_date": "2026-06-30",
  "meios": {
    "D": {
      "status": "Processado",
      "versao": 1,
      "total_comunicacoes": 33127,
      "numero_paginas": 34,
      "hash": "5190ac6b93ee742808284dfbeff06083e55ef7dda39496bf00b475aba0d51cce",
      "downloaded": true,
      "normalized_count": 33127
    },
    "E": {
      "status": "Processado",
      "versao": 1,
      "total_comunicacoes": 292,
      "numero_paginas": 1,
      "downloaded": true,
      "normalized_count": 292
    }
  }
}
```

## 8. Normalizacao

Cada item do caderno deve virar um `PublicationEvent`.

Campos minimos:

```text
source
source_run_id
communication_id
communication_hash
numero_comunicacao
process_number
process_number_masked
court_acronym
court_unit
court_unit_id
publication_date
sent_date
communication_type
document_type
class_name
class_code
medium
medium_full
status
active
text
source_url
raw_path
first_seen_at
```

Mapeamento:

```text
id                         -> communication_id
hash                       -> communication_hash
numeroComunicacao          -> numero_comunicacao
numero_processo            -> process_number
numeroprocessocommascara   -> process_number_masked
siglaTribunal              -> court_acronym
nomeOrgao                  -> court_unit
idOrgao                    -> court_unit_id
data_disponibilizacao      -> publication_date
dataenvio                  -> sent_date
tipoComunicacao            -> communication_type
tipoDocumento              -> document_type
nomeClasse                 -> class_name
codigoClasse               -> class_code
meio                       -> medium
meiocompleto               -> medium_full
texto                      -> text
link                       -> source_url
```

## 9. Idempotencia

O crawler deve poder rodar varias vezes no mesmo dia sem duplicar dados.

Chave natural sugerida:

```text
communication_id
```

Fallback:

```text
court_acronym + medium + publication_date + communication_hash
```

Para arquivos de caderno:

```text
court_acronym + medium + publication_date + versao + hash
```

## 10. Reprocessamento e Mudanca de Versao

A API informa que a versao do caderno pode ser incrementada quando o diario precisa ser reprocessado, por exemplo em caso de cancelamento de comunicacoes.

Regra:

1. Se `hash` e `versao` forem iguais ao que ja foi baixado, pular download.
2. Se `hash` ou `versao` mudarem, baixar novo ZIP.
3. Preservar versoes anteriores.
4. Marcar eventos substituidos ou cancelados conforme campos do item.

Estrutura sugerida para reprocessamento:

```text
pesquisa/data/raw/djen/YYYY/MM/DD/{SIGLA}/{MEIO}/v{VERSAO}/
  caderno_meta.json
  caderno.zip
  pages/
```

Para a primeira implementacao, pode-se salvar em pasta sem `v{VERSAO}` desde que o manifesto preserve `versao` e `hash`. O suporte completo a multiplas versoes fica recomendado para o MVP de producao.

## 11. Validacoes

### 11.1. Validar metadados

Conferir:

```text
meta.sigla_tribunal == tribunal esperado
meta.meio == meio esperado
meta.data == published_date
meta.status in status conhecidos
```

### 11.2. Validar ZIP

Conferir:

```text
arquivo existe
tamanho_bytes confere quando informado
unzip lista arquivos sem erro
numero de paginas internas confere com numero_paginas
```

### 11.3. Validar contagem

Somar `items.length` dos JSONs internos.

Conferir:

```text
normalized_count == total_comunicacoes
```

Se a contagem divergir:

1. registrar erro
2. manter raw baixado
3. marcar caderno como `invalid_count`
4. reenfileirar para retry ou revisao

## 12. Rate Limit e Boas Praticas

A API informa controle de taxa por IP em alguns endpoints. O crawler deve ser educado por padrao.

Regras:

```text
concorrencia baixa: 2 a 4 downloads simultaneos no maximo
sleep entre chamadas de metadados: 200ms a 500ms
retry com backoff
respeitar HTTP 429 aguardando pelo menos 60s
nao usar multiplos IPs para contornar limite
```

## 13. Erros e Alertas

Gerar alerta operacional quando:

- tribunal trabalhista esperado nao aparece na lista
- `dataUltimoEnvio` nao atualiza ate 08:00
- caderno fica `Em processamento` ate 08:00
- download falha repetidamente
- ZIP invalido
- contagem interna diverge de `total_comunicacoes`
- hash muda apos caderno ja processado
- API retorna 429, 5xx ou erro inesperado

Arquivo de erros:

```text
pesquisa/data/processed/djen/YYYY/MM/DD/errors.jsonl
```

Campos:

```text
run_id
timestamp
court_acronym
medium
published_date
stage
error_type
message
retryable
raw_context
```

## 14. Saidas para o Produto

O crawler nao calcula prazo diretamente. Ele entrega a materia-prima para o pipeline de prazos.

Saidas:

```text
publication_events.jsonl.gz
crawler_manifest.json
pending_cadernos.json
errors.jsonl
```

Consumidores:

```text
deadline_detection_job
process_publication_matcher
timeline_event_builder
operational_dashboard
```

## 15. Relacao com Processos Assinados

O crawler baixa todos os cadernos trabalhistas do dia, mas o produto so gera eventos para processos acompanhados.

Fluxo posterior:

```text
publication_events.jsonl.gz
  -> filtrar process_number in ProcessSubscription ativa
  -> gerar PublicationEvent no banco do produto
  -> rodar DeadlineCandidate
  -> criar TimelineEvent e alerta
```

Isso permite:

- ter fonte diaria completa de publicacoes trabalhistas
- evitar consulta individual por processo no DJEN
- manter o produto centrado nos processos dos assinantes

## 16. Primeira Implementacao Recomendada

Criar script:

```text
pesquisa/scripts/crawl_djen_labor_daily.py
```

Parametros:

```text
--date YYYY-MM-DD       opcional; padrao: data publicada no site
--courts TST,TRT2       opcional; padrao: todos
--mediums D,E           opcional; padrao: D,E
--out-dir PATH          opcional; padrao: pesquisa/data
--retry-pending         processa apenas pendencias
--dry-run               consulta metadados sem baixar ZIP
```

Exemplos:

```bash
python scripts/crawl_djen_labor_daily.py
python scripts/crawl_djen_labor_daily.py --dry-run
python scripts/crawl_djen_labor_daily.py --courts TRT2,TST
python scripts/crawl_djen_labor_daily.py --retry-pending
```

## 17. Agendamento Local

Para launchd, criar job diario as 04:00.

Nome sugerido:

```text
com.justra.djen-labor-daily.plist
```

Comando:

```text
cd /Users/heitordoamaraljurkovich/Desktop/justra/pesquisa
.venv/bin/python scripts/crawl_djen_labor_daily.py
```

Retries podem ser outro job ou o proprio script pode reenfileirar pendencias.

## 18. Criterios de Pronto

O crawler esta pronto quando:

1. Descobre TST/TRTs via `/comunicacao/tribunal`.
2. Usa `dataUltimoEnvio` como data publicada.
3. Deduplica siglas de TRTs multi-UF.
4. Consulta os 50 cadernos potenciais do dia.
5. Baixa ZIPs `Processado` com `total_comunicacoes > 0`.
6. Registra `Sem comunicacoes` sem erro.
7. Extrai JSONs internos.
8. Normaliza todos os itens em JSONL.
9. Confere contagem normalizada contra `total_comunicacoes`.
10. Gera manifesto diario.
11. E idempotente em reruns.
12. Gera pendencias e erros revisaveis.
