import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Boxes, ClipboardList, Clock3, Package, Pencil, Plus, RefreshCw, Search, ShoppingBag, Wallet } from 'lucide-react';
import { api, money, nextStatus, sources, statuses } from './client.js';
import { Badge, Dialog, Empty, formatDate, Loading, Notice, OrderStatus, ProductPhoto } from './ui.jsx';

const emptyProduct = { name: '', price: '', stock: '0', description: '', category: '', image_url: '', active: true };
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

export function Dashboard({ data, orders, navigate }) {
    const metrics = [
        ['Pedidos de hoje', data.today, ShoppingBag, 'mint'],
        ['Faturamento do dia', money(data.total_cents), Wallet, 'peach'],
        ['Pendentes de hoje', data.pending, Clock3, 'sand'],
        ['Itens com estoque baixo', data.low_stock.length, Boxes, 'blue']
    ];
    return <>
        <section className="dashboard-hero">
            <div><p className="hero-date">{new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Sao_Paulo' })}</p>
                <h2>Operação de hoje</h2>
                <p>Acompanhe as vendas e mantenha o estoque em dia.</p>
            </div>
            <div className="hero-actions">
                <button className="accent" onClick={() => navigate('novo')}><Plus size={19} /> Pedido de balcão</button>
                <button className="hero-secondary" onClick={() => navigate('pedidos')}><ClipboardList size={18} /> Ver pedidos</button>
            </div>
        </section>
        <section className="metrics" aria-label="Indicadores do dia">
            {metrics.map(([label, value, Icon, tone]) => <article className="panel metric" key={label}>
                <span className={'metric-icon ' + tone}><Icon size={22} /></span>
                <div><span>{label}</span><strong>{value}</strong></div>
            </article>)}
        </section>
        <div className="dashboard-grid">
            <section className="panel dashboard-recent">
                <PanelHeading title="Pedidos recentes"><button className="text-button" onClick={() => navigate('pedidos')}>Ver todos <ArrowRight size={17} /></button></PanelHeading>
                {!orders.length ? <Empty>Nenhum pedido registrado.</Empty> : <div className="recent-list">
                    {orders.slice(0, 5).map(order => <div className="recent-row" key={order.id}>
                        <span className="recent-icon"><ShoppingBag size={19} /></span>
                        <div className="recent-client"><strong>#{order.id} · {order.customer_name || 'Cliente'}</strong><small>{source(order)} · {formatDate(order.created_at, { timeStyle: 'short' })}</small></div>
                        <OrderStatus status={order.status} /><strong className="recent-total">{money(order.total_cents)}</strong>
                    </div>)}
                </div>}
            </section>
            <section className="panel dashboard-stock">
                <PanelHeading title="Atenção ao estoque"><button className="text-button icon-button" aria-label="Abrir estoque" onClick={() => navigate('estoque')}><ArrowUpRight size={19} /></button></PanelHeading>
                {!data.low_stock.length ? <Empty>Nenhum produto com estoque baixo.</Empty> : data.low_stock.slice(0, 5).map(product => <div className="stock-preview" key={product.id}>
                    <span className="metric-icon peach"><Package size={18} /></span><strong>{product.name}</strong>
                    <Badge tone={product.stock ? 'warning' : 'danger'}>{product.stock} un.</Badge>
                </div>)}
            </section>
        </div>
    </>;
}

export function Orders({ orders, refresh, action, busy, error }) {
    const [details, setDetails] = useState(null);
    const [filter, setFilter] = useState('all');
    const visible = filter === 'all' ? orders : orders.filter(order => order.status === filter);
    async function open(id) { setDetails(await api(`/orders/${id}`)); }

    return <>
        <section className="panel">
            <PanelHeading title="Todos os pedidos"><button className="secondary small" onClick={() => action(refresh)}><RefreshCw size={16} /> Atualizar</button></PanelHeading>
            <div className="filters" aria-label="Filtrar pedidos">
                {[['all', 'Todos'], ...Object.entries(statuses)].map(([id, label]) => <button key={id} type="button" aria-pressed={id === filter} onClick={() => setFilter(id)}>{label}</button>)}
            </div>
            {!visible.length ? <Empty>Nenhum pedido neste filtro.</Empty> : <div className="orders-table">
                <div className="orders-head" aria-hidden="true"><span>Pedido / Cliente</span><span>Origem</span><span>Horário</span><span>Status</span><span>Total</span><span>Detalhes</span></div>
                {visible.map(order => <article className={'order-row ' + (order.status === 'pending' ? 'pending-order' : '')} key={order.id}>
                    <div className="order-client"><small>#{order.id}{order.status === 'pending' && <span className="new-dot" aria-label="Pendente" />}</small><strong>{order.customer_name || 'Cliente'}</strong></div>
                    <span className="order-source">{source(order)}</span>
                    <span className="order-time">{formatDate(order.created_at)}</span>
                    <OrderStatus status={order.status} />
                    <strong className="order-total">{money(order.total_cents)}</strong>
                    <button className="secondary small order-action" aria-label={`Ver pedido ${order.id}`} onClick={() => action(() => open(order.id))}>Detalhes <ArrowRight size={15} /></button>
                </article>)}
            </div>}
        </section>
        {details && <Dialog title={`Pedido #${details.id}`} onClose={() => setDetails(null)}>
            {error && <Notice>{error}</Notice>}
            <div className="detail-bar"><OrderStatus status={details.status} /><span>{source(details)} · {formatDate(details.created_at)}</span></div>
            <dl className="details-grid">
                <div><dt>Cliente</dt><dd>{details.details?.name || details.customer_name || '—'}</dd></div>
                <div><dt>Telefone</dt><dd>{details.phone || '—'}</dd></div>
                <div><dt>Recebimento</dt><dd>{details.details ? details.details.fulfillment === 'delivery' ? `Entrega · ${details.details.address}, ${details.details.region}` : 'Retirada' : 'Não informado'}</dd></div>
                <div><dt>Pagamento</dt><dd>{details.payment?.method || details.details?.payment || 'Não informado'}</dd></div>
                <div><dt>Situação do pagamento</dt><dd>{details.payment?.status === 'received' ? 'Recebido' :
                    details.payment ? 'Aguardando recebimento' : 'Sem registro de pagamento'}</dd></div>
                {details.payment?.cash_tendered_cents != null && <div><dt>Valor entregue</dt>
                    <dd>{money(details.payment.cash_tendered_cents)}</dd></div>}
                {details.payment?.change_cents != null && <div><dt>Troco</dt><dd>{money(details.payment.change_cents)}</dd></div>}
            </dl>
            <h3>Itens</h3>
            {details.items.map(item => <div key={item.id} className="product"><span>{item.quantity} × {item.name}</span><strong>{money(item.quantity * item.unit_price_cents)}</strong></div>)}
            {details.details && <p className="total"><span>Frete</span><span>{money(details.details.shipping_cents)}</span></p>}
            <p className="total"><strong>Total</strong><strong>{money(details.total_cents)}</strong></p>
            {details.pix_instructions && <p>Chave Pix <strong>{details.pix_instructions.key}</strong></p>}
            {details.payment?.method.toLowerCase() === 'pix' && details.payment.status === 'pending' &&
                <button className="secondary full" disabled={busy} onClick={() => {
                    if (!window.confirm('Você conferiu o recebimento deste Pix?')) return;
                    action(async () => {
                        await api(`/orders/${details.id}/payment`, { method: 'PATCH', body: { status: 'received' } });
                        await open(details.id);
                    }, 'Recebimento do Pix registrado.');
                }}>Registrar Pix recebido</button>}
            {nextStatus[details.status] && <button className="full" disabled={busy} onClick={() => action(async () => {
                await api(`/orders/${details.id}/status`, { method: 'PATCH', body: { status: nextStatus[details.status] } });
                await open(details.id);
                await refresh();
            }, 'Status atualizado.')}>Marcar como {statuses[nextStatus[details.status]].toLowerCase()}</button>}
        </Dialog>}
    </>;
}

export function Products({ products, action, refresh, busy, error }) {
    const [draft, setDraft] = useState(emptyProduct);
    const [editing, setEditing] = useState(null);
    const [open, setOpen] = useState(false);
    function field(name, value) { setDraft(previous => ({ ...previous, [name]: value })); }
    function edit(product) {
        setEditing(product?.id ?? null);
        setDraft(product ? {
            name: product.name, price: (product.price_cents / 100).toFixed(2),
            stock: String(product.stock), description: product.description || '', category: product.category || '',
            image_url: product.image_url || '', active: Boolean(product.active)
        } : emptyProduct);
        setOpen(true);
    }
    function save(event) {
        event.preventDefault();
        action(async () => {
            const { price, stock, ...metadata } = draft;
            const body = { ...metadata, price_cents: parseMoney(price) };
            if (!Number.isSafeInteger(body.price_cents) || body.price_cents < 0) throw new Error('Informe um preço válido.');
            await api(editing ? `/products/${editing}` : '/products', {
                method: editing ? 'PATCH' : 'POST',
                body: editing ? body : { ...body, stock: Number(stock) }
            });
            setOpen(false);
            await refresh();
        }, editing ? 'Produto atualizado.' : 'Produto cadastrado.');
    }
    return <>
        <div className="module-bar"><p>{products.length} {products.length === 1 ? 'produto no catálogo' : 'produtos no catálogo'}</p>
            <button onClick={() => edit()}><Plus size={19} /> Novo produto</button></div>
        {!products.length ? <section className="panel"><Empty>Cadastre o primeiro produto do catálogo.</Empty></section> : <section className="catalog-grid">
            {products.map(product => <article className="panel catalog-card" key={product.id}>
                <ProductPhoto url={product.image_url} name={product.name} className="catalog-photo" />
                <div className="catalog-body">
                    <span className="muted">{product.category || 'Sem categoria'}</span>
                    <h2>{product.name}</h2>
                    <p className="catalog-price">{money(product.price_cents)} <small>{product.stock} un.</small></p>
                    <div className="catalog-actions">{product.active ? <StockLevel stock={product.stock} /> : <Badge>Inativo</Badge>}
                        <button className="secondary small" aria-label={`Editar ${product.name}`} onClick={() => edit(product)}><Pencil size={16} /> Editar</button>
                    </div>
                </div>
            </article>)}
        </section>}
        {open && <Dialog title={editing ? 'Editar produto' : 'Novo produto'} onClose={() => setOpen(false)}>
            {error && <Notice>{error}</Notice>}
            <form onSubmit={save}>
                <label>Nome<input required maxLength={80} value={draft.name} onChange={e => field('name', e.target.value)} /></label>
                <div className="form-grid">
                    <label>Categoria<input maxLength={80} value={draft.category} onChange={e => field('category', e.target.value)} /></label>
                    <label>Preço em reais<input required inputMode="decimal" value={draft.price} onChange={e => field('price', e.target.value)} /></label>
                </div>
                <label>Descrição<textarea maxLength={500} value={draft.description} onChange={e => field('description', e.target.value)} /></label>
                <label>URL HTTPS da imagem<input type="url" value={draft.image_url} onChange={e => field('image_url', e.target.value)} /></label>
                {!editing && <label>Estoque inicial<input required type="number" min={0} value={draft.stock} onChange={e => field('stock', e.target.value)} /></label>}
                <label className="check"><input type="checkbox" checked={draft.active} onChange={e => field('active', e.target.checked)} /> Ativo no cardápio</label>
                <button className="full" disabled={busy}>{editing ? 'Salvar alterações' : 'Cadastrar produto'}</button>
            </form>
        </Dialog>}
    </>;
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
