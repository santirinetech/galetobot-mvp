import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminShell } from './admin-shell.jsx';
import { api, money } from './client.js';
import { Customers, Dashboard, Orders, Products, Settings, Stock } from './admin-sections.jsx';
import { PublicMenu } from './public-menu.jsx';
import { Chat } from './chat.jsx';
import { emptyPayment, PaymentFields, paymentPayload } from './payment-fields.jsx';
import { Brand, Loading, Notice, ProductPhoto } from './ui.jsx';
import './style.css';

function App() {
    const [logged, setLogged] = useState(null);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [tab, setTab] = useState('dashboard');
    const [products, setProducts] = useState([]);
    const [orders, setOrders] = useState([]);
    const [dashboard, setDashboard] = useState(null);
    const [cart, setCart] = useState({});
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [payment, setPayment] = useState(emptyPayment);
    const [methods, setMethods] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [storeName, setStoreName] = useState('');
    const [connectionError, setConnectionError] = useState('');
    const [syncError, setSyncError] = useState('');
    const [success, setSuccess] = useState('');
    const pending = useRef(null);
    const acting = useRef(false);
    const refreshVersion = useRef(0);

    async function refresh() {
        const version = ++refreshVersion.current;
        try {
            const [catalog, list, summary, settings] = await Promise.all([api('/products'), api('/orders'), api('/dashboard'), api('/settings')]);
            if (version !== refreshVersion.current) return;
            setProducts(catalog);
            setOrders(list);
            setDashboard(summary);
            setStoreName(settings.name);
            setMethods(settings.payments);
            setSyncError('');
        } catch (err) {
            if (version !== refreshVersion.current) return;
            if (err.status === 401) {
                setError('Sua sessão expirou. Entre novamente.');
                setLogged(false);
                return;
            }
            setSyncError(err.message);
        }
    }

    function checkSession() {
        setConnectionError('');
        api('/me').then(() => setLogged(true)).catch(err => {
            if (err.status === 401) setLogged(false);
            else setConnectionError(err.message);
        });
    }
    useEffect(() => {
        checkSession();
    }, []);

    useEffect(() => {
        if (!logged) return;
        refresh();
        const timer = setInterval(refresh, 10000);
        return () => { clearInterval(timer); refreshVersion.current++; };
    }, [logged]);

    async function action(fn, confirmation) {
        if (acting.current) return;
        acting.current = true;
        setError('');
        setSuccess('');
        setBusy(true);
        try {
            await fn();
            if (confirmation) setSuccess(confirmation);
        } catch (e) { setError(e.message); } finally {
            acting.current = false;
            setBusy(false);
        }
    }

    function login(event) {
        event.preventDefault();
        action(async () => {
            await api('/login', { method: 'POST', body: { email, password } });
            setPassword('');
            setLogged(true);
        });
    }

    function quantity(product, delta) {
        setCart(previous => ({
            ...previous, [product.id]: Math.max(0, Math.min(product.stock, 100, (previous[product.id] || 0) + delta))
        }));
    }

    function order() {
        action(async () => {
            const selected = Object.entries(cart).filter(([, qty]) => qty > 0)
                .map(([id, quantity]) => ({ product_id: Number(id), quantity }));
            if (!selected.length) throw new Error('Selecione produtos.');
            const sale = { name, phone: phone.replace(/\D/g, ''), source: 'counter', items: selected, ...paymentPayload(payment) };
            const fingerprint = JSON.stringify(sale);
            if (pending.current?.fingerprint !== fingerprint) {
                // Idempotency key is public-irrelevant and needs uniqueness, including on private HTTP LAN.
                const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
                pending.current = { fingerprint, key };
            }
            await api('/orders', { method: 'POST', body: { ...sale, external_key: pending.current.key } });
            pending.current = null;
            setCart({});
            setPayment(emptyPayment);
            setTab('pedidos');
            await refresh();
        }, 'Pedido registrado com sucesso.');
    }

    const customerFields = <>
        <label>Nome do cliente<input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Telefone com DDD<input type="tel" value={phone} onChange={e => setPhone(e.target.value)} /></label>
    </>;

    if (logged === null) return <main className="login"><section className="panel">
        <Brand />
        {connectionError ? <Notice onRetry={checkSession}>{connectionError}</Notice> : <Loading>Verificando sessão…</Loading>}
    </section></main>;
    if (!logged) return <main className="login">
        <form onSubmit={login} className="panel">
            <Brand />
            <h1>Entrar no painel</h1>
            <p>Gerencie pedidos, catálogo e estoque em um só lugar.</p>
            <label>E-mail<input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username" required /></label>
            <label>Senha<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required /></label>
            <button disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
            {error && <Notice>{error}</Notice>}
            <a href="/cardapio">Abrir cardápio público</a>
        </form>
    </main>;

    function navigate(id) {
        setError('');
        setSuccess('');
        setTab(id);
        window.scrollTo(0, 0);
    }
    function logout() {
        action(async () => {
                await api('/logout', { method: 'POST' });
                setLogged(false);
                setProducts([]);
                setOrders([]);
                setDashboard(null);
                setCart({});
                setName('');
                setPhone('');
                setPayment(emptyPayment);
                pending.current = null;
                setTab('dashboard');
        });
    }
    return <AdminShell {...{ tab, navigate, logout, storeName, busy }}>
            {syncError && <Notice onRetry={refresh}>{syncError}</Notice>}
            {error && <Notice>{error}</Notice>}
            {success && <Notice kind="success">{success}</Notice>}
            {!dashboard && !syncError && <Loading>Carregando operação…</Loading>}
            {tab === 'dashboard' && dashboard && <Dashboard data={dashboard} orders={orders} navigate={navigate} />}
            {tab === 'pedidos' && dashboard && <Orders {...{ orders, refresh, action, busy, error }} />}
            {tab === 'produtos' && dashboard && <Products {...{ products, refresh, action, busy, error }} />}
            {tab === 'estoque' && dashboard && <Stock {...{ products, refresh, action, busy, error }} />}
            {tab === 'clientes' && <Customers action={action} />}
            {tab === 'settings' && <Settings {...{ action, busy, refresh }} />}
            {tab === 'novo' && <>
                <section className="panel"><h2>Cliente</h2>{customerFields}
                    <PaymentFields payments={methods} value={payment} onChange={setPayment} /></section>
                <section className="panel">
                    <h2>Selecione os itens</h2>
                    {products.filter(p => p.active || cart[p.id]).map(product => <div className="product" key={product.id}>
                        <div className="item-identity"><ProductPhoto url={product.image_url} name={product.name} /><div><strong>{product.name}</strong><small>{money(product.price_cents)} · {product.active ? product.stock + ' disponíveis' : 'Inativo'}</small></div></div>
                        <div className="qty">
                            <button className="secondary" aria-label={'Remover ' + product.name} onClick={() => quantity(product, -1)}>−</button>
                            <b>{cart[product.id] || 0}</b>
                            <button aria-label={'Adicionar ' + product.name} disabled={!product.active || (cart[product.id] || 0) >= Math.min(product.stock, 100)}
                                onClick={() => quantity(product, 1)}>+</button>
                        </div>
                    </div>)}
                    <p className="total">Total estimado <strong>{money(products.reduce((sum, p) => sum + p.price_cents * (cart[p.id] || 0), 0))}</strong></p>
                    <button disabled={busy} onClick={() => order()}>Confirmar pedido de balcão</button>
                </section>
            </>}
            {tab === 'ia' && <Chat lab />}
    </AdminShell>;
}

createRoot(document.getElementById('root')).render(/^\/cardapio\/?$/.test(location.pathname) ? <PublicMenu /> : <App />);
