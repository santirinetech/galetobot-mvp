import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createMedia } from './media.js';

import express from 'express';
import bcrypt from 'bcryptjs';
import { initializeDatabase, selectRuntimeDatabase } from './database.js';
import { createOrderService, orderSchema, OrderUnavailableError } from './orders.js';
import { createOrderPage } from './order-page.js';
import { createConversationService, CART_CLEANUP_INTERVAL_MS } from './conversations.js';
import { createChatService } from './chat-service.js';
import { createChatRouters, readChatConfig } from './chat-http.js';
import { controlToken, controlUrl, createWhatsAppAdmin } from './whatsapp-control.js';
import { automationStatus, createWhatsAppAutomation } from './whatsapp-automation.js';
import { integrationAuth, conversationHandler, contextHandler, resumeHandler } from './integrations.js';
import { counterPaymentSchema, createStoreCheckout, createStoreRouter, productFields } from './store.js';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
if (args.length !== 1 || !['--development', '--test', '--operational', '--hosted'].includes(args[0])) {
    throw new Error('Use --development, --test, --operational ou --hosted como modo exclusivo da API');
}
const mode = args[0].slice(2);
if (mode === 'hosted') {
    const origin = URL.parse(process.env.APP_ORIGIN ?? '');
    if (process.env.NODE_ENV !== 'production' || origin?.protocol !== 'https:' || origin.origin !== process.env.APP_ORIGIN) {
        throw new Error('A hospedagem exige NODE_ENV=production e APP_ORIGIN com a origem HTTPS exata');
    }
    if (!process.env.WEBHOOK_TOKEN || /^ALTER(?:AR|E)_/i.test(process.env.WEBHOOK_TOKEN)) {
        throw new Error('A hospedagem exige WEBHOOK_TOKEN configurado');
    }
    if (/^ALTER(?:AR|E)_/i.test(process.env.ADMIN_PASSWORD ?? '')) {
        throw new Error('A hospedagem exige senha administrativa configurada');
    }
} else if (mode !== 'test') {
    const envFile = mode === 'operational' ? '../../../.env' : '../../../.env.development';
    dotenv.config({ path: fileURLToPath(new URL(envFile, import.meta.url)) });
}

const app = express();
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
const origin = process.env.APP_ORIGIN || 'http://localhost:5173';
const enableStore = mode !== 'operational';
const runtime = selectRuntimeDatabase(mode, process.env);
const db = initializeDatabase({
    ...runtime,
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
    enableStore
});
const orders = createOrderService(db, { enableStore });
const { createOrder } = orders;
const checkout = enableStore ? createStoreCheckout(db, orders) : null;
const conversations = createConversationService(db, orders, { checkout });
const media = checkout ? createMedia(db, mode !== 'test' && process.env.PRODUCT_MEDIA_DIR || runtime.databasePath + '.media') : null;
const store = checkout ? createStoreRouter(db, orders, checkout, auth, csrf, media) : null;
const whatsappAutomation = enableStore ? createWhatsAppAutomation(db) : null;
const whatsappControlToken = controlToken(process.env);
let chatConfig = { mode: 'off' };
if (checkout) {
    try {
        chatConfig = readChatConfig(process.env);
    } catch {
        console.error('Configuração do chat inválida. O atendimento inteligente ficou desabilitado.');
    }
}
const chat = chatConfig.mode !== 'off' ? createChatService(db, conversations) : null;
const chatRouters = chat && createChatRouters(chat, chatConfig, auth, csrf, {
    contact: () => checkout.settings().human_contact_url ?? chatConfig.contact
});
conversations.cleanupExpiredCarts();
store?.cleanup();
chat?.clean();
const cleanupTimer = setInterval(() => {
    try {
        conversations.cleanupExpiredCarts();
        store?.cleanup();
        chat?.clean();
    } catch {
        console.error('Falha interna na limpeza dos carrinhos');
    }
}, CART_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();
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
app.get('/api/integrations/products', integrationAuth, (_req, res) => {
    const products = db.prepare(`
        SELECT id, name, price_cents, stock
        FROM products
        WHERE active = 1
        ORDER BY name
    `).all();
    res.json(products);
});
const orderList = db.prepare(`SELECT o.*,c.name customer_name,c.phone
    ${enableStore ? ',p.status AS payment_status,p.method AS payment_method' : ''}
    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
    ${enableStore ? 'LEFT JOIN order_payments p ON p.order_id=o.id' : ''}
    ORDER BY o.id DESC LIMIT 100`);
const orderPage = enableStore ? createOrderPage(db) : null;
app.get('/api/orders', auth, (req, res) => orderPage && Object.keys(req.query).length ? orderPage(req, res) : res.json(orderList.all()));
const productSchema = productFields.extend({ stock: z.number().int().min(0) }).partial({
    description: true, category: true, image_url: true, active: true
});
const addProduct = db.transaction(p => {
    if (!enableStore) return db.prepare('INSERT INTO products(name,price_cents,stock) VALUES(?,?,?)').run(p.name, p.price_cents, p.stock).lastInsertRowid;
    const id = db.prepare('INSERT INTO products(name,price_cents,stock,description,category,image_url,active) VALUES(?,?,?,?,?,?,?)')
        .run(p.name, p.price_cents, p.stock, p.description ?? '', p.category ?? '', p.image_url ?? '', Number(p.active ?? true)).lastInsertRowid;
    if (p.stock) db.prepare('INSERT INTO stock_movements(product_id,delta,balance,reason) VALUES(?,?,?,?)').run(id, p.stock, p.stock, 'Saldo inicial');
    return id;
}).immediate;
app.post('/api/products', auth, csrf, (req, res) => {
    const parsed = productSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 'Produto inválido');
    return res.status(201).json({ id: addProduct(parsed.data) });
});
const setStock = db.transaction((id, stock) => {
    const previous = db.prepare('SELECT stock FROM products WHERE id=?').get(id);
    if (!previous) return false;
    db.prepare('UPDATE products SET stock=? WHERE id=?').run(stock, id);
    db.prepare('INSERT INTO audit(action,detail) VALUES(?,?)').run('stock_adjust', JSON.stringify({ id, stock }));
    if (enableStore && stock !== previous.stock) {
        db.prepare('INSERT INTO stock_movements(product_id,delta,balance,reason) VALUES(?,?,?,?)')
            .run(id, stock - previous.stock, stock, 'Ajuste de saldo');
    }
    return true;
}).immediate;
app.patch('/api/products/:id/stock', auth, csrf, (req, res) => {
    const parsed = z.object({ stock: z.number().int().min(0) }).safeParse(req.body);
    if (!parsed.success) return fail(res, 'Estoque inválido');
    if (!setStock(req.params.id, parsed.data.stock)) return res.status(404).json({ error: 'Produto não encontrado' });
    return res.json({ ok: true });
});
function orderHandler(req, res, next, allowPayment = false) {
    const p = orderSchema.safeParse(req.body);
    if (!p.success) return fail(res, 'Dados do pedido inválidos: telefone com DDD, nome e itens são obrigatórios');
    try {
        const financial = allowPayment && checkout && p.data.source === 'counter' ? counterPaymentSchema.safeParse(req.body) : null;
        if (financial && !financial.success) return fail(res, 'Revise a forma de pagamento e o troco.');
        const details = financial?.data?.payment
            ? () => checkout.summarize({ ...p.data, ...financial.data, fulfillment: 'pickup' }, { counter: true }).checkout
            : null;
        const result = createOrder(p.data, details);
        return res.status(201).json(result);
    } catch (error) {
        if (error instanceof OrderUnavailableError) return res.status(409).json({ error: error.message });
        return next(error);
    }
}
app.post('/api/orders', auth, csrf, (req, res, next) => orderHandler(req, res, next, true));
// Simulador interno do canal WhatsApp, autenticado com a sessão do administrador.
app.post('/api/simulate', auth, csrf, (req, res) => {
    const p = z.object({ phone: z.string().regex(/^\d{10,11}$/), message: z.string().min(1).max(500) }).safeParse(req.body); if (!p.success) return fail(res, 'Mensagem inválida'); const { phone, message } = p.data; const recent = db.prepare(`SELECT o.id,o.total_cents,o.created_at FROM orders o JOIN customers c ON c.id=o.customer_id WHERE c.phone=? ORDER BY o.id DESC LIMIT 1`).get(phone); const items = recent ? db.prepare(`SELECT p.name,oi.product_id,oi.quantity,p.stock,p.price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=?`).all(recent.id) : []; const lower = message.toLocaleLowerCase('pt-BR'); if (/de sempre|último pedido|ultimo pedido|repetir/.test(lower)) { if (!recent) return res.json({ reply: 'Ainda não encontrei pedidos anteriores para esse número. O que você gostaria de pedir?', suggested_items: [] }); const shortages = items.filter(x => x.stock < x.quantity); const description = items.map(x => `${x.quantity}x ${x.name}`).join(', '); const reply = shortages.length ? `Seu último pedido foi ${description}. Hoje ${shortages.map(x => `${x.name}: apenas ${x.stock} disponível(is)`).join('; ')}. Quer ajustar as quantidades?` : `Seu último pedido foi ${description}. Temos esses itens disponíveis agora. Quer repetir?`; return res.json({ reply, suggested_items: items.map(x => ({ product_id: x.product_id, quantity: x.quantity })), stock_checked: true }); }
    res.json({ reply: 'Olá! Posso ajudar com seu pedido. Você pode consultar os produtos disponíveis ou pedir “o de sempre”.', suggested_items: [] });
});
// Endpoint de integração preparado; não habilita WhatsApp real. Requer segredo separado.
app.post('/api/integrations/order', integrationAuth, orderHandler);
app.post('/api/integrations/conversation', integrationAuth, conversationHandler(conversations, chat, whatsappAutomation));
app.post('/api/integrations/conversation/context', integrationAuth, contextHandler(conversations, chat, whatsappAutomation));
if (whatsappAutomation) app.get('/api/integrations/whatsapp-control/automation',
    automationStatus(whatsappAutomation, whatsappControlToken));
if (chatRouters) app.use('/api/integrations/ai-lab', chatRouters.internal);
if (chatRouters) app.use('/api/chat', chatRouters.publicChat);
if (chatRouters) app.use('/api/admin/ai-lab', chatRouters.lab);
else app.use('/api/admin/ai-lab', auth, (_req, res) =>
    res.status(503).json({ error: 'O Laboratório IA ainda não está configurado.' }));
if (mode === 'hosted') {
    const ready = db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1');
    app.get('/healthz', (_req, res) => {
        ready.get();
        res.sendStatus(204);
    });
}
if (enableStore) {
    app.use('/api/admin/whatsapp', createWhatsAppAdmin({
        auth, csrf, url: controlUrl(process.env.WHATSAPP_CONTROL_URL), token: whatsappControlToken,
        automation: whatsappAutomation
    }));
    app.get('/api/conversation-handoffs', auth, (_req, res) => res.json(conversations.listHandoffs()));
    app.post('/api/conversation-handoffs/resume', auth, csrf, resumeHandler(conversations));
}
if (store) app.use('/api', store.router);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Rota indisponível nesta instância da API.' }));
app.use((err, req, res, _next) => {
    if (res.headersSent) return req.socket.destroy();
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON malformado' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload acima do limite' });
    console.error('Falha interna na API');
    return res.status(500).json({ error: 'Erro interno' });
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || (['operational', 'hosted'].includes(mode) ? '0.0.0.0' : '127.0.0.1');

const server = app.listen(port, host, () => {
  console.log(`🍗 GaletoBot MVP API rodando em http://${host}:${server.address().port}`);
});
