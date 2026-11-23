# Arquitetura
- `apps/web`: React/Vite, interface mobile-first; proxy `/api` em desenvolvimento.
- `apps/api`: Express, SQLite local, autenticação e regras de negócio. A inicialização seleciona o banco existente nos caminhos documentados no README ou usa `DATABASE_PATH`.
- `POST /api/orders`: única operação que confirma pedidos; total calculado pelo servidor e estoque atualizado na mesma transação.
- `POST /api/simulate`: demonstração determinística de “o de sempre”; não usa IA generativa.
- `POST /api/integrations/order`: endpoint protegido para integração futura; requer `WEBHOOK_TOKEN` e payload idempotente.
- n8n/IA/WhatsApp: conectores futuros; nunca acessar SQLite diretamente.
