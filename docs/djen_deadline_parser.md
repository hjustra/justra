# Parser DJEN Trabalhista para Candidatos de Prazo

Status: especificacao do parser de prazos
Data: 2026-06-30
Escopo: publicacoes DJEN/Comunica PJe de TST e TRT1 a TRT24
Produto relacionado: Justra Monitor Trabalhista

## 1. Objetivo

Criar um parser que leia as publicacoes ja normalizadas pelo crawler DJEN trabalhista e transforme publicacoes relevantes em estruturas auditaveis de prazo provavel.

O parser deve responder:

```text
Esta publicacao pode gerar prazo?
Para quem?
Qual foi o gatilho?
Qual e a data inicial provavel?
Qual e a data final provavel, quando calculavel?
Qual e o risco operacional?
O resultado precisa de revisao humana?
```

O resultado principal nao e um prazo definitivo. O resultado principal e um `DeadlineCandidate`.

Isso e importante porque prazo processual depende de regras sensiveis:

- tipo de ciencia
- calendario oficial
- feriados nacionais, estaduais, municipais e do tribunal
- suspensoes de expediente
- prazo em dobro
- natureza da parte
- forma de intimacao
- teor completo do ato no PJe

O produto deve tratar o resultado como prazo provavel ate que exista validacao juridica suficiente.

## 2. Adaptacao do MD original para o nosso caso

O MD anexado partia desta entrada:

```text
texto cru completo de um diario + lista de processos de interesse
```

No nosso pipeline atual, a entrada primaria ja e mais estruturada:

```text
pesquisa/data/processed/djen/YYYY/MM/DD/publication_events.jsonl.gz
```

Cada linha desse arquivo ja e um `PublicationEvent`, gerado pelo crawler `crawl_djen_labor_daily.py`.

Portanto, a primeira versao do parser nao precisa quebrar um caderno inteiro em blocos de processo. Ela deve consumir `PublicationEvent` diretamente.

Mesmo assim, o parser deve preservar um fallback para texto bruto, porque:

- alguns textos do DJEN vem com HTML e blocos internos;
- alguns campos estruturados podem estar ausentes;
- a auditoria humana precisa ver o trecho original;
- futuramente podemos reprocessar outros formatos de diario.

## 3. Entrada

### 3.1. Entrada principal

Arquivo diario agregado:

```text
pesquisa/data/processed/djen/YYYY/MM/DD/publication_events.jsonl.gz
```

Exemplo real de campos disponiveis:

```json
{
  "source": "djen_comunica_pje",
  "source_run_id": "djen_20260630_191531",
  "communication_id": 653170161,
  "communication_hash": "hash",
  "numero_comunicacao": 123,
  "process_number": "01003137820235010302",
  "process_number_masked": "0100313-78.2023.5.01.0302",
  "court_acronym": "TRT1",
  "court_unit": "2a Vara do Trabalho de Petropolis",
  "publication_date": "2026-06-30",
  "sent_date": "26/06/2026",
  "communication_type": "Intimacao",
  "document_type": "Notificacao",
  "class_name": "Acao Trabalhista - Rito Sumarissimo",
  "class_code": "1125",
  "medium": "D",
  "medium_full": "Diario de Justica Eletronico Nacional",
  "status": "P",
  "active": true,
  "text": "Fica(m) o(s) destinatario(s)... no prazo de 10 dias...",
  "source_url": "https://pje.trt1.jus.br/...",
  "raw_path": "data/raw/djen/.../caderno.zip::pagina.json",
  "first_seen_at": "2026-06-30T19:15:31-03:00"
}
```

### 3.2. Entrada complementar recomendada

O parser deve aceitar, quando disponivel:

```text
ProcessSubscription ativa
ProcessSnapshot/DataJud
ProcessMovement recentes
calendario nacional
calendario do tribunal
calendario municipal da unidade judiciaria
tabela de suspensoes do TRT/TST
regras revisadas de prazo trabalhista
```

Na primeira implementacao, o parser pode rodar em dois modos:

```text
all-publications
  processa todas as publicacoes do dia e gera candidatos nacionais

subscribed-only
  processa apenas processos acompanhados por assinantes
```

O modo `all-publications` e util para construir a fonte diaria completa. O modo `subscribed-only` e util para produto e alerta.

## 4. Saidas

### 4.1. Arquivos de saida

Diretorio:

```text
pesquisa/data/processed/djen_deadlines/YYYY/MM/DD/
```

Arquivos:

```text
deadline_candidates.jsonl.gz
calendar_event_candidates.jsonl.gz
non_deadline_publications.jsonl.gz
deadline_parser_manifest.json
errors.jsonl
review_samples.jsonl
```

### 4.2. Tipos de saida

O parser deve separar tres resultados:

```text
DeadlineCandidate
  publicacao que provavelmente gera prazo

CalendarEventCandidate
  publicacao que informa ato futuro, como audiencia ou julgamento,
  mas nao necessariamente prazo de manifestacao

NonDeadlinePublication
  publicacao lida e classificada como sem prazo detectado
```

Essa separacao evita transformar pauta de julgamento, audiencia ou distribuicao em prazo artificial.

## 5. Modelo DeadlineCandidate

Campos minimos:

```json
{
  "id": "djen-deadline-653170161-001",
  "source": "djen_deadline_parser",
  "source_version": "0.1",
  "parser_run_id": "deadline_20260630_210000",
  "publication_event_id": 653170161,
  "communication_hash": "hash",
  "process_number": "01003137820235010302",
  "process_number_masked": "0100313-78.2023.5.01.0302",
  "court_acronym": "TRT1",
  "court_unit": "2a Vara do Trabalho de Petropolis",
  "medium": "D",
  "communication_type": "Intimacao",
  "document_type": "Notificacao",
  "class_name": "Acao Trabalhista - Rito Sumarissimo",
  "availability_date": "2026-06-30",
  "legal_publication_date": "2026-07-01",
  "start_date": "2026-07-02",
  "due_date": "2026-07-15",
  "deadline_days": 10,
  "deadline_day_type": "business_days",
  "deadline_source": "explicit_text",
  "trigger_type": "intimacao_manifestacao",
  "deadline_kind": "manifestacao",
  "action_required": true,
  "intimated_parties": [
    {
      "name": "PARTE EXEMPLO",
      "role": "active",
      "source": "destinatarios"
    }
  ],
  "attorneys": [
    {
      "name": "ADVOGADO EXEMPLO",
      "oab": "123456",
      "uf": "SP"
    }
  ],
  "risk_level": "high",
  "risk_reasons": [
    "prazo explicito encontrado",
    "texto contem sob pena de preclusao"
  ],
  "confidence": "high",
  "requires_human_review": false,
  "requires_holiday_validation": true,
  "requires_pje_opening": false,
  "calendar_used": {
    "kind": "basic_weekdays",
    "court": "TRT1",
    "municipality": null,
    "validated_until": null
  },
  "evidence": {
    "matched_terms": ["prazo de 10 dias"],
    "matched_rule_ids": ["explicit_deadline_days_v1"],
    "text_excerpt": "notificado(s) para ciencia ... no prazo de 10 dias"
  },
  "calculation_notes": [
    "data_disponibilizacao do DJEN tratada como availability_date",
    "legal_publication_date calculada como primeiro dia util seguinte",
    "start_date calculada como primeiro dia util seguinte a publicacao legal",
    "feriados locais ainda nao validados"
  ],
  "raw_text": "texto original normalizado para auditoria",
  "source_url": "https://pje.trt1.jus.br/...",
  "created_at": "2026-06-30T21:00:00-03:00"
}
```

## 6. Modelo CalendarEventCandidate

Use quando a publicacao nao abre prazo claro, mas traz ato futuro.

Exemplos:

- audiencia
- pauta de julgamento
- sessao de julgamento
- leilao/praca/hasta
- pericia designada

Campos:

```json
{
  "id": "djen-calendar-653220556-001",
  "publication_event_id": 653220556,
  "process_number": "01007763420265010522",
  "process_number_masked": "0100776-34.2026.5.01.0522",
  "court_acronym": "TRT1",
  "event_type": "audiencia",
  "event_date": "2026-07-28",
  "event_time": "09:50",
  "event_mode": "presencial",
  "event_location": "2a Vara do Trabalho de Resende",
  "intimated_parties": [],
  "risk_level": "high",
  "risk_reasons": [
    "ausencia pode gerar arquivamento, revelia ou confissao"
  ],
  "confidence": "high",
  "requires_human_review": true,
  "raw_text": "texto original normalizado para auditoria"
}
```

## 7. Modelo NonDeadlinePublication

Use quando a publicacao foi lida, mas nao ha prazo ou evento futuro relevante.

Exemplos:

- lista de distribuicao
- publicacao meramente informativa
- texto diz expressamente que nao e necessario apresentar resposta
- comunicacao cancelada

Campos:

```json
{
  "publication_event_id": 653095838,
  "process_number": "01009788920265010302",
  "process_number_masked": "0100978-89.2026.5.01.0302",
  "court_acronym": "TRT1",
  "classification": "distribution_no_deadline",
  "reason": "tipoComunicacao=Lista de distribuicao e tipoDocumento=Distribuicao",
  "confidence": "high",
  "created_at": "2026-06-30T21:00:00-03:00"
}
```

## 8. Datas e contagem

### 8.1. Nomes internos

O parser deve evitar ambiguidade entre data de disponibilizacao e data legal de publicacao.

Usar:

```text
availability_date
  data_disponibilizacao recebida do DJEN/Comunica

legal_publication_date
  data considerada como publicacao para contagem do prazo

start_date
  data inicial da contagem

due_date
  data final provavel
```

### 8.2. Regra padrao configuravel

Regra padrao para diario eletronico:

```text
legal_publication_date = primeiro dia util seguinte a availability_date
start_date = primeiro dia util seguinte a legal_publication_date
```

A regra deve ser configuravel por fonte. Se o Comunica PJe ou outra fonte passar a fornecer campo oficial de publicacao legal ja calculado, esse campo deve prevalecer.

### 8.3. Dias uteis

Na Justica do Trabalho, a contagem processual deve usar dias uteis.

O parser deve calcular `due_date` apenas se tiver:

```text
start_date
deadline_days
deadline_day_type
calendar policy
```

Na primeira versao, se nao houver calendario completo:

```json
{
  "calendar_used": {"kind": "basic_weekdays"},
  "requires_holiday_validation": true
}
```

### 8.4. Calendarios

Prioridade de calendario:

```text
1. calendario especifico do tribunal/unidade, com suspensoes
2. calendario do TRT/TST
3. calendario nacional + estadual/municipal conhecido
4. weekdays basico, segunda a sexta
```

O parser nunca deve esconder a incerteza do calendario.

## 9. Classificacao de gatilhos

### 9.1. Tipos iniciais de trigger

Valores recomendados:

```text
intimacao_manifestacao
citacao
notificacao
edital
acordao_publicado
sentenca_publicada
decisao_publicada
despacho_manifestacao
contrarrazoes
embargos_de_declaracao
recurso
impugnacao_calculos
audiencia
pauta_julgamento
distribuicao_sem_prazo
comunicacao_cancelada
expediente_sem_prazo_identificado
unknown
```

### 9.2. Tipos iniciais de prazo

Valores recomendados:

```text
manifestacao
contestacao
contrarrazoes
embargos_de_declaracao
recurso_ordinario
recurso_revista
agravo_peticao
agravo_instrumento
impugnacao_calculos
cumprimento_obrigacao
pagamento
ciencia_sem_manifestacao
unknown
```

### 9.3. Heuristicas positivas

O parser deve procurar termos e padroes como:

```text
prazo de X dias
no prazo de X dias
em X dias
manifestar-se
apresentar manifestacao
impugnar
impugnacao fundamentada
contrarrazoes
embargos de declaracao
recurso ordinario
agravo de peticao
comprovar pagamento
cumprir obrigacao
sob pena de preclusao
sob pena de revelia
sob pena de confissao
sob pena de arquivamento
```

Regex inicial para prazo explicito:

```python
EXPLICIT_DAYS_RE = r"(?i)\\b(?:no\\s+)?prazo\\s+de\\s+0*(\\d{1,3})\\s+dias?\\b|\\bem\\s+0*(\\d{1,3})\\s+dias?\\b"
```

O parser deve aceitar `08 dias` e converter para `8`.

### 9.4. Heuristicas negativas

Nem toda intimacao gera acao.

Classificar como sem prazo ou como revisao humana quando houver:

```text
nao e necessario apresentar resposta
para ciencia apenas
para ciencia da arrematacao, sem ordem de manifestacao
lista de distribuicao
distribuido para
baixa definitiva
arquivamento definitivo sem ato a praticar
comunicacao cancelada
```

Se o texto contiver ao mesmo tempo um prazo e uma negacao, exemplo:

```text
sera aguardada a resposta pelo prazo devido. Nao e necessario apresentar resposta a esta intimacao.
```

entao:

```text
requires_human_review = true
confidence = low
due_date = null
```

## 10. Extracao de parte intimada

### 10.1. Fontes estruturadas

Prioridade:

```text
raw_publication.destinatarios
raw_publication.destinatarioadvogados
```

O crawler atual normaliza apenas alguns campos em `PublicationEvent`. O parser deve, quando necessario, poder abrir o `raw_path` para recuperar:

```text
destinatarios
destinatarioadvogados
```

Mapeamento inicial de polo:

```text
A -> active
P -> passive
T -> third_party
unknown -> unknown
```

### 10.2. Fontes textuais

Fallback por texto:

```text
DESTINATARIO(S):
Intimado(s) / Citado(s)
Intimado(s)/Citado(s):
RECLAMANTE:
RECLAMADO:
RECORRENTE:
RECORRIDO:
AGRAVANTE:
AGRAVADO:
```

O parser deve diferenciar:

```text
parte do processo
parte intimada
advogado
```

Quando nao conseguir diferenciar:

```text
intimated_parties[].role = "unknown"
requires_human_review = true
```

## 11. Risco

### 11.1. Niveis

```text
critical
high
medium
low
info
```

### 11.2. Regras iniciais

`critical`:

- due_date hoje ou vencido
- texto contem risco grave: revelia, confissao, arquivamento, preclusao
- prazo explicito curto, ate 2 dias uteis

`high`:

- prazo explicito encontrado
- audiencia futura com consequencia de ausencia
- prazo final em ate 5 dias uteis
- texto contem ordem de cumprir, comprovar, pagar, impugnar ou manifestar

`medium`:

- prazo inferido por tipo de documento, sem prazo explicito
- acordao/sentenca/decisao publicada que pode abrir via recursal
- edital com possivel necessidade de resposta

`low`:

- ciencia sem ordem clara de acao
- evento futuro sem consequencia expressa

`info`:

- distribuicao
- movimentacao meramente informativa
- comunicacao sem prazo identificado

## 12. Confianca e revisao humana

### 12.1. Confidence

```text
high
medium
low
```

`high`:

- prazo explicito encontrado
- data base calculavel
- parte intimada extraida
- sem termos contraditorios

`medium`:

- prazo inferido por regra revisada
- parte intimada parcial
- texto claro, mas sem prazo expresso

`low`:

- texto contraditorio
- prazo possivel, mas tipo do ato incerto
- calendario incompleto e prazo curto
- precisa abrir PJe para confirmar

### 12.2. requires_human_review

Marcar `true` quando:

- prazo nao for explicito
- houver regra inferida sem validacao juridica final
- texto contiver negacao e ordem de prazo ao mesmo tempo
- parte intimada nao for identificada com seguranca
- data base nao for confiavel
- calendario completo nao estiver disponivel e o prazo for de alto risco
- o ato depender de teor completo no PJe
- publicacao for acordao, sentenca ou decisao sem comando textual claro

## 13. Tabela de regras

As regras nao devem ficar hardcoded dentro do parser.

Arquivo sugerido:

```text
pesquisa/config/deadline_rules_trabalhista.yml
```

Formato:

```yaml
version: 1
rules:
  - id: explicit_deadline_days_v1
    priority: 100
    applies_when:
      communication_type_any: ["Intimacao", "Notificacao", "Edital"]
      text_regex_any:
        - "(?i)\\bprazo\\s+de\\s+0*(\\d{1,3})\\s+dias?\\b"
        - "(?i)\\bem\\s+0*(\\d{1,3})\\s+dias?\\b"
    extract:
      deadline_days_from_regex_group: true
      deadline_day_type: business_days
    output:
      trigger_type: intimacao_manifestacao
      deadline_kind: manifestacao
      deadline_source: explicit_text
      confidence: high
      requires_human_review: false

  - id: negative_no_response_required_v1
    priority: 200
    applies_when:
      text_regex_any:
        - "(?i)nao\\s+e\\s+necessario\\s+apresentar\\s+resposta"
    output:
      classification: no_action_required
      deadline_source: none
      confidence: high
      requires_human_review: false
```

Regras juridicas inferidas, como prazos recursais, devem entrar na tabela apenas com status de revisao:

```yaml
legal_review_status: pending | approved | deprecated
```

O parser so deve usar regra inferida para calcular `due_date` automaticamente quando:

```text
legal_review_status = approved
```

Caso contrario, pode gerar candidato sem `due_date`, com:

```text
requires_human_review = true
deadline_source = inferred_unvalidated_rule
```

## 14. Pipeline do parser

Fluxo:

```text
start
  -> carregar publication_events.jsonl.gz
  -> filtrar active=true e status valido
  -> opcional: filtrar ProcessSubscription ativa
  -> normalizar texto HTML para texto plano
  -> extrair dados estruturados faltantes do raw_path, se necessario
  -> classificar comunicacao cancelada / sem prazo obvio
  -> extrair partes intimadas e advogados
  -> detectar evento futuro
  -> detectar prazo explicito
  -> aplicar regras aprovadas
  -> calcular datas
  -> calcular risco
  -> atribuir confidence e flags de revisao
  -> gravar DeadlineCandidate / CalendarEventCandidate / NonDeadlinePublication
  -> gerar manifest e amostras para revisao
end
```

## 15. Calculo de data final

Pseudocodigo:

```python
def calculate_deadline(event, days, calendar):
    availability_date = parse_date(event["publication_date"])
    legal_publication_date = next_business_day(availability_date, calendar)
    start_date = next_business_day(legal_publication_date, calendar)
    due_date = add_business_days(start_date, days, calendar, inclusive=True)
    return legal_publication_date, start_date, due_date
```

Observacao de implementacao:

```text
Se start_date e o primeiro dia contado, entao prazo de 1 dia vence no proprio start_date.
```

O manifest deve registrar a politica usada:

```json
{
  "date_policy": "electronic_diary_next_business_day",
  "count_policy": "start_date_inclusive_business_days",
  "calendar_policy": "basic_weekdays"
}
```

## 16. Exemplos de classificacao

### 16.1. Prazo explicito

Texto:

```text
Fica(m) o(s) destinatario(s) notificado(s) para impugnacao fundamentada,
sob pena de preclusao, conforme art. 879, paragrafo 2o da CLT,
no prazo de 08 dias.
```

Saida:

```json
{
  "trigger_type": "intimacao_manifestacao",
  "deadline_kind": "impugnacao_calculos",
  "deadline_days": 8,
  "deadline_source": "explicit_text",
  "risk_level": "high",
  "risk_reasons": ["prazo explicito", "sob pena de preclusao"],
  "confidence": "high",
  "requires_human_review": false
}
```

### 16.2. Audiencia ou pauta

Texto:

```text
Deverao as partes comparecer a audiencia presencial no dia 28/07/2026 09:50.
O nao comparecimento do Autor importara no arquivamento e do Reu em revelia e confissao.
```

Saida:

```json
{
  "output_type": "CalendarEventCandidate",
  "event_type": "audiencia",
  "event_date": "2026-07-28",
  "event_time": "09:50",
  "risk_level": "high",
  "deadline_days": null,
  "due_date": null
}
```

### 16.3. Ciencia sem acao

Texto:

```text
Fica(m) o(s) destinatario(s) notificado(s) para ciencia.
Nao e necessario apresentar resposta a esta intimacao.
```

Saida:

```json
{
  "output_type": "NonDeadlinePublication",
  "classification": "science_no_action_required",
  "confidence": "high"
}
```

### 16.4. Acordao publicado

Texto:

```text
Ficam as partes intimadas do acordao.
```

Saida V1:

```json
{
  "output_type": "DeadlineCandidate",
  "trigger_type": "acordao_publicado",
  "deadline_kind": "unknown",
  "deadline_days": null,
  "due_date": null,
  "deadline_source": "possible_trigger_without_explicit_deadline",
  "risk_level": "medium",
  "confidence": "medium",
  "requires_human_review": true,
  "requires_pje_opening": true
}
```

Motivo: publicacao de acordao pode abrir vias recursais, mas o tipo de prazo depende de contexto juridico.

## 17. Manifest

Arquivo:

```text
deadline_parser_manifest.json
```

Campos:

```json
{
  "run_id": "deadline_20260630_210000",
  "source_publication_path": "pesquisa/data/processed/djen/2026/06/30/publication_events.jsonl.gz",
  "target_date": "2026-06-30",
  "mode": "all-publications",
  "parser_version": "0.1",
  "rules_version": 1,
  "calendar_policy": "basic_weekdays",
  "total_publications_read": 168561,
  "deadline_candidates": 0,
  "calendar_event_candidates": 0,
  "non_deadline_publications": 0,
  "requires_human_review": 0,
  "requires_holiday_validation": 0,
  "risk_counts": {
    "critical": 0,
    "high": 0,
    "medium": 0,
    "low": 0,
    "info": 0
  },
  "top_trigger_types": [],
  "started_at": "2026-06-30T21:00:00-03:00",
  "finished_at": "2026-06-30T21:02:00-03:00"
}
```

## 18. Script recomendado

Criar:

```text
pesquisa/scripts/extract_djen_deadline_candidates.py
```

Parametros:

```text
--date YYYY-MM-DD
--input PATH
--out-dir PATH
--mode all-publications|subscribed-only
--rules PATH
--calendar-policy basic-weekdays|court-calendar
--limit N
--dry-run
--review-sample N
```

Exemplos:

```bash
python scripts/extract_djen_deadline_candidates.py --date 2026-06-30
python scripts/extract_djen_deadline_candidates.py --date 2026-06-30 --mode subscribed-only
python scripts/extract_djen_deadline_candidates.py --date 2026-06-30 --limit 1000 --dry-run
```

## 19. Relacao com UX/admin

Na aba Admin `Coleta DJEN`, adicionar depois:

```text
Publicacoes lidas
Candidatos de prazo
Eventos de calendario
Sem prazo
Alto risco
Revisao humana
Calendario nao validado
Erros do parser
```

Tabela recomendada:

```text
Tribunal | Processo | Gatilho | Parte intimada | Inicio | Vencimento | Risco | Revisao
```

Filtros:

```text
tribunal
tipo de gatilho
risco
com/sem data final
requires_human_review
requires_holiday_validation
```

## 20. Criterios de aceitacao do MVP

O MVP esta pronto quando:

1. Le `publication_events.jsonl.gz` de um dia completo.
2. Nao carrega o arquivo inteiro em memoria.
3. Identifica prazos explicitos `prazo de X dias` e `em X dias`.
4. Extrai parte intimada de `destinatarios` ou do texto.
5. Calcula `legal_publication_date`, `start_date` e `due_date`.
6. Marca `requires_holiday_validation=true` quando usar calendario basico.
7. Separa audiencia/pauta como `CalendarEventCandidate`.
8. Separa distribuicao e ciencia sem acao como `NonDeadlinePublication`.
9. Gera manifest com contagens.
10. Gera amostra de revisao humana.
11. E idempotente para o mesmo dia e mesma versao de regras.

## 21. Fora do escopo da primeira implementacao

Nao prometer nesta fase:

- prazo definitivo oficial
- interpretacao completa de todos os prazos recursais
- prazo em dobro automatico
- validacao completa de feriados locais
- leitura obrigatoria do PJe para todos os atos
- substituicao de revisao humana em casos ambiguos

## 22. Referencias normativas para validar regras

Usar como base de validacao juridica antes de aprovar regras inferidas:

```text
Lei 11.419/2006
https://www.planalto.gov.br/ccivil_03/_ato2004-2006/2006/lei/l11419.htm

Consolidacao das Leis do Trabalho, art. 775 e demais dispositivos aplicaveis
https://www.planalto.gov.br/ccivil_03/decreto-lei/del5452.htm

Normas e calendarios do TST e de cada TRT
fontes oficiais dos respectivos tribunais
```

## 23. Principio de seguranca

Toda saida que chegar ao usuario deve deixar claro:

```text
Prazo provavel calculado a partir da publicacao no DJEN.
Verifique feriados locais, suspensoes, forma de ciencia e regras especificas.
```

Mensagem curta para UI:

```text
Prazo provavel. Revisao recomendada antes de protocolar ou deixar transcorrer.
```
