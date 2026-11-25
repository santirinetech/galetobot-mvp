import { hasControlToken } from './whatsapp-control.js';

export const probeCommand = 'diagnostico de conexao galetobot';
export const probeReply = 'Teste GaletoBot concluído. Nenhum pedido foi criado.';

export function isProbe(body) {
    return /^wa-probe:[a-f0-9]{16}$/.test(body.session_id) &&
        body.message_id === body.session_id.slice('wa-probe:'.length) && body.mensagem === probeCommand;
}

export function createWhatsAppAutomation(db) {
    const read = db.prepare('SELECT enabled,revision FROM whatsapp_automation WHERE id=1');
    const update = db.prepare(`INSERT INTO whatsapp_automation VALUES(1,?,1)
        ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,revision=whatsapp_automation.revision+1`);
    const audit = db.prepare('INSERT INTO audit(action,detail) VALUES (?,?)');
    function get() {
        const row = read.get();
        return { enabled: row ? Boolean(row.enabled) : true, revision: row?.revision ?? 0 };
    }
    const set = db.transaction((enabled, userId) => {
        if (enabled !== get().enabled) {
            update.run(Number(enabled));
            audit.run(enabled ? 'whatsapp_automation_resumed' : 'whatsapp_automation_paused', String(userId));
        }
        return get();
    }).immediate;
    return { get, set };
}

export function automationStatus(automation, token) {
    return (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!hasControlToken(req, token)) return res.sendStatus(403);
        return res.json(automation.get());
    };
}
