import React, { useState } from 'react';
import { ArrowUpRight, Boxes, ClipboardList, FlaskConical, LayoutDashboard, LogOut, Menu, Moon,
    Package, PanelLeftClose, PanelLeftOpen, Plus, Settings, ShoppingBag, Sun, Users } from 'lucide-react';
import { Button, Overlay, Wordmark } from './design-system.jsx';
import './admin-shell.css';

const sections = [
    { label: 'Operação', pages: [
        ['dashboard', 'Visão geral', LayoutDashboard], ['pedidos', 'Pedidos', ClipboardList],
        ['novo', 'Balcão', ShoppingBag], ['estoque', 'Estoque', Boxes]
    ] },
    { label: 'Gestão', pages: [
        ['produtos', 'Produtos', Package], ['clientes', 'Clientes', Users],
        ['settings', 'Configurações', Settings], ['ia', 'Laboratório IA', FlaskConical]
    ] }
];
const tabs = sections.flatMap(section => section.pages);
const shortcuts = tabs.slice(0, 4);

function read(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; }
    catch { return fallback; }
}

function save(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Browser may disable storage. */ }
}

export function AdminShell({ tab, navigate, logout, storeName, busy, children }) {
    const [theme, setTheme] = useState(() => read('galeto-theme', 'light') === 'dark' ? 'dark' : 'light');
    const [collapsed, setCollapsed] = useState(() => read('galeto-sidebar', 'wide') === 'compact');
    const [menu, setMenu] = useState(false);

    function select(id) { setMenu(false); navigate(id); }
    function navigation([id, label, Icon], compact = false) {
        return <button key={id} type="button" className="ops-nav-button" title={compact ? label : undefined}
            aria-label={label} aria-current={tab === id ? 'page' : undefined} onClick={() => select(id)}>
            <Icon size={19} aria-hidden="true" />{!compact && <span>{label}</span>}
        </button>;
    }

    return <div className={'admin-shell ops-shell' + (collapsed ? ' ops-shell--collapsed' : '')} data-theme={theme}>
        <aside className="sidebar ops-sidebar">
            <div className="ops-sidebar-head">
                <button type="button" className="brand-button ops-brand-button" aria-label="GaletoBot" onClick={() => select('dashboard')}>
                    <Wordmark compact={collapsed} />
                </button>
                <Button variant="icon" icon={collapsed ? PanelLeftOpen : PanelLeftClose} className="ops-sidebar-toggle"
                    aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
                    aria-expanded={!collapsed} onClick={() => {
                        setCollapsed(!collapsed);
                        save('galeto-sidebar', collapsed ? 'wide' : 'compact');
                    }} />
            </div>
            <nav aria-label="Navegação administrativa" className="ops-nav">
                {sections.map(section => <div className="ops-nav-group" key={section.label}>
                    {!collapsed && <div className="ops-nav-caption">{section.label}</div>}
                    {section.pages.map(page => navigation(page, collapsed))}
                </div>)}
            </nav>
            <button type="button" className="ops-nav-button ops-logout" title={collapsed ? 'Sair da conta' : undefined}
                aria-label="Sair da conta" onClick={logout}><LogOut size={19} aria-hidden="true" />{!collapsed && 'Sair da conta'}</button>
        </aside>
        <header className="topbar ops-topbar">
            <button type="button" className="brand-button mobile-brand ops-brand-button" aria-label="GaletoBot" onClick={() => select('dashboard')}>
                <Wordmark compact />
            </button>
            <div className="ops-store"><span>Estabelecimento</span><strong title={storeName || undefined}>{storeName || 'GaletoBot'}</strong></div>
            <div className="ops-top-actions">
                <Button variant="icon" icon={theme === 'light' ? Moon : Sun} aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'}
                    onClick={() => {
                        const next = theme === 'light' ? 'dark' : 'light';
                        setTheme(next);
                        save('galeto-theme', next);
                    }} />
                <Button href="/cardapio" icon={ArrowUpRight} variant="quiet" className="ops-menu-link" aria-label="Abrir cardápio"><span>Cardápio</span></Button>
                <Button icon={Plus} variant="primary" className="ops-quick-order" onClick={() => select('novo')}>Novo pedido</Button>
            </div>
        </header>
        <nav className="mobile-nav ops-mobile-nav" aria-label="Atalhos do painel">
            {shortcuts.map(page => navigation(page))}
            <button type="button" className="ops-nav-button" data-current={!shortcuts.some(([id]) => id === tab)}
                onClick={() => setMenu(true)} aria-expanded={menu} aria-label="Mais opções"><Menu size={19} aria-hidden="true" /><span>Mais</span></button>
        </nav>
        {menu && <Overlay title="Menu do painel" onClose={() => setMenu(false)}>
            <nav className="ops-overflow-nav" aria-label="Todos os módulos">{tabs.map(page => navigation(page))}
                <Button variant="quiet" icon={LogOut} onClick={() => { setMenu(false); logout(); }}>Sair da conta</Button>
            </nav>
        </Overlay>}
        <main className="container admin-main ops-main" aria-busy={busy}>
            {children}
        </main>
    </div>;
}
