# Justra Monitor Trabalhista - Estrutura de Produto

Status: proposta de arquitetura de produto
Data: 2026-06-30
Escopo: TST e TRT1 a TRT24

## 1. Visao

O Justra passa a operar como um monitor diario de processos trabalhistas acompanhados pelo assinante.

A ideia central e simples:

1. O assinante cadastra ou anexa um processo.
2. O Justra busca o processo no DataJud.
3. O Justra monta uma timeline inicial com tudo que aconteceu ate agora.
4. A partir dali, o Justra monitora publicacoes, prazos e novas movimentacoes todos os dias.

O produto nao precisa manter historico nacional de todos os processos. O historico completo so e necessario para processos acompanhados por assinantes.

## 2. Objetivos do Produto

### 2.1. Fonte de prazos diarios

Entregar ao assinante os prazos provaveis originados de publicacoes oficiais do direito do trabalho.

Fonte principal:

- Comunica PJe / DJEN

O DJEN nao entrega prazo final pronto. Ele entrega atos publicados que podem disparar prazo, como intimacoes, citacoes, notificacoes, editais, acordaos e decisoes. O Justra deve identificar esses gatilhos e calcular o prazo provavel com base em regras processuais, calendario e contexto.

### 2.2. Fonte de movimentacoes diarias

Entregar ao assinante as novas movimentacoes dos processos acompanhados.

Fonte principal:

- DataJud CNJ

O DataJud e a melhor fonte para montar a timeline processual e detectar novos movimentos. Ele deve ser usado tanto no onboarding quanto no monitoramento recorrente.

## 3. Principio de Arquitetura

Separar tres camadas:

```text
Publicacao oficial     -> DJEN / Comunica PJe
Movimentacao processual -> DataJud
Inteligencia Justra     -> prazos, timeline, resumo, alertas, deduplicacao
```

O DJEN responde melhor a pergunta:

> O que foi publicado oficialmente hoje e pode gerar ciencia/prazo?

O DataJud responde melhor a pergunta:

> O que aconteceu no processo e qual e a historia processual ate agora?

O Justra responde:

> O que isso significa para o assinante?

## 4. Fluxo de Onboarding do Processo

### 4.1. Entrada

O assinante informa um numero CNJ ou anexa um documento que contenha o numero do processo.

Exemplos:

```text
1001269-68.2025.5.02.0303
0000008-93.2010.5.15.0127
```

### 4.2. Normalizacao

O sistema deve:

1. Extrair numero CNJ.
2. Validar estrutura.
3. Remover mascara para consultas tecnicas.
4. Identificar ramo e tribunal pelo segmento do numero.

Exemplo:

```text
1001269-68.2025.5.02.0303
segmento: 5
tribunal: TRT2
origem: 0303
```

### 4.3. Busca inicial no DataJud

O processo e consultado no endpoint do tribunal correspondente.

Resultado esperado:

- dados basicos do processo
- classe
- grau
- orgao julgador
- assuntos
- partes quando disponivel
- movimentos
- data da ultima atualizacao

### 4.4. Timeline inicial

O Justra transforma os movimentos em eventos legiveis.

Exemplo de timeline:

```text
2025-09-10 - Processo distribuido
2025-10-02 - Audiencia designada
2025-11-18 - Contestacao juntada
2026-02-03 - Concluso para julgamento
2026-02-21 - Sentenca proferida
2026-02-25 - Intimacao publicada no DJEN
2026-03-10 - Recurso ordinario interposto
```

### 4.5. Resumo inicial

Apos montar a timeline, o Justra gera um resumo do estado atual.

Formato sugerido:

```text
Este processo e uma acao trabalhista de rito ordinario no TRT2.
Ele ja teve audiencia, sentenca e interposicao de recurso ordinario.
O ultimo movimento conhecido indica remessa ao segundo grau.
Nao ha prazo ativo detectado nas publicacoes recentes armazenadas.
```

O resumo deve distinguir fato processual de inferencia.

## 5. Monitoramento Diario de Prazos

### 5.1. Fonte

Usar cadernos diarios do Comunica PJe / DJEN para TST e TRT1 a TRT24.

Meios:

```text
D = Diario de Justica Eletronico Nacional
E = Plataforma Nacional de Editais
```

### 5.2. Coleta diaria

Rotina diaria:

1. Baixar metadados de caderno por tribunal, data e meio.
2. Baixar ZIP do caderno quando houver comunicacoes.
3. Ler JSON interno.
4. Filtrar somente processos acompanhados por assinantes.
5. Persistir publicacoes relevantes.
6. Classificar possivel gatilho de prazo.

### 5.3. Eventos que podem gerar prazo

Prioridade alta:

- Intimacao
- Citacao
- Notificacao
- Edital
- Publicacao de acordao
- Publicacao de sentenca
- Despacho com ordem de manifestacao
- Decisao monocratica

### 5.4. Calculo de prazo

O sistema deve gerar um `DeadlineCandidate`, nao um prazo definitivo sem ressalvas.

Campos minimos:

```text
process_number
publication_id
publication_date
communication_type
document_type
detected_trigger
deadline_kind
start_date
due_date
confidence
calculation_notes
requires_human_review
```

### 5.5. Regras de seguranca juridica

O Justra deve evitar prometer certeza quando o dado nao permite.

Exemplos de mensagens:

```text
Prazo provavel calculado a partir da publicacao no DJEN.
Verifique regras especificas de ciencia, feriados locais e prazo em dobro.
```

```text
Publicacao detectada, mas o tipo de prazo nao foi identificado com seguranca.
Revisao humana recomendada.
```

## 6. Monitoramento Diario de Movimentacoes

### 6.1. Fonte

Usar DataJud somente para processos acompanhados.

Nao e necessario baixar historico nacional. O sistema faz backfill completo apenas no cadastro do processo e depois coleta incremental.

### 6.2. Rotina

1. Buscar processo no DataJud.
2. Extrair lista de movimentos.
3. Gerar fingerprint de cada movimento.
4. Comparar com movimentos ja vistos.
5. Salvar apenas novos movimentos.
6. Atualizar timeline.
7. Gerar resumo curto do que mudou.

### 6.3. Fingerprint de deduplicacao

Sugestao:

```text
tribunal + process_number + movement_code + movement_name + movement_datetime
```

Quando o DataJud nao fornecer algum campo com estabilidade suficiente, incluir hash do movimento bruto normalizado.

### 6.4. Saida para o usuario

Exemplos:

```text
Nova movimentacao: concluso para julgamento.
```

```text
Nova movimentacao: recurso ordinario remetido ao TRT.
```

```text
Nova movimentacao detectada, sem impacto de prazo identificado.
```

## 7. Modelo de Dados Proposto

### 7.1. ProcessSubscription

Representa que um usuario acompanha um processo.

```text
id
user_id
process_number
process_number_digits
court_code
court_acronym
created_at
status
nickname
source
```

### 7.2. ProcessSnapshot

Estado mais recente conhecido pelo DataJud.

```text
id
process_number
court_acronym
raw_datajud_payload
class_name
class_code
degree
court_unit
subject_names
last_datajud_update
fetched_at
```

### 7.3. ProcessMovement

Movimento normalizado.

```text
id
process_number
court_acronym
movement_code
movement_name
movement_datetime
movement_complement
fingerprint
raw_movement
first_seen_at
source
```

### 7.4. PublicationEvent

Publicacao encontrada no DJEN/Comunica.

```text
id
process_number
court_acronym
communication_id
communication_hash
publication_date
sent_date
communication_type
document_type
court_unit
class_name
text
source_url
medium
raw_publication
first_seen_at
```

### 7.5. DeadlineCandidate

Prazo calculado ou sugerido.

```text
id
process_number
publication_event_id
trigger_type
deadline_type
start_date
due_date
calendar_used
confidence
status
requires_human_review
notes
created_at
```

### 7.6. TimelineEvent

Visao unificada para o usuario.

```text
id
process_number
event_date
event_type
source
title
summary
importance
related_movement_id
related_publication_id
related_deadline_id
created_at
```

## 8. MVP Recomendado

### Fase 1 - Onboarding com DataJud

Entregar:

- cadastro de processo por numero CNJ
- deteccao de tribunal
- busca no DataJud
- timeline historica inicial
- resumo do estado atual

Fora do escopo:

- calculo de prazo
- coleta nacional diaria

### Fase 2 - Prazos por DJEN para processos assinados

Entregar:

- coleta diaria dos cadernos DJEN de TST e TRTs
- filtro por processos acompanhados
- armazenamento de publicacoes
- classificacao de gatilhos de prazo
- alerta de prazo provavel

Fora do escopo:

- garantia de prazo oficial definitivo
- interpretacao complexa de todos os tipos de prazo

### Fase 3 - Movimentacoes incrementais

Entregar:

- rotina diaria de DataJud para processos acompanhados
- deduplicacao de movimentos
- atualizacao da timeline
- resumo do que mudou desde a ultima consulta

## 9. Arquitetura de Jobs

```text
process_onboarding_job
  entrada: process_number
  fonte: DataJud
  saida: ProcessSnapshot, ProcessMovement, TimelineEvent, resumo inicial

djen_daily_publication_job
  entrada: data
  fonte: Comunica PJe / DJEN
  saida: PublicationEvent filtrado por processos acompanhados

deadline_detection_job
  entrada: PublicationEvent
  fonte: regras Justra + calendario
  saida: DeadlineCandidate, TimelineEvent

datajud_daily_movement_job
  entrada: ProcessSubscription ativa
  fonte: DataJud
  saida: novos ProcessMovement, TimelineEvent

timeline_summary_job
  entrada: novos eventos
  fonte: LLM + regras
  saida: resumo curto para usuario
```

## 10. Pontos de Atencao

### 10.1. Prazos

Prazo e area sensivel. O produto deve tratar resultado como prazo provavel quando a fonte nao tiver ciencia/prazo final oficial.

Riscos:

- feriados locais
- suspensoes regionais
- prazo em dobro
- ciencia por portal diferente da publicacao
- contagem em dias uteis
- tipo de parte ou procuradoria
- segredo de justica ou dado incompleto

### 10.2. DataJud

O DataJud pode nao ser feed incremental perfeito. A rotina deve ser idempotente e tolerar atraso de atualizacao.

### 10.3. DJEN

O DJEN e excelente para publicacoes, mas pode conter texto longo, HTML, variacao de grafia e documentos com nomenclatura inconsistente.

### 10.4. Links externos do ato

Nem todo link publico permitira abrir ou capturar o ato automaticamente. O MVP nao deve depender disso para detectar publicacoes, prazos provaveis ou movimentacoes.

## 11. Decisoes de Produto

1. O usuario acompanha processos cadastrados, nao todos os processos do Brasil.
2. O historico completo e baixado apenas no onboarding do processo.
3. O monitoramento diario de prazo usa DJEN como fonte principal.
4. O monitoramento diario de movimentacao usa DataJud como fonte principal.
5. A timeline unifica DataJud, DJEN e prazos calculados.
6. Prazos sao apresentados com nivel de confianca e notas de calculo.

## 12. Experiencia do Usuario

### Tela do processo

Componentes:

- cabecalho com numero CNJ, tribunal, classe e orgao
- resumo do estado atual
- card de prazo ativo ou "nenhum prazo detectado"
- timeline unificada
- publicacoes recentes
- movimentacoes recentes

### Alertas

Tipos:

- prazo provavel detectado
- publicacao nova sem prazo identificado
- movimentacao nova
- processo sem atualizacao
- falha de consulta da fonte

### Linguagem

O produto deve falar como assistente juridico operacional:

```text
Hoje saiu uma intimacao neste processo.
O texto indica ciencia de sentenca.
Calculei prazo provavel ate 2026-07-08, sujeito a conferencia de feriados locais e regras especificas.
```

## 13. Proximo Passo Tecnico

Implementar primeiro um prototipo de onboarding:

```text
input: numero CNJ
output:
  - tribunal detectado
  - payload DataJud salvo
  - movimentos normalizados
  - timeline gerada
  - resumo inicial
```

Depois acoplar o DJEN:

```text
input: lista de processos acompanhados + data
output:
  - publicacoes do dia
  - candidatos de prazo
  - alertas
```
