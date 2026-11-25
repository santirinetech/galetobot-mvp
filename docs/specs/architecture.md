# Arquitetura
- `apps/web`: React/Vite, interface mobile-first; proxy `/api` em desenvolvimento.
- `apps/api`: Express, SQLite local, autenticação e regras de negócio. Demonstração, teste e operação têm modos explícitos e caminhos separados. A operação exige `DATABASE_PATH` apontando para um banco existente.
- `POST /api/orders` e `POST /api/integrations/order`: usam o serviço compartilhado de pedidos, que calcula o total e atualiza o estoque na mesma transação.
- `POST /api/simulate`: demonstração determinística de “o de sempre”; não usa IA generativa.
- `POST /api/integrations/conversation`: processa mensagens autenticadas, persiste carrinho e responde com `resposta`. A confirmação usa o mesmo serviço de pedidos e grava pedido, baixa e resposta na mesma transação.
- O modo hospedado habilita o checkout comercial com um SQLite existente e origem HTTPS. O Nginx serve o build React e separa a origem pública das rotas privadas do n8n.
- O adaptador Baileys é um processo separado. O n8n existente usa a API por HTTP e o Gemini para interpretar ações estruturadas.
