import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { customerSchema, itemsSchema, OrderUnavailableError } from './orders.js';

const text = max => z.string().trim().max(max);
const cents = z.number().int().min(0).max(100_000_000);
const regions = z.array(z.object({ name: text(80).min(1), shipping_cents: cents })).max(80)
    .refine(rows => new Set(rows.map(row => row.name)).size === rows.length);
const settingsSchema = z.object({
    name: text(100).min(1), hours: text(300), menu_note: text(300),
    menu_open: z.boolean(), regions,
    payments: z.array(text(50).min(1)).min(1).max(12),
    pix_key: text(150).regex(/^[^\p{Cc}]*$/u).optional(),
    region_aliases: z.array(z.object({ alias: text(80).min(1), regiao: text(80).min(1) })).max(100).optional()
}).refine(data => (data.region_aliases ?? []).every(row => data.regions.some(region => region.name === row.regiao)), {
    message: 'Apelidos devem apontar para regiões cadastradas.'
});
const defaultSettings = { name: 'GaletoBot', hours: '', menu_note: '', menu_open: true, regions: [], payments: ['Dinheiro', 'Pix', 'Cartão'] };
export const productFields = z.object({
    name: text(80).min(1), price_cents: cents, description: text(500), category: text(80),
    image_url: z.union([z.literal(''), z.url({ protocol: /^https$/ }).max(1000)]), active: z.boolean()
});
const cashFields = {
    cash_tendered_cents: cents.positive().optional(),
    no_change: z.boolean().optional()
};
const validCash = data => !(data.no_change && data.cash_tendered_cents != null) &&
    (data.cash_tendered_cents == null && !data.no_change || data.payment?.toLowerCase() === 'dinheiro');
export const counterPaymentSchema = z.object({ payment: text(50).min(1).optional(), ...cashFields }).refine(validCash);
const checkoutSchema = customerSchema.extend({
    items: itemsSchema,
    fulfillment: z.enum(['pickup', 'delivery']),
    payment: text(50).min(1),
    region: text(80).default(''),
    address: text(180).default(''),
    ...cashFields
}).refine(validCash);
const tokenSchema = z.object({ token: z.uuid() });
const statusFlow = { pending: ['confirmed'], confirmed: ['preparing'], preparing: ['ready'], ready: ['completed'], completed: [] };
const storeDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
const quoteLifetime = 15 * 60 * 1000;

export function createStoreCheckout(db, orders) {
    const readSettings = db.prepare('SELECT value FROM store_settings WHERE id=1').pluck();
    const settings = () => JSON.parse(readSettings.get() ?? JSON.stringify(defaultSettings));

    function summarize(data, { counter = false } = {}) {
        const config = settings();
        if (!counter && !config.menu_open) throw new OrderUnavailableError('Pedidos pelo cardápio estão fechados.');
        const payment = config.payments.find(value => value.toLocaleLowerCase('pt-BR') === data.payment?.toLocaleLowerCase('pt-BR'));
        if (!payment) throw new OrderUnavailableError('Forma de pagamento indisponível.');
        const region = config.regions.find(row => row.name.toLocaleLowerCase('pt-BR') === data.region?.toLocaleLowerCase('pt-BR'));
        if (data.fulfillment === 'delivery' && (!region || !data.address)) {
            throw new OrderUnavailableError('Informe endereço e região atendida.');
        }
        const shipping_cents = data.fulfillment === 'delivery' ? region.shipping_cents : 0;
        const checkout = {
            name: data.name,
            fulfillment: data.fulfillment, payment, shipping_cents,
            region: data.fulfillment === 'delivery' ? region.name : '',
            address: data.fulfillment === 'delivery' ? data.address : ''
        };
        const quote = orders.quoteOrder(data.items);
        const total_cents = quote.total_cents + shipping_cents;
        if (payment.toLowerCase() === 'dinheiro') {
            const tendered = data.cash_tendered_cents;
            if (tendered != null) {
                if (!Number.isSafeInteger(tendered) || tendered < total_cents || tendered > 100_000_000) {
                    throw new OrderUnavailableError('O valor em dinheiro deve cobrir o total com frete. Informe outro valor para troco.');
                }
                checkout.cash_tendered_cents = tendered;
                checkout.change_cents = tendered - total_cents;
            } else if (data.no_change === true) {
                checkout.change_cents = 0;
            }
        }
        return { checkout, lines: quote.lines, subtotal_cents: quote.total_cents, total_cents };
    }

    return { settings, summarize };
}

function withBody(schema, action) {
    return (req, res, next) => {
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: 'Dados inválidos. Revise os campos.' });
        try {
            return action(parsed.data, req, res);
        } catch (error) {
            if (error instanceof OrderUnavailableError) return res.status(409).json({ error: error.message });
            return next(error);
        }
    };
}

export function createStoreRouter(db, orders, checkout, auth, csrf, media) {
    const router = Router();
    const { settings, summarize } = checkout;
    const orderById = db.prepare('SELECT o.*, c.name customer_name, c.phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id WHERE o.id=?');
    const paymentByOrder = db.prepare('SELECT * FROM order_payments WHERE order_id=?');
    const markReceived = db.prepare(`UPDATE order_payments SET status='received',
        received_at=CURRENT_TIMESTAMP, received_by=? WHERE order_id=? AND status='pending'`);
    const auditPayment = db.prepare("INSERT INTO audit(action,detail) VALUES('pix_received',?)");
    const receivePix = db.transaction((id, operator) => {
        const payment = paymentByOrder.get(id);
        if (payment?.method.toLowerCase() !== 'pix') {
            throw new OrderUnavailableError('Este pedido não tem um pagamento Pix registrado.');
        }
        if (markReceived.run(operator, id).changes) {
            auditPayment.run(JSON.stringify({ order_id: payment.order_id, user_id: operator }));
        }
        return paymentByOrder.get(id);
    }).immediate;
    const stockMovement = db.prepare('INSERT INTO stock_movements(product_id,delta,balance,reason) SELECT id,?,stock,? FROM products WHERE id=?');
    const saveQuote = db.prepare('INSERT INTO site_checkouts(token,request,summary,expires_at) VALUES(?,?,?,?)');
    const getCheckout = db.prepare('SELECT * FROM site_checkouts WHERE token=?');
    const saveReceipt = db.prepare('UPDATE site_checkouts SET order_id=?,request=NULL,summary=NULL WHERE token=?');
    const removeExpired = db.prepare('DELETE FROM site_checkouts WHERE order_id IS NULL AND expires_at<=?');
    const checkoutLimit = rateLimit({ windowMs: 60000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false,
        message: { error: 'Muitas tentativas. Aguarde um minuto.' } });

    function pixInstructions(payment) {
        const key = payment?.method.toLowerCase() === 'pix' && payment.status === 'pending' && settings().pix_key;
        return key ? { pix_instructions: { key, notice: 'A equipe verificará o recebimento do Pix.' } } : {};
    }

    function receipt(order) {
        return { id: order.id, total_cents: order.total_cents, status: order.status,
            ...pixInstructions(paymentByOrder.get(order.id)) };
    }

    const confirm = db.transaction(token => {
        const row = getCheckout.get(token);
        if (!row) throw new OrderUnavailableError('Cotação inválida ou expirada.');
        if (row.order_id) {
            const order = orderById.get(row.order_id);
            return receipt(order);
        }
        if (row.expires_at <= Date.now()) throw new OrderUnavailableError('Cotação expirada. Revise o pedido.');
        const data = JSON.parse(row.request);
        const quote = summarize(data);
        if (JSON.stringify(quote) !== row.summary) throw new OrderUnavailableError('O resumo mudou. Calcule e revise novamente.');
        const order = orders.createOrder({ ...data, source: 'site' }, quote.checkout);
        saveReceipt.run(order.id, token);
        return receipt({ ...order, status: 'pending' });
    }).immediate;

    router.get('/menu', (_req, res) => {
        const products = db.prepare('SELECT id,name,description,category,image_url,price_cents,stock FROM products WHERE active=1 ORDER BY category,name,id').all();
        const { pix_key: _pix, region_aliases: _aliases, ...publicSettings } = settings();
        res.json({ products, settings: publicSettings });
    });
    router.post('/menu/quote', csrf, checkoutLimit, withBody(checkoutSchema, (data, _req, res) => {
        const summary = summarize(data);
        const token = randomUUID();
        removeExpired.run(Date.now());
        saveQuote.run(token, JSON.stringify(data), JSON.stringify(summary), Date.now() + quoteLifetime);
        const { lines, ...totals } = summary;
        res.status(201).json({ token, ...totals, items: lines });
    }));
    router.post('/menu/confirm', csrf, checkoutLimit, withBody(tokenSchema, ({ token }, _req, res) =>
        res.set('Cache-Control', 'no-store').json(confirm(token))));
    router.post('/menu/status', csrf, checkoutLimit, withBody(tokenSchema, ({ token }, _req, res) => {
        const row = getCheckout.get(token);
        const order = row?.order_id && orderById.get(row.order_id);
        if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
        return res.set('Cache-Control', 'no-store').json(receipt(order));
    }));

    if (media) {
        router.get('/media/:name', media.serve);
        const readPhoto = db.prepare('SELECT image_url FROM products WHERE id=?').pluck();
        const writePhoto = db.prepare('UPDATE products SET image_url=? WHERE id=?');
        media.routes(router, '/products/:id/photo', auth, csrf,
            req => readPhoto.get(req.params.id), (req, url) => writePhoto.run(url, req.params.id));
    }
    router.patch('/products/:id', auth, csrf, withBody(productFields.partial().refine(p => Object.keys(p).length > 0), (fields, req, res) => {
        const previous = fields.image_url !== undefined && db.prepare('SELECT image_url FROM products WHERE id=?').pluck().get(req.params.id);
        const result = db.prepare(`
            UPDATE products SET name=COALESCE(?,name),price_cents=COALESCE(?,price_cents),
                description=COALESCE(?,description),category=COALESCE(?,category),
                image_url=COALESCE(?,image_url),active=COALESCE(?,active)
            WHERE id=?
        `)
            .run(fields.name ?? null, fields.price_cents ?? null, fields.description ?? null, fields.category ?? null,
                fields.image_url ?? null, fields.active === undefined ? null : Number(fields.active), req.params.id);
        if (result.changes && previous) void media?.removeIfUnused(previous);
        return result.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Produto não encontrado.' });
    }));
    const adjust = db.transaction((id, delta, reason) => {
        if (!db.prepare('SELECT id FROM products WHERE id=?').get(id)) return false;
        if (!db.prepare('UPDATE products SET stock=stock+? WHERE id=? AND stock+?>=0').run(delta, id, delta).changes) {
            throw new OrderUnavailableError('Estoque insuficiente para a saída.');
        }
        stockMovement.run(delta, reason, id);
        return true;
    }).immediate;
    router.post('/products/:id/movements', auth, csrf, withBody(z.object({
        delta: z.number().int().min(-1_000_000).max(1_000_000).refine(n => n !== 0), reason: text(160).min(1)
    }), (data, req, res) => adjust(req.params.id, data.delta, data.reason)
        ? res.status(201).json({ ok: true }) : res.status(404).json({ error: 'Produto não encontrado.' })));
    router.get('/stock/movements', auth, (_req, res) => res.json(db.prepare(`
        SELECT m.*, p.name FROM stock_movements m JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 200
    `).all()));
    router.get('/orders/:id', auth, (req, res) => {
        const order = orderById.get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
        const items = db.prepare(`SELECT i.*, COALESCE(i.product_name,p.name) name FROM order_items i
            JOIN products p ON p.id=i.product_id WHERE i.order_id=? ORDER BY i.id`).all(order.id);
        const payment = paymentByOrder.get(order.id) ?? null;
        return res.set('Cache-Control', 'no-store').json({ ...order, items, details: JSON.parse(order.checkout_details ?? 'null'),
            payment, ...pixInstructions(payment) });
    });
    router.patch('/orders/:id/payment', auth, csrf, withBody(z.strictObject({ status: z.literal('received') }),
        (_data, req, res) => {
            if (!orderById.get(req.params.id)) return res.status(404).json({ error: 'Pedido não encontrado.' });
            return res.json(receivePix(req.params.id, req.userId));
        }));
    router.patch('/orders/:id/status', auth, csrf, withBody(z.object({ status: text(25) }), ({ status }, req, res) => {
        const order = orderById.get(req.params.id);
        if (!order) return res.status(404).json({ error: 'Pedido não encontrado.' });
        if (status === order.status) return res.json({ ok: true });
        if (!statusFlow[order.status]?.includes(status) ||
            !db.prepare('UPDATE orders SET status=? WHERE id=? AND status=?').run(status, order.id, order.status).changes) {
            return res.status(409).json({ error: 'Transição de status inválida.' });
        }
        return res.json({ ok: true });
    }));
    router.get('/dashboard', auth, (_req, res) => {
        const today = storeDay.format(new Date());
        const recent = db.prepare(`SELECT o.status,o.total_cents,o.created_at,o.source,p.status AS payment_status
            FROM orders o LEFT JOIN order_payments p ON p.order_id=o.id
            WHERE o.created_at >= datetime('now','-2 days') AND o.source <> 'whatsapp-simulated'`).all()
            .filter(order => storeDay.format(new Date(order.created_at.replace(' ', 'T') + 'Z')) === today);
        const received = db.prepare(`SELECT o.total_cents,p.received_at FROM order_payments p JOIN orders o ON o.id=p.order_id
            WHERE p.status='received' AND p.received_at>=datetime('now','-2 days') AND o.source <> 'whatsapp-simulated'`).all()
            .filter(payment => storeDay.format(new Date(payment.received_at.replace(' ', 'T') + 'Z')) === today);
        const channels = new Map();
        for (const order of recent) channels.set(order.source, (channels.get(order.source) ?? 0) + 1);
        res.json({
            today: recent.length, pending: recent.filter(o => o.status === 'pending').length,
            total_cents: recent.reduce((sum, o) => sum + o.total_cents, 0),
            received_today_cents: received.reduce((sum, order) => sum + order.total_cents, 0),
            received_today: received.length,
            orders_pending_payment: recent.filter(order => order.payment_status === 'pending').length,
            orders_without_payment: recent.filter(order => order.payment_status === null).length,
            channels: [...channels].map(([source, count]) => ({ source, count })),
            low_stock: db.prepare('SELECT id,name,stock FROM products WHERE active=1 AND stock<=2 ORDER BY stock,name').all()
        });
    });
    router.get('/customers', auth, (_req, res) => res.json(db.prepare(`
        SELECT c.id,c.name,c.phone, COUNT(o.id) AS orders FROM customers c LEFT JOIN orders o ON c.id=o.customer_id
        GROUP BY c.id ORDER BY c.name,c.id LIMIT 250
    `).all()));
    router.get('/customers/:id/orders', auth, (req, res) => res.json(db.prepare(`
        SELECT id,source,status,total_cents,created_at FROM orders WHERE customer_id=? ORDER BY id DESC LIMIT 100
    `).all(req.params.id)));
    router.get('/settings', auth, (_req, res) => res.json(settings()));
    router.put('/settings', auth, csrf, withBody(settingsSchema, (data, _req, res) => {
        db.prepare('INSERT INTO store_settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(JSON.stringify(data));
        return res.json(data);
    }));
    return { router, cleanup: () => removeExpired.run(Date.now()) };
}
