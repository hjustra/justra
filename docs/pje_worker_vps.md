# Worker PJe em VPS externa

Este documento descreve o deploy do `justra-pje-worker` em uma VPS separada da Azure.

## Objetivo

Manter a Azure como backend principal da Justra e mover apenas a origem das chamadas ao PJe para uma VPS menor. A VPS não hospeda site, banco, DJEN, DataJud nem arquivos de usuário; ela só consome jobs da fila PJe e devolve o payload para `https://staging.justra.com.br`.

## Arquitetura

- Azure:
  - `justra.service`
  - banco/arquivos/fila
  - DJEN, DataJud, Falcão e UI
  - endpoint público `/api/operator/pje/jobs/*`
- VPS PJe:
  - `justra-pje-worker.service`
  - clone read-only do repositório
  - Playwright/Chromium
  - token de operador PJe
  - Azure OpenAI apenas para OCR do CAPTCHA, quando aplicável

## Requisitos da VPS

- Ubuntu Server 24.04 LTS ou 22.04 LTS
- x64
- 1 vCPU mínimo; 2 vCPU preferível
- 2 GB RAM mínimo
- 20 GB disco mínimo
- IPv4 público fixo
- SSH por chave
- Firewall liberando apenas porta 22 de entrada
- Saída HTTPS liberada

## Fluxo de implantação

1. Criar a VPS em provedor menor, de preferência no Brasil.
2. Antes de instalar qualquer coisa, testar se o PJe aceita a origem da VPS:

```bash
curl -sS -D /tmp/pje_headers.txt -o /tmp/pje_body.html \
  "https://pje.trt2.jus.br/consultaprocessual/captcha/detalhe-processo/1001051-45.2025.5.02.0075/1"
head -40 /tmp/pje_headers.txt
head -c 900 /tmp/pje_body.html
```

3. Se retornar `403 CloudFront`, descartar essa VPS/provedor.
4. Se retornar HTML normal do PJe/CAPTCHA, rodar o bootstrap:

```bash
sudo REPO_URL=git@github.com:hjustra/justra.git BRANCH=staging \
  bash /tmp/bootstrap_pje_worker_ubuntu.sh
```

5. Se o bootstrap gerar uma deploy key, cadastrar a chave pública no GitHub como read-only Deploy Key e rodar o bootstrap novamente.
6. Configurar `/etc/justra/pje-worker.env` com:

```bash
JUSTRA_PJE_BACKEND_URL=https://staging.justra.com.br
JUSTRA_PJE_OPERATOR_ID=pje-worker-vps-01
JUSTRA_PJE_OPERATOR_TOKEN=...
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://optti-oa-us.openai.azure.com/
AZURE_OPENAI_DEPLOYMENT=gpt-4.1-mini
```

7. Desligar o worker PJe da Azure para evitar que ele consuma jobs e marque `blocked_by_origin`:

```bash
sudo systemctl disable --now justra-pje-worker
```

8. Iniciar o worker na VPS:

```bash
sudo systemctl start justra-pje-worker
sudo journalctl -u justra-pje-worker -f
```

## Validação

- O painel **PJe operador** deve mostrar o worker consumindo jobs.
- O log da VPS deve mostrar `STATUS: 200` ou carregamento do CAPTCHA/PJe, não `403 CloudFront`.
- Um job com importação bem-sucedida deve virar `succeeded`.
- O processo correspondente deve receber movimentos/documentos do PJe.

## Operação

Atualizar código na VPS:

```bash
cd /opt/justra/app
sudo -H -u justra git pull --ff-only origin staging
sudo systemctl restart justra-pje-worker
sudo journalctl -u justra-pje-worker -n 120 --no-pager
```

Reativar worker da Azure só se o experimento for revertido:

```bash
sudo systemctl enable --now justra-pje-worker
```

## Critério de decisão

- Se a VPS retorna `200`/CAPTCHA e jobs PJe concluem, adotamos a VPS como worker PJe de staging.
- Se a VPS também retorna `403 CloudFront`, testamos outro provedor.
- Não usar rotação agressiva de IP. O desenho recomendado é IP fixo, baixo volume, rate limit e circuit breaker.
