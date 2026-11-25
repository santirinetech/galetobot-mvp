# Piloto visual Brasa — Etapa 5

## Identidade e componentes

O piloto usa Carvão na navegação, Creme na base clara e Brasa para ações e seleção. Verde fica reservado a sinais operacionais. A borda, a escala de espaçamento, o foco e as cores semânticas são definidos em `design-system.css`. O wordmark GaletoBot e a chama Lucide são provisórios.

Manrope (títulos) e Inter (interface) são fontes variáveis com subconjunto latino, empacotadas em WOFF2. O Vite entrega as licenças OFL junto com o build. Nomes com caracteres fora do subconjunto podem usar as fontes de fallback do sistema. [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope) · [Inter](https://github.com/google/fonts/tree/main/ofl/inter)

O módulo `design-system.jsx` oferece wordmark, botões, cabeçalho de página, campos, superfícies, etiquetas, seleção, tabela semântica, feedback e diálogos com opção de drawer. A estrutura comum persiste tema e largura da sidebar no navegador, quando o armazenamento local está disponível. A navegação inferior continua no mobile. Foco visível e movimento reduzido são respeitados. Os componentes usam os pontos de quebra de 540 e 820 px e as tabelas, métricas e colunas respondem à largura do seu contêiner.

## Semântica dos indicadores

- **Valor dos pedidos** soma os pedidos comerciais criados no dia de referência, em `America/Sao_Paulo`.
- **Recebimentos registrados** soma o total dos pedidos cujo pagamento tem situação `received` e data de registro no dia de referência. Um pedido de outro dia pode entrar nesse indicador. É o valor registrado pela operação, sem conciliação bancária.
- Pagamentos pendentes ou desconhecidos nunca entram no valor recebido. O painel mostra a diferença no resumo e na lista. Simulações legadas ficam fora dos indicadores comerciais.
- **Pedidos recentes** apresenta os pedidos comerciais mais recentes disponíveis. A distribuição por canal usa as contagens reais do período, independentemente do limite de 100 pedidos da lista.

As respostas de `GET /api/dashboard` e `GET /api/orders` receberam campos aditivos. As transições no Kanban usam o mesmo `PATCH /api/orders/:id/status` já usado pelo detalhe. A confirmação manual do Pix continua no detalhe. Não há migração de SQLite.

## Compatibilidade e próxima etapa

O tema se aplica à navegação e ao piloto. Fora da Visão Geral e de Pedidos, o conteúdo legado preserva sua superfície clara nesta etapa, inclusive quando a navegação está escura. Login e cardápio mantêm sua apresentação atual.

| Superfície | Reuso planejado |
| --- | --- |
| Balcão, Produtos e Estoque | Campos, botões, filtros, etiquetas e tabelas; drawers de detalhes e edição. |
| Clientes e Configurações | Cabeçalhos, superfícies, formulários e mensagens de validação. |
| Central WhatsApp e Laboratório IA | Estados, superfícies, foco e feedback. Preservar os fluxos de pareamento e conversação. |
| Login | Wordmark, tipografia, campos, ações e estados de erro. |
| Cardápio e Chat Web | Usar tokens na identidade configurável do estabelecimento, categorias, disponibilidade, carrinho e assistente. Usar fotos reais cadastradas quando disponíveis. |

### Pedir com IA na instalação local

O botão só aparece quando `GET /api/chat/availability` responde `available: true`. A inspeção de `.env`, `.env.development` e das variáveis do processo não encontrou `CHAT_MODE` ativo. A API usa `off` por padrão e desabilita o recurso se a configuração do webhook for inválida. Nada foi habilitado durante este piloto. A configuração e homologação continuam descritas no [guia multicanal](atendimento-web.md).

## Validação

As imagens do piloto foram geradas no Chrome com dados fictícios em SQLite temporário. Incluem temas claro e escuro, desktop e mobile, Visão Geral, lista, Kanban, detalhe e estado vazio. O ensaio também exercita carregamento, erro e recuperação, filtros, colapso da sidebar, mudança de status e confirmação Pix pelo backend. Nos nove pares de tokens de texto e fundo verificados por tema, o menor contraste foi 5,92:1 no claro e 6,98:1 no escuro. A homologação visual das demais telas fica para a Etapa 6.
