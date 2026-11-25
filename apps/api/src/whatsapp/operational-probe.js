import { randomBytes } from 'node:crypto';
import { ControlError } from '../whatsapp-control.js';
import { probeCommand, probeReply } from '../whatsapp-automation.js';

const lifetime = 3 * 60_000;

export function createWhatsAppProbe({ post, now = Date.now }) {
    let current;

    function start(phone) {
        if (current?.expires_at > now() && !current.replied_at && !current.failed) throw new ControlError('busy');
        const id = randomBytes(8).toString('hex');
        current = { id, phone, challenge: 'GALETO-TESTE ' + id.toUpperCase(), expires_at: now() + lifetime };
    }

    function state() {
        if (!current) return null;
        if (current.expires_at <= now()) delete current.phone;
        const { phone: _phone, id: _id, ...publicState } = current;
        return publicState;
    }

    async function handle({ jid, remoteJidAlt, text, signal, emit, send }) {
        if (!/^GALETO-TESTE\b/i.test(text)) return false;
        const test = current;
        if (!test || test.expires_at <= now() || test.received_at || text !== test.challenge ||
            ![jid, remoteJidAlt].some(address => /^(\d{10,15})(?::\d+)?@s\.whatsapp\.net$/.exec(address)?.[1] === test.phone)) return true;
        test.received_at = test.notify_at = now();
        try {
            const data = await post({
                session_id: 'wa-probe:' + test.id, message_id: test.id, mensagem: probeCommand
            }, signal, (event, fields) => {
                if (event === 'webhook_request') test.webhook_at = now();
                if (event === 'webhook_response') test.http_status = fields.status;
                emit(event, fields);
            });
            if (data?.resposta !== probeReply) throw new Error('Probe rejected');
            test.processed_at = now();
            emit('webhook_ok');
            if (current !== test || test.expires_at <= now() || !await send(probeReply)) throw new Error('Probe invalidated');
            test.replied_at = now();
            emit('reply_sent');
        } catch {
            if (!test.processed_at) emit('webhook_failed');
            test.failed = true;
        } finally {
            delete test.phone;
        }
        return true;
    }

    return { start, state, handle };
}
