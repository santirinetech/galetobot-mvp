import { readFile } from 'node:fs/promises';
import dotenv from 'dotenv';
import makeWASocket, {
    DEFAULT_CONNECTION_CONFIG, DisconnectReason, useMultiFileAuthState
} from '@whiskeysockets/baileys';
import { createBaileysLogger } from './diagnostics.js';
import { createMessageHandler } from './messages.js';
import { createSupervisor } from './supervisor.js';

dotenv.config({ path: new URL('../../../../.env', import.meta.url) });

const webhook = process.env.N8N_WEBHOOK_URL;
const token = process.env.N8N_WEBHOOK_TOKEN;
const protocol = process.env.WHATSAPP_PROTOCOL_MODE ?? 'bundled';
const diagnostics = process.env.WHATSAPP_DIAGNOSTICS ?? 'basic';
const session = './whatsapp-session';

if (!webhook || !token) throw new Error('Configure N8N_WEBHOOK_URL e N8N_WEBHOOK_TOKEN.');
let target;
try {
    target = new URL(webhook);
} catch {
    throw new Error('N8N_WEBHOOK_URL invalida.');
}
if (!['http:', 'https:'].includes(target.protocol) || target.pathname.includes('/webhook-test/')) {
    throw new Error('Configure a URL HTTP(S) de producao do webhook.');
}
if (!['bundled', 'queried'].includes(protocol) || !['basic', 'detailed'].includes(diagnostics)) {
    throw new Error('Configuracao de diagnostico ou protocolo invalida.');
}

function log(event, fields) {
    if (diagnostics === 'basic' && event === 'transport_activity' && !fields.messageNodes &&
        !fields.offlinePreviews && !fields.offlineEnds && fields.state === 'open') return;
    console.log(JSON.stringify({ component: 'whatsapp', event, ...fields }));
}

const supervisor = createSupervisor({
    log, reasons: DisconnectReason,
    fail: () => { process.exitCode = 1; },
    async open({ persist, emit, signal }) {
        // Validate before the Baileys helper, which treats an unreadable file as absent.
        let auth;
        try {
            const stored = JSON.parse(await readFile(`${session}/creds.json`, 'utf8'));
            if (!stored?.me?.id) throw new Error('Sessao invalida.');
            auth = await useMultiFileAuthState(session);
            if (auth.state.creds.me?.id !== stored.me.id) throw new Error('Sessao indisponivel.');
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
        const socket = makeWASocket({ version, auth: state, logger });
        return {
            ev: socket.ev, ws: socket.ws, saveCredentials,
            async end() {
                await socket.end();
                if (socket.ws.isClosing && !socket.ws.isClosed) {
                    await new Promise(resolve => socket.ws.once('close', resolve));
                }
            },
            sendMessage: (...args) => socket.sendMessage(...args)
        };
    },
    processMessages: createMessageHandler(async ({ jid, id, text, signal, emit }) => {
        emit('webhook_request');
        const response = await fetch(target, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'Content-Type': 'application/json', 'X-GaletoBot-Token': token },
            body: JSON.stringify({ session_id: jid, mensagem: text, message_id: id }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15000)])
        });
        emit('webhook_response', { status: response.status });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new Error('Webhook rejeitado.');
        }
        const data = await response.json();
        if (data?.suprimir_resposta === true && data.resposta === '') return null;
        if (typeof data?.resposta !== 'string' || !data.resposta.trim()) throw new Error('Resposta invalida.');
        return data.resposta;
    })
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void supervisor.stop(); });
}
void supervisor.start();
