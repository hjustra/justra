# Fila PJe assistida com aprovação no staging

Este documento define o MVP implementado para coleta PJe assistida na Justra.

O fluxo é híbrido:

- o **staging/prod** controla fila, aprovação, prioridade, auditoria e notificações;
- o **Mac do operador** roda um agente local que abre Chrome, espera o CAPTCHA/login ser resolvido manualmente e executa `scripts/pje_operator_collect.py`;
- o backend recebe o payload pelo endpoint PJe já existente e aplica a captura a todos os casos vinculados ao mesmo CNJ.

Este fluxo não automatiza, contorna ou resolve CAPTCHA. O CAPTCHA continua sendo resolvido por uma pessoa.

## Componentes

1. **Backend Justra**
   - persiste jobs em `APP_DATA_DIR/pje_jobs.json`;
   - registra auditoria em `APP_DATA_DIR/pje_job_events.jsonl`;
   - cria jobs quando usuário adiciona/recoleta processo ou quando monitoramento detecta necessidade;
   - expõe a aba admin `/admin/pje`;
   - permite aprovar, reenfileirar, cancelar ou marcar manual;
   - conclui jobs automaticamente quando `/api/pje-extension/import` recebe payload do CNJ/job.

2. **Aba de aprovação no staging**
   - menu admin: **PJe operador**;
   - mostra jobs por prioridade;
   - exibe badge com pendências/aprovados/executando;
   - permite aprovar jobs para execução pelo agente local.

3. **Agente local**
   - arquivo: `scripts/pje_operator_agent.py`;
   - roda no Mac do operador;
   - puxa apenas jobs aprovados (`operator_requested`);
   - executa `scripts/pje_operator_collect.py` com `--job-id`, `--cnj`, `--pje-url` e `--justra-url`;
   - reporta sucesso/falha para o backend.

4. **Coletor local**
   - arquivo: `scripts/pje_operator_collect.py`;
   - abre Chrome no PJe;
   - aguarda o operador resolver CAPTCHA/login;
   - captura dados visíveis, movimentos e documentos disponíveis;
   - envia para `/api/pje-extension/import`.

## Fluxo do usuário

### Adicionar processo

1. Usuário informa CNJ em **Processos**.
2. Backend cria/atualiza dossiê e acompanhamento.
3. Backend cria job PJe com motivo `user_add`/`user_watch`.
4. UI mostra que a coleta entrou na fila assistida.
5. UI aguarda até 60 segundos pelo job.
6. Se o job concluir, a tela atualiza dados PJe.
7. Se não concluir, volta ao fallback manual: usuário abre PJe, resolve CAPTCHA e envia pela extensão.

### Recoletar PJe

1. Usuário clica **Recoletar PJe**.
2. Backend cria/reabre job com prioridade alta.
3. UI aguarda até 60 segundos.
4. Se o operador concluir, os dados entram automaticamente.
5. Se não, o fluxo manual com extensão continua disponível.

### Monitoramento

Quando a central de atualizações roda, o backend cria jobs `scheduled_refresh` para processos acompanhados sem job ativo e sem coleta recente. Jobs concluídos recentemente não são reenfileirados de imediato.

## Fluxo do operador

1. Entrar no staging como admin.
2. Abrir `/admin/pje`.
3. Aprovar jobs prioritários.
4. Rodar no Mac:

```bash
.venv/bin/python scripts/pje_operator_agent.py \
  --justra-url https://staging.justra.com.br \
  --token "$JUSTRA_PJE_OPERATOR_TOKEN"
```

5. O agente puxa o próximo job aprovado.
6. O coletor abre o Chrome no PJe.
7. Operador resolve CAPTCHA/login manualmente.
8. O coletor envia o payload para a Justra.
9. Backend marca o job como `succeeded` e atualiza casos do CNJ.

## Estados

- `queued`: aguardando aprovação no staging.
- `operator_requested`: aprovado; agente local pode puxar.
- `operator_running`: agente local assumiu e está executando.
- `retry_wait`: falha transitória aguardando retry.
- `succeeded`: import recebido e aplicado.
- `manual_required`: fallback manual necessário.
- `failed`: falha final.
- `cancelled`: cancelado.

## Segurança

- A aba staging não executa Python no navegador.
- O agente local só puxa jobs aprovados.
- O agente executa Python por lista de argumentos, sem shell.
- O backend aceita agente por token admin ou `JUSTRA_PJE_OPERATOR_TOKEN`.
- Nenhum cookie, senha ou sessão PJe é persistido.
- O import PJe continua validando origem/token conforme configuração do backend.

## Endpoints

Usuário:

- `GET /api/pje/jobs/{job_id}`: status do job se o usuário tiver acesso ao CNJ.

Admin:

- `GET /api/admin/pje`: dashboard da fila.
- `POST /api/admin/pje/jobs/action`: aprovar, retry, manual ou cancelar.

Operador local:

- `POST /api/operator/pje/jobs/next`: puxa próximo job aprovado.
- `POST /api/operator/pje/jobs/finish`: reporta sucesso/falha do agente.

Importação:

- `POST /api/pje-extension/import`: recebe payload da extensão ou coletor Python e conclui jobs por `job_id` ou CNJ.

## Critérios de aceite

- Adicionar processo cria job PJe.
- Recoletar PJe cria/reabre job com prioridade alta.
- `/admin/pje` mostra fila e badge de pendências.
- Aprovar job muda status para `operator_requested`.
- Agente local puxa somente job aprovado.
- Coletor envia payload com `job_id`.
- Import PJe marca job como `succeeded`.
- Usuário tem fallback manual após 60 segundos.
- Fluxo antigo da extensão continua funcionando.
