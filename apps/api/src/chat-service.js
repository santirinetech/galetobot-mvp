import { createHash, randomBytes, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
export const chatLifetime = 60 * 60 * 1000;
export class ChatError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const missing = () => new ChatError(404, 'session_missing', 'Conversa inexistente ou expirada.');
const busy = () => new ChatError(409, 'turn_pending', 'Uma mensagem ainda está sendo processada.');
const modelFailure = Symbol('model failure');

export function createChatService(db, conversations, { now = Date.now, timeout = 15_000 } = {}) {
    const getSession = db.prepare('SELECT * FROM chat_sessions WHERE id=? AND expires_at>?');
    const findSession = db.prepare('SELECT * FROM chat_sessions WHERE token_hash=? AND scope=? AND owner IS ? AND expires_at>?');
    const insertSession = db.prepare('INSERT INTO chat_sessions VALUES (?,?,?,?,?)');
    const turnById = db.prepare('SELECT * FROM chat_turns WHERE session_id=? AND message_id=?');
    const finishTurn = db.prepare("UPDATE chat_turns SET status=?,error=?,applied_at=? WHERE seq=? AND status='pending'");
    const recordContext = db.prepare('UPDATE chat_turns SET context=? WHERE seq=? AND context IS NULL');
    const oldTurns = db.prepare('SELECT * FROM chat_turns WHERE session_id=? ORDER BY seq DESC LIMIT 100');
    const expireTurns = db.prepare("UPDATE chat_turns SET status='failed',error='timeout' WHERE session_id=? AND status='pending' AND deadline<=?");
    const countTurns = db.prepare('SELECT count(*) FROM chat_turns WHERE session_id=?').pluck();
    const pendingTurn = db.prepare("SELECT 1 FROM chat_turns WHERE session_id=? AND status='pending'");
    const addTurn = db.prepare("INSERT INTO chat_turns(session_id,message_id,message,created_at,deadline,status) VALUES(?,?,?,?,?,'pending')");

    function create(scope, owner = null) {
        const token = randomBytes(32).toString('hex');
        const id = 'web:' + randomUUID();
        insertSession.run(id, digest(token), scope, owner, now() + chatLifetime);
        return token;
    }

    function session(token, scope, owner = null) {
        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw missing();
        const row = findSession.get(digest(token), scope, owner, now());
        if (!row) throw missing();
        return row;
    }

    function guard(body) {
        if (!getSession.get(body.session_id, now())) throw missing();
        const turn = turnById.get(body.session_id, body.message_id);
        if (!turn || turn.message !== body.mensagem) throw missing();
        if (turn.status === 'failed' || (turn.status === 'pending' && turn.deadline <= now())) {
            throw new ChatError(409, 'turn_expired', 'O prazo desta mensagem expirou.');
        }
        return turn;
    }

    const reserve = db.transaction((row, messageId, message) => {
        if (!getSession.get(row.id, now())) throw missing();
        expireTurns.run(row.id, now());
        const existing = turnById.get(row.id, messageId);
        if (existing) {
            if (existing.message !== message) throw new ChatError(409, 'message_conflict', 'Identificador já utilizado.');
            return { turn: existing, created: false };
        }
        if (pendingTurn.get(row.id)) throw busy();
        if (countTurns.get(row.id) >= 100) throw new ChatError(429, 'session_limit', 'Limite da conversa atingido. Inicie outra conversa.');
        addTurn.run(row.id, messageId, message, now(), now() + timeout);
        return { turn: turnById.get(row.id, messageId), created: true };
    }).immediate;

    const context = db.transaction(body => {
        const turn = guard(body);
        const prepared = conversations.prepareMessage(body);
        recordContext.run(Number(prepared.use_model), turn.seq);
        if (prepared.suppress) finishTurn.run('done', null, null, turn.seq);
        return prepared;
    }).immediate;

    const apply = db.transaction(body => {
        const turn = guard(body);
        if (turn.status === 'done') return conversations.readResponse(body.session_id, body.message_id);
        if (turn.context === null) throw new ChatError(409, 'context_missing', 'Contexto da mensagem indisponível.');
        if (turn.context === 1 && !body.interpretacao) {
            finishTurn.run('failed', 'model_unavailable', now(), turn.seq);
            return modelFailure;
        }
        const result = conversations.processMessage({ ...body, interpretacao: turn.context ? body.interpretacao : undefined }, 'web-chat');
        finishTurn.run('done', null, now(), turn.seq);
        return result;
    }).immediate;
    function process(body) {
        const result = apply(body);
        if (result === modelFailure) throw new ChatError(502, 'model_unavailable', 'O serviço de interpretação não devolveu ações válidas.');
        return result;
    }

    function view(row) {
        if (!getSession.get(row.id, now())) throw missing();
        expireTurns.run(row.id, now());
        const display = oldTurns.all(row.id).reverse().map(turn => ({
            message_id: turn.message_id, message: turn.message, created_at: turn.created_at, status: turn.status,
            error: turn.error,
            reply: turn.status === 'done' ? conversations.readResponse(row.id, turn.message_id)?.resposta ?? '' : '',
            ...(row.scope === 'lab' ? { diagnostic: {
                context: turn.context === null ? null : turn.context === 1 ? 'model_requested' : 'deterministic',
                applied: turn.status === 'done' && turn.applied_at !== null,
                duration_ms: turn.applied_at === null ? null : turn.applied_at - turn.created_at
            }} : {})
        }));
        return { conversation_id: row.id.slice(4), expires_at: row.expires_at, turns: display, cart: conversations.view(row.id) };
    }

    const clean = db.transaction(() => {
        const expired = 'SELECT id FROM chat_sessions WHERE expires_at<=?';
        for (const table of ['conversation_carts', 'conversation_messages', 'conversation_confirmations', 'conversation_handoffs']) {
            db.prepare(`DELETE FROM ${table} WHERE session_id IN (${expired})`).run(now());
        }
        db.prepare('DELETE FROM chat_sessions WHERE expires_at<=?').run(now());
    }).immediate;

    return { create, session, reserve, context, process, view, clean,
        fail: (turn, error) => finishTurn.run('failed', error, now(), turn.seq),
        result: (row, id) => turnById.get(row.id, id) };
}
