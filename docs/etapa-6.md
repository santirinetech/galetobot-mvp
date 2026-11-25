# GaletoBot 2.0 · Operação comercial e cardápio

O painel e o cardápio compartilham os componentes e tokens Brasa. A marca GaletoBot permanece no painel. O cardápio usa o nome e o logotipo do estabelecimento. As preferências de tema do painel e da loja são locais ao navegador.

## Pedidos e canais

A listagem usa paginação por ID com busca e filtros no servidor. O Kanban exibe totais e carrega páginas adicionais por coluna. A consulta antiga sem parâmetros mantém sua resposta anterior. O painel continua aplicando as transições do backend.

O balcão e o checkout público continuam enviando IDs e quantidades. O backend calcula preços, frete e troco e registra a baixa de estoque na transação. Pix permanece pendente até o registro administrativo do recebimento. Um carrinho convencional e uma conversa do assistente mantêm conteúdos independentes.

Com `CHAT_MODE=off` o cardápio permanece disponível. A oferta do chat depende da configuração e de falhas recentes observadas pelo processo. Após um timeout ou falha de integração, o servidor retira temporariamente a oferta por 30 segundos. Antes da primeira mensagem ou após essa janela, a oferta do chat indica que a integração está configurada e a disponibilidade ainda pode precisar ser confirmada. O diagnóstico do Laboratório mostra somente evidências da execução. O teste manual futuro requer um ambiente isolado e configuração própria de n8n e Gemini.

## Fotografias

`POST /api/products/:id/photo` e `POST /api/settings/logo` aceitam JPEG, PNG ou WebP com corpo binário. As operações POST e DELETE exigem sessão administrativa e Origin válido. A API verifica o conteúdo, aplica limites, redimensiona e reencoda para WebP. As URLs públicas em `/api/media/:name` têm nomes opacos. Imagens preexistentes por URL continuam sendo exibidas. O SQLite guarda referências e configurações, enquanto os arquivos processados ficam no diretório `PRODUCT_MEDIA_DIR`. No Compose, mantenha esse diretório no volume persistente de dados da API.

As configurações novas de estabelecimento são campos opcionais do JSON em `store_settings`. Ausência de `pickup_enabled` preserva retirada, e ausência de `human_contact_url` mantém o contato configurado para o chat. O modelo de pedidos e pagamentos mantém a migração da Etapa 2.

## Backup, restauração e rollback

1. Para uma futura implantação autorizada, registre o commit e as referências das imagens em uso. Em ambiente de homologação isolado, faça build da API e do frontend, valide o proxy para os uploads e execute o checkout com pagamentos fictícios.
2. Antes de implantar, faça backup consistente do SQLite pela API de backup do SQLite ou com as gravações pausadas. Pause as gravações de mídia durante a cópia do diretório persistente para obter referências e arquivos do mesmo ponto. Armazene ambos em local protegido e valide o banco com `PRAGMA integrity_check`.
3. Para rollback de código, restaure as versões anteriores da API e do frontend juntas. Preserve o volume, o banco e a pasta de mídia. Uma versão anterior pode deixar de servir URLs de mídia geradas pela Etapa 6. Preserve os arquivos para recuperar a exibição ao voltar para a versão nova.
4. Restaure o snapshot de dados somente se a reversão exigir recuperação de dados e com autorização explícita. Valide em cópia isolada antes de substituir dados operacionais. O snapshot representa o ponto do backup e pedidos feitos depois desse ponto exigem conciliação.
