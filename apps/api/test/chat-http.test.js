import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChatGateway, readChatConfig } from '../src/chat-http.js';
import { createChatService } from '../src/chat-service.js';
import { createConversationService } from '../src/conversations.js';
import { createOrderService } from '../src/orders.js';
import { initializeDatabase } from '../src/database.js';
import { createStoreCheckout } from '../src/store.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const options = { CHAT_MODE: 'demo', N8N_WEBHOOK_URL: 'https://n8n.example.invalid/webhook/test', N8N_WEBHOOK_TOKEN: 'fixture' };
test('web gateway uses original contract, verifies local callback, and recovers a lost response', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'galeto-gateway-'));
    const db = initializeDatabase({ databasePath: join(directory, 'test.db'), enableStore: true,
        allowCreate: true, email: 'chat@example.invalid', password: 'somente-teste-local' });
    t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
    const orders = createOrderService(db, { enableStore: true });
    const conversations = createConversationService(db, orders, { checkout: createStoreCheckout(db, orders) });
    const chat = createChatService(db, conversations);
    let requests = 0, execute, blocked;
    const gateway = createChatGateway(chat, readChatConfig(options), {
        fetcher: async (_url, req) => {
            requests++;
            const body = JSON.parse(req.body);
            assert.deepEqual(Object.keys(body).sort(), ['mensagem', 'message_id', 'session_id']);
            blocked = body;
            const context = execute && chat.context(body);
            if (context) chat.process({ ...body, interpretacao: context.use_model ?
                { actions: [{ type: 'add', value: 'galeto', quantity: 1 }] } : undefined });
            throw Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' });
        }
    });
    const token = gateway.create('web');
    const send = (mensagem, message_id = randomUUID()) => gateway.act('web', token, null, 'send', { mensagem, message_id });
    assert.equal(gateway.available(), true);
    await assert.rejects(send('Quero galeto'), { status: 504 });
    assert.equal(gateway.available(), false);
    assert.throws(() => chat.context(blocked), { code: 'turn_expired' });
    execute = true;
    await send('Quero galeto');
    assert.equal(gateway.available(), true);
    for (const text of ['retirada', 'nome Teste', 'telefone 11900000000', 'Pix']) await send(text);
    const messageId = randomUUID();
    const confirmed = await send('1', messageId);
    const replayed = await send('1', messageId);
    assert.equal(requests, 7);
    assert.equal(confirmed.cart.order_id, 1);
    assert.deepEqual(replayed, confirmed);
    assert.equal(db.prepare('SELECT count(*) FROM orders').pluck().get(), 1);
    assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 9);
    await assert.rejects(gateway.act('web', token, null, 'send', { message_id: randomUUID(), mensagem: 'oi', session_id: 'other' }),
        { code: 'invalid_message' });
});

test('chat config defaults off and requires a distinct isolated lab credential', () => {
    assert.equal(readChatConfig({}).mode, 'off');
    assert.throws(() => readChatConfig({ ...options, CHAT_MODE: 'commercial', CHAT_LAB_URL: 'https://demo.example.invalid' }));
    assert.throws(() => readChatConfig({ ...options, N8N_WEBHOOK_URL: 'https://n8n.example.invalid/webhook-test/test' }));
    assert.equal(readChatConfig({ ...options, CHAT_MODE: 'commercial', CHAT_LAB_URL: 'https://demo.example.invalid',
        CHAT_LAB_TOKEN: 'x'.repeat(32) }).lab.hostname, 'demo.example.invalid');
});

test('a model-only failure leaves deterministic chat available', async () => {
    const gateway = createChatGateway({
        session: () => ({ id: 'fixture' }),
        reserve: () => ({ created: true, turn: {} }),
        fail: () => {},
        result: () => ({ status: 'failed', error: 'model_unavailable' })
    }, readChatConfig(options), { fetcher: async () => new Response(null, { status: 200 }) });
    await assert.rejects(gateway.act('web', 'fixture', null, 'send', {
        message_id: randomUUID(), mensagem: 'Uma mensagem'
    }), { code: 'model_unavailable' });
    assert.equal(gateway.available(), true);
});
