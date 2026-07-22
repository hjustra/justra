# Falcao Hostinger Worker

## Objetivo

O Falcao nao responde a partir da VM Azure atual (`HTTP 403` no CloudFront), mas responde a partir da VPS Hostinger. Por isso, a coleta fica separada:

- Azure: app Justra, DuckDB, importacao e busca juridica.
- Hostinger: worker de coleta Falcao, gerando raw e enviando para Azure.

O usuario final nao participa deste fluxo. A conta gov.br ouro, se for necessaria no futuro, e uma sessao operacional da Justra no worker.

## Fluxo diario

1. O timer `justra-falcao-hostinger.timer` dispara em 08:00, 12:00, 18:00 e 23:00 America/Sao_Paulo.
2. O service `justra-falcao-hostinger.service` executa `scripts/falcao_remote_worker.py`.
3. O worker calcula D-1 por padrao e usa `output_tag=daily_YYYY-MM-DD`.
4. O worker chama `scripts/run_falcao_safe.py`.
5. O wrapper chama `scripts/collect_falcao_direct.mjs`.
6. O raw fica em `/mnt/justra-data/raw/falcao/daily_YYYY-MM-DD`.
7. Se existir `documents.jsonl`, o worker copia o diretorio para a Azure.
8. A Azure move o raw para `/mnt/justra-data/raw/falcao/daily_YYYY-MM-DD`.
9. A Azure pausa `justra.service`, importa no DuckDB com `--append --skip-backup` e religa o servico.
10. A busca juridica passa a ler os documentos importados.

O mesmo `output_tag` permite checkpoint. Se a coleta diaria ficar parcial, as proximas janelas retomam de onde parou. O worker sempre prioriza o dia incompleto mais antigo dentro do plano antes de abrir um novo D-1, evitando acumular backlog invisivel. A politica inicial mira aproximadamente `10k-11k` documentos por dia, usando `FALCAO_REQUEST_BUDGET=320` por disparo e `25-55s` entre requests. O cooldown de `6h` apos `HTTP 429` evita insistir em janela bloqueada sem cancelar o dia inteiro.

## Arquivos principais

Hostinger:

```text
/opt/justra/app
/opt/justra/node-runtime
/mnt/justra-data/raw/falcao
/mnt/justra-data/app/falcao_control.json
/mnt/justra-data/app/falcao_remote_worker.json
/mnt/justra-logs/falcao-remote-worker.log
/mnt/justra-logs/falcao-remote-worker-error.log
/etc/justra/falcao-worker.env
```

Azure:

```text
/opt/justra/app
/mnt/justra-data/raw/falcao
/mnt/justra-data/mvp/trt2/trt2_mvp.duckdb
/mnt/justra-data/knowledge/falcao/import_status.json
```

## Configuracao

Arquivo na Hostinger:

```text
/etc/justra/falcao-worker.env
```

Campos:

```dotenv
JUSTRA_DATA_DIR=/mnt/justra-data
JUSTRA_LOG_DIR=/mnt/justra-logs
JUSTRA_NODE_BIN=/usr/bin/node
JUSTRA_NODE_MODULES=/opt/justra/node-runtime/node_modules
PLAYWRIGHT_BROWSERS_PATH=/home/justra/.cache/ms-playwright

FALCAO_AZURE_TARGET=azureuser@52.151.193.134
FALCAO_AZURE_KEY=/home/justra/.ssh/azure_sync_ed25519
FALCAO_AZURE_APP_DIR=/opt/justra/app
FALCAO_AZURE_DATA_DIR=/mnt/justra-data
FALCAO_AZURE_SERVICE=justra

FALCAO_COLLECTIONS=acordaos,sentencas,decisoesmonocraticas,recursorevista,precedentes
FALCAO_MIN_DELAY_MS=25000
FALCAO_MAX_DELAY_MS=55000
FALCAO_REQUEST_BUDGET=320
FALCAO_BLOCK_FREE_MINUTES=360
FALCAO_PLAN_DAYS=90
```

## Comandos operacionais

Rodar D-1 manualmente:

```bash
sudo systemctl start justra-falcao-hostinger.service
```

Ver timers:

```bash
sudo systemctl list-timers 'justra-falcao*'
```

Ver logs:

```bash
sudo journalctl -u justra-falcao-hostinger.service -n 100 --no-pager
sudo tail -n 100 /mnt/justra-logs/falcao-remote-worker.log
sudo tail -n 100 /mnt/justra-logs/falcao-remote-worker-error.log
```

Rodar uma janela historica:

```bash
sudo -u justra env $(sudo cat /etc/justra/falcao-worker.env | xargs) \
  /opt/justra/app/.venv/bin/python -u /opt/justra/app/scripts/falcao_remote_worker.py \
  --mode backfill \
  --start-date 2026-07-01 \
  --end-date 2026-07-07 \
  --output-tag backfill_2026-07-01_2026-07-07
```

Rodar smoke sem importar:

```bash
sudo -u justra env $(sudo cat /etc/justra/falcao-worker.env | xargs) \
  FALCAO_REQUEST_BUDGET=20 \
  /opt/justra/app/.venv/bin/python -u /opt/justra/app/scripts/falcao_remote_worker.py \
  --start-date 2026-07-21 \
  --end-date 2026-07-21 \
  --collections sentencas \
  --output-tag smoke_2026-07-21 \
  --skip-sync
```

## Login gov.br ouro

O teste atual confirmou que a coleta publica `no-auth` funciona na Hostinger. Se o Falcao passar a exigir autenticacao para algum lote:

1. Subir um Chrome persistente na Hostinger.
2. Fazer login gov.br ouro uma vez em uma sessao operacional da Justra.
3. Usar `collect_falcao_direct.mjs --connect-cdp http://127.0.0.1:9228`.

Esse modo deve ser ativado depois no worker, mas nao e necessario para a coleta validada hoje.

## Estados de falha

- `HTTP 403` ou `429`: o coletor marca bloqueio em `falcao_control.json` e para.
- `documents.jsonl` ausente: nao sincroniza nem importa.
- falha de SSH/SCP: raw fica salvo na Hostinger para reprocessar.
- falha de importacao: raw fica salvo na Azure; repetir importacao depois.
- DuckDB lock: o worker pausa `justra.service` durante a importacao e religa ao final.

## Validacao feita em 2026-07-22

Hostinger:

- frontend Falcao: `HTTP 200`;
- API em contexto de navegador: `HTTP 200`;
- coletor oficial JS: 20 requests, 20 `HTTP 200`;
- raw de prova: 124 documentos em `hostinger_falcao_sentencas_probe_20260721`.

Azure:

- raw de prova sincronizado;
- importacao com `--append`;
- Falcao no DuckDB subiu de 5.770 para 5.894 documentos;
- lote importado: 124 documentos.
