import React from 'react';
import { ArrowRight, Boxes, CalendarDays, ClipboardList, Clock3, Plus, Receipt, Wallet } from 'lucide-react';
import { Amount, Button, Feedback, PageHeading, Surface, Tag } from './design-system.jsx';
import { sources } from './client.js';
import { OrderTag } from './order-tags.jsx';
import { formatDate } from './ui.jsx';
import './overview.css';

const date = () => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeZone: 'America/Sao_Paulo' }).format(new Date());

function Metric({ title, value, note, icon: Icon, tone }) {
    return <div className={'overview-metric overview-metric--' + tone}>
        <div className="overview-metric-title"><span><Icon size={19} aria-hidden="true" /></span><h2>{title}</h2></div>
        <strong className="overview-value">{value}</strong>
        <small>{note}</small>
    </div>;
}

export function Dashboard({ data, orders, navigate }) {
    const recent = orders.filter(order => order.source !== 'whatsapp-simulated').slice(0, 6);
    const channels = [...(data?.channels ?? [])].sort((a, b) => b.count - a.count);
    const received = data?.received_today_cents;
    return <div className="ops-overview">
        <PageHeading title="Visão geral" context={date()} description="Pedidos, recebimentos registrados e alertas da operação."
            actions={<Button icon={Plus} variant="primary" onClick={() => navigate('novo')}>Pedido de balcão</Button>} />
        {data && <>
            <section className="overview-metrics" aria-label="Indicadores do dia">
                <Metric title="Pedidos do dia" value={data.today} note="Todos os canais comerciais" icon={ClipboardList} tone="brasa" />
                <Metric title="Pendentes do dia" value={data.pending} note="Aguardando confirmação" icon={Clock3} tone="amber" />
                <Metric title="Valor dos pedidos" value={<Amount cents={data.total_cents} />} note="Pedidos registrados hoje" icon={Receipt} tone="neutral" />
                <Metric title="Recebimentos registrados" value={received == null ? '—' : <Amount cents={received} />}
                    note={received == null ? 'Informação indisponível' : `${data.received_today} pagamentos registrados hoje`} icon={Wallet} tone="positive" />
            </section>
            <div className="overview-columns">
                <Surface title="Pedidos recentes" className="overview-recent"
                    actions={<Button icon={ArrowRight} variant="quiet" onClick={() => navigate('pedidos')}>Ver pedidos</Button>}>
                    {!recent.length ? <Feedback title="Nenhum pedido registrado">Os pedidos comerciais aparecem aqui.</Feedback> :
                        <ul className="overview-order-list">{recent.map(order => <li key={order.id}>
                            <div className="overview-order-name"><strong>{order.customer_name || 'Cliente'}</strong>
                                <small>#{order.id} · {sources[order.source] || 'Origem desconhecida'} · {formatDate(order.created_at, { timeStyle: 'short' })}</small>
                            </div>
                            <OrderTag status={order.status} />
                            <strong><Amount cents={order.total_cents} /></strong>
                        </li>)}</ul>}
                </Surface>
                <div className="overview-stack">
                    <Surface title="Estoque em atenção" actions={<Button icon={Boxes} variant="quiet" onClick={() => navigate('estoque')}>Ver estoque</Button>}>
                        {!data.low_stock.length ? <Feedback title="Estoque sem alertas">Nenhum produto ativo com duas unidades ou menos.</Feedback> :
                            <ul className="overview-stock-list">{data.low_stock.slice(0, 5).map(product => <li key={product.id}>
                                <strong>{product.name}</strong>
                                <Tag tone={product.stock ? 'warn' : 'danger'}>{product.stock ? `${product.stock} un.` : 'Esgotado'}</Tag>
                            </li>)}</ul>}
                    </Surface>
                    <Surface title="Pedidos por canal" actions={<CalendarDays size={17} aria-hidden="true" />}>
                        {!channels.length ? <Feedback title="Sem pedidos hoje">A distribuição aparece com o primeiro pedido do dia.</Feedback> :
                            <ul className="overview-channels">{channels.map(channel => <li key={channel.source}>
                                <div><span>{sources[channel.source] || 'Origem desconhecida'}</span><strong>{channel.count}</strong></div>
                                <span className="overview-bar" aria-hidden="true"><i style={{ width: 100 * channel.count / data.today + '%' }} /></span>
                            </li>)}</ul>}
                    </Surface>
                </div>
            </div>
            {(data.orders_pending_payment > 0 || data.orders_without_payment > 0) && <p className="overview-finance-note">
                Dos pedidos de hoje, {data.orders_pending_payment} aguardam recebimento e {data.orders_without_payment} estão sem registro financeiro.
            </p>}
        </>}
    </div>;
}
