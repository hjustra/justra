# Deploy Fase 1

Este diretorio contem os artefatos para subir a Justra em uma VM Linux simples.

## Layout esperado

```text
/opt/justra/app           checkout Git
/opt/justra/node-runtime  node_modules e browsers Playwright
/mnt/justra-data          dados quentes
/mnt/justra-logs          logs
/etc/justra/justra.env    secrets e variaveis do ambiente
```

## Repositorio privado

Como o repo GitHub e privado, a VM precisa de acesso de leitura. Caminho recomendado:

1. Rodar o bootstrap uma primeira vez.
2. Se a VM ainda nao tiver chave, ele cria `/home/justra/.ssh/id_ed25519`, imprime a chave publica e para.
3. Cadastrar a chave publica no GitHub como Deploy Key read-only do repo `hjustra/justra`.
4. Rodar o bootstrap novamente com `REPO_URL=git@github.com:hjustra/justra.git`.

## Bootstrap

Na VM Ubuntu:

```bash
sudo REPO_URL=git@github.com:hjustra/justra.git BRANCH=staging bash deploy/scripts/bootstrap_ubuntu.sh
```

Se o repo ainda nao estiver clonado, copie este diretorio `deploy/` para a VM ou rode os comandos manualmente a partir do guia `docs/azure_phase1_deploy.md`.

## Servicos

```bash
sudo systemctl status justra
sudo journalctl -u justra -f
sudo systemctl list-timers 'justra*'
sudo systemctl start justra-djen-daily.service
```

O servico web exige que o DuckDB principal exista no caminho:

```text
$JUSTRA_DATA_DIR/mvp/trt2/trt2_mvp.duckdb
```
