# Segurança — baseline do MVP
- Banco local e API escutando apenas 127.0.0.1; não publicar na internet.
- Senha de administrador obrigatória com 12+ caracteres, hash bcrypt, cookie HttpOnly SameSite Strict, sessão com expiração.
- Alterações feitas pelo painel exigem sessão e Origin válido.
- Integração externa requer token separado. Nunca usar token em frontend.
- SQL parametrizado e transações SQLite; preço recalculado exclusivamente no backend; estoque atualizado com condição atômica.
- Dados de demonstração fictícios. Nunca usar clientes, senhas, números, sessões WhatsApp ou bancos de produção.
- Antes de produção: TLS, proxy reverso, rotatividade de segredos, RBAC, backup e restore testados, testes automatizados, proteção CSRF em deploy, CORS, monitoramento, política LGPD, revisão de dependências, deploy seguro e auditoria ampliada.
- MVP não passou por pentest e não está pronto para produção.
