import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { ChatError, chatLifetime } from './chat-service.js';

const messageSchema = z.strictObject({
    message_id: z.uuid(),
    mensagem: z.string().trim().min(1).max(500)
});
const errorMessages = {
    model_unavailable: 'O serviço de interpretação está indisponível. Tente outra mensagem ou continue pelo cardápio.',
    integration_unavailable: 'O atendimento inteligente está indisponível. Você pode continuar pelo cardápio.',
    timeout: 'O atendimento excedeu o tempo de resposta. Verifique o resultado antes de enviar novamente.'
};

function endpoint(value, name) {
    if (!value) return null;
    const url = URL.parse(value);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error(name + ' inválida.');
    }
    return url;
}

export function readChatConfig(env) {
    const mode = env.CHAT_MODE ?? 'off';
    if (!['off', 'demo', 'commercial'].includes(mode)) throw new Error('CHAT_MODE inválido.');
    if (mode === 'off') return { mode };
    const webhook = endpoint(env.N8N_WEBHOOK_URL, 'N8N_WEBHOOK_URL');
    if (!webhook || webhook.pathname.includes('/webhook-test/') || !env.N8N_WEBHOOK_TOKEN) {
        throw new Error('O chat exige um webhook de produção do ambiente selecionado.');
    }
    const lab = mode === 'commercial' ? endpoint(env.CHAT_LAB_URL, 'CHAT_LAB_URL') : null;
    const secret = env.CHAT_LAB_TOKEN;
    if ((lab || secret) && (!secret || secret.length < 32 || secret === env.N8N_WEBHOOK_TOKEN || secret === env.WEBHOOK_TOKEN)) {
        throw new Error('Configure uma credencial exclusiva para o Laboratório.');
    }
    const contact = endpoint(env.CHAT_HUMAN_CONTACT_URL, 'CHAT_HUMAN_CONTACT_URL');
    if (contact && contact.protocol !== 'https:') throw new Error('O contato humano exige HTTPS.');
    return { mode, webhook, webhookToken: env.N8N_WEBHOOK_TOKEN, lab, secret, contact: contact?.href };
}

function throttle(limit) {
    return rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
        message: { error: 'Limite de requisições atingido. Aguarde um minuto.' } });
}

function asyncRoute(handler) {
    return async (req, res, next) => {
        try { await handler(req, res); }
        catch (error) {
            if (!(error instanceof ChatError)) return next(error);
            res.status(error.status).json({ error: error.message, code: error.code });
        }
    };
}

export function createChatGateway(chat, config, { fetcher = fetch, webhookTimeout = 12_000 } = {}) {
    let concurrent = 0;
    let budgetUntil = 0;
    let used = 0;

    async function send(row, data) {
        const reserved = chat.reserve(row, data.message_id, data.mensagem);
        const { turn } = reserved;
        if (reserved.created) {
            const now = Date.now();
            if (now >= budgetUntil) { used = 0; budgetUntil = now + 60_000; }
            if (concurrent >= 4 || used >= 60) {
                chat.fail(turn, 'integration_unavailable');
                throw new ChatError(429, 'capacity', 'Capacidade temporariamente atingida.');
            }
            concurrent++;
            used++;
            let failure = 'integration_unavailable';
            try {
                const response = await fetcher(config.webhook, {
                    method: 'POST', redirect: 'error',
                    headers: { 'Content-Type': 'application/json', 'X-GaletoBot-Token': config.webhookToken },
                    body: JSON.stringify({ ...data, session_id: row.id }),
                    signal: AbortSignal.timeout(webhookTimeout)
                });
                // The saved turn is authoritative even if the webhook fails after committing.
                await response.body?.cancel();
            } catch (error) {
                if (error?.name === 'TimeoutError') failure = 'timeout';
            } finally {
                concurrent--;
                chat.fail(turn, failure);
            }
        }
        const result = chat.result(row, data.message_id);
        if (result.status === 'failed') {
            const error = result.error;
            throw new ChatError(error === 'timeout' ? 504 : 502, error, errorMessages[error]);
        }
        return chat.view(row);
    }

    return {
        create: (scope, owner) => chat.create(scope, owner),
        async act(scope, token, owner, operation, input) {
            const row = chat.session(token, scope, owner);
            if (operation === 'read') return chat.view(row);
            const parsed = messageSchema.safeParse(input);
            if (!parsed.success) throw new ChatError(400, 'invalid_message', 'Mensagem ou identificador inválido.');
            return send(row, parsed.data);
        }
    };
}

function isAuthorized(input, expected) {
    if (!input || !expected) return false;
    const a = Buffer.from(input), b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createChatRouters(chat, config, auth, csrf, options) {
    const gateway = createChatGateway(chat, config, options);
    const publicChat = Router(), lab = Router(), internal = Router();
    const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: chatLifetime };

    function boundary(router, limit) {
        router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }, throttle(limit));
    }
    function mount(router, path, scope, owner, run) {
        const cookie = scope === 'lab' ? 'galeto_lab' : 'galeto_chat';
        router.post('/sessions', csrf, throttle(10), asyncRoute(async (req, res) => {
            const token = await run('create', undefined, owner(req));
            res.cookie(cookie, token, { ...cookieOptions, path }).status(201).json({ ok: true });
        }));
        router.get('/session', asyncRoute(async (req, res) => {
            const result = await run('read', req.cookies[cookie], owner(req));
            res.json(scope === 'web' && result.cart.state === 'HUMAN' ? { ...result, contact: config.contact } : result);
        }));
        router.post('/messages', csrf, asyncRoute(async (req, res) => {
            const result = await run('send', req.cookies[cookie], owner(req), req.body);
            res.json(scope === 'web' && result.cart.state === 'HUMAN' ? { ...result, contact: config.contact } : result);
        }));
    }
    function local(scope) {
        return (operation, token, owner, input) => operation === 'create' ? gateway.create(scope, owner) : gateway.act(scope, token, owner, operation, input);
    }
    async function remote(operation, token, owner, input) {
        if (!config.lab) throw new ChatError(503, 'lab_unavailable', 'Configure um ambiente de demonstração independente.');
        try {
            const response = await (options?.fetcher ?? fetch)(new URL('/api/integrations/ai-lab', config.lab), {
                method: 'POST', redirect: 'error', signal: AbortSignal.timeout(16_000),
                headers: { 'Content-Type': 'application/json', 'X-Galeto-Lab-Token': config.secret },
                body: JSON.stringify({ operation, token, owner, input })
            });
            const value = await response.json();
            if (response.ok) return operation === 'create' ? value.token : value;
            if (response.status === 404) throw new ChatError(404, 'session_missing', 'Conversa inexistente ou expirada.');
            if ([400, 409, 429, 502, 504].includes(response.status) && typeof value.code === 'string') {
                throw new ChatError(response.status, 'lab_operation_failed', 'O laboratório não concluiu a operação. Consulte a conversa.');
            }
        } catch (error) { if (error instanceof ChatError) throw error; }
        throw new ChatError(503, 'lab_unavailable', 'O ambiente de demonstração está indisponível.');
    }

    boundary(publicChat, 75);
    publicChat.get('/availability', (_req, res) => res.json({ available: true }));
    mount(publicChat, '/api/chat', 'web', () => null, local('web'));
    boundary(lab, 90);
    lab.use(auth);
    mount(lab, '/api/admin/ai-lab', 'lab', req => String(req.userId), config.mode === 'demo' ? local('lab') : remote);

    boundary(internal, 90);
    const remoteRequest = z.strictObject({
        operation: z.enum(['create', 'read', 'send']), owner: z.string().regex(/^\d{1,18}$/),
        token: z.string().optional(), input: messageSchema.optional()
    });
    internal.post('/', asyncRoute(async (req, res) => {
        if (config.mode !== 'demo' || !isAuthorized(req.get('x-galeto-lab-token'), config.secret)) {
            return res.status(403).json({ error: 'Acesso ao laboratório recusado.' });
        }
        const parsed = remoteRequest.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Operação inválida.' });
        const { operation, token, owner, input } = parsed.data;
        const value = await local('lab')(operation, token, 'remote:' + owner, input);
        return res.json(operation === 'create' ? { token: value } : value);
    }));
    return { publicChat, lab, internal };
}
