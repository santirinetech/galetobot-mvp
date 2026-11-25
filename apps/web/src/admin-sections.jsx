import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Package, Pencil, Plus, RefreshCw, Search } from 'lucide-react';
import { api, money, sources, statuses } from './client.js';
import { Badge, Dialog, Empty, formatDate, Loading, Notice, OrderStatus, ProductPhoto } from './ui.jsx';
import { WhatsAppSettings } from './whatsapp-settings.jsx';

const parseMoney = value => value.trim() ? Math.round(Number(value.trim().replace(',', '.')) * 100) : NaN;
const source = order => sources[order.source] || 'Origem desconhecida';

function useResource(path) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const load = useCallback(async () => {
        try { setData(await api(path)); setError(''); } catch (err) { setError(err.message); }
    }, [path]);
    useEffect(() => { load(); }, [load]);
    return { data, error, load };
}

function ResourceError({ resource }) {
    return resource.error ? <Notice onRetry={resource.load}>{resource.error}</Notice> : null;
}

function PanelHeading({ title, children }) {
    return <div className="panel-heading"><h2>{title}</h2>{children}</div>;
}

function StockLevel({ stock }) {
    return <Badge tone={stock === 0 ? 'danger' : stock <= 2 ? 'warning' : 'success'}>
        {stock === 0 ? 'Esgotado' : stock <= 2 ? 'Estoque baixo' : 'Em estoque'}
    </Badge>;
}

export function Stock({ products, action, refresh, busy, error }) {
    const history = useResource('/stock/movements');
    const [open, setOpen] = useState(false);
    const [productId, setProductId] = useState('');
    const [units, setUnits] = useState('1');
    const [type, setType] = useState('in');
    const [reason, setReason] = useState('');
    function start(product = '') { setProductId(String(product)); setUnits('1'); setType('in'); setReason(''); setOpen(true); }
    function submit(event) {
        event.preventDefault();
        action(async () => {
            await api(`/products/${productId}/movements`, { method: 'POST', body: { delta: Number(units) * (type === 'in' ? 1 : -1), reason } });
            setOpen(false);
            await Promise.all([history.load(), refresh()]);
        }, 'Movimentação registrada.');
    }
    return <>
        <section className="panel">
            <PanelHeading title="Saldos do estoque"><button onClick={() => start()} disabled={!products.length}><Plus size={18} /> Movimentar</button></PanelHeading>
            {!products.length ? <Empty>Nenhum produto cadastrado.</Empty> : products.map(product => <div key={product.id} className="product stock-row">
                <div className="item-identity"><ProductPhoto url={product.image_url} name={product.name} /><div><strong>{product.name}</strong><small>{product.stock} un.</small></div></div>
                <StockLevel stock={product.stock} /><button className="secondary small" aria-label={`Movimentar ${product.name}`} onClick={() => start(product.id)}><ArrowUpRight size={17} /></button>
            </div>)}
        </section>
        <section className="panel">
            <PanelHeading title="Histórico de movimentações"><button className="secondary small" onClick={history.load}><RefreshCw size={16} /> Atualizar</button></PanelHeading>
            <ResourceError resource={history} />
            {!history.data && !history.error && <Loading />}
            {history.data?.length === 0 && <Empty>Nenhuma movimentação registrada.</Empty>}
            {history.data?.map(row => <div key={row.id} className="product">
                <div className="item-identity"><span className={'metric-icon ' + (row.delta > 0 ? 'mint' : 'peach')}>{row.delta > 0 ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}</span>
                    <div><strong>{row.name} · {row.reason}</strong><small>{formatDate(row.created_at)}</small></div></div>
                <Badge tone={row.delta > 0 ? 'success' : 'warning'}>{row.delta > 0 ? '+' : ''}{row.delta} · saldo {row.balance}</Badge>
            </div>)}
        </section>
        {open && <Dialog title="Movimentação de estoque" onClose={() => setOpen(false)}>
            {error && <Notice>{error}</Notice>}
            <form onSubmit={submit}>
                <label>Produto<select required value={productId} onChange={e => setProductId(e.target.value)}>
                    <option value="">Selecione</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
                <div className="form-grid">
                    <label>Tipo<select value={type} onChange={e => setType(e.target.value)}><option value="in">Entrada</option><option value="out">Saída</option></select></label>
                    <label>Quantidade<input type="number" min={1} required value={units} onChange={e => setUnits(e.target.value)} /></label>
                </div>
                <label>Motivo<input required maxLength={160} value={reason} onChange={e => setReason(e.target.value)} /></label>
                <button className="full" disabled={busy}>Registrar movimentação</button>
            </form>
        </Dialog>}
    </>;
}

export function Customers({ action }) {
    const resource = useResource('/customers');
    const [selection, setSelection] = useState(null);
    const [query, setQuery] = useState('');
    const search = query.trim().toLocaleLowerCase('pt-BR');
    const visible = (resource.data || []).filter(c => c.name.toLocaleLowerCase('pt-BR').includes(search) || (c.phone || '').includes(search));
    return <>
        <section className="panel">
            <PanelHeading title="Clientes" />
            <label className="search"><Search size={19} /><input type="search" aria-label="Buscar cliente" placeholder="Buscar por nome ou telefone" value={query} onChange={e => setQuery(e.target.value)} /></label>
            <ResourceError resource={resource} />
            {!resource.data && !resource.error && <Loading />}
            {resource.data && !visible.length && <Empty>{search ? 'Nenhum cliente encontrado para esta busca.' : 'Nenhum cliente registrado.'}</Empty>}
            {visible.map(customer => <div key={customer.id} className="product">
                <div className="item-identity"><span className="avatar">{customer.name.charAt(0).toUpperCase()}</span><div><strong>{customer.name}</strong><small>{customer.phone} · {customer.orders} pedidos</small></div></div>
                <button className="secondary small" onClick={() => action(async () => { setSelection({ customer, orders: await api(`/customers/${customer.id}/orders`) }); })}>Histórico <ArrowRight size={16} /></button>
            </div>)}
        </section>
        {selection && <Dialog title={`Pedidos de ${selection.customer.name}`} onClose={() => setSelection(null)}>
            {selection.orders.length === 0 && <Empty>Nenhum pedido registrado.</Empty>}
            {selection.orders.map(order => <div className="product" key={order.id}><div><strong>#{order.id} · {source(order)}</strong><small>{formatDate(order.created_at)}</small></div>
                <OrderStatus status={order.status} /><strong>{money(order.total_cents)}</strong></div>)}
        </Dialog>}
    </>;
}

export function Settings({ action, busy, refresh }) {
    const resource = useResource('/settings');
    const handoffs = useResource('/conversation-handoffs');
    const [settings, setSettings] = useState(null);
    const [regionText, setRegionText] = useState('');
    const [payments, setPayments] = useState('');
    const [aliases, setAliases] = useState('');
    useEffect(() => {
        if (!resource.data) return;
        setSettings(resource.data);
        setRegionText(resource.data.regions.map(row => `${row.name} | ${(row.shipping_cents / 100).toFixed(2)}`).join('\n'));
        setPayments(resource.data.payments.join('\n'));
        setAliases((resource.data.region_aliases ?? []).map(row => `${row.alias} | ${row.regiao}`).join('\n'));
    }, [resource.data]);
    if (!settings) return resource.error ? <ResourceError resource={resource} /> : <Loading>Carregando configurações…</Loading>;
    function change(field, value) { setSettings(current => ({ ...current, [field]: value })); }
    return <><form onSubmit={event => {
        event.preventDefault();
        action(async () => {
            const regions = regionText.split('\n').filter(line => line.trim()).map(line => {
                const [name, fee, ...rest] = line.split('|').map(value => value.trim());
                const shipping_cents = parseMoney(fee || '');
                if (rest.length || !name || !Number.isSafeInteger(shipping_cents) || shipping_cents < 0) {
                    throw new Error('Informe cada região no formato Bairro | 6,00.');
                }
                return { name, shipping_cents };
            });
            const region_aliases = aliases.split('\n').filter(line => line.trim()).map(line => {
                const [alias, regiao, ...rest] = line.split('|').map(part => part.trim());
                if (!alias || !regiao || rest.length || !regions.some(region => region.name === regiao)) {
                    throw new Error('Informe cada apelido no formato Apelido | Nome da região cadastrada.');
                }
                return { alias, regiao };
            });
            await api('/settings', { method: 'PUT', body: {
                ...settings, regions, region_aliases, payments: payments.split('\n').map(p => p.trim()).filter(Boolean)
            } });
            await refresh();
        }, 'Configurações salvas.');
    }}>
        <div className="settings-grid">
            <section className="panel"><PanelHeading title="Estabelecimento" />
                <label>Nome<input required maxLength={100} value={settings.name} onChange={e => change('name', e.target.value)} /></label>
                <label>Aviso no cardápio<textarea maxLength={300} value={settings.menu_note} onChange={e => change('menu_note', e.target.value)} /></label>
            </section>
            <section className="panel"><PanelHeading title="Funcionamento" />
                <label>Horário de funcionamento<input maxLength={300} value={settings.hours} onChange={e => change('hours', e.target.value)} /></label>
                <label className="check"><input type="checkbox" checked={settings.menu_open} onChange={e => change('menu_open', e.target.checked)} /> Aceitar pedidos pelo site e WhatsApp</label>
            </section>
            <section className="panel"><PanelHeading title="Entregas" />
                <label>Regiões e taxas de entrega<textarea value={regionText} onChange={e => setRegionText(e.target.value)} placeholder="Bairro | 6,00" /></label>
                <p className="muted">Uma região por linha, no formato Bairro | 6,00.</p>
                <label>Apelidos das regiões<textarea value={aliases} onChange={e => setAliases(e.target.value)} placeholder="Apelido | Nome da região cadastrada" /></label>
            </section>
            <section className="panel"><PanelHeading title="Pagamentos" />
                <label>Formas de pagamento<textarea value={payments} onChange={e => setPayments(e.target.value)} /></label>
                <p className="muted">Uma forma de pagamento por linha.</p>
                <label>Chave Pix para atendimento<input maxLength={150} value={settings.pix_key ?? ''} onChange={e => change('pix_key', e.target.value)} /></label>
            </section>
        </div>
        <button disabled={busy}>Salvar configurações</button>
    </form>
    <WhatsAppSettings />
    <section className="panel" style={{ marginTop: 16 }}>
        <PanelHeading title="Atendimento humano"><button type="button" className="secondary small" onClick={handoffs.load}>Atualizar</button></PanelHeading>
        <ResourceError resource={handoffs} />
        {!handoffs.data && !handoffs.error && <Loading />}
        {handoffs.data?.length === 0 && <Empty>Nenhuma transferência ativa.</Empty>}
        {handoffs.data?.map(entry => <div key={entry.session_id} className="product">
            <div><strong>{entry.session_id}</strong><small>{formatDate(new Date(entry.requested_at).toISOString())}</small></div>
            <button type="button" disabled={busy} className="secondary small" onClick={() => action(async () => {
                await api('/conversation-handoffs/resume', { method: 'POST', body: { session_id: entry.session_id } });
                await handoffs.load();
            }, 'Atendimento automático retomado.')}>Retomar automação</button>
        </div>)}
    </section></>;
}
