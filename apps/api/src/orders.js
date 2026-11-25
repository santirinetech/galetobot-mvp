import { z } from 'zod';

export const MAX_ORDER_ITEMS = 30;
export const MAX_ITEM_QUANTITY = 100;

export const itemsSchema = z.array(z.object({
    product_id: z.number().int().positive(),
    quantity: z.number().int().min(1).max(MAX_ITEM_QUANTITY)
})).min(1).max(MAX_ORDER_ITEMS);
export const orderSchema = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().regex(/^\d{10,11}$/), source: z.enum(['counter', 'whatsapp-simulated']), items: itemsSchema, external_key: z.string().min(8).max(100).optional() });

export const customerSchema = orderSchema.pick({ name: true, phone: true });

export class OrderUnavailableError extends Error {}

export function createOrderService(db, { enableStore = false } = {}) {
    const findProduct = db.prepare('SELECT * FROM products WHERE id=?');
    const previousOrder = db.prepare('SELECT id,total_cents FROM orders WHERE external_key=?');
    const saveCustomer = db.prepare('INSERT INTO customers(phone,name) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name');
    const registerCustomer = db.prepare('INSERT INTO customers(phone,name) VALUES(?,?) ON CONFLICT(phone) DO NOTHING');
    const findCustomer = db.prepare('SELECT id FROM customers WHERE phone=?');
    const saveOrder = db.prepare('INSERT INTO orders(customer_id,source,total_cents,external_key) VALUES(?,?,?,?)');
    const decrementStock = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?');
    const saveItem = db.prepare('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES(?,?,?,?)');
    const storeOrder = enableStore && db.prepare('UPDATE orders SET status=?, checkout_details=? WHERE id=?');
    const savePayment = enableStore && db.prepare(
        'INSERT INTO order_payments(order_id,method,cash_tendered_cents,change_cents) VALUES(?,?,?,?)');
    const nameItem = enableStore && db.prepare('UPDATE order_items SET product_name=? WHERE id=?');
    const movement = enableStore && db.prepare('INSERT INTO stock_movements(product_id,delta,balance,reason,order_id) SELECT id,?,stock,?,? FROM products WHERE id=?');
    const auditOrder = db.prepare('INSERT INTO audit(action,detail) VALUES(?,?)');

    function quoteOrder(items) {
        const consolidated = new Map();
        for (const item of items) {
            consolidated.set(item.product_id, (consolidated.get(item.product_id) ?? 0) + item.quantity);
        }

        let total_cents = 0;
        const lines = [];
        for (const [id, quantity] of consolidated) {
            const product = findProduct.get(id);
            if (!product || !product.active) throw new OrderUnavailableError('Produto indisponível');
            if (product.stock < quantity) {
                throw new OrderUnavailableError(`${product.name}: somente ${product.stock} disponível(is)`);
            }
            total_cents += product.price_cents * quantity;
            lines.push({ product_id: id, name: product.name, quantity, unit_price_cents: product.price_cents });
        }
        return { total_cents, lines };
    }

    const createOrder = db.transaction((order, details = null) => {
        if (order.external_key) {
            const existing = previousOrder.get(order.external_key);
            if (existing) return { ...existing, replayed: true };
        }

        if (typeof details === 'function') details = details();
        const { total_cents: subtotal, lines } = quoteOrder(order.items);
        const total_cents = subtotal + (enableStore ? (details?.shipping_cents ?? 0) : 0);
        const customerStatement = ['whatsapp', 'site', 'web-chat'].includes(order.source) ? registerCustomer : saveCustomer;
        customerStatement.run(order.phone, order.name);
        const customer = findCustomer.get(order.phone);
        const { lastInsertRowid: id } = saveOrder.run(customer.id, order.source, total_cents, order.external_key || null);
        if (enableStore) {
            const status = ['whatsapp', 'site', 'web-chat'].includes(order.source) ? 'pending' : 'confirmed';
            storeOrder.run(status, details ? JSON.stringify(details) : null, id);
            if (details?.payment) {
                savePayment.run(id, details.payment, details.cash_tendered_cents ?? null, details.change_cents ?? null);
            }
        }
        for (const line of lines) {
            if (!decrementStock.run(line.quantity, line.product_id, line.quantity).changes) {
                throw new OrderUnavailableError(`${line.name}: estoque insuficiente`);
            }
            const item = saveItem.run(id, line.product_id, line.quantity, line.unit_price_cents);
            if (enableStore) {
                nameItem.run(line.name, item.lastInsertRowid);
                movement.run(-line.quantity, 'Venda', id, line.product_id);
            }
        }
        auditOrder.run('order_created', String(id));
        return { id, total_cents };
    });

    return { createOrder: createOrder.immediate, quoteOrder };
}
