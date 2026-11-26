# Entrega KODIE

O GaletoBot é um projeto independente do Galeto Master. A demonstração de atendimento inteligente reúne Laboratório IA, n8n, Gemini e API comercial.

O responsável relatou uma homologação real com “Quero arroz e galeto”. O workflow executou os nós de Gemini, normalização JavaScript, API de conversas e resposta ao webhook. O pedido #1 ficou pendente, com origem Chat Web, total de R$ 63,00 e pagamento em dinheiro a receber. A operação reduziu galeto de 10 para 9 e arroz de 8 para 7 unidades. Não houve pagamento real.

O modelo observado foi Gemini 3.5 Flash Lite. Uma homologação anterior de pedidos pelo WhatsApp está documentada no projeto e corresponde a outra etapa. Os testes automatizados usam mocks e SQLite temporário.

A [demonstração](https://demo-galetobot.santirine.com.br) e o [cardápio](https://demo-galetobot.santirine.com.br/cardapio) possuem ambiente próprio. O acesso administrativo é fornecido separadamente. Consulte o [índice de evidências](../evidencias/README.md), o [roteiro n8n](roteiro-n8n.md) e o [guia multicanal](../atendimento-web.md).
