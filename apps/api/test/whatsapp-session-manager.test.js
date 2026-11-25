import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSessionVault } from '../src/whatsapp/session-vault.js';
import { createSessionManager } from '../src/whatsapp/session-manager.js';
import { qrImage, qrLifetime } from '../src/whatsapp/pairing-qr.js';

async function fixture(t, stored) {
    const root = await mkdtemp(join(tmpdir(), 'galeto-wa-vault-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    if (stored !== undefined) await writeFile(join(root, 'creds.json'), stored);
    const vault = createSessionVault(root);
    const sockets = [];
    let now = 1000;
    let active = 0, max = 0, reply = false;
    const timers = new Set();
    const manager = createSessionManager({
        vault, now: () => now, renderQr: qrImage,
        clock: { setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) },
        makeSupervisor(options) {
            const socket = {
                ...options, active: false,
                async start() { active++; max = Math.max(active, max); socket.active = true; socket.log('socket_state', { state: 'starting' }); },
                async stop() { if (socket.active) { active--; socket.active = false; } return true; },
                flushWrites: async () => true,
                unlink: async () => reply
            };
            sockets.push(socket);
            return socket;
        }
    });
    t.after(() => manager.shutdown());
    await manager.start();
    return { root, vault, manager, sockets, advance: ms => { now += ms; },
        ack: () => { reply = true; }, max: () => max };
}

const credentials = id => JSON.stringify({ me: { id }, preKey: 'fixture-private-key' });
async function simulatePair(manager, socket) {
    socket.onPairing({ authenticated: true });
    assert.equal(manager.state().state, 'authenticating');
    await writeFile(join(socket.directory, 'creds.json'), credentials('5511900001234:2@s.whatsapp.net'));
    socket.log('reconnect_scheduled', { attempt: 1 });
    socket.log('socket_state', { state: 'starting' });
    socket.log('socket_state', { state: 'open' });
    assert.equal(manager.state().state, 'syncing');
    socket.log('pending_notifications', { complete: true });
    for (let i = 0; i < 100 && manager.state().pairing; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(manager.state().pairing, false);
}

test('fresh install waits for an explicit operation, rotates QR, expires it and promotes only after sync', async t => {
    const f = await fixture(t);
    assert.equal(f.manager.state().state, 'disconnected');
    assert.equal(f.sockets.length, 0);
    const pairing = f.manager.command({ action: 'pair' });
    await assert.rejects(f.manager.command({ action: 'pair' }), { code: 'busy' });
    await pairing;
    const socket = f.sockets[0];
    assert.equal(socket.allowPairing, true);
    assert.equal(f.manager.state().state, 'awaiting_auth');
    assert.equal(socket.onPairing({ qr: 'fake-first-challenge' }), true);
    const first = f.manager.state().qr;
    assert.match(first.image, /^data:image\/svg\+xml;base64,/);
    assert.doesNotMatch(Buffer.from(first.image.split(',')[1], 'base64').toString(), /fake-first-challenge/);
    socket.onPairing({ qr: 'fake-second-challenge' });
    assert.notEqual(f.manager.state().qr.image, first.image);
    f.advance(qrLifetime);
    assert.equal(f.manager.state().qr, null);
    assert.equal(f.manager.state().state, 'awaiting_auth');
    await simulatePair(f.manager, socket);
    assert.equal(await f.vault.readActive(), socket.directory);
    assert.equal(f.manager.state().account, '****1234');
    assert.equal(f.manager.state().state, 'connected');
    assert.doesNotMatch(JSON.stringify(f.manager.state()), /5511900001234|fixture-private-key/);
    await f.manager.shutdown();
    const reopened = createSessionVault(f.root);
    await reopened.init();
    assert.equal(await reopened.readActive(), socket.directory);
    assert.match(await reopened.account(socket.directory), /5511900001234/);
    assert.equal(f.max(), 1);
});

test('replacement requires confirmation and protected backup, cancellation restores old session', async t => {
    const old = credentials('5511900006789@s.whatsapp.net');
    const f = await fixture(t, old);
    await f.manager.start();
    assert.equal(f.sockets.length, 1);
    await assert.rejects(f.manager.command({ action: 'pair', replace: false }), { code: 'replacement_required' });
    await f.manager.command({ action: 'pair', replace: true });
    const backup = (await readdir(join(f.root, '.galeto'))).find(file => file.startsWith('backup-'));
    assert.equal(await readFile(join(f.root, '.galeto', backup, 'creds.json'), 'utf8'), old);
    assert.equal(await f.vault.readActive(), f.root);
    await f.manager.command({ action: 'cancel' });
    assert.equal(f.sockets.at(-1).directory, f.root);
    assert.equal(await readFile(join(f.root, 'creds.json'), 'utf8'), old);
    const reconnect = f.manager.command({ action: 'reconnect' });
    await assert.rejects(f.manager.command({ action: 'reconnect' }), { code: 'busy' });
    await reconnect;
    assert.equal(f.max(), 1);
});

test('invalid credentials are preserved, and an inconclusive unlink preserves the active slot', async t => {
    const bad = await fixture(t, '{invalid');
    assert.equal(bad.manager.state().state, 'invalid_session');
    assert.equal(await readFile(join(bad.root, 'creds.json'), 'utf8'), '{invalid');
    const f = await fixture(t, credentials('5511900006789@s.whatsapp.net'));
    const socket = f.sockets[0];
    socket.log('socket_state', { state: 'open' });
    socket.log('pending_notifications', { complete: true });
    await assert.rejects(f.manager.command({ action: 'unlink', confirm: true }), { code: 'unlink_uncertain' });
    assert.equal(await f.vault.readActive(), f.root);
    f.ack();
    await f.manager.command({ action: 'unlink', confirm: true });
    assert.equal(await f.vault.readActive(), null);
    assert.ok((await readdir(join(f.root, '.galeto'))).some(file => file.startsWith('backup-')));
    assert.equal(f.manager.state().state, 'disconnected');
});

test('open transport with stalled synchronization degrades, but completed synchronization stays healthy when idle', async t => {
    const f = await fixture(t, credentials('5511900006789@s.whatsapp.net'));
    const socket = f.sockets[0];
    socket.log('socket_state', { state: 'open' });
    assert.equal(f.manager.state().state, 'syncing');
    f.advance(90_001);
    assert.equal(f.manager.state().state, 'degraded');
    socket.log('pending_notifications', { complete: true });
    f.advance(24 * 60 * 60_000);
    assert.equal(f.manager.state().state, 'connected');
    assert.equal(f.manager.state().last_inbound, null);
});
