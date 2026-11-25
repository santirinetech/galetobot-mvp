# Atendimento multicanal

O Chat Web usa o mesmo motor comercial do WhatsApp e o mesmo webhook do ambiente. O navegador acessa somente a API do GaletoBot. O Baileys pode ficar desligado durante os testes Web. O cardápio convencional e o balcão continuam chamando a API diretamente, inclusive quando n8n ou Gemini estiver indisponível.

## Configuração por ambiente

O padrão é `CHAT_MODE=off`. Use `N8N_WEBHOOK_URL` e `N8N_WEBHOOK_TOKEN` no servidor para o webhook de produção do **ambiente selecionado**, com seus próprios segredos. Os dois nós HTTP do workflow devem apontar para as rotas de contexto e aplicação da mesma API que recebeu o chat. As chamadas de retorno usam a credencial de integração dessa API. O navegador não decide o destino. O proxy público continua bloqueando `/api/integrations/*`.

- **Instalação exclusivamente demonstrativa:** use `CHAT_MODE=demo`, banco e usuários fictícios e o n8n que já atende somente essa instalação. O Laboratório e o Chat Web ficam nessa base. Reserve estoque fictício para os testes concorrentes. Nunca aponte o webhook de demonstração para a API comercial.
- **Instalação comercial:** use `CHAT_MODE=commercial` no ambiente operacional. Para habilitar o Laboratório, forneça `CHAT_LAB_URL` com a origem privada da API demonstrativa e `CHAT_LAB_TOKEN` igual nos dois serviços. A credencial tem pelo menos 32 caracteres e é distinta dos tokens do webhook e das rotas de integração. A API demonstrativa usa `CHAT_MODE=demo`, outro SQLite, outros usuários, configurações e credenciais e um webhook que só encaminha para ela. Pode reutilizar a definição de workflow no n8n demonstrativo existente. Sem esse destino, o Laboratório fica indisponível. O endpoint interno exige a credencial e só executa operações no lado demonstrativo. Use rede restrita e HTTPS ao encaminhar entre hosts.
- **Contato humano:** `CHAT_HUMAN_CONTACT_URL` é um endereço HTTPS escolhido pela loja. O chat suspende a automação e encaminha o cliente para esse contato. Mensagens manuais de atendentes ainda não são enviadas pelo painel de chat. Sem contato configurado, o canal humano aparece como indisponível.

O fluxo legado `POST /api/simulate` permanece autenticado para compatibilidade. A tela atual usa o Laboratório, que chama o atendimento n8n. Os carrinhos do cardápio e do chat permanecem separados; fechar o chat mantém sua sessão recuperável até expirar.

## Endpoints e dados

- Público: `GET /api/chat/availability`, `POST /api/chat/sessions`, `GET /api/chat/session` e `POST /api/chat/messages`.
- Administrador: `POST /api/admin/ai-lab/sessions`, `GET /api/admin/ai-lab/session` e `POST /api/admin/ai-lab/messages`.
- Entre APIs: `POST /api/integrations/ai-lab`, restrito ao ambiente de demonstração.
- Callbacks n8n: as rotas de contexto e conversa preservam a mensagem e os identificadores originais. Sessões Web só aceitam callbacks de turnos reservados pela API.

O navegador usa cookie HttpOnly. A criação de turno associa ID, mensagem, sessão e prazo em SQLite. Cada conversa comporta até 100 turnos e expira em uma hora. O gateway limita execuções simultâneas e consumo por processo. Atrás de proxy, o limite HTTP pode ser agregado pelo endereço do proxy. Controle por IP de origem em uso público exige configuração separada do ingress com proxies confiáveis.

A migração cria `chat_sessions` e `chat_turns`. A rotina de expiração remove histórico e estado dessas conversas, preservando pedidos, clientes e pagamentos. A conversa pode conter telefone e endereço. Mantenha backups protegidos, retenção restrita e revise o tratamento de dados encaminhados ao n8n e Gemini antes de ativar a operação pública. O diagnóstico do Laboratório registra apenas correlação, horário, contexto, aplicação observada e falhas. O export atual não comprova execução do Gemini nem informa identificador da execução. Confirme esses dados no n8n durante homologação. Um futuro envelope opcional pode trazer o ID da execução e o resultado de cada nó.

## Ensaio real futuro

1. Prepare banco, estoque, região com taxa, credenciais e chave Pix fictícios em instalação isolada. Garanta que o Baileys está desligado.
2. Configure o workflow existente desse ambiente com as duas URLs da API isolada. Verifique que ele preserva `session_id`, `message_id` e `mensagem`. Confira a distinção entre consultar Pix e selecionar Pix nos nós de interpretação.
3. No navegador, abra o Laboratório, envie uma frase com itens e região e confirme no n8n se o modelo executou quando o contexto o solicitou. Confira as ações validadas, o frete e o total. Complete o pedido com `1`. Compare pedido, pagamento pendente e movimento de estoque. Repita pelo Chat Web e compare a origem do pedido.
4. Repita com cartão, dinheiro com troco, dinheiro sem troco e reenvio do mesmo turno. Interrompa o webhook em um ensaio controlado e verifique o erro explícito e o retorno ao cardápio convencional. Os ensaios automatizados atuais usam mocks e não homologam o Gemini ou o n8n publicado.

## Implantação e rollback futuros

Gere e teste as imagens candidatas em ambiente isolado. Antes de atualizar a API comercial, preserve as imagens anteriores e obtenha snapshot consistente do SQLite. Atualize API e frontend juntos com o chat desligado inicialmente. A migração das tabelas é aditiva. Habilite primeiro a instalação demonstrativa e valide o percurso real antes de ativar o Chat Web comercial. O serviço WhatsApp e seu volume de sessão podem permanecer como estão.

Para interromper o recurso, configure `CHAT_MODE=off` e recrie a API. Para rollback completo, retorne às imagens anteriores de API e frontend e preserve o SQLite ativo com as tabelas aditivas. A interface anterior pode mostrar a origem literal de pedidos Chat Web. Voltar ao snapshot completo requer conciliar pedidos e estoque gravados depois do backup.

No cardápio convencional, a chave Pix aparece para o token de um pedido Pix confirmado e ainda pendente de pagamento. No balcão, o método é opcional e a chave pode ser consultada no detalhe administrativo. O troco é calculado pelo servidor. A confirmação de Pix pela equipe continua independente do estado do pedido.
