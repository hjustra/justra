# Deploy Azure Fase 1

Objetivo: manter a experiencia de desenvolvimento local leve, com codigo no GitHub e execucao/dados na Azure.

## Desenho

```text
MacBook/Codex local
  checkout Git leve: codigo, site, scripts, docs
  sem DJEN/Falcao bruto, sem bancos grandes, sem .env real

GitHub
  main: producao
  staging: homologacao

Azure VM
  /opt/justra/app: checkout Git
  /mnt/justra-data: dados quentes
  /mnt/justra-logs: logs
  systemd: processo web e jobs
  nginx: HTTPS e proxy reverso

Azure Blob Storage
  historico bruto DJEN/Falcao/PDF/HTML/JSONL compactado
```

## Variaveis de ambiente essenciais

```text
JUSTRA_DATA_DIR=/mnt/justra-data
JUSTRA_LOG_DIR=/mnt/justra-logs
JUSTRA_PUBLIC_URL=https://staging.justra...
JUSTRA_ADMIN_EMAIL=...
JUSTRA_ADMIN_PASSWORD=...
OPENAI_API_KEY=...
DATAJUD_API_KEY=...
JUSTRA_NODE_BIN=/usr/bin/node
JUSTRA_NODE_MODULES=/opt/justra/app/node_modules
# Opcional. Em Linux, deixe vazio se usar Chromium instalado pelo Playwright.
JUSTRA_CHROME_PATH=
```

## Tamanho inicial recomendado

- VM: `B2s` ou `B2ms`.
- Disco do sistema: 64 GB.
- Disco de dados: 512 GB minimo; 1 TB preferivel se DJEN e Falcao ficarem quentes por mais tempo.
- Retencao local: 30 a 60 dias para bruto pesado.
- Arquivo historico: Blob Storage com lifecycle para Cool/Archive.

## Fluxo de deploy

Inicio manual por SSH:

```bash
git push
ssh justra-staging 'cd /opt/justra/app && git pull && sudo systemctl restart justra'
```

Depois:

- push em `staging` aciona deploy de homologacao;
- merge em `main` aciona deploy de producao;
- dados e secrets nunca entram no Git.

## Dependencias Falcao

Na VM, o coletor Falcao precisa de Node.js, Playwright e Chromium. Instalacao inicial sugerida dentro de `/opt/justra/app`:

```bash
npm install playwright
npx playwright install --with-deps chromium
```

Depois defina:

```text
JUSTRA_NODE_BIN=/usr/bin/node
JUSTRA_NODE_MODULES=/opt/justra/app/node_modules
JUSTRA_CHROME_PATH=
```

## Proximo passo tecnico

Criar a VM, montar `/mnt/justra-data` e `/mnt/justra-logs`, clonar `git@github.com:hjustra/justra.git` em `/opt/justra/app` e configurar `.env` no servidor.
