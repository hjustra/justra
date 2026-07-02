# Justra PJe Capture - Chrome MVP

Primeira versão de teste para o fluxo em que o advogado abre o processo no PJe, resolve o CAPTCHA manualmente e usa a extensão para baixar ou enviar todos os documentos visíveis para a Justra.

## Como instalar no Chrome

1. Abra `chrome://extensions`.
2. Ative o modo de desenvolvedor.
3. Clique em "Carregar sem compactação".
4. Selecione esta pasta: `/Users/heitordoamaraljurkovich/Desktop/justra/pesquisa/extensions/pje-capture-chrome`.

## Como testar

1. Abra o processo de teste ou acesse:
   `https://pje.trt2.jus.br/consultaprocessual/detalhe-processo/1000717-52.2024.5.02.0202/1#589702a`
2. Resolva o CAPTCHA no PJe.
3. Clique no botão flutuante "Justra".
4. Clique em "Baixar todos docs" ou "Enviar para Justra".

As duas ações varrem os documentos da lista visível, abrem cada item, aguardam o visualizador e acumulam o texto em `documents[]`.

## Escopo desta versão

- Não burla CAPTCHA.
- Não salva senha, token OAB ou certificado.
- Captura somente o que o usuário consegue ver na página carregada.
- Ordena movimentos do mais recente para o mais antigo quando há data identificável.
- Quando o documento está em HTML ou iframe acessível, salva o texto em `documents[].content_text`.
- Salva uma auditoria em `document_candidates[]` com o status de cada item encontrado na lista.
- Quando o conteúdo está em visualizador fechado/PDF sem texto acessível, salva referências em `document_refs[]` para a próxima etapa de download/extração.
- O botão "Enviar para Justra" envia para `http://127.0.0.1:8787/api/pje-extension/import`.

Os imports enviados ficam em:

`/Users/heitordoamaraljurkovich/Desktop/justra/pesquisa/data/app/pje_extension_imports.jsonl`
