import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Plus, RefreshCw } from 'lucide-react';
import { api, money, sources, statuses } from './client.js';
import { Badge, Dialog, Empty, formatDate, Loading, Notice, OrderStatus, ProductPhoto } from './ui.jsx';
import { Amount, Button, Feedback, Field, Overlay, PageHeading, Surface, Tag } from './design-system.jsx';
import { matches, StockTag } from './catalog-operation.jsx';
import { OrderTag } from './order-tags.jsx';
import { WhatsAppSettings } from './whatsapp-settings.jsx';

const parseMoney = value => value.trim() ? Math.round(Number(value.trim().replace(',', '.')) * 100) : NaN;
const source = order => sources[order.source] || 'Origem desconhecida';

function useResource(path) {
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const pending = useRef(null);
    const load = useCallback(async () => {
        pending.current?.abort();
        const controller = new AbortController();
        pending.current = controller;
        try {
            const updated = await api(path, { signal: controller.signal });
            if (!controller.signal.aborted) { setData(updated); setError(''); }
        } catch (err) { if (!controller.signal.aborted) setError(err.message); }
    }, [path]);
    useEffect(() => {
        const timer = setTimeout(load, 120);
        return () => { clearTimeout(timer); pending.current?.abort(); };
    }, [load]);
    return { data, error, load };
}

function ResourceError({ resource }) {
    return resource.error ? <Notice onRetry={resource.load}>{resource.error}</Notice> : null;
}

function PanelHeading({ title, children }) {
    return <div className="panel-heading"><h2>{title}</h2>{children}</div>;
}

export function Stock({ products, action, refresh, busy, error }) {
    const history = useResource('/stock/movements');
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('');
    const visible = products.filter(item => matches(item.name, query) &&
        (!filter || filter === 'empty' && item.stock === 0 || filter === 'low' && item.stock > 0 && item.stock <= 2));
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
        <PageHeading title="Estoque" description="Saldos e origem das movimenta??es."
            actions={<Button variant="primary" icon={Plus} disabled={!products.length} onClick={() => start()}>Movimentar</Button>} />
        <Surface className="operation-filters">
            <Field label="Buscar produto" type="search" value={query} onChange={e => setQuery(e.target.value)} />
            <Field as="select" label="Disponibilidade" value={filter} onChange={e => setFilter(e.target.value)}>
                <option value="">Todos</option><option value="empty">Esgotados</option><option value="low">Estoque baixo</option>
            </Field>
        </Surface>
        <div className="operation-split">
            <Surface title="Saldos do estoque">
                {!visible.length && <Feedback title="Nenhum produto neste filtro" />}
                {visible.map(product => <div key={product.id} className="operation-line">
                    <div><strong>{product.name}</strong><small>{product.stock} unidades dispon?veis</small></div>
                    <div className="ds-actions"><StockTag product={product} />
                        <Button variant="quiet" aria-label={'Movimentar ' + product.name} onClick={() => start(product.id)}>Ajustar</Button></div>
                </div>)}
            </Surface>
            <Surface title="Movimenta??es" actions={<Button variant="quiet" icon={RefreshCw} onClick={history.load}>Atualizar</Button>}>
                {history.error && <Feedback kind="error" title="Falha na consulta" onRetry={history.load}>{history.error}</Feedback>}
                {!history.data && !history.error && <Feedback kind="loading" title="Carregando hist?rico..." />}
                {history.data?.length === 0 && <Feedback title="Nenhuma movimenta??o registrada" />}
                {history.data?.map(row => <div key={row.id} className="operation-line">
                    <div><strong>{row.name} ? {row.reason}</strong>
                        <small>{row.order_id ? source(row) + ' #' + row.order_id :
                            row.reason === 'Saldo inicial' ? 'Cadastro' : 'Ajuste administrativo'} ? {formatDate(row.created_at)}</small></div>
                    <Tag tone={row.delta > 0 ? 'success' : 'warn'}>{row.delta > 0 ? '+' : ''}{row.delta} ? saldo {row.balance}</Tag>
                </div>)}
            </Surface>
        </div>
        {open && <Overlay drawer title="Movimentar estoque" onClose={() => setOpen(false)}>
            {error && <Feedback kind="error" title="Ajuste n?o conclu?do">{error}</Feedback>}
            <form className="operation-form" onSubmit={submit}>
                <Field as="select" label="Produto" required value={productId} onChange={e => setProductId(e.target.value)}>
                    <option value="">Selecione</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Field>
                <Field as="select" label="Tipo" value={type} onChange={e => setType(e.target.value)}>
                    <option value="in">Entrada</option><option value="out">Sa?da</option>
                </Field>
                <Field label="Quantidade" required type="number" min={1} value={units} onChange={e => setUnits(e.target.value)} />
                <Field label="Motivo" required maxLength={160} value={reason} onChange={e => setReason(e.target.value)} />
                <Button type="submit" variant="primary" disabled={busy}>Registrar movimenta??o</Button>
            </form>
        </Overlay>}
    </>;
}

export function Customers({ action }) {
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('name');
    const [selection, choose] = useState(null);
    const resource = useResource('/customers?' + new URLSearchParams({ q: query, sort }));
    return <>
        <PageHeading title="Clientes" description="Consulte contatos e hist?rico de pedidos." />
        <Surface className="operation-filters">
            <Field label="Buscar cliente" type="search" maxLength={100} placeholder="Nome ou telefone" value={query} onChange={e => setQuery(e.target.value)} />
            <Field as="select" label="Ordenar por" value={sort} onChange={e => setSort(e.target.value)}>
                <option value="name">Nome</option><option value="recent">?ltima compra</option><option value="repeat">Quantidade de pedidos</option>
            </Field>
        </Surface>
        <Surface title="Clientes cadastrados">
            {resource.error && <Feedback kind="error" title="Falha na consulta" onRetry={resource.load}>{resource.error}</Feedback>}
            {!resource.data && !resource.error && <Feedback kind="loading" title="Carregando clientes..." />}
            {resource.data?.length === 0 && <Feedback title="Nenhum cliente encontrado" />}
            {resource.data?.map(customer =>
                <div className="operation-line customer-row" key={customer.id}>
                    <div><strong>{customer.name}</strong><small>{customer.phone}</small></div>
                    <div><strong>{customer.orders} pedidos</strong><small>?ltima compra ? {formatDate(customer.last_order_at)}</small></div>
                    <div><strong><Amount cents={customer.ordered_cents} /></strong><small>Valor acumulado dos pedidos</small></div>
                    <Button variant="quiet" icon={ArrowRight} onClick={() => action(async () =>
                        choose({ customer, orders: await api('/customers/' + customer.id + '/orders') }))}>Hist?rico</Button>
                </div>)}
        </Surface>
        {selection && <Overlay drawer title={'Pedidos de ' + selection.customer.name} onClose={() => choose(null)}>
            {!selection.orders.length && <Feedback title="Nenhum pedido registrado" />}
            {selection.orders.map(row => <div className="operation-line" key={row.id}><div><strong>#{row.id} ? {source(row)}</strong>
                <small>{formatDate(row.created_at)}</small></div><OrderTag status={row.status} /><Amount cents={row.total_cents} /></div>)}
        </Overlay>}
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
