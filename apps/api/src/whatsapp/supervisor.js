const settle = tasks => Promise.allSettled([...tasks]);

export function createSupervisor({ open, processMessages, log, fail, reasons,
    retryLimit = 6, stableMs = 300_000, connectMs = 45_000, reportMs = 30_000,
    random = Math.random, clock = globalThis, now = Date.now }) {
    let current;
    let transition;
    let retry;
    let stopping = false;
    let generation = 0;
    let attempts = 0;
    let badSessionRetries = 0;

    function start() {
        if (stopping || retry || (current && !transition)) return Promise.resolve();
        if (transition) return transition;
        const context = {
            generation: ++generation, state: 'starting', accepting: true, saving: true,
            writes: new Set(), abort: new AbortController(),
            activity: {
                wsMessages: 0, frames: 0, messageNodes: 0, offlineNodes: 0,
                offlineZeroNodes: 0, offlinePreviews: 0, offlineEnds: 0
            },
        };
        current = context;
        const emit = (event, fields = {}) => log(event, { generation: context.generation, ...fields });
        context.emit = emit;
        const active = () => current === context && context.accepting;
        function persist(kind, operation) {
            if (!context.saving) {
                const rejected = Promise.reject(new Error('Socket encerrado'));
                rejected.catch(() => {});
                return rejected;
            }
            const pending = Promise.resolve().then(operation);
            context.writes.add(pending);
            pending.then(() => {
                context.writes.delete(pending);
                emit('auth_saved', { kind });
            }, () => {
                context.writes.delete(pending);
                context.authFailed = true;
                emit('auth_failed', { kind });
                void close(context, 'auth_failure');
            });
            return pending;
        }

        transition = Promise.resolve().then(async () => {
            emit('socket_state', { state: context.state });
            context.socket = await open({ persist, emit, signal: context.abort.signal });
            if (!active()) return;
            const { ev, ws } = context.socket;
            const save = () => { void context.socket.saveCredentials(); };
            ev.on('creds.update', save);
            context.detachCredentials = () => ev.off('creds.update', save);
            const track = (emitter, name, listener) => {
                emitter.on(name, listener);
                (context.detach ??= []).push(() => emitter.off(name, listener));
            };

            track(ev, 'connection.update', update => {
                if (!active()) return;
                if (update.qr) {
                    void close(context, 'pairing_required');
                    return;
                }
                if (update.connection === 'close') {
                    const code = update.lastDisconnect?.error?.output?.statusCode ?? update.lastDisconnect?.error?.statusCode;
                    void close(context, 'disconnected', Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined);
                    return;
                }
                if (update.connection === 'connecting' || update.connection === 'open') {
                    context.state = update.connection;
                    emit('socket_state', { state: context.state });
                    if (context.state === 'open') clock.clearTimeout(context.deadline);
                }
                if (typeof update.receivedPendingNotifications === 'boolean') {
                    context.offlineComplete = update.receivedPendingNotifications;
                    emit('pending_notifications', { complete: context.offlineComplete });
                }
                if (context.state === 'open' && context.offlineComplete) context.stableSince ??= now();
            });
            track(ev, 'messages.upsert', ({ messages, type }) => {
                if (!active()) return;
                emit('messages_upsert', { type: type === 'notify' || type === 'append' ? type : 'other', count: messages.length });
                if (type !== 'notify') return;
                void Promise.resolve().then(() => processMessages(context.socket, messages, {
                    active, signal: context.abort.signal, emit
                })).catch(() => { if (active()) emit('message_handler_failed'); });
            });
            track(ev, 'messages.update', updates => {
                if (active()) emit('messages_update', { count: updates.length });
            });
            const frameSupported = typeof ws?.on === 'function' && typeof ws?.off === 'function';
            if (frameSupported) {
                track(ws, 'message', () => { if (active()) context.activity.wsMessages++; });
                track(ws, 'frame', frame => {
                    if (!active()) return;
                    context.activity.frames++;
                    if (frame?.tag === 'message') {
                        context.activity.messageNodes++;
                        if (frame.attrs?.offline) context.activity.offlineNodes++;
                        if (frame.attrs?.offline === '0') context.activity.offlineZeroNodes++;
                    }
                });
                track(ws, 'CB:ib,,offline_preview', () => { if (active()) context.activity.offlinePreviews++; });
                track(ws, 'CB:ib,,offline', () => { if (active()) context.activity.offlineEnds++; });
            }
            emit('transport_probe', { supported: frameSupported });
            context.report = clock.setInterval(() => report(context), reportMs);
            context.deadline = clock.setTimeout(() => { void close(context, 'connect_timeout'); }, connectMs);
        }).catch(() => {
            void close(context, 'startup_failure');
        }).finally(() => { transition = undefined; });
        return transition;
    }

    function report(context) {
        context.emit('transport_activity', { state: context.state, offlineComplete: context.offlineComplete ?? false,
            ...context.activity });
        for (const key of Object.keys(context.activity)) context.activity[key] = 0;
    }

    function close(context, cause, code, final = false) {
        if (current !== context) return Promise.resolve();
        if (context.closing) return context.closing;
        context.accepting = false;
        context.abort.abort();
        clock.clearTimeout(context.deadline);
        clock.clearInterval(context.report);
        const initialization = transition;
        context.closing = Promise.resolve().then(async () => {
            await initialization;
            report(context);
            context.state = 'closing';
            context.emit('socket_state', { state: context.state, cause, code });
            for (const detach of context.detach ?? []) detach();
            try {
                await context.socket?.end();
            } finally {
                context.detachCredentials?.();
                context.saving = false;
                await settle(context.writes);
            }
            current = undefined;
            context.emit('socket_state', { state: 'closed' });
            if (context.authFailed) {
                context.emit('socket_halted', { cause: 'auth_failure' });
                stopping = true;
                fail();
                return;
            }
            if (stopping || final) return;
            if (context.stableSince !== undefined && now() - context.stableSince >= stableMs) {
                attempts = 0;
                badSessionRetries = 0;
            }
            const transient = [reasons.connectionClosed, reasons.connectionLost, reasons.unavailableService,
                reasons.badSession, reasons.restartRequired].includes(code) || code === undefined;
            const repeatedBadSession = code === reasons.badSession && badSessionRetries++ > 0;
            if (cause === 'pairing_required' || !transient || attempts >= retryLimit || repeatedBadSession) {
                context.emit('socket_halted', { cause, code, attempts });
                stopping = true;
                fail();
                return;
            }
            const cap = Math.min(60_000, 1_000 * 2 ** attempts++);
            const delayMs = Math.round(cap * (0.5 + random() * 0.5));
            context.emit('reconnect_scheduled', { attempt: attempts, delayMs });
            retry = clock.setTimeout(() => {
                retry = undefined;
                void start();
            }, delayMs);
        }).catch(async () => {
            context.saving = false;
            await settle(context.writes);
            context.emit('socket_teardown_failed');
            stopping = true;
            fail();
        });
        return context.closing;
    }

    function stop() {
        stopping = true;
        clock.clearTimeout(retry);
        retry = undefined;
        return current ? close(current, 'shutdown', undefined, true) : Promise.resolve();
    }

    return { start, stop };
}
