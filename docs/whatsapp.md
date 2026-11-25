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

O adaptador carrega o `.env` a partir de sua localização no código, mas resolve `./whatsapp-session` a partir do diretório de execução. Ao rodar de `apps/api`, ele utiliza a sessão existente. Se o servidor solicitar pareamento, o adaptador registra `socket_halted` com `cause: pairing_required` e encerra.

Depois de `socket_state` com `state: open`, envie uma pergunta de **outra conta WhatsApp** em uma conversa direta. Confira `messages_upsert` com `type: notify`, a resposta nessa mesma conversa e uma única execução no n8n. O adaptador atende todas as mensagens diretas elegíveis enquanto está ligado. Faça o piloto com uma conta de teste ou durante uma janela controlada.

## Limites para uso contínuo

### Encaminhamento de pedidos no mesmo workflow

O workflow de atendimento já existente pode manter a FAQ e encaminhar mensagens de pedido para `POST /api/integrations/conversation`, com `x-integration-token` e o mesmo payload de entrada. Preserve `session_id` e `message_id`. Em falha transitória, reutilize os mesmos IDs. Use `resposta` do endpoint como texto de retorno.

- Para intenção de compra, o Gemini pode interpretar a mensagem e sugerir comandos determinísticos, como `adicionar 2 #1`. Resolva IDs a partir do catálogo real e peça esclarecimento quando houver ambiguidade. Se a mensagem contém vários itens, use um ID derivado distinto e estável para cada comando e preserve a ordem.
- Durante a coleta de dados, encaminhe os comandos `retirada`, `entrega <região>`, `endereço <endereço>`, `pagamento <forma>`, `nome <nome>`, `telefone <DDD e número>` e `resumo`. A API apresenta taxas, disponibilidade e formas configuradas.
- Encaminhe `confirmar <código>` diretamente a partir do texto explícito do cliente. A etapa de interpretação do Gemini nunca deve produzir uma confirmação. O número do pedido vem da resposta da API.

O [export sanitizado da Etapa 3](n8n/galetobot-kodie-gemini-ia.json) deriva do workflow original. Use o [roteiro de importação e configuração](n8n/etapa-3.md) para homologar uma cópia inativa antes de substituir a versão em uso.

### Cuidados do adaptador

- A deduplicação mantém até 2.000 pares de endereço e ID concluídos por processo, incluindo o endereço alternativo quando fornecido pelo Baileys. Mensagens em andamento são protegidas separadamente. Uma falha antes da tentativa de envio permite reentrega. Após uma tentativa de envio com resultado incerto, o adaptador evita repetir a resposta durante a retenção do ID.
- Os logs do adaptador contêm contadores, estados e categorias fixas. O diagnóstico de HTTP registra apenas o status.
- Mensagens próprias, grupos, broadcasts, newsletters e histórico sincronizado são filtrados. Um atendente automático de outra conta ainda pode gerar troca de respostas. Evite instalar outro emissor de respostas no workflow.
- A equipe validou o atendimento real e o pedido de teste na infraestrutura local. A mudança de hospedagem exige nova validação autorizada.

## Diagnóstico de recepção no LXC

`WHATSAPP_DIAGNOSTICS=detailed` mostra a atividade em janelas de 30 segundos e as fases internas de sincronização reconhecidas na rc14. `basic` é o padrão e reduz os relatórios de conexões abertas em janelas sem nós de mensagem ou atividade offline. `WHATSAPP_PROTOCOL_MODE=bundled` usa a versão embutida. `queried` consulta o repositório oficial por até oito segundos e registra `bundled_fallback` se a consulta falhar.

Com a mesma sessão, registre uma janela de base e depois envie uma mensagem de texto de teste de outra conta. Anote o horário e confirme que o telefone principal a recebeu. Correlacione a janela de `transport_activity` com `messages_upsert` e os eventos de webhook e envio.

| Observação | Ponto a investigar |
| --- | --- |
| `wsMessages` e `frames` avançam, mas `messageNodes` não muda no teste | A atividade do transporte continua. Investigue entrega ao dispositivo vinculado e repita em uma janela com pouco tráfego. |
| `wsMessages` avança e `frames` fica parado | Investigue decodificação ou handshake e compare a fase da conexão. |
| `messageNodes` avança sem `messages_upsert` | Investigue descriptografia, fila offline e sincronização. Confira `decrypt_failure`, `sync_progress`, `event_buffer_timeout` e `stream_error`. |
| Apenas `append` aparece na janela da mensagem nova | Confira `offlineZeroNodes` e o progresso offline. Contadores agregados permitem levantar a hipótese de classificação, sem vincular um nó específico ao teste. |
| `notify` aparece | Confira `webhook_request`, `webhook_response` e `reply_sent` ou a etapa em `message_failed`. |

Repita com a primeira mensagem após 1 h, 8 h, 24 h e 72 h de inatividade, sem sondas intermediárias. Registre o tempo até o evento e a resposta. Para comparar modos de protocolo, use a mesma imagem, sessão e condições, mudando apenas `WHATSAPP_PROTOCOL_MODE`. Se as versões anunciadas forem iguais, a comparação verifica a origem da configuração. Os hooks internos e rótulos de log podem mudar em versões futuras do Baileys. [Issue #2908](https://github.com/WhiskeySockets/Baileys/issues/2908)

## Implantação e gerenciamento pelo painel

Use o [guia da Central WhatsApp](whatsapp-central.md) para preparar o perfil, recuperar uma sessão ou vincular uma conta nova. As instruções de diagnóstico acima continuam disponíveis para investigar o adaptador.
