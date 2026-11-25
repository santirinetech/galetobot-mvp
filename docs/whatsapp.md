# Atendimento GaletoBot pelo WhatsApp

O Baileys encaminha a conversa para um único workflow do n8n. O workflow consulta o catálogo da API Express, envia a pergunta e o catálogo ao Gemini e devolve uma resposta JSON. O Baileys envia o texto ao mesmo JID. Para a etapa de pedidos, o mesmo workflow poderá encaminhar mensagens ao serviço de conversas da API, responsável pela confirmação, pelo preço e pela baixa de estoque.

## Contrato e configuração do workflow existente

1. No node **Webhook**, configure `POST`, **Header Auth** e **Using Respond to Webhook node**. A credencial de entrada usa o cabeçalho `X-GaletoBot-Token` com o valor de `N8N_WEBHOOK_TOKEN`. Use a **Production URL** HTTPS mostrada pelo node do workflow selecionado. Essa URL fica disponível após a publicação ou ativação do workflow, conforme a interface do n8n.
2. Leia do corpo do webhook `mensagem`, `session_id` e `message_id`. Para a FAQ, envie somente a pergunta e os dados necessários do catálogo ao Gemini. Preserve os IDs no n8n para correlação e futuro encaminhamento ao serviço de conversas.
3. No **HTTP Request**, consulte `GET /api/integrations/products` da API de teste com `x-integration-token` e o valor de `WEBHOOK_TOKEN`. Esse token pertence à API Express. A URL deve ser alcançável a partir do ambiente do n8n. Se ele roda em outra máquina ou contêiner, o loopback da API no Windows não é acessível diretamente por ele.
4. O **Code in JavaScript** entrega ao node final um único item com `resposta` como texto não vazio. No **Respond to Webhook**, use **First Incoming Item** ou devolva um objeto JSON com esse campo, com status `200`. A execução precisa responder dentro dos 15 segundos esperados pelo adaptador.

Entrada do Baileys:

```json
{"session_id":"cliente@lid","message_id":"id-unico","mensagem":"Quais produtos estão disponíveis?"}
```

Saída do n8n:

```json
{"resposta":"Mensagem gerada pelo Gemini"}
```

Referências dos nodes do n8n: [Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/), [Header Auth](https://docs.n8n.io/integrations/builtin/credentials/webhook/) e [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/).

## Primeiro teste real

Antes de iniciar uma sessão autorizada, identifique a instância em uso e verifique a configuração do workflow existente. Mantenha uma instância do Baileys para a sessão e um workflow responsável pelo atendimento. Para migrar ao Linux, siga o [guia de implantação](deploy/proxmox.md).

No Git Bash, para reutilizar a configuração existente no `.env` da raiz:

```bash
cd /c/MeusProjetos/galetobot-mvp/apps/api
test -f whatsapp-session/creds.json && node src/whatsapp/connect.js
```

Para testar outro destino sem persistir alterações no `.env`, use uma sessão de Git Bash em que as variáveis sejam fornecidas apenas ao processo:

```bash
cd /c/MeusProjetos/galetobot-mvp/apps/api
read -rsp 'Production URL HTTPS do workflow Gemini: ' galeto_webhook_url; printf '\n'
read -rsp 'Token de entrada do webhook: ' galeto_webhook_token; printf '\n'
test -f whatsapp-session/creds.json &&
  test -n "$galeto_webhook_url" &&
  test -n "$galeto_webhook_token" &&
  N8N_WEBHOOK_URL="$galeto_webhook_url" N8N_WEBHOOK_TOKEN="$galeto_webhook_token" node src/whatsapp/connect.js
unset galeto_webhook_url galeto_webhook_token
```

O adaptador carrega o `.env` a partir de sua localização no código, mas resolve `./whatsapp-session` a partir do diretório de execução. Ao rodar de `apps/api`, ele utiliza a sessão existente. Se aparecer um QR em vez da conexão esperada, interrompa o processo e confira a sessão antes de parear.

Quando o terminal mostrar que o WhatsApp conectou, envie a pergunta de **outra conta WhatsApp** em uma conversa direta. Confira a resposta nessa mesma conversa e uma única execução no n8n. O adaptador ignora mensagens da própria conta e grupos. Ele atende todas as mensagens diretas elegíveis enquanto está ligado, então faça o piloto com uma conta de teste ou durante uma janela controlada.

## Limites para uso contínuo

### Encaminhamento de pedidos no mesmo workflow

O workflow de atendimento já existente pode manter a FAQ e encaminhar mensagens de pedido para `POST /api/integrations/conversation`, com `x-integration-token` e o mesmo payload de entrada. Preserve `session_id` e `message_id`. Em falha transitória, reutilize os mesmos IDs. Use `resposta` do endpoint como texto de retorno.

- Para intenção de compra, o Gemini pode interpretar a mensagem e sugerir comandos determinísticos, como `adicionar 2 #1`. Resolva IDs a partir do catálogo real e peça esclarecimento quando houver ambiguidade. Se a mensagem contém vários itens, use um ID derivado distinto e estável para cada comando e preserve a ordem.
- Durante a coleta de dados, encaminhe os comandos `retirada`, `entrega <região>`, `endereço <endereço>`, `pagamento <forma>`, `nome <nome>`, `telefone <DDD e número>` e `resumo`. A API apresenta taxas, disponibilidade e formas configuradas.
- Encaminhe `confirmar <código>` diretamente a partir do texto explícito do cliente. A etapa de interpretação do Gemini nunca deve produzir uma confirmação. O número do pedido vem da resposta da API.

O [export sanitizado da Etapa 3](n8n/galetobot-kodie-gemini-ia.json) deriva do workflow original. Use o [roteiro de importação e configuração](n8n/etapa-3.md) para homologar uma cópia inativa antes de substituir a versão em uso.

### Cuidados do adaptador

- A deduplicação no Baileys é em memória, limitada a mil IDs por processo. Ela protege contra reentrega imediata durante a execução. Em caso de falha antes da tentativa de envio, o ID volta a ficar disponível para reentrega.
- O adaptador registra metadados e marcadores de diagnóstico de HTTP. Revise a retenção do n8n para proteger os dados do cliente. O envio ao Gemini deve usar o mínimo necessário para responder.
- Mensagens próprias, grupos, broadcasts, newsletters e histórico sincronizado são filtrados. Um atendente automático de outra conta ainda pode gerar troca de respostas. Evite instalar outro emissor de respostas no workflow.
- A equipe validou o atendimento real e o pedido de teste na infraestrutura local. A mudança de hospedagem exige nova validação autorizada.
