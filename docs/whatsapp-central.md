# Central de gerenciamento do WhatsApp

Acesse **Configurações → Conexão WhatsApp**. Uma instalação preparada pode abrir, reconectar e desvincular a conta pelo painel. A API comercial e o serviço WhatsApp continuam em processos distintos. O proxy público encaminha as rotas administrativas da API comercial. A porta 3002 do WhatsApp fica sem publicação no host.

## Configuração da instalação

No ambiente de instalação, configure `WHATSAPP_CONTROL_TOKEN` com um segredo exclusivo de pelo menos 32 caracteres, distinto do token do webhook, do token de integração e do token do Laboratório. O Compose fornece ambos os destinos internos. Para atendimento, mantenha `N8N_WEBHOOK_URL` e `N8N_WEBHOOK_TOKEN` do ambiente correto. Um webhook ausente ou inválido permite abrir a central, mas o painel mostra a integração como não configurada.

O perfil `whatsapp` usa a imagem `galetobot-whatsapp`, a rede de controle interna compartilhada com a API e uma rede de saída própria. O adaptador roda como `node`. O Compose usa `flock` sem um processo intermediário para manter o bloqueio do volume durante a vida do adaptador. Use armazenamento local com suporte a bloqueios e o mesmo arquivo de lock para qualquer candidato que aponte para o mesmo volume. Evite executar uma segunda cópia diretamente no host. A API comercial não monta a sessão ou o Docker Socket.

- **Instalação nova:** prepare um diretório de sessão vazio, gravável pelo UID/GID do container. Exemplo para o caminho padrão, feito somente se ainda estiver ausente.

  ```bash
  test -d ./runtime/whatsapp-session ||
    install -d -m 0700 -o 1000 -g 1000 ./runtime/whatsapp-session
  ```

  O serviço sobe desconectado. Clique em **Vincular conta**. Abra **Aparelhos conectados** no WhatsApp e leia a imagem temporária. O painel consulta o estado periodicamente. Códigos substituídos são atualizados. A janela de pareamento é limitada a cinco minutos e cada imagem expira após 45 segundos.
- **Sessão existente:** preserve o diretório gravável usado anteriormente. O adaptador lê a sessão ativa e tenta recuperá-la sem pedir QR. Uma sessão que exija pareamento fica disponível para diagnóstico. Use **Vincular novamente** para autorizar explicitamente outra sessão.
- **Ausência do serviço:** a API comercial e o Chat Web, cardápio e balcão continuam disponíveis. A central indica serviço indisponível.

## Sessões e recuperação

O volume mantém os arquivos legados e um diretório protegido `.galeto`. Cada tentativa cria um diretório separado. Ao substituir uma sessão, o adaptador primeiro encerra o socket, aguarda a persistência e copia os artefatos de autenticação para um backup privado. A indicação `.galeto/active.json` muda apenas após a autenticação, o ciclo de reinício solicitado e a sincronização inicial. Cancelar ou expirar preserva a indicação anterior. Um processo interrompido antes da ativação retoma a sessão anteriormente ativa. Os diretórios de tentativa interrompida ficam preservados.

A desvinculação requer confirmação no painel e aguarda uma resposta de sucesso do servidor WhatsApp. Se a resposta for inconclusiva, o volume ativo fica preservado e o painel informa a limitação. Quando a desvinculação é confirmada, a indicação ativa fica vazia e o serviço aguarda uma nova ação. Mantenha o volume e os backups fora do Git e restritos ao operador da instalação. Para backup integral, pare somente o adaptador, aguarde seu encerramento e copie o volume completo para armazenamento privado, incluindo o ponteiro e os arquivos de chave. Faça qualquer recuperação offline com um único escritor. Um backup local não reativa um aparelho revogado pelo WhatsApp.

Em caso de reinício do container, a sessão ativa é novamente carregada. O supervisor aplica seu limite de tentativas com backoff. O serviço de gerenciamento permanece disponível após esgotar as tentativas. O Compose limita os reinícios por falha do processo a três. Após parar o serviço manualmente ou reiniciar o host, confira o estado do perfil e suba-o pela rotina de inicialização do ambiente.

## Diagnóstico e pausa

Socket aberto, sincronização inicial e entrega de mensagens são sinais distintos. O painel usa sinais reais do adaptador. Um período sem mensagens não provoca reconexão nem degradação automática. Quando o transporte fica aberto sem sinal de sincronização, a central indica degradação. O histórico resumido e os horários de diagnóstico são mantidos em memória e reiniciam junto com o processo.

Em **Diagnóstico e eventos**, informe o número de teste autorizado com código do país. Envie desse número a mensagem indicada para a conta da loja. O teste só aceita o código temporário da conversa direta esperada. Se o WhatsApp entregar somente um LID sem telefone associado na mensagem, use outro número cuja identidade o adaptador consiga verificar. O diagnóstico acompanha o `notify`, o webhook, a confirmação conhecida da API e o envio pelo adaptador. Ele pode ser usado com a automação pausada. A API trata o teste por um caminho determinístico sem carrinho, pedido ou chamada ao Gemini. O teste comprova envio pelo adaptador, enquanto a confirmação de entrega ao telefone é feita pelo operador. O workflow deve encaminhar os campos originais e respeitar `use_model: false` para esse teste.

A pausa global é persistida na tabela aditiva `whatsapp_automation`. O adaptador consulta a política antes de chamar o n8n e novamente antes de iniciar o envio. Sem acesso à política, ele suspende as respostas automáticas. A API comercial também verifica a pausa nas rotas de contexto e aplicação do WhatsApp. Operações já confirmadas permanecem registradas e mensagens já enviadas não podem ser recolhidas. Se a pausa ocorrer entre a chamada e o envio, o adaptador descarta a resposta de uma revisão de política anterior. Um callback anterior que só alcance a API depois da retomada pode ser processado pela política vigente. O contrato atual do workflow não carrega a revisão da autorização. A retomada global preserva as pausas individuais e não interfere no Chat Web, cardápio, balcão ou Laboratório.

## Endpoints

| Destino | Rotas |
| --- | --- |
| Painel → API comercial | `GET /api/admin/whatsapp/state`, `POST /api/admin/whatsapp/actions`, `PATCH /api/admin/whatsapp/automation` |
| API comercial → WhatsApp | `GET /state`, `POST /actions` |
| WhatsApp → API comercial | `GET /api/integrations/whatsapp-control/automation` |

As rotas administrativas exigem sessão, e as escritas validam `Origin`. As operações aceitas são parear, cancelar, reconectar, desvincular e testar. As rotas internas usam `X-Galeto-WA-Token`. As respostas de estado usam `Cache-Control: no-store` e incluem apenas a projeção permitida. O QR é entregue como imagem temporária. O payload bruto, números completos, arquivos e chaves da sessão ficam fora da interface e dos logs.

## Implantação e rollback futuros

Antes de qualquer implantação autorizada, ensaie em uma instalação descartável com conta de teste. Preserve as referências das imagens existentes de API, frontend e WhatsApp, gere um snapshot consistente do SQLite e copie a sessão com o adaptador parado. O schema financeiro e o Chat Web da Etapa 3 permanecem compatíveis.

No ambiente autorizado, com tags candidatas preparadas e configuração preservada, valide e construa as três imagens antes da troca:

```bash
docker compose --env-file .env.production --profile whatsapp config --quiet
docker compose --env-file .env.production --profile whatsapp build api web whatsapp
docker compose --env-file .env.production --profile whatsapp up -d --wait --no-build api web
docker compose --env-file .env.production --profile whatsapp up -d --no-deps --no-build whatsapp
docker compose --env-file .env.production --profile whatsapp ps
```

Use `RELEASE` para identificar as imagens candidatas de API e frontend e `WHATSAPP_RELEASE` para o adaptador. Primeiro verifique a saúde de API e frontend. Depois abra a central e teste o estado. Em instalação nova, gere um QR e homologue o ciclo de pareamento, sincronização, reinício, teste guiado e recebimento depois de períodos de inatividade. Confirme separadamente a desvinculação com uma conta descartável. Os testes locais usam mocks e não comprovam estabilidade prolongada.

Para rollback, encerre o adaptador candidato antes de iniciar o anterior. Use as imagens e o Compose da versão anterior, mantendo o SQLite ativo e a tabela aditiva. Se não houve troca de sessão e a versão anterior lê `creds.json` na raiz, ela pode usar o diretório anterior. Se o ponteiro atual indica uma sessão em `.galeto/session-…`, faça backup e selecione explicitamente essa sessão ou o backup aprovado como volume da versão anterior, que não interpreta o ponteiro. Não reative uma sessão que foi intencionalmente desvinculada. A versão antiga pode ignorar a pausa global do adaptador. Mantenha o canal parado nesse caso até verificar a política desejada. Evite restaurar o SQLite completo sobre pedidos novos.
