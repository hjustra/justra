# Fila automática de coleta PJe

Este documento define o MVP atual da coleta PJe na Justra.

Premissa temporária: para este fluxo, tratamos o CAPTCHA como resolvido/contornável por outra camada. A fila e o worker não implementam solução de CAPTCHA. Eles apenas tentam abrir a página do processo, capturar o conteúdo disponível e importar o payload para a Justra.

## Objetivo

- Usuário adiciona ou recoleta um processo.
- Backend cria um job PJe por CNJ.
- Um worker separado consome a fila automaticamente.
- O worker executa `scripts/pje_operator_collect.py` em modo headless.
- A aba **PJe operador** serve apenas para monitorar jobs, tentativas, erros e status.
- Se o job falhar, entra em retry. Depois do limite, fica como falha/manual.

## Componentes

1. **Backend Justra**
   - persiste jobs em `APP_DATA_DIR/pje_jobs.json`;
   - registra auditoria em `APP_DATA_DIR/pje_job_events.jsonl`;
   - cria jobs quando usuário adiciona/recoleta processo ou quando monitoramento detecta necessidade;
   - expõe `/admin/pje` para acompanhamento;
   - conclui jobs automaticamente quando `/api/pje-extension/import` recebe payload do CNJ/job.

2. **Aba PJe operador**
   - menu admin: **PJe operador**;
   - mostra jobs por prioridade;
   - mostra status, tentativas, último erro e vínculo com casos;
   - permite reenfileirar, cancelar ou marcar manual;
   - não executa Python e não aprova job.

3. **Worker PJe**
   - arquivo: `scripts/pje_operator_agent.py`;
   - roda como serviço separado do app web;
   - busca jobs em `queued`, `operator_requested` ou `retry_wait`;
   - respeita `next_run_at`, prioridade e limite de tentativas;
   - executa `scripts/pje_operator_collect.py` com `--headless`;
   - reporta sucesso/falha para o backend.

4. **Coletor PJe**
   - arquivo: `scripts/pje_operator_collect.py`;
   - abre o PJe via Playwright;
   - aguarda a página do processo ficar pronta;
   - captura dados visíveis, movimentos e documentos disponíveis;
   - envia para `/api/pje-extension/import`.

## Fluxo do usuário

### Adicionar processo

1. Usuário informa CNJ em **Processos**.
2. Backend cria/atualiza dossiê e acompanhamento.
3. Backend cria job PJe com motivo `user_add`/`user_watch`.
4. UI informa que o PJe entrou na fila automática.
5. Worker tenta coletar em segundo plano.
6. Se concluir rápido, a tela atualiza o processo.
7. Se demorar, o processo continua na fila e pode ser acompanhado em **PJe operador**.

### Recoletar PJe

1. Usuário clica **Recoletar PJe**.
2. Backend cria/reabre job com prioridade alta.
3. Worker tenta coletar em segundo plano.
4. Sucesso importa os dados e marca o job como `succeeded`.
5. Falha entra em `retry_wait` até atingir o limite de tentativas.

### Monitoramento

Quando a central de atualizações roda, o backend cria jobs `scheduled_refresh` para processos acompanhados sem job ativo e sem coleta recente. Jobs concluídos recentemente não são reenfileirados de imediato.

## Estados

- `queued`: aguardando worker.
- `operator_requested`: compatibilidade com jobs antigos; também aguardando worker.
- `operator_running`: worker assumiu e está executando.
- `retry_wait`: falha transitória aguardando retry.
- `succeeded`: import recebido e aplicado.
- `manual_required`: revisão/coleta manual necessária.
- `failed`: falha final após limite de tentativas.
- `cancelled`: cancelado.

## Deploy

O worker roda em serviço separado:

```bash
sudo systemctl enable --now justra-pje-worker
sudo journalctl -u justra-pje-worker -f
```

Comando equivalente:

```bash
.venv/bin/python scripts/pje_operator_agent.py \
  --justra-url http://127.0.0.1:8787 \
  --headless \
  --poll-seconds 10 \
  --collector-timeout 180
```

O serviço usa `/etc/justra/justra.env`, incluindo `JUSTRA_PJE_OPERATOR_TOKEN`.

## Segurança

- A aba staging não executa código local.
- O worker autentica com `JUSTRA_PJE_OPERATOR_TOKEN` ou token admin.
- O worker executa Python por lista de argumentos, sem shell.
- Nenhum cookie, senha ou sessão PJe é persistido pelo coletor.
- O import PJe continua validando origem conforme configuração do backend.

## Endpoints

Usuário:

- `GET /api/pje/jobs/{job_id}`: status do job se o usuário tiver acesso ao CNJ.

Admin:

- `GET /api/admin/pje`: dashboard da fila.
- `POST /api/admin/pje/jobs/action`: retry, manual ou cancelar.

Worker:

- `POST /api/operator/pje/jobs/next`: puxa próximo job disponível.
- `POST /api/operator/pje/jobs/finish`: reporta sucesso/falha.

Importação:

- `POST /api/pje-extension/import`: recebe payload da extensão ou coletor Python e conclui jobs por `job_id` ou CNJ.

## Critérios de aceite

- Adicionar processo cria job PJe.
- Recoletar PJe cria/reabre job com prioridade alta.
- `/admin/pje` mostra fila, tentativas, execução e falhas.
- Worker puxa jobs sem aprovação manual.
- Worker roda `pje_operator_collect.py --headless`.
- Falha agenda retry até o limite.
- Import PJe marca job como `succeeded`.
- Fluxo antigo da extensão continua disponível como fallback operacional.
