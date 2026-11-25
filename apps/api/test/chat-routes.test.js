import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

const origin = 'http://localhost:5173';
const secret = 'test-only-isolated-lab-token-00000';
const integration = 'fixture-integration-token';
const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
const email = 'operator@example.invalid';
const password = 'local-test-password';

async function instance(t, mode, labUrl = '') {
    let base, messages = 0;
    const webhook = createServer(async (req, res) => {
        try {
            messages++;
            const data = JSON.parse(Buffer.concat(await Array.fromAsync(req)));
            const send = async (suffix, payload) => fetch(base + '/api/integrations/conversation' + suffix, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-integration-token': integration },
                body: JSON.stringify(payload)
            });
            const pre = await send('/context', data);
            const context = await pre.json();
            if (!pre.ok || context.suppress) {
                res.writeHead(pre.status).end(JSON.stringify(context));
                return;
            }
            if (context.use_model && data.mensagem === 'Quero galeto') {
                data.interpretacao = { actions: [{ type: 'add', value: 'galeto', quantity: 1 }] };
            }
            const out = await send('', data);
            res.writeHead(out.status).end(await out.text());
        } catch { res.writeHead(502).end(); }
    });
    webhook.listen(0, '127.0.0.1');
    await once(webhook, 'listening');
    const directory = mkdtempSync(join(tmpdir(), 'galeto-http-chat-'));
    const filename = join(directory, 'chat.db');
    const child = spawn(process.execPath, [entry, '--test'], { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', DATABASE_PATH: filename, DATABASE_ALLOW_CREATE: '1',
        APP_ORIGIN: origin, ADMIN_EMAIL: email, ADMIN_PASSWORD: password, WEBHOOK_TOKEN: integration,
        CHAT_MODE: mode, CHAT_LAB_URL: labUrl, CHAT_LAB_TOKEN: secret, CHAT_HUMAN_CONTACT_URL: '',
        N8N_WEBHOOK_TOKEN: 'fixture-webhook', N8N_WEBHOOK_URL: 'http://127.0.0.1:' + webhook.address().port + '/webhook/fixture'
    } });
    const closed = once(child, 'close');
    t.after(async () => {
        child.kill();
        await closed;
        await new Promise(resolve => webhook.close(resolve));
        rmSync(directory, { recursive: true, force: true });
    });
    for await (const line of createInterface({ input: child.stdout })) {
        base = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (base) break;
    }
    assert.ok(base);
    return {
        base, get messages() { return messages; },
        count(table) {
            const db = new Database(filename, { readonly: true });
            try { return db.prepare('SELECT count(*) FROM ' + table).pluck().get(); } finally { db.close(); }
        },
        async request(path, body, cookie, requestOrigin = origin) {
            const response = await fetch(base + '/api' + path, {
                method: body === undefined ? 'GET' : 'POST',
                headers: { 'Content-Type': 'application/json', Origin: requestOrigin, ...(cookie && { Cookie: cookie }) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(7000)
            });
            const setCookie = response.headers.get('set-cookie');
            return { status: response.status, body: await response.json(), cookie: setCookie?.split(';')[0], setCookie };
        }
    };
}

test('lab authenticates admins and routes real checkout only to the configured demonstration database', { timeout: 15000 }, async t => {
    const demo = await instance(t, 'demo');
    const commercial = await instance(t, 'commercial', demo.base);
    const prefix = '/admin/ai-lab';
    assert.equal((await commercial.request(prefix + '/sessions', {})).status, 401);
    const admin = (await commercial.request('/login', { email, password })).cookie;
    assert.equal((await commercial.request(prefix + '/sessions', {}, admin, 'https://wrong.example')).status, 403);
    const session = await commercial.request(prefix + '/sessions', {}, admin);
    assert.equal(session.status, 201);
    assert.match(session.setCookie, /HttpOnly/i);
    const cookie = admin + '; ' + session.cookie;
    assert.equal((await demo.request('/integrations/ai-lab', { operation: 'create', owner: '1' })).status, 403);
    for (const mensagem of ['Quero galeto', 'retirada', 'nome Pessoa Teste', 'telefone 11900000000', 'Pix', '1']) {
        const result = await commercial.request(prefix + '/messages', { mensagem, message_id: randomUUID() }, cookie);
        assert.equal(result.status, 200);
        assert.ok(result.body.turns.at(-1).diagnostic);
    }
    assert.equal((await commercial.request(prefix + '/session', undefined, cookie)).body.cart.order_id, 1);
    assert.equal(commercial.messages, 0);
    assert.equal(demo.messages, 6);
    assert.equal(demo.count('orders'), 1);
    assert.equal(commercial.count('orders'), 0);
    assert.equal(commercial.count('chat_sessions'), 0);
});

test('public chat orders without Baileys, keeps cookies isolated and reports interpretation failure', { timeout: 15000 }, async t => {
    const site = await instance(t, 'demo');
    const prefix = '/chat';
    assert.equal((await site.request(prefix + '/availability')).body.available, true);
    assert.equal((await site.request(prefix + '/session')).status, 404);
    assert.equal((await site.request(prefix + '/sessions', {}, undefined, 'https://wrong.example')).status, 403);
    const first = await site.request(prefix + '/sessions', {});
    const second = await site.request(prefix + '/sessions', {});
    assert.equal(first.status, 201);
    assert.notEqual(first.cookie, second.cookie);
    const send = (mensagem, cookie = first.cookie, message_id = randomUUID()) => site.request(prefix + '/messages', { mensagem, message_id }, cookie);
    const fail = await send('fixture sem interpretacao');
    assert.equal(fail.status, 502);
    assert.equal(fail.body.code, 'model_unavailable');
    assert.equal((await site.request('/menu')).status, 200);
    assert.equal((await site.request(prefix + '/messages', { message_id: randomUUID(), mensagem: 'oi', session_id: 'web:fake' }, first.cookie)).status, 400);
    const added = await send('Quero galeto');
    assert.equal(added.body.cart.items.length, 1);
    assert.equal('diagnostic' in added.body.turns.at(-1), false);
    assert.equal((await site.request(prefix + '/session', undefined, second.cookie)).body.turns.length, 0);
    for (const text of ['retirada', 'nome Cliente Teste', 'telefone 11900000001', 'Cartão']) assert.equal((await send(text)).status, 200);
    const id = randomUUID();
    assert.equal((await send('Sim', first.cookie, id)).body.cart.order_id, 1);
    assert.equal((await send('Sim', first.cookie, id)).body.cart.order_id, 1);
    assert.equal(site.count('orders'), 1);
    for (const text of ['Quero galeto', 'retirada', 'nome Cliente Teste', 'telefone 11900000002', 'Dinheiro, troco para 60']) {
        assert.equal((await send(text, second.cookie)).status, 200);
    }
    assert.match((await site.request(prefix + '/session', undefined, second.cookie)).body.turns.at(-1).reply, /15,00/);
    assert.equal((await send('1', second.cookie)).body.cart.order_id, 2);
    assert.equal(site.count('order_payments'), 2);
    assert.equal(site.count('stock_movements'), 2);
    const handoff = await send('atendente', first.cookie);
    assert.equal(handoff.body.cart.state, 'HUMAN');
    assert.equal(handoff.body.contact, undefined);
    for (let i = 0; i < 8; i++) assert.equal((await site.request(prefix + '/sessions', {})).status, 201);
    assert.equal((await site.request(prefix + '/sessions', {})).status, 429);
});
