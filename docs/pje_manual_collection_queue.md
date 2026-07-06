# Fluxo PJe com coleta assistida por operador humano

Este documento define como a Justra deve evoluir os botões **Adicionar e abrir PJe** e **Recoletar PJe** usando uma fila de coleta por processo, com intervenção humana para resolver CAPTCHA quando necessário.

Importante: este fluxo não automatiza, contorna ou resolve CAPTCHA. O CAPTCHA continua sendo resolvido por um humano autorizado. A Justra apenas organiza a fila, informa o usuário, reutiliza coletas por CNJ e recebe os dados da página já liberada pelo mesmo contrato de importação usado pela extensão Chrome.

## Objetivos

1. Criar uma fila global de coleta PJe por processo, parecida com a fila persistente do DataJud.
2. Permitir que um operador humano resolva CAPTCHA/login do PJe para processos em fila.
3. Reutilizar uma coleta PJe válida para todos os usuários que acompanham o mesmo CNJ.
4. Se a coleta assistida não acontecer em até 1 minuto no fluxo interativo, voltar para o fluxo normal: advogado abre o PJe, resolve o CAPTCHA e a extensão Justra coleta.
5. Em atualizações periódicas, tentar recoletar com fila e retries por processo; depois de falhas repetidas, marcar como coleta manual necessária.

## Limites de segurança

- A Justra não deve chamar scripts de bypass de CAPTCHA.
- A Justra não deve armazenar senha, cookie ou sessão PJe do advogado ou do operador.
- A Justra não deve simular resolução de CAPTCHA.
- A coleta só deve ocorrer depois que uma pessoa abrir o PJe e obter acesso legítimo à página do processo.
- O backend não consegue ler uma página liberada no navegador local do operador sozinho; quem envia o conteúdo deve ser um cliente autorizado, preferencialmente a extensão Chrome da Justra em modo operador.

## Atores

- **Usuário advogado**: adiciona processo, acompanha timeline e pode cair no fluxo manual.
- **Operador Justra**: pessoa que pode abrir uma fila interna e resolver CAPTCHA/login manualmente.
- **Extensão Chrome Justra**: captura dados visíveis da página PJe liberada e envia para a API da Justra.
- **Backend Justra**: controla fila, timeouts, retries, cache por processo e atualização dos dossiês.

## Conceito principal

A coleta PJe passa a ser orientada por uma entidade global: `pje_job`.

O job é por CNJ, não por usuário. Se três usuários acompanham o mesmo processo, todos compartilham o mesmo job e a mesma última coleta válida.

O usuário não deve esperar indefinidamente. Ao adicionar/recoletar:

1. A Justra cria ou reutiliza um job PJe para o CNJ.
2. A interface mostra um aviso curto: "Estamos tentando coletar o PJe para você. Se levar mais de 1 minuto, abriremos o fluxo manual."
3. Um operador humano vê o job na fila interna.
4. O operador abre o PJe, resolve CAPTCHA/login manualmente e, com a página liberada, aciona a captura pela extensão.
5. Se a captura chegar em até 60 segundos, o usuário recebe os dados sem precisar resolver CAPTCHA.
6. Se não chegar em até 60 segundos, o sistema volta para o fluxo atual: abre o PJe para o usuário e orienta a captura pela extensão.

## Estados do job

Estados propostos:

- `queued`: job criado e aguardando operador.
- `operator_opened`: operador abriu o link do PJe.
- `capture_pending`: página liberada aguardando captura pela extensão.
- `captured`: payload recebido da extensão.
- `succeeded`: dados aplicados aos dossiês/processos vinculados.
- `manual_required`: usuário deve seguir o fluxo normal no PJe.
- `retry`: falha transitória, será tentado novamente.
- `failed`: falha final após limite de tentativas.
- `cancelled`: job substituído/removido.

Campos principais:

```json
{
  "id": "pje:<cnj>",
  "process_number": "10010514520255020075",
  "process_number_masked": "1001051-45.2025.5.02.0075",
  "page_url": "https://pje.trt2.jus.br/consultaprocessual/captcha/detalhe-processo/1001051-45.2025.5.02.0075/1",
  "status": "queued",
  "reason": "user_add|user_recollect|scheduled_refresh",
  "priority": 50,
  "attempts": 0,
  "max_attempts": 3,
  "created_at": "2026-07-03T15:00:00",
  "updated_at": "2026-07-03T15:00:00",
  "user_wait_until": "2026-07-03T15:01:00",
  "next_run_at": "",
  "locked_by": "",
  "locked_at": "",
  "last_error": "",
  "last_capture_at": "",
  "last_import_id": ""
}
```

## Timeouts

Há dois timeouts diferentes.

**Timeout do usuário: 60 segundos**

Esse timeout existe para UX. Se um usuário adicionou/recoletou e a coleta assistida não terminou em 60 segundos, a tela volta para o fluxo normal. Isso não significa que o job global morreu; significa só que aquele usuário não ficará esperando.

**Timeout/retry do job**

O job pode continuar na fila para atualização global. Falhas transitórias podem gerar retry até 3 tentativas. Exemplos:

- rede instável;
- página PJe carregou incompleta;
- payload da extensão chegou sem movimentos/documentos esperados;
- erro temporário da API Justra ao importar.

Após 3 tentativas fracassadas, o status vira `manual_required` ou `failed`, conforme o tipo de erro.

## Geração do page-url

O backend deve gerar o `page_url` a partir do CNJ e do tribunal, usando o mesmo padrão já usado para abrir a consulta oficial do PJe.

Exemplo TRT2:

```text
https://pje.trt2.jus.br/consultaprocessual/captcha/detalhe-processo/1001051-45.2025.5.02.0075/1
```

Se houver variação por tribunal ou grau, o gerador deve ficar encapsulado em uma função única, por exemplo:

```text
officialPjeUrlForProcessNumber(cnj)
```

O restante do sistema nunca deve montar URL PJe manualmente fora dessa função.

## Fluxo: Adicionar e abrir PJe

1. Usuário informa um CNJ.
2. Backend cria/atualiza dossiê e watch.
3. Backend inicia DataJud e DJEN em segundo plano.
4. Backend cria/reutiliza `pje_job` para o CNJ.
5. UI mostra alerta:

```text
Estamos tentando coletar o PJe para você. Se levar mais de 1 minuto, abriremos o fluxo manual.
```

6. UI faz polling do status do job por até 60 segundos.
7. Se o job virar `succeeded`, a tela atualiza timeline/documentos.
8. Se passar 60 segundos sem sucesso, a UI abre o PJe para o usuário e mantém o fluxo atual da extensão.

## Fluxo: Recoletar PJe

1. Usuário clica em **Recoletar PJe**.
2. Backend cria job com `force=true` ou reabre job existente se ele estiver ativo.
3. O job tem prioridade maior que atualização agendada.
4. UI mostra o mesmo alerta de 60 segundos.
5. Se a coleta assistida chegar a tempo, atualiza o dossiê.
6. Se não chegar, abre o fluxo manual para o usuário.

## Fluxo: atualização periódica

1. Scheduler seleciona processos com coleta PJe velha ou ausente.
2. Cria jobs `scheduled_refresh` por CNJ.
3. Operador resolve jobs quando possível.
4. Falhas transitórias usam retry até 3 vezes.
5. Depois disso, o processo fica com status `manual_required`, sem incomodar todos os usuários automaticamente.
6. Quando algum usuário abrir aquele processo, a UI mostra que a recoleta PJe precisa ser feita manualmente.

## Como o operador humano resolve

Tela interna proposta:

```text
/admin/pje-coleta
```

Ela deve mostrar:

- CNJ;
- tribunal;
- quantidade de usuários/casos vinculados;
- idade da última coleta;
- status do job;
- botão **Abrir PJe**;
- botão **Marcar como exige manual**;
- último erro;
- tempo restante do SLA de 60 segundos quando houver usuário esperando.

Procedimento do operador:

1. Abrir `/admin/pje-coleta`.
2. Clicar no job mais urgente.
3. Clicar em **Abrir PJe**.
4. Resolver CAPTCHA/login manualmente no navegador.
5. Quando a página do processo estiver liberada, usar a extensão Justra para enviar os dados.
6. A extensão envia o payload com `job_id` ou `process_number`.
7. Backend aplica a importação, marca o job como `succeeded` e atualiza todos os usuários ligados ao CNJ.

## Alternativa interna: operador Python

Para testes internos, também existe um fluxo sem clique na extensão, usando um Chrome visível controlado por Python:

```bash
.venv/bin/python scripts/pje_operator_collect.py \
  --cnj "1001051-45.2025.5.02.0075" \
  --justra-url "https://staging.justra.com.br"
```

Esse script:

1. abre a URL do PJe para o CNJ;
2. espera o operador resolver CAPTCHA/login manualmente;
3. detecta quando a página de detalhe do processo carregou;
4. captura movimentos, dados visíveis e documentos;
5. salva um JSON local em `data/operator_pje_captures/`;
6. envia o payload para a Justra pelo endpoint de importação PJe.

Primeira instalação local:

```bash
.venv/bin/python -m pip install playwright
.venv/bin/python -m playwright install chromium
```

Para testar sem enviar para a Justra:

```bash
.venv/bin/python scripts/pje_operator_collect.py \
  --cnj "1001051-45.2025.5.02.0075" \
  --justra-url "https://staging.justra.com.br" \
  --dry-run
```

Observação: o endpoint atual de importação foi criado para extensão Chrome. O script Python envia um `Origin` interno (`chrome-extension://justra-pje-operator-python`) para reaproveitar esse contrato durante os testes. Se o staging/prod estiver com lista restrita de extensões, será necessário liberar esse origin ou criar um endpoint/token de operador próprio.

## Contrato com a extensão

A extensão deve continuar enviando o mesmo payload atual, mas com metadados extras opcionais:

```json
{
  "job_id": "pje:10010514520255020075",
  "process_number": "1001051-45.2025.5.02.0075",
  "capture_mode": "operator|user_manual",
  "source_url": "https://pje.trt2.jus.br/consultaprocessual/...",
  "captured_at": "2026-07-03T15:00:45",
  "payload": {
    "movements": [],
    "documents": [],
    "full_text_documents": []
  }
}
```

Se `job_id` vier preenchido, o backend tenta associar a captura ao job. Se não vier, usa o CNJ como fallback, como hoje.

## APIs propostas

Endpoints internos/usuário:

- `POST /api/pje/jobs`
  - cria ou reutiliza job por CNJ.
  - usado por Adicionar e Recoletar.

- `GET /api/pje/jobs/{job_id}`
  - retorna status para polling da UI.

- `POST /api/pje/jobs/{job_id}/manual-required`
  - operador ou backend marca fallback manual.

- `POST /api/extension/pje/import`
  - endpoint atual de importação da extensão.
  - deve aceitar `job_id` opcional.

Endpoints admin:

- `GET /api/admin/pje/jobs`
  - lista fila do operador.

- `POST /api/admin/pje/jobs/{job_id}/claim`
  - operador assume o job.

- `POST /api/admin/pje/jobs/{job_id}/release`
  - operador solta o job sem falha final.

## Reuso por processo

Quando uma captura PJe é recebida:

1. Backend salva o payload normal.
2. Atualiza o dossiê do usuário que originou a coleta, se houver.
3. Localiza outros casos/watches com o mesmo CNJ.
4. Atualiza metadados compartilhados: última coleta, contagem de movimentos, documentos capturados, data da captura.
5. A timeline dos demais usuários passa a enxergar a coleta sem nova ida ao PJe.

## UX mínima

Mensagens para o usuário:

- Durante tentativa assistida:

```text
Estamos tentando coletar o PJe para você. Se levar mais de 1 minuto, abriremos o fluxo manual.
```

- Quando cai para manual:

```text
Não conseguimos concluir a coleta assistida agora. Abra o PJe, resolva o CAPTCHA e use a extensão Justra para enviar os dados.
```

- Quando sucesso:

```text
PJe coletado. Movimentos e documentos foram adicionados ao processo.
```

## Persistência

Arquivos sugeridos em `APP_DATA_DIR`:

- `pje_jobs.json`: fila e estado dos jobs.
- `pje_shared_captures.json`: índice por CNJ com última coleta válida.
- `pje_job_events.jsonl`: log de auditoria append-only.

Exemplo de chave:

```text
pje_jobs["10010514520255020075"]
```

## Critérios de sucesso

- Adicionar processo não deve travar esperando PJe indefinidamente.
- Usuário deve receber fallback manual em até 60 segundos.
- Captura feita por operador deve alimentar todos os usuários do mesmo CNJ.
- Recoleta deve respeitar retries por processo.
- Depois de 3 falhas, status deve ser manual.
- O fluxo atual da extensão deve continuar funcionando mesmo se a fila nova falhar.
- Nenhum segredo, cookie ou sessão PJe deve ser persistido.

## Ordem de implementação

1. Backend: modelo `pje_jobs`, persistência, APIs de criação/status/admin.
2. Backend: associação de importação da extensão com `job_id` e atualização multiusuário por CNJ.
3. Frontend: alertas, polling de 60 segundos e fallback para abrir PJe.
4. Admin: tela `/admin/pje-coleta` para operador humano.
5. Scheduler: criação de jobs de atualização periódica com retry.
6. Smoke tests: adicionar, recoletar, timeout, captura com job, captura sem job, multiusuário.
