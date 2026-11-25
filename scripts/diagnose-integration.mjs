import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';

async function run() {
    const config = dotenv.parse(readFileSync(new URL('../.env.development', import.meta.url)));
    const port = Number(process.argv[2] ?? config.PORT ?? 3000);
    const token = config.WEBHOOK_TOKEN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta local inválida.');
    if (!token || token.startsWith('ALTERE_')) throw new Error('Configure WEBHOOK_TOKEN em .env.development.');
    const override = process.env.WEBHOOK_TOKEN !== undefined && process.env.WEBHOOK_TOKEN !== token;
    console.log(`Alvo: loopback:${port}. Token lido de .env.development (valor omitido).`);
    if (override) console.log('O shell tem WEBHOOK_TOKEN divergente. O inicializador preserva variáveis já presentes.');
    const id = randomUUID();
    const body = { session_id: `diagnostico-${id}@lid`, message_id: id, mensagem: 'Como faço um pedido?' };
    const base = `http://127.0.0.1:${port}/api/integrations/conversation`;
    async function post(route, payload, authenticated) {
        const headers = { 'Content-Type': 'application/json' };
        if (authenticated) headers['x-integration-token'] = token;
        return fetch(base + route, { method: 'POST', body: JSON.stringify(payload), headers,
            redirect: 'error', signal: AbortSignal.timeout(4000) });
    }
    for (const suffix of ['/context', '']) {
        const response = await post(suffix, body, false);
        console.log(`${suffix || '/conversation'} sem token: HTTP ${response.status}`);
        if (response.status !== 401) throw new Error('O controle sem token não retornou 401. Diagnóstico interrompido.');
    }
    const context = await post('/context', body, true);
    console.log(`/context com token: HTTP ${context.status}`);
    if (!context.ok || (await context.json()).use_model !== true) {
        throw new Error('Confira o processo da API, o modo de desenvolvimento e a origem efetiva do WEBHOOK_TOKEN.');
    }
    const reply = await post('', { ...body, interpretacao: { actions: [{ type: 'faq', value: 'pedir' }] } }, true);
    console.log(`/conversation com token: HTTP ${reply.status}`);
    if (!reply.ok || !(await reply.json()).resposta?.trim()) throw new Error('A conversa não retornou texto.');
    console.log('FAQ verificada com interpretação de teste. Nenhum pedido foi enviado.');
}

try {
    await run();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
