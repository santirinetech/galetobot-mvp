import React, { useEffect, useState } from 'react';
import { ArrowRight, ClipboardList, Columns3, List, RefreshCw } from 'lucide-react';
import { api, nextStatus, sources, statuses } from './client.js';
import { formatDate } from './ui.jsx';
import { Amount, Button, ChoiceGroup, DataTable, Feedback, Field, Overlay, PageHeading, Surface } from './design-system.jsx';
import { OrderTag, PaymentTag, orderTones } from './order-tags.jsx';
import './orders-pilot.css';

const layouts = [{ id: 'list', label: 'Lista', icon: List }, { id: 'board', label: 'Kanban', icon: Columns3 }];
const statusOptions = [{ id: 'all', label: 'Todos' }, ...Object.entries(statuses).map(([id, label]) => ({ id, label }))];
const columns = ['Pedido / Cliente', 'Canal', 'Horário', 'Status do pedido', 'Pagamento', 'Total', 'Ações'];
const advanceLabels = { confirmed: 'Confirmar', preparing: 'Iniciar preparo', ready: 'Marcar pronto', completed: 'Concluir' };
const source = order => sources[order.source] || 'Origem desconhecida';
const searchable = value => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const initials = name => (name || 'Cliente').trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const time = order => formatDate(order.created_at, { timeStyle: 'short' });

function DetailButton({ order, choose }) {
    return <Button variant="quiet" icon={ArrowRight} aria-label={`Ver pedido ${order.id}`} onClick={() => choose(order.id)}>Detalhes</Button>;
}

function OrderCard({ order, choose, advance, busy, board }) {
    const next = nextStatus[order.status];
    return <article className={'ops-order-card tone-' + (orderTones[order.status] ?? 'neutral')}>
        <div className="ops-order-card-meta"><strong>#{order.id}</strong><time>{time(order)}</time></div>
        <div className="ops-order-card-name">
            <strong>{order.customer_name || 'Cliente'}</strong><small>{source(order)}</small>
        </div>
        <div className="ops-order-card-tags">
            {!board && <OrderTag status={order.status} />}<PaymentTag status={order.payment_status} />
        </div>
        <div className="ops-order-card-end"><strong><Amount cents={order.total_cents} /></strong>
            <DetailButton order={order} choose={choose} /></div>
        {board && next && <Button className="ops-advance" disabled={busy}
            aria-label={`${advanceLabels[next]} pedido ${order.id}`} onClick={() => advance(order)}>
            {advanceLabels[next]}
        </Button>}
    </article>;
}

function OrderRows({ orders, choose }) {
    return <>
        <DataTable className="ops-orders-table" label="Pedidos comerciais" columns={columns}>
            {orders.map(order => <tr key={order.id} className={order.status === 'pending' ? 'ops-order-pending' : undefined}>
                <td><div className="ops-order-identity">
                    <span className="ops-order-initials" aria-hidden="true">{initials(order.customer_name)}</span>
                    <span><strong>{order.customer_name || 'Cliente'}</strong><small>#{order.id}</small></span>
                </div></td>
                <td>{source(order)}</td>
                <td className="ops-order-time">{time(order)}<small>{formatDate(order.created_at, { dateStyle: 'short' })}</small></td>
                <td><OrderTag status={order.status} /></td>
                <td><PaymentTag status={order.payment_status} />
                    {order.payment_method && <small className="ops-payment-method">{order.payment_method}</small>}</td>
                <td><strong><Amount cents={order.total_cents} /></strong></td>
                <td><DetailButton order={order} choose={choose} /></td>
            </tr>)}
        </DataTable>
        <div className="ops-orders-cards">{orders.map(order => <OrderCard key={order.id} order={order} choose={choose} />)}</div>
    </>;
}

function Board({ orders, filter, choose, advance, busy }) {
    const lanes = Object.entries(statuses).filter(([status]) => filter === 'all' || status === filter);
    return <section className="ops-board" aria-label="Kanban de pedidos" tabIndex={0}>
        {lanes.map(([status, label]) => {
            const items = orders.filter(order => order.status === status);
            return <section key={status} className={'ops-lane tone-' + orderTones[status]} aria-label={label}>
                <header><h2>{label}</h2><span>{items.length}</span></header>
                <div className="ops-lane-body">
                    {items.length ? items.map(order => <OrderCard key={order.id} {...{ order, choose, advance, busy }} board />)
                        : <p>Sem pedidos neste status.</p>}
                </div>
            </section>;
        })}
    </section>;
}

function OrderDetails({ details, busy, error, onPayment, onStatus }) {
    const checkout = details.details, payment = details.payment;
    return <>
        {error && <Feedback kind="error" title="Operação não concluída">{error}</Feedback>}
        <div className="ops-drawer-summary">
            <div><OrderTag status={details.status} /> <PaymentTag status={payment?.status} /></div>
            <span>{source(details)} · {formatDate(details.created_at)}</span>
        </div>
        <dl className="ops-drawer-facts">
            <div><dt>Cliente</dt><dd>{checkout?.name || details.customer_name || '—'}</dd></div>
            <div><dt>Telefone</dt><dd>{details.phone || '—'}</dd></div>
            <div><dt>Recebimento</dt><dd>{checkout ? checkout.fulfillment === 'delivery' ?
                `Entrega · ${checkout.address}, ${checkout.region}` : 'Retirada' : 'Não informado'}</dd></div>
            <div><dt>Método de pagamento</dt><dd>{payment?.method || checkout?.payment || 'Não informado'}</dd></div>
            {payment?.cash_tendered_cents != null && <div><dt>Valor entregue</dt><dd><Amount cents={payment.cash_tendered_cents} /></dd></div>}
            {payment?.change_cents != null && <div><dt>Troco</dt><dd><Amount cents={payment.change_cents} /></dd></div>}
        </dl>
        <h3>Itens do pedido</h3>
        <dl className="ops-drawer-items">
            {details.items.map(item => <div key={item.id}><dt>{item.quantity} × {item.name}</dt>
                <dd><Amount cents={item.quantity * item.unit_price_cents} /></dd></div>)}
            {checkout && <div><dt>Frete</dt><dd><Amount cents={checkout.shipping_cents} /></dd></div>}
            <div className="ops-drawer-total"><dt>Total</dt><dd><Amount cents={details.total_cents} /></dd></div>
        </dl>
        {details.pix_instructions && <p className="ops-drawer-pix">Chave Pix <strong>{details.pix_instructions.key}</strong></p>}
        <div className="ds-actions">
            {payment?.method.toLowerCase() === 'pix' && payment.status === 'pending' &&
                <Button disabled={busy} onClick={onPayment}>Registrar Pix recebido</Button>}
            {nextStatus[details.status] && <Button variant="primary" disabled={busy} onClick={onStatus}>
                Marcar como {statuses[nextStatus[details.status]].toLowerCase()}
            </Button>}
        </div>
    </>;
}

export function Orders({ orders, refresh, action, busy, error, ready }) {
    const [layout, setLayout] = useState('list');
    const [filter, setFilter] = useState('all');
    const [search, setSearch] = useState('');
    const [channel, setChannel] = useState('all');
    const [selected, choose] = useState(null);
    const [details, setDetails] = useState(null);
    const [loadError, setLoadError] = useState('');
    const [reload, setReload] = useState(0);
    const visible = orders.filter(order => (filter === 'all' || order.status === filter) &&
        (channel === 'all' || order.source === channel) &&
        searchable(`#${order.id} ${order.customer_name ?? ''}`).includes(searchable(search.trim())));

    function open(id) { setDetails(null); setLoadError(''); choose(id); }
    useEffect(() => {
        if (selected === null) return;
        const controller = new AbortController();
        api(`/orders/${selected}`, { signal: controller.signal }).then(setDetails)
            .catch(err => { if (!controller.signal.aborted) setLoadError(err.message); });
        return () => controller.abort();
    }, [selected, reload]);

    function advance(order, drawer = false) {
        const status = nextStatus[order.status];
        if (!status) return;
        action(async () => {
            await api(`/orders/${order.id}/status`, { method: 'PATCH', body: { status } });
            if (drawer) setReload(reload => reload + 1);
            await refresh();
        }, 'Status atualizado.');
    }
    function receive() {
        if (!window.confirm('Você conferiu o recebimento deste Pix?')) return;
        action(async () => {
            await api(`/orders/${selected}/payment`, { method: 'PATCH', body: { status: 'received' } });
            setReload(reload => reload + 1);
            await refresh();
        }, 'Recebimento do Pix registrado.');
    }

    return <div className="ops-orders">
        <PageHeading title="Pedidos" description="Acompanhe o preparo e confira o pagamento de cada pedido."
            actions={<Button icon={RefreshCw} onClick={() => action(refresh)} disabled={busy}>Atualizar</Button>} />
        {ready && <>
            <Surface className="ops-order-tools">
                <div className="ops-order-controls">
                    <Field label="Buscar pedido" type="search" placeholder="Número ou cliente" value={search} onChange={e => setSearch(e.target.value)} />
                    <Field as="select" label="Canal" value={channel} onChange={e => setChannel(e.target.value)}>
                        <option value="all">Todos os canais</option>
                        {Object.entries(sources).map(([key, name]) => <option key={key} value={key}>{name}</option>)}
                    </Field>
                    <div className="ops-layout"><ChoiceGroup label="Visualização" options={layouts} value={layout} onChange={setLayout} /></div>
                </div>
                <div className="ops-order-filter">
                    <ChoiceGroup label="Filtrar por status" options={statusOptions} value={filter} onChange={setFilter} />
                    <span aria-live="polite">{visible.length} {visible.length === 1 ? 'pedido' : 'pedidos'}</span>
                </div>
            </Surface>
            {!visible.length ? <Surface><Feedback title={orders.length ? 'Nenhum pedido neste filtro' : 'Nenhum pedido registrado'}>
                {orders.length ? 'Ajuste os filtros para consultar outros pedidos.' : 'Os pedidos recebidos pelos canais de venda aparecem aqui.'}
            </Feedback></Surface> : layout === 'list' ? <Surface><OrderRows orders={visible} choose={open} /></Surface>
                : <Board orders={visible} filter={filter} choose={open} advance={advance} busy={busy} />}
        </>}
        {selected !== null && <Overlay title={`Pedido #${selected}`} drawer onClose={() => choose(null)}>
            {loadError ? <Feedback kind="error" title="Não foi possível abrir o pedido"
                onRetry={() => { setLoadError(''); setReload(value => value + 1); }}>{loadError}</Feedback>
                : details ? <OrderDetails {...{ details, busy, error }} onPayment={receive} onStatus={() => advance(details, true)} />
                    : <Feedback kind="loading" title="Carregando detalhes do pedido…" />}
        </Overlay>}
    </div>;
}
