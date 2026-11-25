import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Counter, Products } from './catalog-operation.jsx';
import { AdminShell } from './admin-shell.jsx';
import { Dashboard } from './overview.jsx';
import { Orders } from './orders-pilot.jsx';
import { Button, Feedback, Field, PageHeading, Wordmark } from './design-system.jsx';
import { Moon, Sun } from 'lucide-react';
import { api } from './client.js';
import { Customers, Settings, Stock } from './admin-sections.jsx';
import { PublicMenu } from './public-menu.jsx';
import { Chat } from './chat.jsx';
import { emptyPayment, paymentPayload } from './payment-fields.jsx';
import { Notice } from './ui.jsx';
import './style.css';
import './experiences.css';

function Login({ logged, login, email, setEmail, password, setPassword, busy, error, connectionError, checkSession }) {
    const [theme, setTheme] = useState(() => localStorage.getItem('galeto-theme') === 'dark' ? 'dark' : 'light');
    return <main className="ops-shell brasa-login" data-theme={theme}>
        <section className="brasa-login-brand"><Wordmark /><p>Gestão de pedidos, catálogo e estoque.</p></section>
        <section className="brasa-login-content">
            <Button variant="icon" icon={theme === 'dark' ? Sun : Moon}
                aria-label={theme === 'dark' ? 'Ativar tema claro' : 'Ativar tema escuro'} onClick={() => {
                    const next = theme === 'dark' ? 'light' : 'dark';
                    localStorage.setItem('galeto-theme', next);
                    setTheme(next);
                }} />
            {logged === null ? (connectionError ?
                <Feedback kind="error" title="Falha ao verificar a sessão" onRetry={checkSession}>{connectionError}</Feedback> :
                <Feedback kind="loading" title="Verificando sessão…" />) :
                <form onSubmit={login}>
                    <PageHeading title="Entrar no painel" />
                    <Field label="E-mail" value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username" required />
                    <Field label="Senha" value={password} onChange={e => setPassword(e.target.value)} type="password" autoComplete="current-password" required />
                    {error && <Feedback kind="error" title="Acesso indisponível">{error}</Feedback>}
                    <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</Button>
                    <a href="/cardapio">Abrir cardápio público</a>
                </form>}
        </section>
    </main>;
}

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

    function quantity(product, requested) {
        setCart(previous => ({
            ...previous, [product.id]: Math.max(0, Math.min(product.stock, 100, Number.isSafeInteger(requested) ? requested : 0))
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

    if (!logged) return <Login {...{ logged, login, email, setEmail, password, setPassword, busy, error, connectionError, checkSession }} />;

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
    const pilot = true;
    return <AdminShell {...{ tab, navigate, logout, storeName, busy, pilot }}>
            {syncError && (pilot
                ? <Feedback kind="error" title="Falha ao carregar a operação" onRetry={refresh}>{syncError}</Feedback>
                : <Notice onRetry={refresh}>{syncError}</Notice>)}
            {error && <Notice>{error}</Notice>}
            {success && <Notice kind="success">{success}</Notice>}
            {!dashboard && !syncError && (pilot ? <Feedback kind="loading" title="Carregando operação…" /> :
                <Loading>Carregando operação…</Loading>)}
            {tab === 'dashboard' && <Dashboard data={dashboard} orders={orders} navigate={navigate} />}
            {tab === 'pedidos' && <Orders {...{ orders, refresh, action, busy, error }} ready={Boolean(dashboard)} />}
            {tab === 'produtos' && dashboard && <Products {...{ products, refresh, action, busy, error }} />}
            {tab === 'estoque' && dashboard && <Stock {...{ products, refresh, action, busy, error }} />}
            {tab === 'clientes' && <Customers action={action} />}
            {tab === 'settings' && <Settings {...{ action, busy, refresh }} />}
            {tab === 'novo' && <Counter {...{ products, cart, name, setName, phone, setPhone, methods, payment, setPayment, busy, order }} change={quantity} />}
            {tab === 'ia' && <><PageHeading title={'Laboratório IA'} description={'Ambiente de demonstração para testar o atendimento.'} /><Chat lab /></>}
    </AdminShell>;
}

createRoot(document.getElementById('root')).render(/^\/cardapio\/?$/.test(location.pathname) ? <PublicMenu /> : <App />);
