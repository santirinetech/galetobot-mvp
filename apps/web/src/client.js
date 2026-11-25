export const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const sources = { counter: 'Balcão', site: 'Site', 'web-chat': 'Chat Web', whatsapp: 'WhatsApp', 'whatsapp-simulated': 'Simulação' };
export const statuses = { pending: 'Pendente', confirmed: 'Confirmado', preparing: 'Em preparo', ready: 'Pronto', completed: 'Concluído' };
export const nextStatus = { pending: 'confirmed', confirmed: 'preparing', preparing: 'ready', ready: 'completed' };

export async function api(path, { body, ...options } = {}) {
    let response;
    try {
        response = await fetch('/api' + path, {
            credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            ...options, body: body === undefined ? undefined : JSON.stringify(body)
        });
    } catch (cause) {
        throw new Error('Falha de rede ao acessar o painel. Verifique a conexão e tente novamente.', { cause });
    }
    const json = response.headers.get('content-type')?.includes('application/json');
    if (!json) {
        const message = response.ok
            ? 'O endereço da API retornou uma página. Verifique o proxy do painel.'
            : `O servidor respondeu HTTP ${response.status} sem uma resposta da API. Verifique o proxy.`;
        throw Object.assign(new Error(message), { status: response.status });
    }
    const result = await response.json();
    if (!response.ok) {
        const error = new Error(result.error || 'Erro na requisição');
        error.status = response.status;
        throw error;
    }
    return result;
}
