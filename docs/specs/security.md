# Segurança — baseline do MVP
- Banco local. Configure `HOST=127.0.0.1` para uso local. O bind padrão `0.0.0.0` preserva o acesso do n8n pela LAN. Restrinja a porta da API no firewall às máquinas ou à rede autorizada e mantenha a API fora da internet.
- Senha de administrador obrigatória com 12+ caracteres, hash bcrypt, cookie HttpOnly SameSite Strict, sessão com expiração.
- Alterações feitas pelo painel exigem sessão e Origin válido.
- Integração externa requer token separado. Nunca usar token em frontend.
- SQL parametrizado e transações SQLite; preço recalculado exclusivamente no backend; estoque atualizado com condição atômica.
- Dados de demonstração fictícios. Nunca usar clientes, senhas, números, sessões WhatsApp ou bancos de produção.
- Antes de produção: TLS, proxy reverso, rotatividade de segredos, RBAC, backup e restore testados, testes automatizados, proteção CSRF em deploy, CORS, monitoramento, política LGPD, revisão de dependências, deploy seguro e auditoria ampliada.
- MVP não passou por pentest e não está pronto para produção.
