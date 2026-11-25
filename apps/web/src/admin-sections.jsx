import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Plus, RefreshCw } from 'lucide-react';
import { api, money, sources, statuses } from './client.js';
import { Badge, Dialog, Empty, formatDate, Loading, Notice, OrderStatus, ProductPhoto } from './ui.jsx';
import { Amount, Button, Feedback, Field, Overlay, PageHeading, Surface, Tag } from './design-system.jsx';
import { matches, PhotoInput, StockTag } from './catalog-operation.jsx';
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
        <PageHeading title="Estoque" description="Saldos e origem das movimentações."
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
                    <div><strong>{product.name}</strong><small>{product.stock} unidades disponíveis</small></div>
                    <div className="ds-actions"><StockTag product={product} />
                        <Button variant="quiet" aria-label={'Movimentar ' + product.name} onClick={() => start(product.id)}>Ajustar</Button></div>
                </div>)}
            </Surface>
            <Surface title="Movimentações" actions={<Button variant="quiet" icon={RefreshCw} onClick={history.load}>Atualizar</Button>}>
                {history.error && <Feedback kind="error" title="Falha na consulta" onRetry={history.load}>{history.error}</Feedback>}
                {!history.data && !history.error && <Feedback kind="loading" title="Carregando histórico..." />}
                {history.data?.length === 0 && <Feedback title="Nenhuma movimentação registrada" />}
                {history.data?.map(row => <div key={row.id} className="operation-line">
                    <div><strong>{row.name} · {row.reason}</strong>
                        <small>{row.order_id ? source(row) + ' #' + row.order_id :
                            row.reason === 'Saldo inicial' ? 'Cadastro' : 'Ajuste administrativo'} · {formatDate(row.created_at)}</small></div>
                    <Tag tone={row.delta > 0 ? 'success' : 'warn'}>{row.delta > 0 ? '+' : ''}{row.delta} · saldo {row.balance}</Tag>
                </div>)}
            </Surface>
        </div>
        {open && <Overlay drawer title="Movimentar estoque" onClose={() => setOpen(false)}>
            {error && <Feedback kind="error" title="Ajuste não concluído">{error}</Feedback>}
            <form className="operation-form" onSubmit={submit}>
                <Field as="select" label="Produto" required value={productId} onChange={e => setProductId(e.target.value)}>
                    <option value="">Selecione</option>{products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Field>
                <Field as="select" label="Tipo" value={type} onChange={e => setType(e.target.value)}>
                    <option value="in">Entrada</option><option value="out">Saída</option>
                </Field>
                <Field label="Quantidade" required type="number" min={1} value={units} onChange={e => setUnits(e.target.value)} />
                <Field label="Motivo" required maxLength={160} value={reason} onChange={e => setReason(e.target.value)} />
                <Button type="submit" variant="primary" disabled={busy}>Registrar movimentação</Button>
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
        <PageHeading title="Clientes" description="Consulte contatos e histórico de pedidos." />
        <Surface className="operation-filters">
            <Field label="Buscar cliente" type="search" maxLength={100} placeholder="Nome ou telefone" value={query} onChange={e => setQuery(e.target.value)} />
            <Field as="select" label="Ordenar por" value={sort} onChange={e => setSort(e.target.value)}>
                <option value="name">Nome</option><option value="recent">Última compra</option><option value="repeat">Quantidade de pedidos</option>
            </Field>
        </Surface>
        <Surface title="Clientes cadastrados">
            {resource.error && <Feedback kind="error" title="Falha na consulta" onRetry={resource.load}>{resource.error}</Feedback>}
            {!resource.data && !resource.error && <Feedback kind="loading" title="Carregando clientes..." />}
            {resource.data?.length === 0 && <Feedback title="Nenhum cliente encontrado" />}
            {resource.data?.map(customer =>
                <div className="operation-line customer-row" key={customer.id}>
                    <div><strong>{customer.name}</strong><small>{customer.phone}</small></div>
                    <div><strong>{customer.orders} pedidos</strong><small>Última compra · {formatDate(customer.last_order_at)}</small></div>
                    <div><strong><Amount cents={customer.ordered_cents} /></strong><small>Valor acumulado dos pedidos</small></div>
                    <Button variant="quiet" icon={ArrowRight} onClick={() => action(async () =>
                        choose({ customer, orders: await api('/customers/' + customer.id + '/orders') }))}>Histórico</Button>
                </div>)}
        </Surface>
        {selection && <Overlay drawer title={'Pedidos de ' + selection.customer.name} onClose={() => choose(null)}>
            {!selection.orders.length && <Feedback title="Nenhum pedido registrado" />}
            {selection.orders.map(row => <div className="operation-line" key={row.id}><div><strong>#{row.id} · {source(row)}</strong>
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
    const [file, setFile] = useState(null);
    const [remove, setRemove] = useState(false);
    useEffect(() => {
        if (!resource.data) return;
        setSettings(resource.data);
        setRegionText(resource.data.regions.map(row => `${row.name} | ${(row.shipping_cents / 100).toFixed(2)}`).join('\n'));
        setPayments(resource.data.payments.join('\n'));
        setAliases((resource.data.region_aliases ?? []).map(row => `${row.alias} | ${row.regiao}`).join('\n'));
    }, [resource.data]);
    const heading = <PageHeading title="Configurações" description="Identidade da loja, canais de atendimento e regras de operação." />;
    if (!settings) return <>{heading}{resource.error ?
        <Feedback kind="error" title="Falha na consulta" onRetry={resource.load}>{resource.error}</Feedback> :
        <Feedback kind="loading" title="Carregando configurações..." />}</>;
    const change = (field, value) => setSettings(current => ({ ...current, [field]: value }));
    function save(event) {
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
                if (rest.length || !alias || !regions.some(region => region.name === regiao)) {
                    throw new Error('Informe cada apelido no formato Apelido | Nome da região cadastrada.');
                }
                return { alias, regiao };
            });
            await api('/settings', { method: 'PUT', body: {
                ...settings, regions, region_aliases, payments: payments.split('\n').map(p => p.trim()).filter(Boolean)
            } });
            if (file) await api('/settings/logo', { method: 'POST', file });
            else if (remove) await api('/settings/logo', { method: 'DELETE' });
            setFile(null);
            setRemove(false);
            await Promise.all([resource.load(), refresh()]);
        }, 'Configurações salvas.');
    }
    return <>{heading}<form onSubmit={save}>
        <div className="store-settings-grid">
            <Surface title="Identidade do estabelecimento"><div className="operation-form">
                <Field label="Nome comercial" required maxLength={100} value={settings.name} onChange={e => change('name', e.target.value)} />
                <Field as="textarea" label="Aviso no cardápio" maxLength={300} value={settings.menu_note} onChange={e => change('menu_note', e.target.value)} />
                <Field as="select" label="Identidade do cardápio" value={settings.brand_theme ?? 'brasa'} onChange={e => change('brand_theme', e.target.value)}>
                    <option value="brasa">Brasa</option><option value="carvao">Carvão</option>
                </Field>
                <PhotoInput url={settings.logo_url} file={file} remove={remove}
                    onFile={next => { setFile(next); setRemove(false); }} onRemove={() => { setFile(null); setRemove(!remove); }} />
            </div></Surface>
            <Surface title="Funcionamento e contato"><div className="operation-form">
                <Field label="Horário de funcionamento" maxLength={300} value={settings.hours} onChange={e => change('hours', e.target.value)} />
                <Field label="Contato de atendimento humano (HTTPS)" type="url" maxLength={500} value={settings.human_contact_url ?? ''}
                    onChange={e => change('human_contact_url', e.target.value)} />
                <label className="check"><input type="checkbox" checked={settings.menu_open} onChange={e => change('menu_open', e.target.checked)} /> Aceitar pedidos pelos canais públicos</label>
                <label className="check"><input type="checkbox" checked={settings.pickup_enabled !== false} onChange={e => change('pickup_enabled', e.target.checked)} /> Permitir retirada na loja</label>
            </div></Surface>
            <Surface title="Entrega"><div className="operation-form">
                <Field as="textarea" label="Bairros e taxas" value={regionText} onChange={e => setRegionText(e.target.value)} placeholder="Bairro | 6,00" />
                <Field as="textarea" label="Apelidos de bairros" value={aliases} onChange={e => setAliases(e.target.value)} placeholder="Apelido | Nome da região cadastrada" />
                <small>Sem regiões cadastradas, a entrega fica indisponível.</small>
            </div></Surface>
            <Surface title="Pagamentos"><div className="operation-form">
                <Field as="textarea" label="Formas de pagamento · uma por linha" value={payments} onChange={e => setPayments(e.target.value)} />
                <Field label="Chave Pix" maxLength={150} value={settings.pix_key ?? ''} onChange={e => change('pix_key', e.target.value)} />
            </div></Surface>
        </div>
        <Button type="submit" variant="primary" disabled={busy}>Salvar configurações</Button>
    </form>
    <WhatsAppSettings />
    <Surface title="Atendimento humano" className="store-handoffs" actions={<Button variant="quiet" onClick={handoffs.load}>Atualizar</Button>}>
        {handoffs.error && <Feedback kind="error" title="Falha na consulta" onRetry={handoffs.load}>{handoffs.error}</Feedback>}
        {!handoffs.data && !handoffs.error && <Feedback kind="loading" title="Consultando transferências..." />}
        {handoffs.data?.length === 0 && <Feedback title="Nenhuma transferência ativa" />}
        {handoffs.data?.map(entry => <div key={entry.session_id} className="operation-line">
            <div><strong>{entry.session_id.startsWith('web:') ? 'Chat Web' : 'WhatsApp'}</strong>
                <small>Conversa ••••{entry.session_id.split('@')[0].slice(-4)} · {formatDate(new Date(entry.requested_at).toISOString())}</small></div>
            <div className="ds-actions"><Tag tone="warn">Pausado</Tag><Button disabled={busy} onClick={() => action(async () => {
                await api('/conversation-handoffs/resume', { method: 'POST', body: { session_id: entry.session_id } });
                await handoffs.load();
            }, 'Atendimento automático retomado.')}>Retomar automação</Button></div>
        </div>)}
    </Surface></>;
}
