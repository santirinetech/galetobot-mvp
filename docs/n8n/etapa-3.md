# Etapa 3 · Atendimento comercial

O [workflow sanitizado](galetobot-kodie-gemini-ia.json) deriva do export **GaletoBot - KODIE - Gemini IA**. Ele preserva os cinco nós originais e acrescenta decisões de encaminhamento, a chamada à API de conversas e um nó para devolver o status HTTP correto. O export vem inativo, com URLs de exemplo, sem credenciais e sem dados fixados de execuções.

## Atualizar o workflow já validado

O **export de referência** abaixo usa nomes sem sufixo. Para o workflow publicado no piloto KODIE, preserve os nomes e o prompt publicados e siga o [roteiro de migração](../kodie/roteiro-n8n.md).

Atualize primeiro a API com o procedimento de inicialização de desenvolvimento já usado. No workflow existente, substitua apenas o conteúdo dos dois campos abaixo. O export versionado contém os textos completos. A partir da raiz, no PowerShell, carregue os valores:

```powershell
$workflow = Get-Content -Raw -Encoding utf8 .\docs\n8n\galetobot-kodie-gemini-ia.json | ConvertFrom-Json
$prompt = ($workflow.nodes | Where-Object name -eq 'Message a model').parameters.messages.values[0].content
$code = ($workflow.nodes | Where-Object name -eq 'Code in JavaScript').parameters.jsCode
```

1. **Message a model → Messages → Content**, no modo Expression. Copie o valor integral com `$prompt | Set-Clipboard`. Se o editor já exibir o prefixo de expressão, cole o texto a partir de `{{`.
2. **Code in JavaScript → JavaScript**. Copie o código integral com `$code | Set-Clipboard`.
3. Salve e publique a atualização do mesmo workflow. Preserve os demais nós, URLs, tokens, modelo e credenciais.

Em **Configurações** do painel, cadastre **Presidente Médici** com a taxa aprovada pela loja se a região ainda estiver ausente. O alias **Morro do Meio** já é reconhecido quando a região canônica existe. Uma lista de regiões vazia desabilita a entrega.

Para validar com uma conta de teste no WhatsApp, peça os itens, escolha entrega e Pix, informe nome e telefone em uma única mensagem, depois informe Morro do Meio e o endereço. Confira itens, subtotal, taxa e total no resumo. Envie `1` ou “Pode confirmar” e confira o pedido e a baixa de cada item no painel. Na execução da mensagem com várias intenções, confira `use_model: true` na saída de **HTTP Request**, a saída de **Message a model**, as ações normalizadas em **Code in JavaScript** e o HTTP 200 em **API de conversas**.

## Importar e testar

1. Inicie a API GaletoBot em modo de desenvolvimento com banco descartável e `WEBHOOK_TOKEN` configurado. Use as instruções no [README](../../README.md). O último modo operacional legado permanece fora desta homologação.
2. Em **Configurações**, configure as regiões e taxas, as formas de pagamento e a chave Pix do ambiente de teste. Use dados fictícios. Cadastre aliases no formato `Apelido | Nome da região cadastrada`. `Morro do Meio` é reconhecido como `Presidente Médici` quando esta região existe no cadastro. A taxa é sempre lida do cadastro canônico. Quando o mesmo texto aponta para regiões distintas, o bot pede esclarecimento.
3. No n8n de teste, importe o JSON pelo menu do workflow, opção **Import from File**. Mantenha-o inativo e abra o editor. [Documentação de importação e exportação](https://docs.n8n.io/build/manage-workflows/export-and-import.md)
4. No node **Webhook**, associe a credencial **Header Auth** com cabeçalho `X-GaletoBot-Token` e valor de `N8N_WEBHOOK_TOKEN` do adaptador. O path de exemplo é `galetobot-atendimento`.
5. Em **HTTP Request** e **API de conversas**, substitua apenas o host de exemplo pelo endereço da API de teste acessível ao n8n. Preserve respectivamente `/api/integrations/conversation/context` e `/api/integrations/conversation`. Associe a ambos a credencial **Header Auth** com nome de cabeçalho `x-integration-token` e valor de `WEBHOOK_TOKEN` de `.env.development`. Mantenha **Include Response Headers and Status** e **Never Error** ligados, conforme o export. Isso permite encaminhar o status original quando a API rejeitar a chamada. Use uma rede privada ou HTTPS. [Configuração do HTTP Request](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.httprequest/)
6. Em **Message a model**, associe a credencial **Google Gemini(PaLM)**. O export conserva o modelo `models/gemini-3.5-flash-lite` do original. Confirme a disponibilidade na sua conta e registre qualquer substituição no teste. [Node Google Gemini](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-langchain.googlegemini/)
7. Para verificar o contrato isolado, use os testes automatizados da API. Abaixo está o exemplo de corpo que o adaptador envia. Use um ID diferente para cada mensagem nova e reutilize o ID em reenvios.

```json
{"session_id":"homologacao@lid","message_id":"etapa3-001","mensagem":"Quero dois galetos e um arroz."}
```

Continue com `entrega Morro do Meio` ou `retirada`, `endereço Rua Teste, 10` na entrega, `nome Cliente Teste`, `telefone 11900000000`, `pagamento Pix` e `resumo`. Envie `1` e confira o número e a baixa no painel. Reenvie a mesma mensagem com o mesmo `message_id` e confira o mesmo recibo. Envie um novo `1` com outro ID e confira que nenhum pedido adicional é criado. Teste também `atendente`, seguido de outra mensagem. A primeira confirma a transferência, e a seguinte é suprimida. Após a retomada administrativa, o cliente precisa pedir novo resumo.

## Dados, falhas e ativação

- O Gemini devolve ações estruturadas. IDs de sessão e mensagem vêm do Webhook, e a API valida as ações. Ela monta respostas a partir do [conhecimento versionado](../../apps/api/src/knowledge.json) e dos dados atuais. Endereço de retirada, devoluções, alergênicos e prazo de entrega continuam pendentes se não houver cadastro. Horário vem de Configurações.
- A API decide confirmações a partir da mensagem original, da conversa e do resumo vigente. A interface do cliente mostra números e aceita linguagem natural. O formato legado `confirmar <UUID>` continua compatível.
- A chave Pix vem da configuração administrativa, fica fora do cardápio público e do contexto do Gemini. Em um reenvio, a API consulta a chave atual. O histórico do bot armazena um marcador, sem copiar a chave na resposta persistida.
- Se o Gemini falhar, a API oferece comandos determinísticos. Falhas de API retornam JSON com `error` e `etapa` e status HTTP correspondente, como `401` para credencial recusada e `502` para falha de transporte. O Baileys não envia esses erros como mensagens ao cliente. O silêncio com HTTP `200` fica reservado à supressão confirmada pela API.
- Para comparar o token do arquivo com o que a API local aceita, rode `node scripts/diagnose-integration.mjs` na raiz. O diagnóstico executa uma FAQ, omite os valores das credenciais e não envia pedidos. Variáveis já presentes no shell têm precedência sobre `.env.development` no inicializador.
- A retenção de execuções está desativada no export para reduzir exposição de dados. Use apenas dados de teste ao inspecionar nós. As requisições da API têm timeout de três segundos cada. Verifique a latência ponta a ponta frente ao limite de 15 segundos do adaptador.
- Após aprovação do piloto, coloque a atualização no workflow escolhido e mantenha **um único workflow ativo** para o atendimento. Copie a **Production URL** desse Webhook para `N8N_WEBHOOK_URL`, verifique a credencial e use o adaptador atualizado na sessão Baileys existente. Para retorno em silêncio, o adaptador respeita `{"resposta":"","suprimir_resposta":true}`. Evite iniciar outra instância para a mesma sessão.

O teste automatizado local usa SQLite temporário, respostas simuladas do Gemini e as expressões do JSON exportado. A importação no n8n, a ligação às credenciais reais e o percurso real WhatsApp → n8n → API → WhatsApp exigem homologação separada e autorizada.

### Compatibilidade do workflow com Pix e troco

O contrato de entrada e saída permanece igual. Encaminhe `mensagem`, `message_id` e `session_id` originais, inclusive quando o contexto responder `use_model: false`. Use a ação `pix` para consultas da chave e `payment` com valor `Pix` para seleção, especialmente quando a mesma mensagem trouxer outras informações. A API interpreta as confirmações e as frases de dinheiro e troco suportadas diretamente. Nenhuma ação de confirmação ou de pagamento recebido deve ser gerada pelo modelo. Em homologação, confira esses pontos no workflow existente antes de decidir se o prompt publicado precisa de ajuste.
