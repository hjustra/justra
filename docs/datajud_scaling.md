# Escala DataJud para Produto Multiusuario

Status: proposta de arquitetura; Fase 1 iniciada no MVP
Data: 2026-07-03
Escopo: Justra Monitor Trabalhista, DataJud/CNJ, DJEN e processos acompanhados

## Implementacao Atual

Em 2026-07-03, a Fase 1 foi iniciada no MVP com uma fila persistente em arquivo:

```text
datajud_jobs.json
```

O objetivo dessa primeira execucao e mudar a semantica do produto:

```text
antes: rota de usuario podia disparar chamada DataJud em thread imediata
agora: rota de usuario enfileira job deduplicado por CNJ; worker unico consome a fila
```

Ainda nao e a versao final para 1000+ usuarios/hora, porque a migracao para Postgres e o batch por multiplos CNJs ficam para as fases seguintes.

## 1. Problema

O DataJud nao deve ser acionado diretamente pelo carregamento da tela do usuario.

Se 1000 usuarios acessarem a Justra em uma hora, isso nao pode significar 1000 chamadas ao DataJud. A tela deve ler dados ja persistidos na base da Justra. Quando faltar dado, o sistema deve criar uma tarefa em fila para coleta posterior.

Principio central:

```text
Escalar por processo unico, nao por usuario.
```

Exemplo:

```text
1000 usuarios por hora
3000 visualizacoes de dashboard por hora
2000 processos acompanhados no total
800 processos unicos

Chamadas esperadas ao DataJud durante abertura de tela: 0
Chamadas ao banco/cache Justra: milhares, baratas e controladas
Chamadas ao DataJud: feitas apenas por worker, deduplicadas por CNJ
```

## 2. Diferenca entre DJEN e DataJud

### 2.1. DJEN

O DJEN funciona bem como coleta diaria em lote.

Caracteristicas:

- possui cadernos/arquivos diarios
- a unidade de coleta e o tribunal/data/meio
- baixar uma vez atende todos os usuarios
- o mesmo arquivo pode ser indexado e consultado por todos
- custo previsivel por dia

Modelo:

```text
TST/TRTs -> PDFs/JSON diarios -> indice Justra -> usuarios
```

### 2.2. DataJud

O DataJud funciona como API de busca.

Caracteristicas:

- nao entrega um arquivo diario unico com todos os movimentos novos
- a consulta costuma retornar o processo com seu historico de movimentos
- para saber o que mudou, a Justra precisa comparar com o snapshot anterior
- chamadas em burst podem gerar `429 Too Many Requests`
- IPs de nuvem podem ser mais sensiveis a limitacao

Modelo correto:

```text
processos unicos -> fila -> worker DataJud -> snapshots/eventos Justra -> usuarios
```

## 3. Estado Atual Observado

No acervo local DataJud/TRT2 ja existe uma coleta grande:

```text
processes: 58.799
movements: 1.542.126
decision_events: 28.306
subjects: 291.858
claims: 133.235
```

Essa coleta foi feita para montar acervo e analise, principalmente por `dataAjuizamento`.

Ela nao e equivalente a uma rotina diaria de "todos os movimentos novos do dia", porque o coletor buscou processos e extraiu os movimentos existentes dentro deles. Para monitoramento diario, precisamos transformar isso em pipeline incremental com deduplicacao.

## 4. Meta de Escala

Meta inicial:

```text
1000 usuarios por hora
0 chamadas DataJud no carregamento de tela
latencia de dashboard baseada apenas em banco/cache Justra
DataJud consumido por worker com rate limit global
```

Meta operacional:

```text
processo novo acompanhado: cria job DataJud
processo visto no DJEN: cria job DataJud com prioridade maior
processo ja atualizado recentemente: nao cria novo job
mesmo CNJ para varios usuarios: um unico job
```

## 5. Arquitetura Alvo

### 5.1. Componentes

```text
Frontend
  -> API Justra
      -> Banco operacional
      -> Fila DataJud
      -> Worker DataJud
      -> Indice DJEN
      -> Cache/tabelas de leitura
```

### 5.2. Regra de ouro

Nenhuma rota de leitura do produto deve fazer request externo ao DataJud.

Rotas como estas devem ler apenas dados locais:

```text
GET /api/cases
GET /api/deadlines
GET /api/updates
GET /api/process/:cnj
```

Rotas de acao podem criar jobs:

```text
POST /api/cases
POST /api/updates/datajud/refresh
POST /api/process/:cnj/refresh
```

Mas mesmo as rotas de acao nao devem bloquear esperando o DataJud responder.

Resposta esperada:

```json
{
  "ok": true,
  "status": "queued",
  "message": "Consulta DataJud agendada."
}
```

## 6. Modelo de Dados

### 6.1. user_process_watches

Tabela que liga usuarios a processos.

Campos sugeridos:

```text
id
user_id
process_number
process_number_masked
source
active
created_at
updated_at
```

Indice:

```text
(user_id, process_number)
process_number
```

### 6.2. process_snapshots

Estado mais recente conhecido do processo no DataJud.

Campos sugeridos:

```text
process_number
court
court_acronym
degree
class_name
court_unit
filing_date
last_movement_at
movement_count
status
fetched_at
source_hash
raw_ref
last_error
```

Indice:

```text
process_number unique
last_movement_at
fetched_at
status
```

### 6.3. movement_events

Movimentos deduplicados por processo.

Campos sugeridos:

```text
id
process_number
movement_code
movement_name
movement_date
court_unit
complements
category
risk_level
source_hash
first_seen_at
last_seen_at
```

Chave de deduplicacao sugerida:

```text
process_number
movement_code
movement_name
movement_date
court_unit
complements_hash
```

### 6.4. datajud_jobs

Fila persistente de coleta DataJud.

Campos sugeridos:

```text
id
process_number
court
priority
status
reason
attempts
next_run_at
locked_at
locked_by
last_error
created_at
updated_at
```

Status:

```text
queued
running
succeeded
retry
rate_limited
failed
discarded
```

Prioridades:

```text
100 = processo com publicacao DJEN recente
80  = processo recem-cadastrado pelo usuario
50  = refresh manual solicitado
20  = refresh periodico
```

Regra de deduplicacao:

```text
Nao criar novo job queued/running/retry para o mesmo process_number.
Se ja existe job, atualizar priority=max(priority_atual, nova_priority).
```

## 7. Worker DataJud

### 7.1. Responsabilidade

O worker e o unico componente que chama DataJud em producao.

Fluxo:

```text
1. buscar jobs prontos por priority desc, next_run_at asc
2. bloquear jobs com locked_at/locked_by
3. montar lote de CNJs por tribunal
4. chamar DataJud
5. persistir snapshots e movement_events
6. marcar jobs como succeeded/retry/rate_limited
7. liberar lock
```

### 7.2. Rate limit global

Config inicial conservadora:

```text
max_workers: 1
request_interval_seconds: 10
max_requests_per_minute: 6
max_requests_per_hour: 300
cooldown_after_429_minutes: 60
backoff_base_minutes: 15
backoff_max_hours: 12
```

O numero exato deve ser ajustado por observacao. O ponto importante e que o limite e global, nao por usuario.

### 7.3. Comportamento em 429

Ao receber `429 Too Many Requests`:

```text
1. parar chamadas imediatamente
2. marcar cooldown global
3. reagendar jobs pendentes para depois do cooldown
4. manter cache antigo visivel aos usuarios
5. registrar metrica e alerta operacional
```

Nunca tentar "compensar" o atraso fazendo burst apos o cooldown.

### 7.4. Refresh policy

Sugestao inicial:

```text
processo com DJEN hoje: refresh DataJud em ate 30 minutos
processo novo cadastrado: refresh DataJud em ate 5 minutos
processo acompanhado sem novidade: refresh a cada 24-72 horas
processo com erro recente: retry com backoff
processo arquivado/inativo: refresh raro ou sob demanda
```

## 8. Batch por CNJ

O maior ganho potencial e consultar multiplos CNJs por request.

Hipotese a validar:

```json
{
  "size": 50,
  "query": {
    "terms": {
      "numeroProcesso.keyword": [
        "10007175220245020202",
        "00019611620105020043"
      ]
    }
  }
}
```

Se o DataJud aceitar bem `terms` por `numeroProcesso.keyword`, a escala melhora muito.

Exemplo:

```text
1000 processos unicos novos/hora

sem batch:
1000 requests/hora

batch 50:
20 requests/hora
```

Plano de teste:

```text
1. testar terms com 2 CNJs TRT2
2. testar 10 CNJs
3. testar 50 CNJs
4. medir latencia, tamanho de resposta e risco de 429
5. definir batch_size padrao
```

Se batch nao funcionar, manter 1 CNJ por request, mas com fila lenta, cache e prioridades.

## 9. Estimativa para 1000 Usuarios por Hora

### 9.1. Caso correto

```text
1000 usuarios/hora abrindo dashboard
0 requests DataJud
1000 leituras API Justra
1000 consultas locais em banco/cache
```

### 9.2. Processos novos

Cenario:

```text
1000 usuarios/hora
20% cadastram processo novo
media 3 processos por usuario ativo
600 processos informados/hora
400 CNJs unicos apos dedupe
```

Sem batch:

```text
400 requests DataJud/hora
```

Com batch 50:

```text
8 requests DataJud/hora
```

### 9.3. Refresh diario de base acompanhada

Cenario:

```text
50.000 processos acompanhados
refresh medio a cada 48h
25.000 processos/dia
```

Sem batch:

```text
25.000 requests/dia
```

Com batch 50:

```text
500 requests/dia
```

Com DJEN priorizando apenas processos com publicacao recente:

```text
requests ainda menores nos dias sem movimento relevante
```

## 10. DJEN como Gatilho de Prioridade

O DJEN deve alimentar a fila DataJud.

Fluxo:

```text
1. crawler DJEN baixa cadernos diarios
2. parser extrai publicacoes e CNJs
3. sistema cruza CNJs com processos acompanhados
4. publicacao relevante cria/eleva job DataJud
5. worker atualiza snapshot e movimentos
6. usuario ve prazo/publicacao imediatamente e movimento depois
```

Beneficio:

```text
Nao precisamos reconsultar todos os processos todos os dias.
Priorizamos onde ha sinal oficial de novidade.
```

## 11. Papel do PJe

O PJe continua user-driven.

Uso:

```text
usuario abre PJe
resolve CAPTCHA
extensao captura dados visiveis
Justra importa documentos/movimentos/texto
```

Isso complementa DataJud e DJEN, principalmente para inteiro teor e documentos que nao existem no DataJud.

## 12. Banco Recomendado

Para produto multiusuario, o operacional deve ir para Postgres.

Postgres:

- usuarios
- processos acompanhados
- fila DataJud
- snapshots
- movimentos
- publicacoes DJEN filtradas
- jobs e locks

DuckDB:

- acervo analitico
- relatorios
- busca juridica
- datasets grandes de leitura

Regra:

```text
Postgres para operacao online.
DuckDB para analise e acervo.
```

## 13. Observabilidade

Metricas minimas:

```text
datajud_requests_total
datajud_requests_by_status
datajud_429_total
datajud_cooldown_active
datajud_jobs_queued
datajud_jobs_running
datajud_jobs_failed
datajud_job_latency_seconds
datajud_last_success_at
datajud_unique_processes_refreshed
```

Alertas:

```text
429 recorrente por mais de 2 ciclos
fila acima de limite por mais de 1 hora
nenhum sucesso DataJud em 6 horas
jobs prioritarios atrasados
```

## 14. Roadmap de Implementacao

### Fase 1 - MVP escalavel

Objetivo: remover DataJud do caminho sincrono do usuario.

Itens:

```text
1. criar datajud_jobs persistente
2. deduplicar jobs por process_number
3. transformar refresh manual em enqueue
4. criar worker simples com 1 request por vez
5. manter cooldown global em 429
6. UI ler somente cache local
```

### Fase 2 - Batch e prioridade DJEN

Objetivo: reduzir requests por CNJ e priorizar processos com sinal de novidade.

Itens:

```text
1. testar terms query por lista de CNJs
2. implementar batch por tribunal
3. DJEN cria/eleva jobs DataJud
4. refresh periodico menos agressivo para processos sem novidade
5. registrar metricas de request/status/latencia
```

### Fase 3 - Banco operacional

Objetivo: preparar 1000+ usuarios/hora.

Itens:

```text
1. migrar watches/jobs/snapshots/movements para Postgres
2. criar indices por user_id, process_number, status, next_run_at
3. separar web app e worker em servicos diferentes
4. criar painel operacional de fila
5. manter DuckDB como camada analitica
```

### Fase 4 - Escala nacional controlada

Objetivo: ampliar tribunais e base acompanhada sem depender de burst.

Itens:

```text
1. workers por tribunal com limite global central
2. politicas diferentes para TRT/TST
3. reprocessamento por janelas
4. compactacao/arquivamento de snapshots antigos
5. reconciliacao periodica com DJEN/PJe
```

## 15. Decisoes Arquiteturais

Decisoes propostas:

```text
1. DataJud nunca deve bloquear request de usuario.
2. A unidade de escala e process_number, nao user_id.
3. DJEN e a fonte primaria de novidades/prazos diarios.
4. DataJud e fonte de timeline e enriquecimento.
5. PJe e fonte user-driven para dados visiveis e documentos.
6. Postgres deve ser o banco operacional antes de escala real.
7. DuckDB deve continuar para acervo e analise.
```

## 16. Perguntas em Aberto

Pontos que precisam de teste/decisao:

```text
1. DataJud aceita bem terms com 10, 50 ou 100 CNJs?
2. Qual e o limite real por chave/IP antes de 429?
3. Azure sofre mais bloqueio que IP residencial?
4. Vale solicitar canal/credencial institucional ao CNJ?
5. Qual SLA esperado para refresh DataJud apos DJEN?
6. Quais tribunais trabalhistas tem maior volume e exigem politicas proprias?
```

## 17. Resumo Executivo

Para 1000 usuarios por hora, o DataJud precisa ser tratado como recurso escasso e compartilhado.

A Justra deve:

```text
ler localmente em tempo real
coletar DataJud em segundo plano
deduplicar por CNJ
usar DJEN como gatilho diario
testar batch por multiplos CNJs
persistir fila e resultados em Postgres
```

Assim, o crescimento de usuarios aumenta principalmente leituras locais, nao chamadas externas ao CNJ.
