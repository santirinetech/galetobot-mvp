import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

export const controlAction = z.discriminatedUnion('action', [
    z.strictObject({ action: z.literal('pair'), replace: z.boolean().default(false) }),
    z.strictObject({ action: z.literal('cancel') }),
    z.strictObject({ action: z.literal('reconnect') }),
    z.strictObject({ action: z.literal('unlink'), confirm: z.literal(true) }),
    z.strictObject({ action: z.literal('probe'), phone: z.string().regex(/^\d{10,15}$/) })
]);
const timestamp = z.number().int().nonnegative();
const optionalTime = timestamp.nullable().optional();
const probeSchema = z.object({
    challenge: z.string().regex(/^GALETO-TESTE [A-F0-9]{16}$/), expires_at: timestamp,
    received_at: optionalTime, notify_at: optionalTime, webhook_at: optionalTime,
    http_status: z.number().int().min(100).max(599).optional(),
    processed_at: optionalTime, replied_at: optionalTime, failed: z.boolean().optional()
});
const stateSchema = z.object({
    state: z.enum(['unavailable', 'disconnected', 'awaiting_auth', 'qr', 'authenticating', 'syncing',
        'connected', 'reconnecting', 'degraded', 'invalid_session', 'auth_error']),
    socket: z.enum(['closed', 'starting', 'connecting', 'open', 'closing']).optional(),
    sync: z.enum(['pending', 'complete', 'unknown']).optional(),
    account: z.string().regex(/^\*{4}\d{4}$/).nullable().optional(),
    has_session: z.boolean().optional(),
    operation: z.enum(['pair', 'cancel', 'reconnect', 'unlink', 'probe']).nullable().optional(),
    pairing: z.boolean().optional(),
    qr: z.object({ image: z.string().max(200000).regex(/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/),
        expires_at: timestamp }).nullable().optional(),
    last_inbound: optionalTime, last_reply: optionalTime, last_n8n_ok: optionalTime, last_n8n_failure: optionalTime,
    n8n_configured: z.boolean().optional(),
    retries: z.number().int().nonnegative().optional(),
    events: z.array(z.object({
        event: z.enum(['socket_state','pending_notifications','reconnect_scheduled','socket_halted','auth_failed',
            'decrypt_failure','event_buffer_timeout','stream_error','pair_started','pair_cancelled','pair_saved',
            'unlinked','operation_failed','login_initialization_failed','sync_stalled']),
        at: timestamp, generation: z.number().int().nonnegative().optional(),
        code: z.number().int().min(100).max(599).optional()
    })).max(30).optional(),
    probe: probeSchema.nullable().optional()
});

const failures = {
    invalid_action: [400, 'Operação inválida.'],
    busy: [409, 'Aguarde a operação em andamento.'],
    replacement_required: [409, 'Confirme a substituição da sessão anterior.'],
    no_session: [409, 'Nenhuma sessão está vinculada.'],
    not_connected: [409, 'Conecte a sessão antes de realizar esta operação.'],
    unlink_uncertain: [409, 'O WhatsApp não confirmou a desvinculação. A sessão foi preservada.'],
    storage_failure: [503, 'Não foi possível preparar ou guardar a sessão. Confira o armazenamento.'],
    unavailable: [503, 'O serviço WhatsApp está indisponível.']
};

export class ControlError extends Error {
    constructor(code) {
        super(failures[code]?.[1] ?? failures.unavailable[1]);
        this.code = code;
        this.status = failures[code]?.[0] ?? 503;
    }
}

export function controlToken(env) {
    const token = env.WHATSAPP_CONTROL_TOKEN;
    if (typeof token !== 'string' || token.length < 32 || [env.WEBHOOK_TOKEN, env.N8N_WEBHOOK_TOKEN, env.CHAT_LAB_TOKEN].includes(token)) return null;
    return token;
}

export function hasControlToken(req, token) {
    const supplied = Buffer.from(req.get('x-galeto-wa-token') ?? '');
    const expected = Buffer.from(token ?? '');
    return expected.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function controlUrl(value) {
    const url = URL.parse(value ?? '');
    return url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash ? url : null;
}

const noStore = (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
const respondError = (res, error) => {
    const failure = error instanceof ControlError ? error : new ControlError('unavailable');
    return res.status(failure.status).json({ error: failure.message, code: failure.code });
};

function parseAction(body) {
    const parsed = controlAction.safeParse(body);
    if (!parsed.success) throw new ControlError('invalid_action');
    return parsed.data;
}

function actionLimit() {
    return rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-7', legacyHeaders: false,
        message: { error: 'Muitas operações. Aguarde um minuto.' } });
}

export function createWhatsAppControl(manager, token) {
    const router = Router();
    router.use(noStore, (req, res, next) => hasControlToken(req, token) ? next() : res.sendStatus(403));
    router.get('/state', (_req, res) => res.json(manager.state()));
    router.post('/actions', actionLimit(), express.json({ limit: '2kb' }), async (req, res) => {
        try {
            await manager.command(parseAction(req.body));
            res.json(manager.state());
        } catch (error) { respondError(res, error); }
    });
    router.use((error, _req, res, _next) => respondError(res,
        new ControlError(error?.type?.startsWith('entity.') ? 'invalid_action' : 'unavailable')));
    return router;
}

export function createWhatsAppAdmin({ auth, csrf, url, token, fetcher = fetch }) {
    const router = Router();
    router.use(noStore, auth);

    async function call(path, payload) {
        if (!token || !url) throw new ControlError('unavailable');
        try {
            const response = await fetcher(new URL(path, url), {
                method: payload ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
                headers: { 'X-Galeto-WA-Token': token, 'Content-Type': 'application/json' },
                body: payload && JSON.stringify(payload)
            });
            const value = await response.json();
            const safe = stateSchema.safeParse(value);
            if (response.ok && safe.success) return safe.data;
            if (response.status === 429) throw new ControlError('busy');
            if (Object.hasOwn(failures, value?.code)) throw new ControlError(value.code);
        } catch (error) {
            if (error instanceof ControlError) throw error;
        }
        throw new ControlError('unavailable');
    }

    router.get('/state', async (_req, res) => {
        try { res.json(await call('/state')); }
        catch { res.json({ state: 'unavailable' }); }
    });
    router.post('/actions', csrf, actionLimit(), async (req, res) => {
        try { res.json(await call('/actions', parseAction(req.body))); }
        catch (error) { respondError(res, error); }
    });
    return router;
}
