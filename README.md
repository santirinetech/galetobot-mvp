# GaletoBot MVP — entrega 24/11
Projeto **novo e isolado**, inspirado no Galeto Master. NÃO substitui produção.

## Requisitos
Node.js 20+ e npm, Windows/Linux/macOS. `better-sqlite3` pode precisar de ferramentas de compilação se não houver binário para sua versão do Node.

## Instalação (VS Code)
```bash
npm install
cp .env.example .env
```
No PowerShell, use `Copy-Item .env.example .env` em vez de `cp` se preferir. Edite `.env`: troque `ADMIN_PASSWORD` por senha forte e `WEBHOOK_TOKEN` por segredo aleatório. Use `ADMIN_EMAIL` para o login.

## Executar
```bash
npm run dev
```
Acesse **http://localhost:5173** no computador. A API é local em `127.0.0.1:3000`. A interface é mobile-first, mas o acesso por celular físico ainda requer uma estratégia segura de rede/proxy: o proxy Vite é acessível na rede local e deve ser usado somente em ambiente confiável de teste. Não exponha a porta 5173 na internet. O backend permanece limitado a localhost.

## Roteiro de demonstração
1. Faça login.
2. Veja estoque inicial (Galeto 10, Tropeiro 5, Arroz 8, Salpicão 2).
3. Crie pedido presencial com nome e telefone fictícios.
4. Observe baixa do estoque e pedido no painel.
5. Vá a Atendimento IA, informe o mesmo telefone e envie `quero o de sempre`.
6. O simulador mostra o último pedido e confere estoque; confirme o pedido simulado.
7. Reduza estoque pelo painel e repita a simulação para demonstrar aviso de falta.

## Limites honestos
- A aba “IA” é um **simulador local determinístico**, sem Gemini e sem WhatsApp real.
- O endpoint de integração é um ponto de entrada protegido, mas não há workflow n8n importável pronto nesta versão.
- Não há suporte a impressão térmica, PWA instalável/offline ou deploy em produção.
- Não use dados reais de clientes na apresentação.
- O login é provisionado na primeira inicialização; alterar ADMIN_PASSWORD depois não altera a senha já gravada. Para ambiente de demonstração recém-criado, apague somente o banco **novo de desenvolvimento** em `apps/api/data/galeto-dev.db` com o processo parado para reinicializar. Nunca faça isso em produção.
