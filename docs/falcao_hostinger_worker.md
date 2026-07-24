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

O mesmo `output_tag` permite checkpoint. Se a coleta diaria ficar parcial, as proximas janelas retomam de onde parou. O worker sempre prioriza o dia incompleto mais antigo dentro do plano antes de abrir um novo D-1, evitando acumular backlog invisivel.

A politica conservadora atual, aplicada depois de bloqueios `HTTP 429`, usa `FALCAO_REQUEST_BUDGET=80` por disparo, `90-180s` entre requests e cooldown de `12h`. Esta politica sacrifica vazao para reduzir a chance de bloqueio repetido. Se o endpoint ficar estavel por varios dias, aumente em degraus pequenos, por exemplo `100`, `120`, `160`, mantendo o mesmo intervalo de delay.

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
FALCAO_API_MODE=no-auth
FALCAO_USER_DATA_DIR=/mnt/justra-data/app/falcao_gold_profile
FALCAO_MIN_DELAY_MS=90000
FALCAO_MAX_DELAY_MS=180000
FALCAO_REQUEST_BUDGET=80
FALCAO_BLOCK_FREE_MINUTES=720
FALCAO_PLAN_DAYS=90
```

`FALCAO_API_MODE` aceita:

- `no-auth`: rota publica atual, `/api/no-auth/pesquisa`.
- `frontend`: rota usada pelo Falcao logado, `/api/frontend/pesquisa`.

O modo `frontend` exige que o navegador persistente ou CDP tenha uma sessao gov.br/PDPJ valida. O coletor busca o token no storage do proprio navegador e adiciona o header `Authorization` sem registrar o token em logs.

## Mitigacao de bloqueios

### Controles imediatos

- Manter apenas um worker Falcao ativo por ambiente.
- Respeitar checkpoint e deduplicacao por `document_id`; nunca reiniciar lote removendo `checkpoint.json` para "ganhar velocidade".
- Tratar `HTTP 429` como sinal de limite do provedor, nao como erro transitorio simples.
- Usar cooldown minimo de `12h` apos `429`; se houver dois bloqueios no mesmo dia, manter `strategy_review_required=true` e revisar politica antes de destravar.
- Aumentar vazao apenas por degraus pequenos e depois de dias sem bloqueio.

### Alternativas para nao depender de uma unica coleta

1. **DataJud como camada processual oficial.** Usar a API Publica do DataJud para metadados, classe, assunto, partes publicas e movimentacoes. Ela nao substitui inteiro teor, mas reduz a necessidade de buscar tudo no Falcao.
2. **DJEN/DEJT como descoberta diaria.** Usar os diarios para identificar processos e publicacoes recentes; o Falcao fica focado em inteiro teor relevante, nao em varrer tudo.
3. **Fontes oficiais por tribunal.** Manter coletores especificos para repositórios oficiais quando existirem, como Basis TRT2, TST e paginas publicas de jurisprudencia por tribunal.
4. **BNP/Pangea para precedentes.** Usar o Banco Nacional de Precedentes para precedentes e temas repetitivos, sem depender da mesma janela de Falcao.
5. **Acesso institucional.** Buscar canal formal com CNJ/CSJT/tribunais para acesso autorizado, limite dedicado ou exportacao em lote. Este e o caminho mais solido se a Justra precisar de historico massivo.
6. **Sessao autenticada apenas se houver permissao.** Uma conta gov.br ouro usa rotas autenticadas do proprio frontend (`/api/frontend/pesquisa`). Isso deve ser tratado como um modo proprio de coleta, nao como aumento de limite no endpoint `no-auth`.
7. **Multi-origem com limite global, nao evasao.** VPS adicionais podem dar alta disponibilidade e reduzir dependencia de uma origem falhar, mas nao devem ser usadas para burlar rate limit. Se forem usadas, manter orçamento global central e limites por origem.
8. **Backlog separado da coleta diaria.** Rodar diario com baixa vazao e previsibilidade; rodar historico em janelas noturnas, com budget proprio e pausas longas.

Referencias oficiais uteis:

- DataJud API Publica: https://www.cnj.jus.br/sistemas/datajud/api-publica/
- Endpoints DataJud: https://datajud-wiki.cnj.jus.br/api-publica/endpoints/
- DJEN/Comunicacoes Processuais: https://www.cnj.jus.br/programas-e-acoes/processo-judicial-eletronico-pje/comunicacoes-processuais/
- Banco Nacional de Precedentes: https://www.cnj.jus.br/tecnologia-da-informacao-e-comunicacao/justica-4-0/banco-nacional-de-precedentes-bnp/

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

O teste manual no Chrome logado confirmou que o frontend autenticado chama:

- `/jurisprudencia-nacional-backend/api/frontend/autocompletar`;
- `/jurisprudencia-nacional-backend/api/frontend/pesquisa`;
- `/jurisprudencia-nacional-backend/api/frontend/pesquisa/filtros`.

Todas as chamadas capturadas voltaram `HTTP 200` e `usesNoAuth=false`. O console tambem indicou que o proprio frontend adiciona `Authorization`, por isso o coletor em modo `frontend` tenta reaproveitar o token salvo no storage do navegador logado.

Para salvar a sessao ouro na Hostinger:

1. Instalar o unit `justra-falcao-gold-login.service`.
2. Iniciar a janela de login na VPS:

```bash
sudo systemctl start justra-falcao-gold-login.service
```

3. No Mac, abrir o tunel SSH:

```bash
ssh -N -L 6080:127.0.0.1:6080 -i ~/.ssh/justra_hostinger_pje_worker root@srv1846791.hstgr.cloud
```

4. Abrir no navegador local:

```text
http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale
```

5. Fazer login gov.br ouro/PDPJ/Falcao na janela remota. O navegador esta rodando na VPS, entao cookies e storage ficam em `/mnt/justra-data/app/falcao_gold_profile`.
6. Depois do login, parar a janela:

```bash
sudo systemctl stop justra-falcao-gold-login.service
```

7. Rodar smoke autenticado:

```bash
sudo -u justra env $(sudo cat /etc/justra/falcao-worker.env | xargs) \
  FALCAO_API_MODE=frontend \
  FALCAO_USER_DATA_DIR=/mnt/justra-data/app/falcao_gold_profile \
  FALCAO_REQUEST_BUDGET=5 \
  /opt/justra/app/.venv/bin/python -u /opt/justra/app/scripts/falcao_remote_worker.py \
  --start-date 2026-07-21 \
  --end-date 2026-07-21 \
  --collections sentencas \
  --output-tag smoke_gold_2026-07-21 \
  --skip-sync
```

8. Se o smoke retornar `HTTP 200` em `/api/frontend/pesquisa`, configurar `FALCAO_API_MODE=frontend` em `/etc/justra/falcao-worker.env` e reativar a coleta.

Se a sessao expirar, o worker deve pausar com erro de autenticacao e exigir novo login operacional.

O login remoto abre o Chromium diretamente no display virtual, sem controle Playwright. Isso reduz a chance de o CAPTCHA do gov.br rejeitar a tentativa por sinais de automacao. O Playwright volta a ser usado depois, apenas para a coleta com o perfil ja autenticado.

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
