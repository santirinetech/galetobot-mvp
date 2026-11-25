import React, { useEffect, useRef, useState } from 'react';
import { api, money, statuses } from './client.js';
import { ArrowDown, MessageCircle, Minus, Plus, ShoppingBag } from 'lucide-react';
import { Badge, Brand, Dialog, Empty, Loading, Notice, ProductPhoto } from './ui.jsx';
import { Chat } from './chat.jsx';

const initial = { name: '', phone: '', fulfillment: 'pickup', payment: '', address: '', region: '' };

export function PublicMenu() {
    const [menu, setMenu] = useState(null);
    const [cart, setCart] = useState({});
    const [customer, setCustomer] = useState(initial);
    const [quote, setQuote] = useState(null);
    const [receipt, setReceipt] = useState(null);
    const [tracking, setTracking] = useState(() => sessionStorage.getItem('galeto-menu-tracking'));
    const [pending, setPending] = useState(() => sessionStorage.getItem('galeto-menu-pending'));
    const [error, setError] = useState('');
    const [menuError, setMenuError] = useState('');
    const [busy, setBusy] = useState(false);
    const [chatAvailable, setChatAvailable] = useState(false);
    const [chatOpen, setChatOpen] = useState(false);
    const requesting = useRef(false);

    useEffect(() => {
        let active = true;
        api('/chat/availability').then(data => { if (active) setChatAvailable(data.available === true); }).catch(() => {});
        return () => { active = false; };
    }, []);

    useEffect(() => {
        let stopped = false;
        async function refresh() {
            try {
                const latest = await api('/menu');
                if (!stopped) { setMenu(latest); setMenuError(''); }
            } catch (err) {
                if (!stopped) setMenuError(err.message);
            }
        }
        refresh();
        const timer = setInterval(refresh, 12000);
        return () => { stopped = true; clearInterval(timer); };
    }, []);
    useEffect(() => {
        if (!tracking) return;
        let stopped = false;
        async function refreshStatus() {
            try {
                const current = await api('/menu/status', { method: 'POST', body: { token: tracking } });
                if (!stopped) setReceipt(current);
            } catch (err) {
                if (!stopped) setError(err.message);
            }
        }
        refreshStatus();
        const timer = setInterval(refreshStatus, 12000);
        return () => { stopped = true; clearInterval(timer); };
    }, [tracking]);

    function update(field, value) {
        setCustomer(previous => ({ ...previous, [field]: value }));
        setQuote(null);
    }
    function quantity(product, delta) {
        setQuote(null);
        setCart(previous => ({
            ...previous,
            [product.id]: delta < 0
                ? Math.max(0, (previous[product.id] || 0) + delta)
                : Math.min(product.stock, 100, (previous[product.id] || 0) + delta)
        }));
    }
    async function request(action) {
        if (requesting.current) return;
        requesting.current = true;
        setBusy(true);
        setError('');
        try { await action(); } catch (err) { setError(err.message); } finally {
            requesting.current = false;
            setBusy(false);
        }
    }
    function review(event) {
        event.preventDefault();
        setQuote(null);
        request(async () => {
            const items = Object.entries(cart).filter(([, count]) => count > 0)
                .map(([id, quantity]) => ({ product_id: Number(id), quantity }));
            setQuote(await api('/menu/quote', {
                method: 'POST', body: { ...customer, phone: customer.phone.replace(/\D/g, ''), items }
            }));
        });
    }
    function confirm(token) {
        request(async () => {
            sessionStorage.setItem('galeto-menu-pending', token);
            setPending(token);
            let result;
            try {
                result = await api('/menu/confirm', { method: 'POST', body: { token } });
            } catch (err) {
                if (err.status === 409) {
                    sessionStorage.removeItem('galeto-menu-pending');
                    setPending(null);
                    setQuote(null);
                }
                throw err;
            }
            setReceipt(result);
            sessionStorage.setItem('galeto-menu-tracking', token);
            sessionStorage.removeItem('galeto-menu-pending');
            setTracking(token);
            setPending(null);
            setQuote(null);
            setCart({});
        });
    }
    const config = menu?.settings;
    const categories = [...new Set((menu?.products ?? []).map(product => product.category || 'Cardápio'))];
    const count = Object.values(cart).reduce((sum, qty) => sum + qty, 0);

    return <>
        <header className="public-header"><Brand /><a className="button small secondary" href="/">Painel</a></header>
        <main className="container public-menu">
            <section className="menu-hero">
                <h1>{config?.name || 'GaletoBot'}</h1>
                <h2>Cardápio</h2>
                {config?.hours && <p>{config.hours}</p>}
                {config?.menu_note && <p>{config.menu_note}</p>}
                {config && <Badge tone={config.menu_open ? 'success' : 'warning'}>{config.menu_open ? 'Aceitando pedidos' : 'Pedidos fechados'}</Badge>}
                {chatAvailable && <div className="public-chat-entry">
                    <button type="button" onClick={() => setChatOpen(true)} disabled={Boolean(pending) || busy}>
                        <MessageCircle size={18} aria-hidden="true" /> Pedir com IA
                    </button>
                    <small>Os carrinhos do cardápio e da conversa são separados.</small>
                </div>}
            </section>
            {chatOpen && <Dialog title="Pedir com IA" onClose={() => setChatOpen(false)}>
                <Chat onContinue={() => setChatOpen(false)} />
            </Dialog>}
            {menuError && <Notice>{menuError}</Notice>}
            {!menu && !menuError && <Loading>Carregando cardápio…</Loading>}
            {error && <Notice>{error}</Notice>}
            {pending && <section className="panel">
                <p>A confirmação anterior ainda não retornou. Consulte o resultado antes de enviar outro pedido.</p>
                <button disabled={busy} onClick={() => confirm(pending)}>Verificar confirmação</button>
            </section>}
            {receipt && <section className="panel" aria-live="polite">
                <h2>Pedido #{receipt.id}</h2>
                <p>{statuses[receipt.status] || receipt.status} · {money(receipt.total_cents)}</p>
            </section>}
            {categories.length > 1 && <nav className="category-links" aria-label="Categorias">
                {categories.map((category, index) => <a href={`#categoria-${index}`} key={category}>{category}</a>)}
            </nav>}
            <div className={`menu-layout ${count ? 'with-cart' : ''}`}>
            <div className="menu-categories">
            {categories.map((category, index) => <section className="menu-category" id={`categoria-${index}`} key={category}>
                <h2>{category}</h2>
                <div className="menu-grid">{menu.products.filter(p => (p.category || 'Cardápio') === category).map(product =>
                    <article key={product.id} className="panel menu-item">
                        <ProductPhoto url={product.image_url} name={product.name} className="menu-photo" />
                        <h3>{product.name}</h3>
                        {product.description && <p>{product.description}</p>}
                        <strong>{money(product.price_cents)}</strong>
                        <Badge tone={product.stock ? 'success' : 'danger'}>{product.stock ? 'Disponível' : 'Esgotado'}</Badge>
                        <div className="qty">
                            <button type="button" className="secondary" aria-label={`Remover ${product.name}`} disabled={busy || !cart[product.id]} onClick={() => quantity(product, -1)}><Minus size={17} /></button>
                            <span>{cart[product.id] || 0}</span>
                            <button type="button" aria-label={`Adicionar ${product.name}`} disabled={busy || !config.menu_open || (cart[product.id] || 0) >= product.stock || cart[product.id] >= 100} onClick={() => quantity(product, 1)}><Plus size={17} /></button>
                        </div>
                    </article>
                )}</div>
            </section>)}
            {menu && !menu.products.length && <section className="panel"><Empty>Nenhum produto no cardápio.</Empty></section>}
            </div>
            {count > 0 && <section className="panel menu-cart" id="carrinho">
                <h2><ShoppingBag size={21} /> Seu pedido · {count} {count === 1 ? 'item' : 'itens'}</h2>
                <ul>{Object.entries(cart).filter(([, qty]) => qty > 0).map(([id, qty]) => {
                    const product = menu.products.find(item => item.id === Number(id));
                    return <li key={id}>{qty} × {product?.name || 'Produto indisponível'} <button type="button" className="secondary small" disabled={busy} onClick={() => {
                        setCart(previous => ({ ...previous, [id]: 0 }));
                        setQuote(null);
                    }}>Remover</button></li>;
                })}</ul>
                <form onSubmit={review}>
                    <fieldset disabled={busy}>
                        <label>Nome<input required maxLength={100} value={customer.name} onChange={e => update('name', e.target.value)} /></label>
                        <label>Telefone com DDD<input required type="tel" value={customer.phone} onChange={e => update('phone', e.target.value)} /></label>
                        <label>Recebimento<select value={customer.fulfillment} onChange={e => update('fulfillment', e.target.value)}>
                            <option value="pickup">Retirada</option>
                            {config.regions.length > 0 && <option value="delivery">Entrega</option>}
                        </select></label>
                        {customer.fulfillment === 'delivery' && <>
                            <label>Região<select required value={customer.region} onChange={e => update('region', e.target.value)}>
                                <option value="">Selecione</option>
                                {config.regions.map(region => <option key={region.name}>{region.name}</option>)}
                            </select></label>
                            <label>Endereço<input required maxLength={180} value={customer.address} onChange={e => update('address', e.target.value)} /></label>
                        </>}
                        <label>Pagamento<select required value={customer.payment} onChange={e => update('payment', e.target.value)}>
                            <option value="">Selecione</option>
                            {config.payments.map(payment => <option key={payment}>{payment}</option>)}
                        </select></label>
                        <button disabled={!config.menu_open || Boolean(pending)}>Revisar pedido</button>
                    </fieldset>
                </form>
                {quote && <div className="checkout-summary">
                    <h3>Resumo do pedido</h3>
                    <ul>{quote.items.map(item => <li key={item.product_id}>{item.quantity} × {item.name} · {money(item.unit_price_cents * item.quantity)}</li>)}</ul>
                    <p>{quote.checkout.fulfillment === 'delivery' ? `Entrega em ${quote.checkout.address} · ${quote.checkout.region}` : 'Retirada no estabelecimento'} · {quote.checkout.payment}</p>
                    <p>Frete · {money(quote.checkout.shipping_cents)}</p>
                    <p className="total">Total <strong>{money(quote.total_cents)}</strong></p>
                    <button disabled={busy || Boolean(pending)} onClick={() => confirm(quote.token)}>Confirmar pedido</button>
                </div>}
            </section>}
            </div>
            {count > 0 && <a className="button accent cart-shortcut" href="#carrinho"><ShoppingBag size={18} /> Seu pedido · {count} {count === 1 ? 'item' : 'itens'} <ArrowDown size={17} /></a>}
        </main>
    </>;
}
