# Fluxo de desenvolvimento Justra

Este repositorio usa um fluxo simples para manter mudancas rapidas sem perder controle de producao.

## Branches

- `main`: codigo aprovado para producao.
- `staging`: codigo em teste/homologacao, base para o ambiente staging.
- `codex/<descricao>`: branches temporarias para mudancas feitas localmente com Codex.

## Rotina local

Antes de mudar codigo:

```bash
git switch staging
git pull
git switch -c codex/minha-mudanca
```

Depois de alterar e testar:

```bash
git status
git add .
git commit -m "Descricao curta da mudanca"
git push -u origin codex/minha-mudanca
```

O merge para `staging` deve ser feito por pull request no GitHub. Quando `staging` estiver validado, abrimos outro pull request de `staging` para `main`.

## Deploy

- Deploy de staging: acompanha a branch `staging`.
- Deploy de producao: acompanha a branch `main`.
- Dados, bancos locais, logs, `.env` e arquivos gerados nao entram no Git.
- Segredos de cada ambiente ficam fora do repositorio, em variaveis do servidor ou em secrets do GitHub/Azure.
- Em servidor, use `JUSTRA_DATA_DIR=/mnt/justra-data` e `JUSTRA_LOG_DIR=/mnt/justra-logs` para separar dados/logs do checkout Git.

## Proximo bloco de infraestrutura

Para subir na Azure, precisamos definir:

- assinatura/subscription Azure a usar;
- regiao preferida;
- dominio ou subdominio para staging e producao;
- estrategia de dados: disco gerenciado, Blob Storage ou banco gerenciado;
- forma de deploy: manual via SSH no inicio, depois GitHub Actions.
