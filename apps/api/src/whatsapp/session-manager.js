import { ControlError } from '../whatsapp-control.js';
import { qrImage, qrLifetime } from './pairing-qr.js';

const pairLifetime = 5 * 60_000;
const historyEvents = new Set(['socket_state', 'pending_notifications', 'reconnect_scheduled', 'socket_halted', 'auth_failed',
    'decrypt_failure', 'event_buffer_timeout', 'stream_error', 'pair_started', 'pair_cancelled', 'pair_saved', 'unlinked',
    'operation_failed', 'login_initialization_failed', 'sync_stalled']);

function maskedAccount(jid) {
    const match = /^(\d{4,15})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
    return match ? '****' + match[1].slice(-4) : null;
}

export function createSessionManager({ vault, makeSupervisor, log = () => {}, renderQr = qrImage,
    probe, n8nConfigured = false, now = Date.now, clock = globalThis }) {
    let selected, supervisor, pairing, operation, shuttingDown = false, storageReady = false;
    let phase = 'disconnected', socket = 'closed', sync = 'unknown', retries = 0, account = null;
    let openAt = null, signalFailure = false, unhealthySync = false;
    const events = [];
    const timestamps = { last_inbound: null, last_reply: null, last_n8n_ok: null, last_n8n_failure: null };

    function record(event, fields = {}) {
        if (historyEvents.has(event)) {
            events.unshift({ event, at: now(), generation: fields.generation, code: fields.code });
            if (events.length > 30) events.pop();
        }
        log(event, fields);
    }

    function state() {
        if (socket === 'open' && sync !== 'complete' && openAt !== null && now() - openAt > 90_000 && !unhealthySync) {
            unhealthySync = true;
            record('sync_stalled');
        }
        const qr = pairing?.qr?.expires_at > now() ? pairing.qr : null;
        return {
            state: qr ? 'qr' : phase === 'qr' ? 'awaiting_auth' :
                (socket === 'open' && (unhealthySync || signalFailure) ? 'degraded' : phase),
            socket, sync, account, retries, pairing: Boolean(pairing), qr,
            has_session: Boolean(selected), operation: operation?.name ?? null, events: [...events],
            ...timestamps, n8n_configured: n8nConfigured, probe: probe?.state() ?? null
        };
    }

    async function stopSocket() {
        if (supervisor && !await supervisor.stop()) throw new ControlError('storage_failure');
        supervisor = null;
        socket = 'closed';
        sync = 'unknown';
    }

    async function restore() {
        if (shuttingDown) return;
        account = null;
        if (!selected) { phase = 'disconnected'; return; }
        try { account = maskedAccount(await vault.account(selected)); }
        catch { phase = 'invalid_session'; return; }
        await open(selected, false);
    }

    function onPairing({ qr, authenticated }) {
        if (!pairing || shuttingDown) return false;
        if (authenticated) {
            pairing.qr = null;
            pairing.authenticated = true;
            phase = 'authenticating';
            return true;
        }
        try {
            pairing.qr = { image: renderQr(qr), expires_at: now() + qrLifetime };
            phase = 'qr';
            return true;
        } catch {
            phase = 'auth_error';
            return false;
        }
    }

    function onSocketEvent(event, fields) {
        if (event === 'socket_state') {
            socket = fields.state;
            if (socket === 'starting') {
                sync = 'pending';
                signalFailure = false;
                unhealthySync = false;
                openAt = null;
                phase = pairing ? (pairing.authenticated ? 'authenticating' : 'awaiting_auth') : 'reconnecting';
            }
            if (socket === 'open') {
                openAt = now();
                phase = sync === 'complete' && !pairing ? 'connected' : 'syncing';
            }
        }
        if (event === 'pending_notifications') {
            sync = fields.complete ? 'complete' : 'pending';
            if (fields.complete) {
                unhealthySync = false;
                if (socket === 'open' && !pairing) phase = 'connected';
            }
        }
        if (event === 'decrypt_failure' || event === 'login_initialization_failed') signalFailure = true;
        if (event === 'inbound_message') {
            signalFailure = false;
            timestamps.last_inbound = now();
        }
        if (event === 'reply_sent') timestamps.last_reply = now();
        if (event === 'webhook_ok') timestamps.last_n8n_ok = now();
        if (event === 'webhook_failed' || (event === 'message_failed' && fields.stage === 'webhook')) {
            timestamps.last_n8n_failure = now();
        }
        if (event === 'reconnect_scheduled') {
            retries = fields.attempt;
            phase = 'reconnecting';
        }
        if (event === 'socket_halted') {
            phase = [401, 411, 440, 500].includes(fields.code) || fields.cause === 'pairing_required' ?
                'invalid_session' : fields.cause === 'auth_failure' || pairing ? 'auth_error' : 'degraded';
            if (pairing) pairing.qr = null;
        }
        record(event, fields);
        if (pairing?.authenticated && !pairing.promotionFailed && socket === 'open' && sync === 'complete' && !operation) promote();
    }

    async function open(directory, allowPairing) {
        if (shuttingDown) return;
        supervisor = makeSupervisor({ directory, allowPairing, onPairing, log: onSocketEvent,
            messagesAllowed: () => !shuttingDown && !pairing && selected === directory });
        retries = 0;
        await supervisor.start();
    }

    function finishPairing() {
        clock.clearTimeout(pairing.timer);
        pairing = null;
    }

    function promote() {
        const candidate = pairing;
        const socketOwner = supervisor;
        const work = Promise.resolve().then(async () => {
            if (!await socketOwner.flushWrites()) return;
            const jid = await vault.account(candidate.directory);
            if (socket !== 'open' || sync !== 'complete' || shuttingDown) return;
            await vault.setActive(candidate.directory);
            selected = candidate.directory;
            account = maskedAccount(jid);
            finishPairing();
            phase = 'connected';
            record('pair_saved');
        }).catch(() => {
            candidate.promotionFailed = true;
            phase = 'auth_error';
            record('operation_failed');
        }).finally(() => { operation = null; });
        operation = { name: 'pair', work };
    }

    async function run(action) {
        if (!storageReady) throw new ControlError('storage_failure');
        switch (action.action) {
        case 'probe':
            if (!probe || pairing || socket !== 'open') throw new ControlError('not_connected');
            probe.start(action.phone);
            return;
        case 'pair': {
            if (pairing) throw new ControlError('busy');
            if (selected && !action.replace) throw new ControlError('replacement_required');
            await stopSocket();
            try {
                if (selected) await vault.backup(selected);
                const directory = await vault.stage();
                pairing = { directory, authenticated: false, qr: null,
                    timer: clock.setTimeout(() => { void expirePairing(); }, pairLifetime) };
                account = null;
                phase = 'awaiting_auth';
                record('pair_started');
                await open(directory, true);
            } catch {
                if (pairing) finishPairing();
                await restore();
                throw new ControlError('storage_failure');
            }
            return;
        }
        case 'cancel':
            if (!pairing) return;
            await stopSocket();
            finishPairing();
            record('pair_cancelled');
            await restore();
            return;
        case 'reconnect':
            if (pairing) throw new ControlError('busy');
            if (!selected) throw new ControlError('no_session');
            await stopSocket();
            await restore();
            return;
        case 'unlink':
            if (pairing) throw new ControlError('busy');
            if (!selected) throw new ControlError('no_session');
            if (socket !== 'open') throw new ControlError('not_connected');
            try {
                if (!await supervisor.unlink()) throw new Error('No acknowledgement');
            } catch { throw new ControlError('unlink_uncertain'); }
            await stopSocket();
            try {
                await vault.backup(selected);
                await vault.setActive(null);
            } catch { phase = 'auth_error'; throw new ControlError('storage_failure'); }
            selected = null;
            account = null;
            phase = 'disconnected';
            record('unlinked');
            return;
        default:
            throw new ControlError('invalid_action');
        }
    }

    function command(action) {
        if (operation || shuttingDown) return Promise.reject(new ControlError('busy'));
        const work = Promise.resolve().then(() => run(action)).finally(() => {
            operation = null;
            if (pairing?.authenticated && !pairing.promotionFailed && socket === 'open' && sync === 'complete' && !shuttingDown) promote();
        });
        operation = { name: action.action, work };
        return work;
    }

    async function expirePairing() {
        try {
            await operation?.work.catch(() => {});
            if (pairing && !shuttingDown) await command({ action: 'cancel' });
        } catch { record('operation_failed'); }
    }

    async function start() {
        try {
            await vault.init();
            selected = await vault.readActive();
            storageReady = true;
            await restore();
        } catch {
            phase = 'invalid_session';
            record('operation_failed');
        }
    }

    async function shutdown() {
        shuttingDown = true;
        if (pairing) clock.clearTimeout(pairing.timer);
        await operation?.work.catch(() => {});
        await stopSocket();
    }

    return { start, shutdown, command, state };
}
