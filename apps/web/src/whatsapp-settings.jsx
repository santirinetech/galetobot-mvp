import React, { useEffect, useRef, useState } from 'react';
import { Link2, Link2Off, Pause, Play, Radio, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from './client.js';
import { Badge, Dialog, Loading, Notice, formatDate } from './ui.jsx';
import './whatsapp-settings.css';

const base = '/admin/whatsapp';
const labels = {
    unavailable: 'Serviço indisponível', disconnected: 'Desconectado', awaiting_auth: 'Aguardando autenticação',
    qr: 'QR Code disponível', authenticating: 'Autenticando', syncing: 'Sincronizando', connected: 'Conectado',
    reconnecting: 'Reconectando', degraded: 'Conexão degradada', invalid_session: 'Sessão inválida',
    auth_error: 'Erro de autenticação'
};
const details = {
    unavailable: 'Confira se o serviço WhatsApp foi habilitado na instalação.',
    disconnected: 'Vincule uma conta para atender pelo WhatsApp.',
    awaiting_auth: 'Aguardando o WhatsApp emitir o próximo QR Code.',
    qr: 'Abra Aparelhos conectados no WhatsApp do telefone e escaneie o QR Code.',
    authenticating: 'A conta está sendo validada. Aguarde a sincronização.',
    syncing: 'O transporte está aberto. Aguardando confirmação da sincronização inicial.',
    connected: 'A sincronização inicial foi concluída. Use o teste guiado para verificar a entrega de mensagens.',
    reconnecting: 'A sessão salva está sendo reutilizada.',
    degraded: 'Confira a sincronização e execute o teste guiado. A conexão pode estar aberta sem receber mensagens.',
    invalid_session: 'A sessão foi preservada. Tente reconectar ou confirme um novo pareamento.',
    auth_error: 'Não foi possível concluir a autenticação. Confira o armazenamento ou cancele o pareamento.'
};
const eventLabels = {
    socket_state: 'Estado do socket alterado', pending_notifications: 'Sinal de sincronização recebido',
    reconnect_scheduled: 'Reconexão agendada', socket_halted: 'Tentativas interrompidas',
    auth_failed: 'Falha ao guardar a sessão', decrypt_failure: 'Falha de descriptografia',
    event_buffer_timeout: 'Tempo de buffer excedido', stream_error: 'Falha no fluxo do WhatsApp',
    pair_started: 'Pareamento iniciado', pair_cancelled: 'Pareamento encerrado sem substituir a sessão',
    pair_saved: 'Nova sessão ativada', unlinked: 'Desvinculação confirmada',
    operation_failed: 'Operação incompleta', login_initialization_failed: 'Falha na inicialização da sessão',
    sync_stalled: 'Sincronização ainda sem confirmação'
};
const socketLabels = { closed: 'Fechado', starting: 'Iniciando', connecting: 'Conectando', open: 'Aberto', closing: 'Encerrando' };
const syncLabels = { unknown: 'Sem confirmação', pending: 'Em andamento', complete: 'Concluída' };
const at = timestamp => timestamp == null ? 'Sem registro' : formatDate(new Date(timestamp).toISOString(), { dateStyle: 'short', timeStyle: 'medium' });

function Probe({ result, now, disabled, execute }) {
    const [phone, setPhone] = useState('');
    const expired = result && result.expires_at <= now;
    const finished = result?.failed || result?.replied_at != null;
    const steps = result ? [
        ['Mensagem recebida', result.received_at],
        ['Evento notify observado', result.notify_at],
        ['Solicitação enviada ao n8n', result.webhook_at],
        ['Retorno HTTP', result.http_status, result.http_status ? 'HTTP ' + result.http_status : null],
        ['API confirmou o teste', result.processed_at],
        ['Resposta enviada pelo adaptador', result.replied_at]
    ] : [];
    return <section className="wa-probe">
        <h3>Teste guiado</h3>
        <p>Use outro número autorizado. O teste não cria pedidos nem solicita interpretação ao Gemini.</p>
        <form onSubmit={e => {
            e.preventDefault();
            const number = phone.replace(/\D/g, '');
            if (/^\d{10,15}$/.test(number)) {
                execute({ action: 'probe', phone: number });
                setPhone('');
            }
        }}>
            <label>Número de teste, com código do país
                <input type="tel" inputMode="tel" maxLength={28} value={phone} onChange={e => setPhone(e.target.value)} />
            </label>
            <button className="secondary" disabled={disabled || (result && !expired && !finished) ||
                !/^\d{10,15}$/.test(phone.replace(/\D/g, ''))}>Iniciar verificação</button>
        </form>
        {result && <div className="wa-probe-result">
            {!expired && !finished && <p>Do número informado, envie <code>{result.challenge}</code> para esta conta.</p>}
            <ol>{steps.map(([label, seen, hint]) => <li key={label}>
                {label} <Badge tone={seen != null ? 'success' : 'neutral'}>{hint ?? (seen != null ? 'Observado' : 'Aguardando')}</Badge>
            </li>)}</ol>
            {expired && !finished && <Notice kind="warning">{result.received_at == null ?
                'A mensagem não chegou ao adaptador. Confira o número com código do país, a conversa direta e o término da sincronização.' :
                'O teste expirou. Confira a primeira etapa sem evidência e tente novamente.'}</Notice>}
            {result.failed && <Notice>{result.webhook_at == null ? 'O teste parou antes da chamada ao n8n. Confira a configuração da integração.' :
                result.processed_at == null ? 'O n8n não devolveu a confirmação esperada da API. Confira o destino e o fluxo.' :
                'O teste chegou à API, mas o envio pelo WhatsApp não foi confirmado.'}</Notice>}
        </div>}
    </section>;
}

export function WhatsAppSettings() {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState(null);
    const [now, setNow] = useState(Date.now);
    const sequence = useRef(0);
    const running = useRef(false);

    async function refresh() {
        const version = ++sequence.current;
        try {
            const next = await api(base + '/state');
            if (version === sequence.current) {
                setNow(Date.now());
                setData(next);
            }
        } catch (err) {
            if (version === sequence.current) {
                setData({ state: 'unavailable' });
                setError(err.message);
            }
        }
    }

    useEffect(() => {
        let active = true;
        let timer;
        async function poll() {
            if (!running.current) await refresh();
            if (active) timer = setTimeout(poll, 3000);
        }
        poll();
        return () => { active = false; clearTimeout(timer); sequence.current++; };
    }, []);

    const timed = Boolean(data?.qr || data?.probe);
    useEffect(() => {
        if (!timed) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [timed]);

    async function execute(command) {
        if (running.current) return;
        running.current = true;
        sequence.current++;
        setBusy(true);
        setError('');
        try {
            if ('enabled' in command) await api(base + '/automation', { method: 'PATCH', body: command });
            else await api(base + '/actions', { method: 'POST', body: command });
        } catch (err) { setError(err.message); }
        finally { await refresh(); running.current = false; setBusy(false); }
    }

    const state = data?.state;
    const available = state && state !== 'unavailable';
    const locked = busy || Boolean(data?.operation);
    const qr = data?.qr?.expires_at > now ? data.qr : null;
    const displayState = state === 'qr' && !qr ? 'awaiting_auth' : state;
    const automation = data?.automation;

    return <section className="panel wa-settings" aria-busy={locked}>
        <header className="wa-heading">
            <div><h2><Radio size={22} aria-hidden="true" /> Conexão WhatsApp</h2><p>{details[displayState] ?? 'Consultando o serviço interno.'}</p></div>
            {state && <Badge tone={state === 'connected' ? 'success' : available ? 'warning' : 'neutral'}>{labels[displayState]}</Badge>}
        </header>
        {error && <Notice>{error}</Notice>}
        {!data && <Loading>Consultando a conexão…</Loading>}
        {data && <>
            <dl className="wa-facts">
                <div><dt>Conta vinculada</dt><dd>{data.account ?? (data.has_session ? 'Identificação indisponível' : '—')}</dd></div>
                <div><dt>Sincronização</dt><dd>{syncLabels[data.sync] ?? 'Sem confirmação'}</dd></div>
                <div><dt>Integração n8n</dt><dd>{data.n8n_configured === false ? 'Não configurada' :
                    data.last_n8n_failure != null && data.last_n8n_failure > (data.last_n8n_ok ?? -1) ? 'Falha na última tentativa' :
                    data.last_n8n_ok ? 'Última tentativa bem-sucedida' : 'Sem verificação'}</dd></div>
                {automation && <div><dt>Automação no WhatsApp</dt><dd>{automation.enabled ? 'Ativa' : 'Pausada'}</dd></div>}
            </dl>
            <div className="wa-actions">
                {available && (data.pairing ?
                    <button className="secondary" disabled={locked} onClick={() => execute({ action: 'cancel' })}>Cancelar pareamento</button> :
                    <button className="wa-primary" disabled={locked} onClick={() => data.has_session ? setConfirm('pair') : execute({ action: 'pair' })}>
                        <Link2 size={16} aria-hidden="true" /> {data.has_session ? 'Vincular novamente' : 'Vincular conta'}
                    </button>)}
                {available && data.has_session && !data.pairing && <>
                    <button className="secondary" disabled={locked} onClick={() => execute({ action: 'reconnect' })}>
                        <RefreshCw size={16} aria-hidden="true" /> Reconectar
                    </button>
                    <button className="secondary" disabled={locked || data.socket !== 'open'} onClick={() => setConfirm('unlink')}>
                        <Link2Off size={16} aria-hidden="true" /> Desvincular
                    </button>
                </>}
                {automation && <button className="secondary" disabled={locked} onClick={() => execute({ enabled: !automation.enabled })}>
                    {automation.enabled ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                    {automation.enabled ? 'Pausar automação' : 'Retomar automação'}
                </button>}
            </div>
            {qr && <figure className="wa-qr">
                <img src={qr.image} alt="QR Code temporário para vincular a conta WhatsApp" />
                <figcaption>Expira em {Math.max(0, Math.ceil((qr.expires_at - now) / 1000))} s. O código será atualizado automaticamente.</figcaption>
            </figure>}
            {available && <details className="wa-advanced">
                <summary><ShieldCheck size={18} aria-hidden="true" /> Diagnóstico e eventos</summary>
                <Probe result={data.probe} now={now} disabled={locked || data.socket !== 'open' || data.pairing} execute={execute} />
                <dl className="wa-facts">
                    <div><dt>Socket</dt><dd>{socketLabels[data.socket] ?? '—'}</dd></div>
                    <div><dt>Tentativas de reconexão</dt><dd>{data.retries ?? 0}</dd></div>
                    <div><dt>Última mensagem recebida</dt><dd>{at(data.last_inbound)}</dd></div>
                    <div><dt>Última resposta enviada</dt><dd>{at(data.last_reply)}</dd></div>
                    <div><dt>Último sucesso n8n</dt><dd>{at(data.last_n8n_ok)}</dd></div>
                    <div><dt>Última falha n8n</dt><dd>{at(data.last_n8n_failure)}</dd></div>
                </dl>
                <h3>Eventos recentes</h3>
                {data.events?.length ? <ul className="wa-events">{data.events.map((entry, index) => <li key={entry.at + ':' + index}>
                    <span>{eventLabels[entry.event]}{entry.code ? ' · ' + entry.code : ''}</span><small>{at(entry.at)}</small>
                </li>)}</ul> : <p>Nenhum evento registrado neste processo.</p>}
            </details>}
        </>}
        {confirm && <Dialog title={confirm === 'pair' ? 'Substituir a sessão?' : 'Desvincular a conta?'} onClose={() => setConfirm(null)}>
            <p>{confirm === 'pair' ? 'A sessão atual será preservada em backup protegido antes de abrir o novo pareamento.' :
                'O GaletoBot solicitará a desvinculação ao WhatsApp. A sessão local será preservada se a resposta for inconclusiva.'}</p>
            <button className="wa-primary" disabled={locked} onClick={() => {
                const payload = confirm === 'pair' ? { action: 'pair', replace: true } : { action: 'unlink', confirm: true };
                setConfirm(null);
                execute(payload);
            }}>{confirm === 'pair' ? 'Confirmar novo pareamento' : 'Confirmar desvinculação'}</button>
        </Dialog>}
    </section>;
}
