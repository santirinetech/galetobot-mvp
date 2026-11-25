import React, { useEffect, useState } from 'react';
import { Minus, Pencil, Plus, ShoppingBag } from 'lucide-react';
import { api } from './client.js';
import { Amount, Button, Feedback, Field, Overlay, PageHeading, Surface, Tag } from './design-system.jsx';
import { PaymentFields } from './payment-fields.jsx';
import { ProductPhoto } from './ui.jsx';
import './operation.css';

const empty = { name: '', price: '', stock: '0', description: '', category: '', image_url: '', active: true };
const categoryOf = product => product.category || 'Sem categoria';
export const matches = (value, query) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .includes(query.trim().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase());
const categories = products => [...new Set(products.map(categoryOf))].sort((a, b) => a.localeCompare(b, 'pt-BR'));

export function StockTag({ product }) {
    if (!product.active) return <Tag>Inativo</Tag>;
    if (product.stock === 0) return <Tag tone="danger">Esgotado</Tag>;
    return <Tag tone={product.stock <= 2 ? 'warn' : 'success'}>{product.stock} un.</Tag>;
}

function CatalogFilters({ products, query, setQuery, category, setCategory, children }) {
    return <Surface className="operation-filters">
        <Field type="search" label="Buscar produto" placeholder="Nome ou categoria" value={query} onChange={e => setQuery(e.target.value)} />
        <Field as="select" label="Categoria" value={category} onChange={e => setCategory(e.target.value)}>
            <option value="">Todas</option>{categories(products).map(item => <option key={item}>{item}</option>)}
        </Field>
        {children}
    </Surface>;
}

function useCatalog(products) {
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('');
    const visible = products.filter(product => (!category || categoryOf(product) === category) &&
        matches(product.name + ' ' + categoryOf(product), query));
    return { visible, controls: { products, query, setQuery, category, setCategory } };
}

function Quantity({ product, value, change, busy }) {
    return <div className="operation-quantity">
        <Button icon={Minus} variant="icon" aria-label={'Remover ' + product.name} disabled={!value || busy}
            onClick={() => change(product, value - 1)} />
        <input type="number" min="0" max={product.stock} value={value} disabled={busy || !product.active}
            aria-label={'Quantidade de ' + product.name} onChange={e => change(product, Number(e.target.value))} />
        <Button icon={Plus} variant="icon" aria-label={'Adicionar ' + product.name}
            disabled={!product.active || value >= Math.min(product.stock, 100) || busy}
            onClick={() => change(product, value + 1)} />
    </div>;
}

export function Counter({ products, cart, change, name, setName, phone, setPhone, methods, payment, setPayment, busy, order }) {
    const { visible, controls } = useCatalog(products.filter(product => product.active));
    const selected = products.filter(product => cart[product.id]);
    const total = selected.reduce((sum, product) => sum + product.price_cents * cart[product.id], 0);
    const count = selected.reduce((sum, product) => sum + cart[product.id], 0);
    const [drawer, setDrawer] = useState(false);
    useEffect(() => { if (!count) setDrawer(false); }, [count]);
    const contents = <>
        {!count && <Feedback title="Carrinho vazio">Selecione os produtos do pedido.</Feedback>}
        {selected.map(product => <div className="operation-line" key={product.id}>
            <div><strong>{product.name}</strong><small><Amount cents={product.price_cents * cart[product.id]} /></small></div>
            <Quantity product={product} value={cart[product.id]} change={change} busy={busy} />
        </div>)}
        <form className="operation-form" onSubmit={event => { event.preventDefault(); order(); }}>
            <Field required label="Nome do cliente" autoComplete="name" value={name} onChange={e => setName(e.target.value)} />
            <Field required label="Telefone com DDD" type="tel" autoComplete="tel" value={phone} onChange={e => setPhone(e.target.value)} />
            <PaymentFields payments={methods} value={payment} onChange={setPayment} />
            <div className="operation-total"><strong>Total estimado</strong><Amount cents={total} /></div>
            <Button type="submit" variant="primary" disabled={!count || busy}>Confirmar pedido de balcão</Button>
        </form>
    </>;
    return <>
        <PageHeading title="Balcão" description="Monte o pedido e registre a venda no mesmo estoque dos outros canais." />
        <div className="operation-split"><section>
            <CatalogFilters {...controls} />
            {!visible.length && <Surface><Feedback title="Nenhum produto encontrado" /></Surface>}
            {categories(visible).map(category => <section key={category} className="operation-category">
                <h2>{category}</h2><div className="operation-catalog">
                    {visible.filter(product => categoryOf(product) === category).map(product => <Surface key={product.id} className="operation-card">
                        <ProductPhoto url={product.image_url} name={product.name} className="operation-photo" />
                        <div className="operation-card-body"><h3>{product.name}</h3>
                            <div className="operation-card-meta"><strong><Amount cents={product.price_cents} /></strong><StockTag product={product} /></div>
                            <Quantity product={product} value={cart[product.id] || 0} change={change} busy={busy} />
                        </div></Surface>)}</div>
            </section>)}
        </section><Surface title="Carrinho do balcão" className="operation-counter-cart">{contents}</Surface></div>
        <Button className="operation-mobile-cart" variant="primary" icon={ShoppingBag} onClick={() => setDrawer(true)}>
            Carrinho · {count} · <Amount cents={total} />
        </Button>
        {drawer && <Overlay drawer title="Carrinho do balcão" onClose={() => setDrawer(false)}>{contents}</Overlay>}
    </>;
}

export function PhotoInput({ url, file, onFile, remove, onRemove }) {
    const [preview, setPreview] = useState('');
    useEffect(() => {
        if (!file) { setPreview(''); return; }
        const local = URL.createObjectURL(file);
        setPreview(local);
        return () => URL.revokeObjectURL(local);
    }, [file]);
    return <div className="operation-photo-form">
        <ProductPhoto url={remove ? '' : preview || url} name="Prévia" className="operation-photo-preview" />
        <div><Field type="file" label="Enviar fotografia" accept="image/jpeg,image/png,image/webp" onChange={e => onFile(e.target.files[0] ?? null)} />
            <small>JPEG, PNG ou WebP · até 5 MB.</small>
            {(url || file) && <Button variant="quiet" onClick={onRemove}>{remove ? 'Desfazer remoção' : 'Remover fotografia'}</Button>}</div>
    </div>;
}

export function Products({ products, action, refresh, busy, error }) {
    const { visible, controls } = useCatalog(products);
    const [status, setStatus] = useState('');
    const [draft, setDraft] = useState(null);
    const [editing, setEditing] = useState(null);
    const [file, setFile] = useState(null);
    const [remove, setRemove] = useState(false);
    const filtered = visible.filter(item => !status || (status === 'active' ? item.active : !item.active));
    const field = (key, value) => setDraft(previous => ({ ...previous, [key]: value }));
    function edit(product) {
        setEditing(product?.id ?? null);
        setDraft(product ? { ...product, price: (product.price_cents / 100).toFixed(2) } : empty);
        setFile(null);
        setRemove(false);
    }
    function save(event) {
        event.preventDefault();
        action(async () => {
            const price = Math.round(Number(draft.price.trim().replace(',', '.')) * 100);
            if (!draft.price.trim() || !Number.isSafeInteger(price) || price < 0) throw new Error('Informe um preço válido.');
            const { name, description, category, active, image_url } = draft;
            const body = { name, description, category, active: Boolean(active), price_cents: price };
            if (!file && !remove && image_url && !image_url.startsWith('/api/media/')) body.image_url = image_url;
            let id = editing;
            if (id) await api('/products/' + id, { method: 'PATCH', body });
            else {
                const created = await api('/products', { method: 'POST', body: { ...body, stock: Number(draft.stock) } });
                id = created.id;
                setEditing(id);
            }
            if (file) await api('/products/' + id + '/photo', { method: 'POST', file });
            else if (remove) await api('/products/' + id + '/photo', { method: 'DELETE' });
            await refresh();
            setDraft(null);
        }, 'Produto salvo.');
    }
    return <>
        <PageHeading title="Produtos" description="Gerencie o catálogo, os preços e as fotografias do cardápio."
            actions={<Button variant="primary" icon={Plus} onClick={() => edit()}>Novo produto</Button>} />
        <CatalogFilters {...controls}><Field as="select" label="Situação" value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Todas</option><option value="active">Ativo</option><option value="inactive">Inativo</option>
        </Field></CatalogFilters>
        {!filtered.length ? <Surface><Feedback title="Nenhum produto encontrado" /></Surface> :
            <div className="operation-products">{filtered.map(product => <Surface key={product.id} className="operation-card">
                <ProductPhoto url={product.image_url} name={product.name} className="operation-photo" />
                <div className="operation-card-body"><small>{categoryOf(product)}</small><h3>{product.name}</h3>
                    <div className="operation-card-meta"><Amount cents={product.price_cents} /><StockTag product={product} /></div>
                    <Button icon={Pencil} aria-label={'Editar ' + product.name} onClick={() => edit(product)}>Editar</Button></div>
            </Surface>)}</div>}
        {draft && <Overlay drawer title={editing ? 'Editar produto' : 'Novo produto'} onClose={() => { if (!busy) setDraft(null); }}>
            {error && <Feedback kind="error" title="Não foi possível salvar">{error}</Feedback>}
            <form className="operation-form" onSubmit={save}>
                <Field label="Nome" required maxLength={80} value={draft.name} onChange={e => field('name', e.target.value)} />
                <Field label="Categoria" maxLength={80} value={draft.category} onChange={e => field('category', e.target.value)} />
                <Field label="Preço em reais" required inputMode="decimal" value={draft.price} onChange={e => field('price', e.target.value)} />
                <Field as="textarea" label="Descrição" maxLength={500} value={draft.description} onChange={e => field('description', e.target.value)} />
                {!editing && <Field label="Estoque inicial" required type="number" min={0} value={draft.stock} onChange={e => field('stock', e.target.value)} />}
                <label className="check"><input type="checkbox" checked={Boolean(draft.active)} onChange={e => field('active', e.target.checked)} /> Ativo no cardápio</label>
                <PhotoInput url={draft.image_url} file={file} remove={remove} onFile={next => { setFile(next); setRemove(false); }}
                    onRemove={() => { setFile(null); setRemove(!remove); }} />
                {!file && !draft.image_url.startsWith('/api/media/') && <Field type="url" label="URL HTTPS da fotografia (opcional)"
                    value={draft.image_url} onChange={e => { field('image_url', e.target.value); setRemove(false); }} />}
                <Button type="submit" variant="primary" disabled={busy}>Salvar produto</Button>
            </form>
        </Overlay>}
    </>;
}
