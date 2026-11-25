import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChatService } from '../src/chat-service.js';
import { createConversationService } from '../src/conversations.js';
import { initializeDatabase } from '../src/database.js';
import { createOrderService } from '../src/orders.js';
import { createStoreCheckout } from '../src/store.js';

function fixture(t, options) {
    const directory = mkdtempSync(join(tmpdir(), 'galeto-chat-'));
    const db = initializeDatabase({ databasePath: join(directory, 'test.db'), enableStore: true,
        allowCreate: true, email: 'chat@example.invalid', password: 'somente-teste-local' });
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    const orders = createOrderService(db, { enableStore: true });
    const checkout = createStoreCheckout(db, orders);
    const engine = createConversationService(db, orders, { checkout });
    return { db, chat: createChatService(db, engine, options) };
}

test('chat shares checkout and records one web order and pending Pix despite replay', t => {
    const { db, chat } = fixture(t);
    const row = chat.session(chat.create('web'), 'web');
    const send = (message, i, actions) => {
        assert.equal(chat.reserve(row, String(i), message).created, true);
        const body = { session_id: row.id, message_id: String(i), mensagem: message };
        assert.equal(chat.context(body).use_model, Boolean(actions));
        return chat.process({ ...body, interpretacao: actions && { actions } });
    };
    send('Quero galeto', 1, [{ type: 'add', value: 'galeto', quantity: 1 }]);
    send('retirada', 2);
    send('nome Cliente Teste', 3);
    send('telefone 11900000000', 4);
    send('Pix', 5);
    assert.equal(chat.view(row).cart.total_cents, 4500);
    const receipt = send('1', 6);
    assert.equal(chat.reserve(row, '6', '1').created, false);
    assert.deepEqual(chat.process({ session_id: row.id, message_id: '6', mensagem: '1' }), receipt);
    assert.deepEqual(db.prepare('SELECT source,status FROM orders').all(), [{ source: 'web-chat', status: 'pending' }]);
    assert.deepEqual(db.prepare('SELECT method,status FROM order_payments').all(), [{ method: 'Pix', status: 'pending' }]);
    assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 9);
    assert.equal(chat.view(row).cart.order_id, 1);
    assert.equal(chat.view(row).turns.some(turn => 'diagnostic' in turn), false);
});

test('protects scope, owner, environment, turn ordering and late callbacks', t => {
    let now = 100;
    const { chat, db } = fixture(t, { now: () => now, timeout: 10 });
    const other = fixture(t);
    const token = chat.create('lab', 'operator-1');
    assert.throws(() => chat.session(token, 'web'), { status: 404 });
    assert.throws(() => chat.session(token, 'lab', 'operator-2'), { status: 404 });
    assert.throws(() => other.chat.session(token, 'lab', 'operator-1'), { status: 404 });
    const row = chat.session(token, 'lab', 'operator-1');
    const body = { session_id: row.id, message_id: '1', mensagem: 'Quero galeto' };
    assert.throws(() => chat.context(body), { status: 404 });
    chat.reserve(row, '1', body.mensagem);
    assert.throws(() => chat.reserve(row, '2', 'resumo'), { code: 'turn_pending' });
    assert.throws(() => chat.reserve(row, '1', 'resumo'), { code: 'message_conflict' });
    assert.throws(() => chat.process(body), { code: 'context_missing' });
    chat.context(body);
    assert.throws(() => chat.process(body), { code: 'model_unavailable' });
    assert.equal(chat.view(row).turns[0].diagnostic.context, 'model_requested');
    chat.reserve(row, '2', 'resumo');
    now += 11;
    assert.throws(() => chat.context({ ...body, message_id: '2', mensagem: 'resumo' }), { code: 'turn_expired' });
    assert.equal(db.prepare('SELECT count(*) FROM orders').pluck().get(), 0);
});
