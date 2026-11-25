import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { test } from 'node:test';
import { controlToken, controlUrl, createWhatsAppAdmin, createWhatsAppControl } from '../src/whatsapp-control.js';

const secret = 'somente-fixture-exclusiva-para-controle';
async function serve(t, router) {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return new URL('http://127.0.0.1:' + server.address().port);
}

test('WhatsApp control requires internal credentials, admin session, Origin and strictly validated actions', async t => {
    let executed = 0;
    const internal = await serve(t, createWhatsAppControl({
        state: () => ({ state: 'disconnected', token: 'fixture-sensitive' }),
        command: async () => { executed++; }
    }, secret));
    const auth = (req, res, next) => req.get('x-fixture-admin') ? next() : res.sendStatus(401);
    const csrf = (req, res, next) => req.get('origin') === 'http://fixture.local' ? next() : res.sendStatus(403);
    const admin = await serve(t, createWhatsAppAdmin({ auth, csrf, url: internal, token: secret }));
    assert.equal((await fetch(new URL('/state', internal))).status, 403);
    assert.equal((await fetch(new URL('/state', admin))).status, 401);
    const enabled = { 'x-fixture-admin': 'yes' };
    const state = await fetch(new URL('/state', admin), { headers: enabled });
    assert.equal(state.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await state.json(), { state: 'disconnected' });
    const action = (body, origin) => fetch(new URL('/actions', admin), {
        method: 'POST', headers: { ...enabled, origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal((await action({ action: 'pair' }, 'http://wrong.local')).status, 403);
    assert.equal((await action({ action: 'unlink' }, 'http://fixture.local')).status, 400);
    assert.equal((await action({ action: 'reconnect', command: 'ignored' }, 'http://fixture.local')).status, 400);
    assert.equal((await action({ action: 'reconnect' }, 'http://fixture.local')).status, 200);
    assert.equal(executed, 1);
});

test('control configuration refuses shared credentials and reports an unavailable service', async t => {
    assert.equal(controlToken({ WHATSAPP_CONTROL_TOKEN: secret, WEBHOOK_TOKEN: secret }), null);
    assert.equal(controlUrl('https://user:password@local.example'), null);
    const admin = await serve(t, createWhatsAppAdmin({
        auth: (_req, _res, next) => next(), csrf: (_req, _res, next) => next(),
        url: new URL('http://fixture.local'), token: secret, fetcher: async () => { throw new Error(secret); }
    }));
    const state = await fetch(new URL('/state', admin));
    assert.deepEqual(await state.json(), { state: 'unavailable' });
});

test('the WhatsApp process starts its authenticated control with an empty profile and no webhook', { timeout: 10000 }, async t => {
    const { spawn } = await import('node:child_process');
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { fileURLToPath } = await import('node:url');
    const { createInterface } = await import('node:readline');
    const directory = await mkdtemp(join(tmpdir(), 'galeto-empty-wa-'));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/whatsapp/connect.js', import.meta.url))], {
        cwd: directory, stdio: ['ignore', 'pipe', 'pipe'], env: {
            ...process.env, WHATSAPP_SESSION_PATH: directory,
            WHATSAPP_CONTROL_HOST: '127.0.0.1', WHATSAPP_CONTROL_PORT: '0', WHATSAPP_CONTROL_TOKEN: secret,
            WHATSAPP_DIAGNOSTICS: 'basic', WHATSAPP_PROTOCOL_MODE: 'bundled',
            N8N_WEBHOOK_URL: '', N8N_WEBHOOK_TOKEN: '', WEBHOOK_TOKEN: '', CHAT_LAB_TOKEN: '', WHATSAPP_API_URL: ''
        }
    });
    const closed = once(child, 'close');
    t.after(async () => {
        child.kill();
        await closed;
        await rm(directory, { recursive: true, force: true });
    });
    let port;
    for await (const line of createInterface({ input: child.stdout })) {
        const ready = JSON.parse(line);
        if (ready.event === 'whatsapp_control_ready') { port = ready.port; break; }
    }
    assert.ok(port);
    const response = await fetch('http://127.0.0.1:' + port + '/state', { headers: { 'x-galeto-wa-token': secret } });
    const state = await response.json();
    assert.equal(state.state, 'disconnected');
    assert.equal(state.has_session, false);
    assert.equal(state.n8n_configured, false);
    assert.equal(state.qr, null);
});
