# Workflow publicado do GaletoBot

O workflow existente **GaletoBot - KODIE - Gemini IA** usa os nomes abaixo. As expressões do n8n dependem dos nomes literais.

| Nó | Responsabilidade |
| --- | --- |
| Webhook1 | Recebe mensagem e identificadores autenticados |
| HTTP Request1 | Consulta `POST /api/integrations/conversation/context` |
| Precisa do Gemini?1 | Decide se a mensagem exige interpretação |
| Message a model1 | Classifica intenções e devolve ações JSON |
| Code in JavaScript1 | Normaliza ações e preserva dados originais |
| Executar conversa? | Decide se chama a API de conversas |
| API de conversas1 | Chama `POST /api/integrations/conversation` |
| Preparar resposta HTTP | Preserva status e monta resposta |
| Respond to Webhook1 | Devolve o JSON ao Baileys |

No corte, altere somente as URLs de **HTTP Request1** e **API de conversas1** para o endereço LAN do novo proxy. Preserve rotas, POST e credenciais. O webhook usa `X-GaletoBot-Token` e as chamadas da API usam `x-integration-token`.

## Export para a entrega

1. Exporte o workflow publicado e salve em `private-local/galetobot-workflow-real.json`, na raiz do projeto. Use só o export do workflow, sem exportar credenciais.
2. Execute `node scripts/sanitize-workflow.mjs`. O script valida nomes, conexões e referências estáticas e cria `docs/n8n/galetobot-publicado.sanitized.json` em arquivo novo, sem objetos de credenciais ou dados fixados, com hosts de exemplo.
3. Revise manualmente prompt, JavaScript, expressões e parâmetros do resultado. Remova URLs privadas, dados identificáveis e segredos embutidos antes de versionar. Para conferir referências novamente, execute `node scripts/sanitize-workflow.mjs --check docs/n8n/galetobot-publicado.sanitized.json`.

O export de referência tem nomes diferentes e permanece útil para os testes. O prompt real contém edições manuais que dependem do arquivo exportado para reprodução fiel. [Exportação no n8n](https://docs.n8n.io/build/manage-workflows/export-and-import.md)
