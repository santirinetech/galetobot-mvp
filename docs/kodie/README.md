# Entrega KODIE

O material local identifica o caso como **4.4 · Assistente de Perguntas Frequentes**. A solução estende a FAQ até o registro de pedidos com estoque transacional. A matriz segue os critérios já registrados no projeto. A revisão definitiva depende do enunciado oficial, caso seja disponibilizado.

| Critério | Evidência disponível | Para entregar |
| --- | --- | --- |
| API Express e catálogo | Testes HTTP com SQLite isolado | Instruções no README |
| IA e engenharia de prompts | Execução e saída Gemini capturadas pela equipe | Anonimizar e anexar prompt e saída |
| Automação n8n e JSON | Execução real capturada pela equipe | Anexar canvas, caminho e resposta JSON |
| Resultado | Pedido WhatsApp #1, R$ 161,00, Pix selecionado e status Pendente | Anexar conversa e estoque, sem transação financeira |
| Arquitetura e reprodução | README, testes e roteiro de deploy | Validar o LXC antes de divulgar a URL |
| Export e código-fonte | Referência local com credenciais removidas | Sanitizar o export real e publicar após revisão |

Para demonstrar, abra o cardápio e o painel isolados. Mostre um pedido com múltiplos itens, entrega, Pix, resumo e confirmação. Relacione a execução do n8n e a saída do Gemini ao pedido e aos movimentos de estoque.

[Índice de evidências](../evidencias/README.md) · [Roteiro do n8n](roteiro-n8n.md) · [Deploy](../deploy/proxmox.md)
