import { z } from 'zod';
import { normalize } from './commercial.js';

const statuses = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
const query = z.strictObject({
    view: z.enum(['list', 'board']), status: z.enum(['all', ...statuses]).default('all'),
    channel: z.enum(['all', 'site', 'web-chat', 'counter', 'whatsapp', 'whatsapp-simulated']).default('all'),
    q: z.string().trim().max(100).default(''),
    before: z.string().regex(/^\d{1,15}$/).transform(Number).optional()
});

export function createOrderPage(db) {
    db.function('order_fold', { deterministic: true }, normalize);
    const where = `FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
        LEFT JOIN order_payments p ON p.order_id=o.id
        WHERE (@status='all' OR o.status=@status) AND (@channel='all' OR o.source=@channel)
          AND (@q='' OR CAST(o.id AS TEXT)=ltrim(@q,'#') OR instr(order_fold(COALESCE(c.name,'')),order_fold(@q))>0)`;
    const count = db.prepare('SELECT count(*) ' + where).pluck();
    const list = db.prepare(`SELECT o.id,o.status,o.source,o.created_at,o.total_cents,c.name AS customer_name,
        p.status AS payment_status,p.method AS payment_method,
        CASE WHEN json_valid(o.checkout_details) THEN json_extract(o.checkout_details,'$.fulfillment') END AS fulfillment
        ${where} AND (@before IS NULL OR o.id<@before) ORDER BY o.id DESC LIMIT @limit`);
    function page(filter, size) {
        const rows = list.all({ ...filter, limit: size + 1 });
        const items = rows.slice(0, size);
        return { items, total: count.get(filter), next: rows.length > size ? items.at(-1).id : null };
    }
    return (req, res) => {
        const parsed = query.safeParse(req.query);
        if (!parsed.success || (parsed.data.view === 'board' && parsed.data.before !== undefined)) {
            return res.status(400).json({ error: 'Filtros de pedidos inválidos.' });
        }
        const { view, before = null, ...filter } = parsed.data;
        if (view === 'board') {
            const lanes = filter.status === 'all' ? statuses : [filter.status];
            return res.json({ lanes: lanes.map(status => ({ status, ...page({ ...filter, status, before }, 20) })) });
        }
        return res.json(page({ ...filter, before }, 25));
    };
}
