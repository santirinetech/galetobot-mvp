import crypto from 'node:crypto';
import { z } from 'zod';
import { interpretationSchema } from './commercial.js';
import { ChatError } from './chat-service.js';

function webCallback(chat, body, method, res, next) {
    if (!chat) return res.status(404).json({ error: 'Canal indisponível.' });
    try {
        return res.json(chat[method](body));
    } catch (error) {
        if (!(error instanceof ChatError)) return next(error);
        return res.status(error.status).json({ error: error.message, code: error.code });
    }
}

export function integrationAuth(req, res, next) {
    const expected = process.env.WEBHOOK_TOKEN;
    if (!expected || expected.startsWith('ALTERE_')) {
        return res.status(503).json({ error: 'Integração não configurada' });
    }
    const supplied = Buffer.from(req.get('x-integration-token') || '');
    const secret = Buffer.from(expected);
    if (supplied.length !== secret.length || !crypto.timingSafeEqual(supplied, secret)) {
        return res.status(401).json({ error: 'Não autorizado' });
    }
    next();
}

const session = z.string().min(1).max(200).regex(/^\S+$/u);
const messageSchema = z.object({
    session_id: session,
    message_id: z.string().min(1).max(200).regex(/^\S+$/u),
    mensagem: z.string().max(500).trim().min(1)
});
const commercialMessage = messageSchema.extend({ interpretacao: interpretationSchema.optional() });

export function conversationHandler(conversations, chat) {
    return (req, res, next) => {
        const parsed = commercialMessage.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Mensagem de conversa inválida' });
        if (parsed.data.session_id.startsWith('web:')) return webCallback(chat, parsed.data, 'process', res, next);
        if (parsed.data.interpretacao && !conversations.prepareMessage) {
            return res.status(503).json({ error: 'Atendimento comercial indisponível neste modo' });
        }
        return res.json(conversations.processMessage(parsed.data));
    };
}

export function contextHandler(conversations, chat) {
    return (req, res, next) => {
        const parsed = messageSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Mensagem de conversa inválida' });
        if (parsed.data.session_id.startsWith('web:')) return webCallback(chat, parsed.data, 'context', res, next);
        if (!conversations.prepareMessage) return res.status(503).json({ error: 'Atendimento comercial indisponível neste modo' });
        return res.json(conversations.prepareMessage(parsed.data));
    };
}

export function resumeHandler(conversations) {
    return (req, res) => {
        const parsed = z.object({ session_id: session }).safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Sessão inválida' });
        if (!conversations.resumeHandoff(parsed.data.session_id, req.userId)) {
            return res.status(404).json({ error: 'Não há transferência ativa para esta sessão' });
        }
        return res.json({ ok: true });
    };
}
