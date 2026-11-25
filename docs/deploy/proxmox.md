# Implantação no Proxmox

Use um LXC Debian 13 novo, dedicado ao GaletoBot. Comece com 2 vCPUs, 2 GB de RAM e 20 GB como estimativas a validar. Use um LXC não privilegiado e verifique suporte a Docker/overlay e às opções de nesting e keyctl na versão do Proxmox antes de provisionar. Se o ambiente não suportar Docker no LXC com isolamento adequado, use uma VM dedicada. [Guia do Proxmox VE](https://pve.proxmox.com/pve-docs/pve-admin-guide.pdf)

## Preparar o Debian

Na VM ou LXC novo, como root, instale o Docker pelo repositório oficial. [Docker Engine para Debian](https://docs.docker.com/engine/install/debian/)

```bash
apt-get update
apt-get install -y ca-certificates curl git openssh-client
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
docker info --format '{{.Driver}}'
```

Reserve o IP LAN do LXC. No firewall do Proxmox, permita SSH pela rede de administração e o acesso à porta privada do Compose somente a partir do servidor n8n. Bloqueie a mesma porta de outras origens e confirme com testes, pois portas publicadas pelo Docker têm regras próprias de encaminhamento. O Nginx também valida o IP de origem. Mantenha a porta pública do proxy em loopback. [Docker e filtragem de pacotes](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

## Preparar a revisão

Use um checkout da revisão aprovada após a publicação da branch ou transfira um `git bundle` da revisão local auditada para o piloto, antes do push. No Windows, depois que houver commits locais:

```powershell
New-Item -ItemType Directory -Force .\private-local | Out-Null
git bundle create private-local/galetobot.bundle feat/pedidos-whatsapp-v02
$lxc = Read-Host 'IP LAN do novo LXC'
scp .\private-local\galetobot.bundle "root@${lxc}:/root/galetobot.bundle"
```

Após transferir o bundle por SSH, no LXC:

```bash
git clone --branch feat/pedidos-whatsapp-v02 /root/galetobot.bundle /opt/galetobot
cd /opt/galetobot
umask 077
install -d -m 0700 ./runtime ./runtime/backups
install -d -m 0700 -o 1000 -g 1000 ./runtime/db
test -e .env.production || install -m 0600 .env.production.example .env.production
```

Os exemplos usam SSH com root quando esse acesso já está autorizado. Se o acesso ao LXC for por outro usuário, transfira para seu diretório privado e faça a instalação com a conta administrativa no LXC.

Edite `.env.production`. Use a origem HTTPS exata, sem barra final, em `APP_ORIGIN`. O domínio pretendido é `https://galetobot.santirine.com.br`. Defina `LAN_BIND_IP` com o IP real do novo LXC e `N8N_SOURCE_IP` com o IP LAN do n8n. Configure o e-mail, a senha e `WEBHOOK_TOKEN` na API. Use o valor esperado pela credencial existente do n8n para o ambiente autorizado. Para a demonstração isolada, use credenciais próprias e comunique o login por canal privado.

Defina uma tag em `RELEASE`, por exemplo o resultado de `git rev-parse --short HEAD`. Para caminhos personalizados, prefira diretórios locais absolutos. Use somente o nome de arquivo em `DATABASE_FILENAME`. O UID 1000 é o usuário `node` da imagem. O diretório do banco precisa permitir escrita por esse usuário, inclusive para os arquivos WAL e SHM. No arquivo de ambiente do Compose, use aspas simples em valores com `$` literal. Restrinja o acesso ao Docker, pois um usuário com acesso ao daemon pode inspecionar o ambiente dos containers.

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build api web
```

## Provisionar o banco

Para a **demonstração KODIE**, faça a inicialização explícita de uma base vazia, com dados fictícios e administrador dedicado. Cadastre regiões, formas de pagamento e catálogo fictícios ou autorizados no painel. O comando recusa sobrescrever um arquivo existente.

```bash
docker compose --env-file .env.production run --rm --no-deps api \
  node scripts/deploy/init-demo.mjs --new-isolated-demo
```

Para uma **migração autorizada**, identifique no Windows o banco efetivamente usado pela instância, conferindo o modo da API e `DEMO_DATABASE_PATH` ou `DATABASE_PATH`. Tire um snapshot de ensaio enquanto a API atende. Para o corte definitivo, pare os escritores autorizados antes de repetir o snapshot, evitando pedidos após o ponto de corte. A API de backup do SQLite lê as transações confirmadas no WAL e gera um arquivo independente. [SQLite Online Backup API](https://sqlite.org/backup.html)

```powershell
New-Item -ItemType Directory -Force .\private-local | Out-Null
$origem = Read-Host 'Caminho do banco GaletoBot autorizado'
node .\scripts\deploy\sqlite-snapshot.mjs "$origem" .\private-local\galetobot-migracao.db
scp .\private-local\galetobot-migracao.db "root@${lxc}:/root/galetobot-migracao.db"
```

Transfira o snapshot via SSH para um diretório privado. No LXC, substitua o caminho pelo arquivo recebido. Escolha um nome novo se já houver banco no destino.

```bash
test ! -e ./runtime/db/incoming.db && \
  install -m 0600 -o 1000 -g 1000 /root/galetobot-migracao.db ./runtime/db/incoming.db && \
  docker compose --env-file .env.production run --rm --no-deps api \
  node scripts/deploy/sqlite-snapshot.mjs /data/incoming.db /data/galetobot-migrado.db
```

Coloque `DATABASE_FILENAME=galetobot-migrado.db` no ambiente. Use a conta administrativa já cadastrada se quiser preservar seu login. A senha no ambiente serve para provisionar um e-mail novo, e uma conta existente mantém sua senha. Guarde o arquivo de entrada na área privada de backups, fora do volume ativo. Mantenha os dados da loja fora da instância dos avaliadores.

## Subir a aplicação e publicar o HTTPS

```bash
docker compose --env-file .env.production up -d --wait api web
docker compose --env-file .env.production ps
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/api/menu >/dev/null
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/integrations/conversation
```

Esperado no último comando: `404`. Verifique no n8n a conectividade à porta LAN configurada. Uma requisição POST direta a uma das duas rotas privadas sem credencial deve retornar `401` quando feita da origem permitida. A porta direta do Express fica na rede Docker.

Instale `cloudflared` no mesmo LXC conforme a Cloudflare. Após aprovação da publicação, no painel Cloudflare One crie um túnel gerenciado, execute o comando de instalação de serviço exibido para Linux com o token guardado localmente e adicione o hostname aprovado com destino `http://127.0.0.1:8080`. Configure redirecionamento HTTP → HTTPS para esse hostname e exclua `/api/*` de regras que forcem cache. O conector encaminha para o loopback. Guarde a credencial do túnel fora do repositório. Verifique a saúde do túnel e teste `/healthz`, o cardápio e o login no domínio. Mantenha o login no aplicativo e considere Cloudflare Access para restringir o piloto aos avaliadores. [Configuração do Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/)

O painel tem uma única classe de administrador, com permissão para ler e alterar pedidos, estoque e configurações. Quem entra como administrador pode visualizar dados de clientes e a chave Pix cadastrada. Libere credenciais apenas em uma instância isolada, com dados fictícios, sem chave Pix real e sem reaproveitar segredos de produção. Restrinja o acesso ao piloto e revogue o acesso ao terminar.

## Atualizar o n8n existente

No corte aprovado, ajuste apenas a URL de **HTTP Request1** e **API de conversas1**. Use, respectivamente, `http://<IP-LAN-LXC>:3001/api/integrations/conversation/context` e `http://<IP-LAN-LXC>:3001/api/integrations/conversation`. Preserve sufixos, credenciais, método POST, transferência do status HTTP e os demais nós. O n8n envia `x-integration-token` com `WEBHOOK_TOKEN`. O Baileys usa o webhook já publicado e envia `X-GaletoBot-Token` com `N8N_WEBHOOK_TOKEN`. O HTTP LAN deve ficar numa rede privada confiável, pois tokens e payloads transitam sem TLS nesse segmento.

O mesmo workflow aponta para um destino ativo por vez. Para pilotar com uma base de avaliadores, coordene a janela antes de redirecioná-lo. A troca de URLs no workflow real é manual.

## Sessão WhatsApp, somente após autorização

1. Identifique o diretório efetivo da sessão do adaptador Windows e desligue essa instância com Ctrl+C. Desabilite qualquer tarefa ou serviço que a reinicie. Confirme que terminou antes da transferência.
2. Transfira o diretório completo por SSH em janela autorizada, com permissões restritas. No LXC, prepare `./runtime/whatsapp-session`, atribua os arquivos ao UID/GID 1000 e use permissões 0700 em diretórios e 0600 em arquivos. Evite copiar apenas `creds.json`, pois as chaves da sessão estão nos demais arquivos.
3. Configure `N8N_WEBHOOK_URL` e `N8N_WEBHOOK_TOKEN` no ambiente privado sem trocar a credencial do workflow publicado. Com a instância Windows parada, ative a instância Linux explicitamente:

```bash
docker compose --env-file .env.production --profile whatsapp up -d --no-deps whatsapp
docker compose --env-file .env.production --profile whatsapp logs --tail=50 whatsapp
```

Use apenas número autorizado. O perfil fica fora da subida padrão e sem reinício automático. Se a sessão exigir um novo QR, o adaptador encerra sem exibi-lo. Confira o estado da sessão antes de autorizar pareamento.

## Backup, atualização e rollback

O backup pode ser criado no mesmo volume com a API ativa. Em seguida, transfira o arquivo para armazenamento privado separado e faça ensaios de restauração. Limite a retenção pelo período necessário. Sessões WhatsApp exigem cópia a frio, com o adaptador parado e autorização específica.

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose --env-file .env.production exec -T api sh -ec \
  'node scripts/deploy/sqlite-snapshot.mjs "$DATABASE_PATH" "/data/$1"' sh "backup-$stamp.db"
install -m 0600 "./runtime/db/backup-$stamp.db" "./runtime/backups/galetobot-$stamp.db"
```

Em atualização, guarde a tag das imagens atuais e um snapshot. Faça checkout da revisão aprovada, altere `RELEASE`, valide e construa as duas imagens. Recrie API e proxy no mesmo comando. Se houver adaptador autorizado, pare-o antes da troca do backend e reative-o depois, com a mesma sessão. Verifique o status, as rotas e o login. Guarde imagens anteriores para rollback.

```bash
docker compose --env-file .env.production config --quiet
docker compose --env-file .env.production build api web
docker compose --env-file .env.production up -d --wait --force-recreate api web
docker compose --env-file .env.production logs --tail=70 api web
```

Para reverter somente o código, selecione a revisão anterior do Compose, a tag anterior em `RELEASE` e execute `up -d --no-build --wait --force-recreate api web`. Confirme primeiro a compatibilidade com o schema atual. Para restauração, pare o adaptador autorizado, se ativo, e os escritores antes do corte. Valide e instale o snapshot em um arquivo novo, seguindo o procedimento de migração com outro nome. Ajuste `DATABASE_FILENAME` e suba API e proxy. Preserve o banco anterior e seus sidecars para investigação. Registre que pedidos posteriores ao snapshot precisam ser reconciliados. Para devolver a sessão ao Windows, pare primeiro o Baileys no Linux e preserve as chaves mais recentes antes de qualquer troca.

```bash
docker compose --env-file .env.production --profile whatsapp stop whatsapp
docker compose --env-file .env.production stop web api
# Use o nome do snapshot escolhido no diretório privado de backups.
test ! -e ./runtime/db/incoming-restore.db && \
  install -m 0600 -o 1000 -g 1000 ./runtime/backups/galetobot-ESCOLHIDO.db ./runtime/db/incoming-restore.db && \
  docker compose --env-file .env.production run --rm --no-deps api \
  node scripts/deploy/sqlite-snapshot.mjs /data/incoming-restore.db /data/restaurado.db
# Ajuste DATABASE_FILENAME=restaurado.db antes de subir.
docker compose --env-file .env.production up -d --no-build --wait --force-recreate api web
```

## Diagnóstico rápido

| Sintoma | Verificação |
| --- | --- |
| API encerra ao subir | Confira origem HTTPS, credenciais, caminho existente, proprietário e permissões do SQLite. |
| API falha com erro de módulo nativo | Refaça o build no LXC para a arquitetura do host. Confira Node e imagem base. |
| Erro 502 público | Confira o status do túnel, a porta loopback, o estado do Compose e `/healthz` local. |
| n8n recebe 403 ou timeout na LAN | Confira o IP de origem visto pelo proxy, o firewall e a porta. |
| n8n recebe 401 | Confira nome do header e associação da credencial existente. O token da API é diferente do token do webhook. |
| Login recebe 403 | Confira se a origem do navegador coincide exatamente com `APP_ORIGIN`. |
| Sem resposta no WhatsApp | Confira a instância autorizada, a execução do workflow e as duas respostas HTTP da API. |
