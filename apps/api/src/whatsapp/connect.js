import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import makeWASocket, {
    DEFAULT_CONNECTION_CONFIG, DisconnectReason, S_WHATSAPP_NET, useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { controlToken, controlUrl, createWhatsAppControl } from '../whatsapp-control.js';
import { createBaileysLogger } from './diagnostics.js';
import { createMessageHandler } from './messages.js';
import { qrLifetime } from './pairing-qr.js';
import { createWhatsAppProbe } from './operational-probe.js';
import { createSessionManager } from './session-manager.js';
import { createSessionVault } from './session-vault.js';
import { createSupervisor } from './supervisor.js';

dotenv.config({ path: new URL('../../../../.env', import.meta.url) });
process.umask(0o077);

const webhook = process.env.N8N_WEBHOOK_URL;
const token = process.env.N8N_WEBHOOK_TOKEN;
const protocol = process.env.WHATSAPP_PROTOCOL_MODE ?? 'bundled';
const diagnostics = process.env.WHATSAPP_DIAGNOSTICS ?? 'basic';
const session = process.env.WHATSAPP_SESSION_PATH ?? './whatsapp-session';
const management = controlToken(process.env);
const apiUrl = controlUrl(process.env.WHATSAPP_API_URL);
const managementPort = Number(process.env.WHATSAPP_CONTROL_PORT ?? 3002);
if (process.env.WHATSAPP_CONTROL_TOKEN && !management) throw new Error('Credencial de controle invalida.');

if ((!webhook || !token) && !management) throw new Error('Configure N8N_WEBHOOK_URL e N8N_WEBHOOK_TOKEN.');
let target;
if (webhook && token) {
    target = URL.parse(webhook);
    if (!target || !['http:', 'https:'].includes(target.protocol) || target.pathname.includes('/webhook-test/') ||
        target.username || target.password) {
        if (!management) throw new Error('Configure a URL HTTP(S) de producao do webhook.');
        target = null;
    }
}
if (!['bundled', 'queried'].includes(protocol) || !['basic', 'detailed'].includes(diagnostics)) {
    throw new Error('Configuracao de diagnostico ou protocolo invalida.');
}

function log(event, fields) {
    if (diagnostics === 'basic' && event === 'transport_activity' && !fields.messageNodes &&
        !fields.offlinePreviews && !fields.offlineEnds && fields.state === 'open') return;
    console.log(JSON.stringify({ component: 'whatsapp', event, ...fields }));
}

async function postWebhook(payload, signal, emit) {
    if (!target) throw new Error('Webhook indisponivel.');
    emit('webhook_request');
    const response = await fetch(target, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/json', 'X-GaletoBot-Token': token },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
    });
    emit('webhook_response', { status: response.status });
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Webhook rejeitado.');
    }
    return response.json();
}

async function checkAutomation(signal) {
    if (!apiUrl) return null;
    try {
        const result = await fetch(new URL('/api/integrations/whatsapp-control/automation', apiUrl), {
            headers: { 'X-Galeto-WA-Token': management }, redirect: 'error',
            signal: AbortSignal.any([signal, AbortSignal.timeout(2000)])
        });
        if (!result.ok) return null;
        const value = await result.json();
        return typeof value.enabled === 'boolean' && Number.isSafeInteger(value.revision) ? value : null;
    } catch { return null; }
}

const probe = createWhatsAppProbe({ post: postWebhook });
const processMessages = createMessageHandler(async ({ jid, id, text, signal, emit }) => {
    try {
        const data = await postWebhook({ session_id: jid, mensagem: text, message_id: id }, signal, emit);
        if (data?.suprimir_resposta === true && data.resposta === '') {
            emit('webhook_ok');
            return null;
        }
        if (typeof data?.resposta !== 'string' || !data.resposta.trim()) throw new Error('Resposta invalida.');
        emit('webhook_ok');
        return data.resposta;
    } catch (error) {
        emit('webhook_failed');
        throw error;
    }
}, {
    checkAutomation: management ? checkAutomation : undefined,
    handleProbe: management ? probe.handle : undefined
});

function makeSupervisor({ directory, allowPairing = false, onPairing, log: record = log, messagesAllowed = () => true }) {
    return createSupervisor({
    log: record, reasons: DisconnectReason, onPairing,
    processMessages: (socket, messages, context) => {
        if (messagesAllowed()) return processMessages(socket, messages, context);
    },
    connectMs: allowPairing ? 300_000 : undefined,
    fail: () => { if (!management) process.exitCode = 1; },
    async open({ persist, emit, signal }) {
        // Validate before the Baileys helper, which treats an unreadable file as absent.
        let auth;
        try {
            const file = await readFile(join(directory, 'creds.json'), 'utf8').catch(error => {
                if (allowPairing && error.code === 'ENOENT') return null;
                throw error;
            });
            const stored = file === null ? null : JSON.parse(file);
            if (file !== null && !stored?.me?.id) throw new Error('Sessao invalida.');
            auth = await useMultiFileAuthState(directory);
            if (stored && auth.state.creds.me?.id !== stored.me.id) throw new Error('Sessao indisponivel.');
        } catch {
            emit('auth_load_failed');
            throw new Error('Sessao indisponivel.');
        }
        const { state, saveCreds } = auth;
        const saveCredentials = () => persist('credentials', saveCreds);
        const setKeys = state.keys.set.bind(state.keys);
        state.keys.set = data => persist('signal_keys', () => setKeys(data));

        let version = DEFAULT_CONNECTION_CONFIG.version;
        let source = 'bundled';
        if (protocol === 'queried') {
            try {
                const result = await fetch('https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/index.ts', {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
                    redirect: 'error'
                });
                if (!result.ok) throw new Error();
                const match = (await result.text()).match(/^const version = \[(\d{1,4}),\s*(\d{1,8}),\s*(\d{1,12})\]/m);
                if (!match) throw new Error();
                version = match.slice(1).map(Number);
                source = 'queried';
            } catch {
                source = 'bundled_fallback';
            }
        }
        signal.throwIfAborted();
        emit('protocol_version', { source, version: version.join('.') });
        const logger = createBaileysLogger((event, fields) => {
            if (!signal.aborted) emit(event, fields);
        }, diagnostics);
        const socket = makeWASocket({ version, auth: state, logger, qrTimeout: qrLifetime });
        return {
            ev: socket.ev, ws: socket.ws, saveCredentials,
            async end() {
                await socket.end();
                if (socket.ws.isClosing && !socket.ws.isClosed) {
                    await new Promise(resolve => socket.ws.once('close', resolve));
                }
            },
            async confirmUnlink() {
                const jid = state.creds.me?.id;
                if (!jid) return false;
                const result = await socket.query({
                    tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'md' },
                    content: [{ tag: 'remove-companion-device', attrs: { jid, reason: 'user_initiated' } }]
                }, 4000);
                return result?.tag === 'iq' && result.attrs?.type === 'result';
            },
            sendMessage: (...args) => socket.sendMessage(...args)
        };
    }
    });
}

let shutdown;
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void shutdown?.().catch(() => { process.exitCode = 1; }); });
}
if (management) {
    const manager = createSessionManager({
        vault: createSessionVault(session), makeSupervisor, log, probe, n8nConfigured: Boolean(target)
    });
    const app = express();
    app.disable('x-powered-by');
    app.use(createWhatsAppControl(manager, management));
    let server, stopping = false;
    shutdown = async () => { stopping = true; server?.close(); await manager.shutdown(); };
    await manager.start();
    if (!stopping) server = app.listen(managementPort, process.env.WHATSAPP_CONTROL_HOST ?? '127.0.0.1');
} else {
    const supervisor = makeSupervisor({ directory: session });
    shutdown = supervisor.stop;
    await supervisor.start();
}
