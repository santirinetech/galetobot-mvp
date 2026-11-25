import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { createBaileysLogger } from '../src/whatsapp/diagnostics.js';
import { createMessageHandler } from '../src/whatsapp/messages.js';
import { createSupervisor } from '../src/whatsapp/supervisor.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function setup({ beforeOpen, save, requestReply, retryLimit = 2 } = {}) {
    const sockets = [], logs = [], timeouts = new Map(), intervals = new Map();
    const counts = { active: 0, maxActive: 0, failed: 0, webhook: 0 };
    const clock = {
        setTimeout(fn, delay) { const key = Symbol(); timeouts.set(key, { fn, delay }); return key; },
        clearTimeout(key) { timeouts.delete(key); },
        setInterval(fn) { const key = Symbol(); intervals.set(key, fn); return key; },
        clearInterval(key) { intervals.delete(key); }
    };
    const supervisor = createSupervisor({
        reasons: DisconnectReason, retryLimit, random: () => 0, clock,
        log: (event, fields) => logs.push({ event, ...fields }),
        fail: () => counts.failed++,
        async open({ persist }) {
            await beforeOpen?.();
            counts.active++;
            counts.maxActive = Math.max(counts.active, counts.maxActive);
            const socket = {
                ev: new EventEmitter(), ws: new EventEmitter(), replies: [],
                saveCredentials: () => persist('credentials', save ?? (() => {})),
                setKeys: operation => persist('signal_keys', operation),
                async end() { counts.active--; },
                async sendMessage(jid, message) { this.replies.push([jid, message.text]); }
            };
            sockets.push(socket);
            return socket;
        },
        processMessages: createMessageHandler(async data => {
            counts.webhook++;
            return requestReply ? requestReply(data) : 'fixture reply';
        })
    });
    return {
        ...supervisor, sockets, logs, counts, timeouts,
        report: () => { for (const fn of intervals.values()) fn(); },
        async nextTimeout() {
            assert.equal(timeouts.size, 1);
            const [[key, { fn, delay }]] = timeouts;
            timeouts.delete(key);
            fn();
            await flush();
            return delay;
        }
    };
}

const disconnect = (socket, code) =>
    socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
const message = (jid, id, alt) => ({
    key: { remoteJid: jid, id, remoteJidAlt: alt }, message: { conversation: 'fixture message' }
});
const upsert = (socket, type, ...messages) => socket.ev.emit('messages.upsert', { type, messages });

test('serializes initialization, fences old callbacks and reconnects with increasing delays', async t => {
    const gate = deferred();
    const h = setup({ beforeOpen: () => gate.promise });
    t.after(h.stop);
    const first = h.start();
    const second = h.start();
    assert.equal(first, second);
    gate.resolve();
    await first;
    assert.equal(h.sockets.length, 1);

    const old = h.sockets[0];
    const staleConnection = old.ev.listeners('connection.update')[0];
    const staleUpsert = old.ev.listeners('messages.upsert')[0];
    disconnect(old, DisconnectReason.connectionLost);
    await flush();
    await h.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(await h.nextTimeout(), 500);
    staleConnection({ connection: 'open' });
    staleUpsert({ type: 'notify', messages: [message('1@lid', 'stale')] });
    assert.equal(h.counts.webhook, 0);
    assert.equal(old.ev.listenerCount('connection.update'), 0);
    assert.equal(old.ws.listenerCount('frame'), 0);

    disconnect(h.sockets[1], DisconnectReason.unavailableService);
    await flush();
    assert.equal(await h.nextTimeout(), 1000);
    disconnect(h.sockets[2], DisconnectReason.restartRequired);
    await flush();
    assert.equal(h.counts.maxActive, 1);
    assert.equal(h.counts.failed, 1);
    assert.equal(h.timeouts.size, 0);
});

test('shutdown drains credentials and Signal writes without replacing the session', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'galeto-auth-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, 'creds.json');
    const auth = await useMultiFileAuthState(dir);
    auth.state.creds.me = { id: 'fixture@s.whatsapp.net' };
    await auth.saveCreds();
    const original = await readFile(file, 'utf8');
    const gate = deferred();
    const h = setup({ save: async () => { await gate.promise; await auth.saveCreds(); } });
    await h.start();
    h.sockets[0].ev.emit('creds.update');
    const keyWrite = h.sockets[0].setKeys(async () => {
        await gate.promise;
        await auth.state.keys.set({ 'device-list': { fixture: ['0'] } });
    });
    let stopped = false;
    const stopping = h.stop().then(() => { stopped = true; });
    await flush();
    assert.equal(stopped, false);
    gate.resolve();
    await Promise.all([keyWrite, stopping]);
    assert.equal(await readFile(file, 'utf8'), original);
    const reopened = await useMultiFileAuthState(dir);
    assert.deepEqual(await reopened.state.keys.get('device-list', ['fixture']), { fixture: ['0'] });
    assert.equal(h.logs.filter(item => item.event === 'auth_saved').length, 2);
    assert.equal(h.timeouts.size, 0);
});

test('auth write failure halts the generation without leaking the error', async () => {
    const h = setup({ save: () => { throw new Error('fixture secret'); } });
    await h.start();
    h.sockets[0].ev.emit('creds.update');
    await flush();
    await h.stop();
    assert.equal(h.counts.failed, 1);
    assert.equal(h.timeouts.size, 0);
    assert.ok(h.logs.some(item => item.event === 'auth_failed'));
    assert.doesNotMatch(JSON.stringify(h.logs), /fixture secret/);
});

test('stopping during initialization closes the socket without attaching listeners or retrying', async () => {
    const gate = deferred();
    const h = setup({ beforeOpen: () => gate.promise });
    const opening = h.start();
    const stopping = h.stop();
    gate.resolve();
    await Promise.all([opening, stopping]);
    assert.equal(h.counts.active, 0);
    assert.equal(h.sockets[0].ev.eventNames().length, 0);
    assert.equal(h.timeouts.size, 0);
});

test('bounds connection setup and never reconnects an open socket due to idle traffic', async t => {
    const h = setup();
    t.after(h.stop);
    await h.start();
    assert.equal(await h.nextTimeout(), 45_000);
    assert.equal(await h.nextTimeout(), 500);
    h.sockets[1].ev.emit('connection.update', { connection: 'open' });
    for (let i = 0; i < 100; i++) h.report();
    assert.equal(h.timeouts.size, 0);
    assert.equal(h.counts.active, 1);
    assert.equal(h.counts.failed, 0);
});

test('QR, replacement and logout halt without retrying', async () => {
    for (const event of [{ qr: 'fixture qr' }, ...[401, 440, 403, 411].map(statusCode =>
        ({ connection: 'close', lastDisconnect: { error: { statusCode } } }))]) {
        const h = setup();
        await h.start();
        h.sockets[0].ev.emit('connection.update', event);
        await flush();
        await h.start();
        assert.equal(h.sockets.length, 1);
        assert.equal(h.counts.failed, 1);
        assert.equal(h.timeouts.size, 0);
        assert.doesNotMatch(JSON.stringify(h.logs), /fixture qr/);
    }
});

test('counts offline and live traffic, replies to LID/PN notify and ignores append and duplicate replies', async t => {
    const h = setup();
    t.after(h.stop);
    await h.start();
    const socket = h.sockets[0];
    socket.ws.emit('message', Buffer.from('fixture private'));
    socket.ws.emit('frame', { tag: 'message', attrs: { offline: '0', from: 'fixture private' } });
    socket.ws.emit('frame', { tag: 'iq' });
    socket.ws.emit('CB:ib,,offline_preview');
    socket.ws.emit('CB:ib,,offline');
    socket.ev.emit('connection.update', { connection: 'open', receivedPendingNotifications: true });
    h.report();
    assert.deepEqual(h.logs.find(item => item.event === 'transport_activity'), {
        event: 'transport_activity', generation: 1, state: 'open', offlineComplete: true,
        wsMessages: 1, frames: 2, messageNodes: 1, offlineNodes: 1, offlineZeroNodes: 1, offlinePreviews: 1, offlineEnds: 1
    });
    upsert(socket, 'append', message('1@lid', 'history'));
    upsert(socket, 'notify', message('1@lid', 'live', '2@s.whatsapp.net'));
    upsert(socket, 'notify', message('2@s.whatsapp.net', 'live'));
    upsert(socket, 'notify', message('3@s.whatsapp.net', 'another'));
    await flush();
    assert.equal(h.counts.webhook, 2);
    assert.deepEqual(socket.replies, [['1@lid', 'fixture reply'], ['3@s.whatsapp.net', 'fixture reply']]);
    assert.deepEqual(h.logs.filter(item => item.event === 'messages_upsert').map(item => item.type),
        ['append', 'notify', 'notify', 'notify']);
    assert.doesNotMatch(JSON.stringify(h.logs), /fixture|@lid|whatsapp\.net/);

    disconnect(socket, DisconnectReason.connectionLost);
    await flush();
    await h.nextTimeout();
    upsert(h.sockets[1], 'notify', message('2@s.whatsapp.net', 'live'));
    await flush();
    assert.equal(h.sockets[1].replies.length, 0);
});

test('a webhook completing after disconnect cannot send from the old socket', async t => {
    const gate = deferred();
    const h = setup({ requestReply: () => gate.promise });
    t.after(h.stop);
    await h.start();
    upsert(h.sockets[0], 'notify', message('1@lid', 'pending'));
    await flush();
    disconnect(h.sockets[0], DisconnectReason.connectionLost);
    await flush();
    await h.nextTimeout();
    gate.resolve('late reply');
    await flush();
    assert.equal(h.sockets[0].replies.length, 0);
});

test('retry after webhook failure, suppress duplicate after ambiguous send failure', async t => {
    let attempts = 0;
    const h = setup({ requestReply: async () => {
        if (++attempts === 1) throw new Error('webhook unavailable');
        return 'reply';
    } });
    t.after(h.stop);
    await h.start();
    const socket = h.sockets[0];
    let sends = 0;
    socket.sendMessage = async () => { sends++; throw new Error('send status unknown'); };
    for (let i = 0; i < 3; i++) {
        upsert(socket, 'notify', message('1@lid', 'one'));
        await flush();
    }
    assert.equal(attempts, 2);
    assert.equal(sends, 1);
});

test('Baileys logger emits only allowlisted categories from raw diagnostics', () => {
    const events = [];
    const logger = createBaileysLogger((event, fields) => events.push({ event, ...fields }), 'detailed');
    logger.error({ sender: 'fixture private', err: new Error('Bad MAC fixture secret') }, 'failed to decrypt message');
    logger.error({ err: new Error('fixture secret'), isSessionRecordError: true }, 'failed to decrypt message');
    logger.info('offline preview received', 'fixture secret');
    logger.warn('Buffer timeout reached, auto-flushing');
    logger.warn({ token: 'fixture secret' }, 'unexpected fixture secret');
    assert.deepEqual(events, [
        { event: 'decrypt_failure', category: 'integrity' },
        { event: 'decrypt_failure', category: 'missing_session' },
        { event: 'sync_progress', phase: 'offline_preview' },
        { event: 'event_buffer_timeout' }
    ]);
});
