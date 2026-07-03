# Justra PJe Operator Capture

Extensão local de operador/desenvolvedor para capturar automaticamente páginas do PJe depois que um humano resolver o CAPTCHA.

Esta extensão não deve ser publicada na Chrome Web Store. Ela existe para uso interno do operador Justra.

## O que ela faz

- Roda em páginas `https://pje.trt2.jus.br/*`.
- Aguarda a página de detalhe do processo ficar acessível.
- Não resolve, automatiza ou contorna CAPTCHA.
- Depois que o operador resolve o CAPTCHA manualmente e o processo carrega, captura movimentos/documentos visíveis.
- Envia automaticamente o payload para a Justra pelo endpoint já existente:

```text
/api/pje-extension/import
```

## Instalação local

1. Abra `chrome://extensions`.
2. Ative **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação**.
4. Selecione a pasta:

```text
/Users/heitordoamaraljurkovich/Desktop/justra/pesquisa/extensions/pje-operator-capture-chrome
```

## Configuração

Clique no ícone da extensão e confira:

- **Autoenviar PJe liberado**: ligado.
- **Ambiente**: use `Justra staging` para testes.
- **CNJ esperado opcional**: deixe vazio para capturar qualquer processo aberto, ou preencha para evitar envio acidental de outro processo.
- **Job ID opcional**: reservado para integração com a fila PJe futura.

## Uso

1. Abra o processo no PJe.
2. Resolva o CAPTCHA manualmente.
3. Aguarde o detalhe do processo carregar.
4. A extensão detecta o CNJ, espera o conteúdo estabilizar e envia automaticamente.
5. O botão flutuante muda para `Justra OK` quando o envio for concluído.

Se quiser forçar uma coleta:

1. Clique no ícone da extensão.
2. Clique em **Capturar agora**.

## Segurança

- A extensão não armazena senha, cookie ou sessão do PJe.
- A extensão não chama scripts externos.
- A extensão não tenta resolver CAPTCHA.
- O envio automático só acontece após a página ficar visível no navegador do operador.

## Reenvio e cooldown

Para evitar duplicação, a extensão guarda no `chrome.storage.local` uma impressão do processo/página enviada recentemente. O cooldown padrão é de 60 minutos por processo/página.

