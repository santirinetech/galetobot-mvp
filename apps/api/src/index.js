import dotenv from 'dotenv';

dotenv.config({
    path: new URL('../../../.env', import.meta.url)
});

import express from 'express';
import bcrypt from 'bcryptjs';
import { initializeDatabase } from './database.js';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'node:crypto';

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
const db = initializeDatabase({
    databasePath: process.env.DATABASE_PATH,
    allowCreate: process.env.NODE_ENV !== 'production' && process.env.DATABASE_ALLOW_CREATE === '1',
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD
});
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const fail = (res, e) => res.status(400).json({ error: e });
function auth(req, res, next) { const raw = req.cookies.galeto_session; if (!raw) return res.status(401).json({ error: 'Faça login' }); const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(raw), Date.now()); if (!row) return res.status(401).json({ error: 'Sessão expirada' }); req.userId = row.user_id; next(); }
function csrf(req, res, next) { if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next(); if (req.get('origin') !== origin) return res.status(403).json({ error: 'Origem não autorizada' }); next(); }
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/api/login', loginLimit, csrf, (req, res) => { const { email, password } = req.body || {}; const u = db.prepare('SELECT * FROM users WHERE email=?').get(email); if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) return res.status(401).json({ error: 'Credenciais inválidas' }); const t = token(); db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(t), u.id, Date.now() + 8 * 60 * 60 * 1000); res.cookie('galeto_session', t, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000, path: '/' }).json({ ok: true }); });
app.post('/api/logout', csrf, (req, res) => { if (req.cookies.galeto_session) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(req.cookies.galeto_session)); res.clearCookie('galeto_session', { path: '/' }).json({ ok: true }); });
app.get('/api/me', auth, (_req, res) => res.json({ ok: true }));
app.get('/api/products', auth, (_req, res) => res.json(db.prepare('SELECT * FROM products ORDER BY id').all()));
// Consulta de produtos para integrações externas, como o n8n.
app.get('/api/integrations/products', (req, res) => {
  const expected = process.env.WEBHOOK_TOKEN;

  if (!expected || expected.startsWith('ALTERE_')) {
    return res.status(503).json({
      error: 'Integração não configurada'
    });
  }

  const supplied = req.get('x-integration-token') || '';

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: 'Não autorizado'
    });
  }

  const products = db.prepare(`
    SELECT id, name, price_cents, stock
    FROM products
    WHERE active = 1
    ORDER BY name
  `).all();

  return res.json(products);
});
app.get('/api/orders', auth, (_req, res) => res.json(db.prepare(`SELECT o.*,c.name customer_name,c.phone FROM orders o LEFT JOIN customers c ON c.id=o.customer_id ORDER BY o.id DESC LIMIT 100`).all()));
const productSchema = z.object({ name: z.string().trim().min(1).max(80), price_cents: z.number().int().min(0), stock: z.number().int().min(0) });
app.post('/api/products', auth, csrf, (req, res) => { const parsed = productSchema.safeParse(req.body); if (!parsed.success) return fail(res, 'Produto inválido'); const p = parsed.data; const r = db.prepare('INSERT INTO products(name,price_cents,stock) VALUES(?,?,?)').run(p.name, p.price_cents, p.stock); res.status(201).json({ id: r.lastInsertRowid }); });
app.patch('/api/products/:id/stock', auth, csrf, (req, res) => { const parsed = z.object({ stock: z.number().int().min(0) }).safeParse(req.body); if (!parsed.success) return fail(res, 'Estoque inválido'); const r = db.prepare('UPDATE products SET stock=? WHERE id=?').run(parsed.data.stock, req.params.id); if (!r.changes) return res.status(404).json({ error: 'Produto não encontrado' }); db.prepare('INSERT INTO audit(action,detail) VALUES(?,?)').run('stock_adjust', JSON.stringify({ id: req.params.id, stock: parsed.data.stock })); res.json({ ok: true }); });
const orderSchema = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().regex(/^\d{10,11}$/), source: z.enum(['counter', 'whatsapp-simulated']), items: z.array(z.object({ product_id: z.number().int().positive(), quantity: z.number().int().min(1).max(100) })).min(1).max(30), external_key: z.string().min(8).max(100).optional() });
const createOrder = db.transaction((o) => {
    if (o.external_key) { const old = db.prepare('SELECT id,total_cents FROM orders WHERE external_key=?').get(o.external_key); if (old) return { ...old, replayed: true }; }
    const consolidated = new Map(); for (const item of o.items) consolidated.set(item.product_id, (consolidated.get(item.product_id) || 0) + item.quantity);
    let total = 0; const lines = [];
    for (const [id, qty] of consolidated) { const p = db.prepare('SELECT * FROM products WHERE id=?').get(id); if (!p || !p.active) throw new Error('Produto indisponível'); if (p.stock < qty) throw new Error(`${p.name}: somente ${p.stock} disponível(is)`); total += p.price_cents * qty; lines.push({ p, qty }); }
    db.prepare('INSERT INTO customers(phone,name) VALUES(?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name').run(o.phone, o.name);
    const customer = db.prepare('SELECT id FROM customers WHERE phone=?').get(o.phone);
    const result = db.prepare('INSERT INTO orders(customer_id,source,total_cents,external_key) VALUES(?,?,?,?)').run(customer.id, o.source, total, o.external_key || null);
    for (const { p, qty } of lines) { const r = db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND active=1 AND stock>=?').run(qty, p.id, qty); if (!r.changes) throw new Error(`${p.name}: estoque insuficiente`); db.prepare('INSERT INTO order_items(order_id,product_id,quantity,unit_price_cents) VALUES(?,?,?,?)').run(result.lastInsertRowid, p.id, qty, p.price_cents); }
    db.prepare('INSERT INTO audit(action,detail) VALUES(?,?)').run('order_created', String(result.lastInsertRowid)); return { id: result.lastInsertRowid, total_cents: total };
});
function orderHandler(req, res) { const p = orderSchema.safeParse(req.body); if (!p.success) return fail(res, 'Dados do pedido inválidos: telefone com DDD, nome e itens são obrigatórios'); try { res.status(201).json(createOrder(p.data)); } catch (e) { res.status(409).json({ error: e.message }); } }
app.post('/api/orders', auth, csrf, orderHandler);
// Simulador interno do canal WhatsApp, autenticado com a sessão do administrador.
app.post('/api/simulate', auth, csrf, (req, res) => {
    const p = z.object({ phone: z.string().regex(/^\d{10,11}$/), message: z.string().min(1).max(500) }).safeParse(req.body); if (!p.success) return fail(res, 'Mensagem inválida'); const { phone, message } = p.data; const recent = db.prepare(`SELECT o.id,o.total_cents,o.created_at FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone=? ORDER BY o.id DESC LIMIT 1`).get(phone); const items = recent ? db.prepare(`SELECT p.name,oi.product_id,oi.quantity,p.stock,p.price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?`).all(recent.id) : []; const lower = message.toLocaleLowerCase('pt-BR'); if (/de sempre|último pedido|ultimo pedido|repetir/.test(lower)) { if (!recent) return res.json({ reply: 'Ainda não encontrei pedidos anteriores para esse número. O que você gostaria de pedir?', suggested_items: [] }); const shortages = items.filter(x => x.stock < x.quantity); const description = items.map(x => `${x.quantity}x ${x.name}`).join(', '); const reply = shortages.length ? `Seu último pedido foi ${description}. Hoje ${shortages.map(x => `${x.name}: apenas ${x.stock} disponível(is)`).join('; ')}. Quer ajustar as quantidades?` : `Seu último pedido foi ${description}. Temos esses itens disponíveis agora. Quer repetir?`; return res.json({ reply, suggested_items: items.map(x => ({ product_id: x.product_id, quantity: x.quantity })), stock_checked: true }); }
    res.json({ reply: 'Olá! Posso ajudar com seu pedido. Você pode consultar os produtos disponíveis ou pedir “o de sempre”.', suggested_items: [] });
});
// Endpoint de integração preparado; não habilita WhatsApp real. Requer segredo separado.
app.post('/api/integrations/order', (req, res) => { const expected = process.env.WEBHOOK_TOKEN; if (!expected || expected.startsWith('ALTERE_')) return res.status(503).json({ error: 'Integração não configurada' }); const supplied = req.get('x-integration-token') || ''; const a = Buffer.from(supplied), b = Buffer.from(expected); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Não autorizado' }); orderHandler(req, res); });
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Erro interno' }); });
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`🍗 GaletoBot MVP API rodando em http://${host}:${port}`);
});
