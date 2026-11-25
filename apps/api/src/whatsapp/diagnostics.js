export function createBaileysLogger(emit, level) {
    const noop = () => {};
    function capture(first, second) {
        const message = typeof first === 'string' ? first : second;
        if (message === 'failed to decrypt message' || message === 'failed to process sender key distribution message') {
            const error = typeof first === 'object' ? first?.err?.message : '';
            let category = 'other';
            if (first?.isSessionRecordError || /no session/i.test(error ?? '')) category = 'missing_session';
            else if (/pre.?key/i.test(error ?? '')) category = 'prekey';
            else if (/bad mac|invalid mac|authentication tag/i.test(error ?? '')) category = 'integrity';
            else if (/counter|duplicate/i.test(error ?? '')) category = 'counter';
            emit('decrypt_failure', { category });
        } else if (message === 'Buffer timeout reached, auto-flushing') {
            emit('event_buffer_timeout');
        } else if (message === 'failed to run digest after login' || message === 'failed to send initial passive iq') {
            emit('login_initialization_failed', { stage: message === 'failed to run digest after login' ? 'key_digest' : 'activation' });
        } else if (message === 'stream errored out') {
            const attrs = first?.reasonNode?.attrs;
            emit('stream_error', { serverSyncAck: first?.reasonNode?.tag === 'ack' &&
                attrs?.class === 'notification' && attrs?.type === 'server_sync' });
        } else if (level === 'detailed' && typeof message === 'string') {
            const sync = offlinePhase(message);
            if (sync) emit('sync_progress', { phase: sync });
        }
    }
    const logger = { level: level === 'detailed' ? 'debug' : 'info', child: () => logger,
        trace: noop, debug: capture, info: capture, warn: capture, error: capture, fatal: capture };
    return logger;
}

function offlinePhase(message) {
    if (message === 'offline preview received') return 'offline_preview';
    if (/^handled \d+ offline messages\/notifications$/.test(message)) return 'offline_batch_done';
    if (message === 'Connection is now AwaitingInitialSync, buffering events') return 'awaiting_initial_sync';
    if (message === 'Doing app state sync') return 'app_state_sync';
    if (message === 'App state sync complete, transitioning to Online state and flushing buffer') return 'app_state_done';
}
