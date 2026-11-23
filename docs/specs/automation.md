# n8n — plano
- Receber mensagens de adaptador WhatsApp em webhook autenticado.
- Identificar sessão e contexto.
- Consultar backend para catálogo, histórico e estoque.
- Classificar intenção via LLM, com saída validada.
- Solicitar confirmação; enviar pedido confirmado ao backend com chave idempotente.
- Enviar resposta ao canal e notificar painel.
- Nunca enviar pedidos reais durante homologação; usar números e banco fictícios.
