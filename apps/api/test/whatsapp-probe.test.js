import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWhatsAppProbe } from '../src/whatsapp/operational-probe.js';
import { createMessageHandler } from '../src/whatsapp/messages.js';
import { isProbe, probeReply } from '../src/whatsapp-automation.js';

test('guided probe accepts only the expected private sender and nonce and replies once', async () => {
    const requests = [], replies = [];
    const probe = createWhatsAppProbe({ now: () => 1000, post: async (body, _signal, emit) => {
        requests.push(body);
        assert.equal(isProbe(body), true);
        emit('webhook_request');
        emit('webhook_response', { status: 200 });
        return { resposta: probeReply };
    } });
    probe.start('5511999999999');
    assert.throws(() => probe.start('5511999999999'), { code: 'busy' });
    const args = { jid: 'private-fixture@lid', text: probe.state().challenge,
        emit() {}, send: async text => { replies.push(text); return true; } };
    await probe.handle({ ...args, remoteJidAlt: '5511888888888@s.whatsapp.net' });
    assert.equal(requests.length, 0);
    const valid = { ...args, remoteJidAlt: '5511999999999@s.whatsapp.net' };
    await probe.handle(valid);
    await probe.handle(valid);
    assert.equal(requests.length, 1);
    assert.deepEqual(replies, [probeReply]);
    assert.equal(probe.state().http_status, 200);
    assert.equal(probe.state().processed_at, 1000);
    assert.equal(probe.state().replied_at, 1000);
    assert.doesNotMatch(JSON.stringify(probe.state()), /5511999999999|private-fixture/);
});

test('HTTP 200 alone is insufficient evidence to send the guide reply', async () => {
    const probe = createWhatsAppProbe({ post: async (_body, _signal, emit) => {
        emit('webhook_response', { status: 200 });
        return { resposta: 'Resposta fora do contrato' };
    } });
    probe.start('5511999999999');
    await probe.handle({ jid: '5511999999999@s.whatsapp.net', text: probe.state().challenge, emit() {},
        send: async () => assert.fail('unexpected send') });
    assert.equal(probe.state().failed, true);
    assert.equal(probe.state().processed_at, undefined);
});

test('pause blocks webhook traffic and revision changes discard an in-flight automated reply', async () => {
    let policy = { enabled: false, revision: 1 };
    let requested = 0;
    const handler = createMessageHandler(async () => {
        requested++;
        policy = { enabled: true, revision: 3 };
        return 'fixture reply';
    }, { checkAutomation: async () => policy });
    const socket = { sendMessage: async () => assert.fail('unexpected send') };
    const context = { active: () => true, emit() {} };
    const message = id => [{ key: { id, remoteJid: 'fixture@lid' }, message: { conversation: 'Olá' } }];
    await handler(socket, message('paused'), context);
    assert.equal(requested, 0);
    policy = { enabled: true, revision: 2 };
    await handler(socket, message('inflight'), context);
    assert.equal(requested, 1);
});
