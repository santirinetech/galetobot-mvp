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
Acesse **http://localhost:5173** no computador. A API usa a porta `3000` por padrão. Quando `HOST` estiver ausente, o bind continua em `0.0.0.0` para permitir acesso pelo n8n a partir da rede local. Nesse cenário, o n8n deve usar o IP LAN da máquina da API e a porta configurada em `PORT`. Restrinja a porta no firewall à rede ou às máquinas autorizadas. Para uso apenas no computador da API, configure `HOST=127.0.0.1`. Mantenha `APP_ORIGIN` igual à origem do painel. O acesso pelo celular físico requer disponibilizar o painel na rede local de teste. Mantenha ambas as portas fora da internet.

## Banco SQLite

Sem `DATABASE_PATH`, a API procura `apps/api/data/galeto-dev.db` e `apps/api/apps/api/data/galeto-dev.db` a partir da raiz do repositório. Se apenas um existir, usa esse arquivo. Se os dois existirem, a inicialização para e pede uma escolha explícita. O backup em `backups-local/` fica fora da busca.

`DATABASE_PATH` aceita um caminho absoluto ou relativo à raiz do repositório e tem prioridade sobre a busca. Por padrão a API exige que o banco exista. Para criar um banco em desenvolvimento ou teste, use `DATABASE_ALLOW_CREATE=1` somente na primeira inicialização. Informe `DATABASE_PATH` para escolher o destino. Sem essa variável e sem candidatos existentes, o destino é `apps/api/data/galeto-dev.db`. Em `NODE_ENV=production`, a API só abre bancos existentes.

Para validar no PowerShell a partir da raiz do repositório, execute `npm.cmd test -w apps/api`. Os testes criam e removem bancos em diretórios temporários e podem ser executados com a API operacional em funcionamento.

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
- O login é provisionado na primeira inicialização. Alterar `ADMIN_PASSWORD` depois não altera a senha já gravada. Para começar uma demonstração com dados iniciais, selecione um arquivo descartável com `DATABASE_PATH` e habilite a criação conforme a seção Banco SQLite.
