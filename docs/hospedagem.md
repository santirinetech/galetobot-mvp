# Hospedagem e isolamento

O procedimento de instalação, atualização, backup e rollback está no [guia do Proxmox](deploy/proxmox.md). O [guia da Etapa 6](etapa-6.md) complementa a restauração das fotografias e do banco.

O responsável informou instalações independentes para a operação comercial e para a demonstração KODIE, com bancos, credenciais e workflows separados. A demonstração deve usar dados fictícios, conta de avaliação controlada e isolamento do estoque e das sessões comerciais.

O alerta `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR` indica que o Express recebeu o cabeçalho de encaminhamento sem uma configuração de proxy confiável compatível. O rate limiter pode identificar o proxy como origem compartilhada e aplicar limites indevidamente. Antes de mudar a configuração, mapeie e teste a cadeia real de proxies, garanta que o primeiro proxy confiável remova cabeçalhos fornecidos pelo cliente e configure confiança restrita aos endereços ou sub-redes efetivamente controlados. Teste tentativas com cabeçalhos forjados e acesso direto. A correção requer homologação e implantação autorizadas.

A exposição de um administrador de avaliação permite alterar dados da demonstração e acionar operações disponíveis. Use credenciais exclusivas e temporárias, controle o acesso e monitore o ambiente. Consulte também a [documentação do laboratório](atendimento-web.md).
