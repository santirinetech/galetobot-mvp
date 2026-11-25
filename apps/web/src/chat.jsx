import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageCircle, Plus, Send } from 'lucide-react';
import { api, money } from './client.js';
import { Loading, Notice } from './ui.jsx';
import './chat.css';

const states = {
    IDLE: 'Início', BUILDING_CART: 'Montando pedido', AWAITING_CONFIRMATION: 'Aguardando confirmação',
    CONFIRMED: 'Pedido confirmado', CANCELLED: 'Cancelado', HUMAN: 'Automação pausada'
};
const turnErrors = {
    model_unavailable: 'O serviço de interpretação não devolveu uma resposta válida.',
    integration_unavailable: 'A integração ficou indisponível.',
    timeout: 'A mensagem excedeu o tempo limite.'
};

function messageId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

export function Chat({ lab = false, onContinue }) {
    const prefix = lab ? '/admin/ai-lab' : '/chat';
    const [view, setView] = useState(null);
    const [draft, setDraft] = useState('');
    const [outbound, setOutbound] = useState(null);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [tab, setTab] = useState('cart');
    const lock = useRef(false);
    const history = useRef(null);
    const stick = useRef(true);
    const read = () => api(prefix + '/session');

    useEffect(() => {
        let active = true;
        read().then(data => { if (active) setView(data); })
            .catch(e => { if (active && e.status !== 404) setError(e.message); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [prefix]);

    const waiting = view?.turns.some(turn => turn.status === 'pending');
    useEffect(() => {
        if (!waiting || busy) return;
        let active = true;
        const timer = setTimeout(() => {
            read().then(data => { if (active) setView(data); }).catch(e => {
                if (active) { setError(e.message); if (e.status === 404) setView(null); }
            });
        }, 1400);
        return () => { active = false; clearTimeout(timer); };
    }, [view, waiting, busy]);

    useLayoutEffect(() => {
        if (history.current && stick.current) history.current.scrollTop = history.current.scrollHeight;
    }, [view, busy, outbound]);

    async function perform(operation) {
        if (lock.current) return;
        lock.current = true;
        setBusy(true);
        setError('');
        try { await operation(); }
        catch (e) { setError(e.message); }
        finally { lock.current = false; setBusy(false); }
    }

    function newConversation() {
        if (waiting || outbound || (view?.cart.items.length && !window.confirm('Iniciar outra conversa e deixar este carrinho?'))) return;
        perform(async () => {
            await api(prefix + '/sessions', { method: 'POST', body: {} });
            stick.current = true;
            setView(await read());
            setDraft('');
        });
    }
    function send(message) {
        perform(async () => {
            stick.current = true;
            setOutbound(message);
            setDraft('');
            try {
                setView(await api(prefix + '/messages', { method: 'POST', body: message }));
                setOutbound(null);
            } catch (e) {
                const current = await read().catch(() => null);
                if (current) {
                    setView(current);
                    if (current.turns.some(turn => turn.message_id === message.message_id)) setOutbound(null);
                } else if (e.status === 404) {
                    setView(null);
                    setOutbound(null);
                    setDraft(message.mensagem);
                }
                throw e;
            }
        });
    }
    const [detailsOpen, setDetailsOpen] = useState(false);
    const cart = view?.cart;
    const latest = view?.turns.at(-1);
    const visibleOutbound = outbound && !view?.turns.some(turn => turn.message_id === outbound.message_id);
    const formatAmount = value => value == null ? 'A calcular' : money(value);

    return <section className={'chat-workspace' + (lab ? ' chat-lab' : '')}>
        <div className="chat-thread">
            <header className="chat-top">
                <div><MessageCircle size={20} aria-hidden="true" /><strong>Assistente GaletoBot</strong></div>
                <button type="button" className="secondary small" disabled={loading || busy || waiting || !!outbound} onClick={newConversation}>
                    <Plus size={16} aria-hidden="true" /> Nova conversa
                </button>
            </header>
            {lab && <small className="chat-environment">Ambiente de demonstração{view ? ' · Conversa ' + view.conversation_id.slice(0, 8) : ''}</small>}
            <div className="chat-history" ref={history} role="log" aria-label="Histórico de mensagens" onScroll={e => {
                const node = e.currentTarget;
                stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
            }}>
                {loading ? <Loading>Recuperando conversa…</Loading> : !view?.turns.length && <div className="chat-empty">
                    <MessageCircle size={28} aria-hidden="true" />
                    <h3>{view ? 'O que você gostaria de pedir?' : 'Comece uma conversa'}</h3>
                    <p>{view ? 'Pergunte sobre os produtos ou descreva seu pedido.' : 'Inicie uma sessão para falar com o assistente.'}</p>
                </div>}
                {view?.turns.map(turn => <div key={turn.message_id} className="chat-turn">
                    <div className="chat-bubble chat-customer"><strong>Você</strong><p>{turn.message}</p></div>
                    {turn.reply && <div className="chat-bubble chat-assistant"><strong>GaletoBot</strong><p>{turn.reply}</p></div>}
                    {turn.error && <small className="chat-turn-error">{turnErrors[turn.error] ?? 'A mensagem não pôde ser concluída.'}</small>}
                </div>)}
                {visibleOutbound && <div className="chat-bubble chat-customer"><strong>Você</strong><p>{outbound.mensagem}</p></div>}
                {(busy && outbound || waiting) && <p className="chat-processing" role="status">Processando mensagem…</p>}
            </div>
            {error && <Notice onRetry={waiting ? () => perform(async () => setView(await read())) : undefined}>{error}</Notice>}
            {visibleOutbound && !busy && <div className="chat-retry">
                <button type="button" className="secondary small" onClick={() => send(outbound)}>Verificar ou reenviar a mesma mensagem</button>
            </div>}
            {cart?.state === 'HUMAN' && !lab && <p className="chat-contact">
                {view.contact ? <a href={view.contact} target="_blank" rel="noopener noreferrer">Continuar pelo contato da loja</a> :
                    'O atendimento humano por este chat está indisponível. Consulte os canais de contato da loja.'}
            </p>}
            {onContinue && <button type="button" className="text-button chat-fallback" onClick={onContinue}>
                Continuar pelo cardápio convencional
            </button>}
            <form className="chat-compose" onSubmit={e => {
                e.preventDefault();
                if (draft.trim() && !busy && !waiting && !outbound) send({ mensagem: draft.trim(), message_id: messageId() });
            }}>
                <textarea aria-label="Mensagem" placeholder="Escreva sua mensagem" rows={2} maxLength={500} value={draft}
                    disabled={!view || busy || waiting || !!outbound || (!lab && cart?.state === 'HUMAN')}
                    onChange={e => setDraft(e.target.value)} onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            e.currentTarget.form.requestSubmit();
                        }
                    }} />
                <button aria-label="Enviar mensagem" disabled={!view || !draft.trim() || busy || waiting || !!outbound || (!lab && cart?.state === 'HUMAN')}>
                    <Send size={18} aria-hidden="true" />
                </button>
            </form>
        </div>
        <aside className="chat-details" aria-label="Informações da conversa" data-expanded={detailsOpen}>
            <button type="button" className="secondary chat-side-toggle" aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen(open => !open)}>{lab ? 'Carrinho e diagnóstico' : 'Carrinho da conversa'}{cart?.items.length ? ' · ' + cart.items.length : ''}</button>
            {lab && <div className="chat-tabs">
                <button type="button" aria-pressed={tab === 'cart'} onClick={() => setTab('cart')}>Carrinho</button>
                <button type="button" aria-pressed={tab === 'diagnostic'} onClick={() => setTab('diagnostic')}>Diagnóstico</button>
            </div>}
            {(tab === 'cart' || !lab) ? <div className="chat-detail-body">
                <h3>Carrinho da conversa</h3>
                <p>{states[cart?.state] ?? 'Sem sessão'}{cart?.order_id ? ' · Pedido #' + cart.order_id : ''}</p>
                {!cart?.items.length ? <p>Nenhum item selecionado.</p> : <>
                    <ul>{cart.items.map(item => <li key={item.product_id}>{item.quantity} × {item.name}</li>)}</ul>
                    {cart.unavailable && <p>Alguns itens precisam ser revistos.</p>}
                    <dl><div><dt>Subtotal</dt><dd>{formatAmount(cart.subtotal_cents)}</dd></div>
                        <div><dt>Frete</dt><dd>{formatAmount(cart.shipping_cents)}</dd></div>
                        <div><dt>Total</dt><dd>{formatAmount(cart.total_cents)}</dd></div></dl>
                </>}
            </div> : <div className="chat-detail-body">
                <h3>Última mensagem</h3>
                {!latest ? <p>Os dados aparecem após o envio.</p> : <dl>
                    <div><dt>Correlação</dt><dd>{latest.message_id}</dd></div>
                    <div><dt>Recebida</dt><dd>{new Date(latest.created_at).toLocaleTimeString('pt-BR')}</dd></div>
                    {latest.diagnostic?.context && <div><dt>Contexto consultado</dt><dd>
                        {latest.diagnostic.context === 'model_requested' ? 'Interpretação solicitada' : 'Modelo dispensado'}
                    </dd></div>}
                    {latest.diagnostic?.applied && <div><dt>Regras comerciais</dt><dd>Processadas</dd></div>}
                    {latest.diagnostic?.duration_ms != null && <div><dt>Duração observada</dt><dd>{latest.diagnostic.duration_ms} ms</dd></div>}
                    {latest.error && <div><dt>Falha</dt><dd>{turnErrors[latest.error] ?? 'Operação indisponível'}</dd></div>}
                    <div><dt>Execução do Gemini</dt><dd>{latest.diagnostic?.context === 'deterministic' ? 'Dispensada' : 'Sem confirmação do workflow'}</dd></div>
                </dl>}
            </div>}
        </aside>
    </section>;
}
