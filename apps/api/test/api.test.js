import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import sharp from 'sharp';

test('API HTTP isolada cobre regressões, erros seguros e reenvio após perda da resposta', { timeout: 15000 }, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'galetobot-http-'));
    const origin = 'http://localhost:5173';
    const token = 'token-ficticio-do-http';
    const email = 'teste@example.invalid';
    const password = 'senha-ficticia-123';
    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url));
    const databasePath = path.join(directory, 'http.db');
    const child = spawn(process.execPath, [entry, '--test'], {
        cwd: directory,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HOST: '127.0.0.1',
            PORT: '0',
            DATABASE_PATH: databasePath,
            DATABASE_ALLOW_CREATE: '1',
            ADMIN_EMAIL: email,
            ADMIN_PASSWORD: password,
            APP_ORIGIN: origin,
            WEBHOOK_TOKEN: token
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    const closed = once(child, 'close');
    t.after(async () => {
        child.kill();
        try {
            await closed;
            assert.doesNotMatch(stderr, /Cliente Privado|11912345678|segredo-ficticio/);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    let baseUrl;
    for await (const line of createInterface({ input: child.stdout })) {
        baseUrl = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (baseUrl) break;
    }
    assert.ok(baseUrl, stderr);

    const privatePayload = { mensagem: 'Cliente Privado 11912345678 segredo-ficticio' };
    for (const [body, status, error] of [
        [JSON.stringify(privatePayload).slice(0, -1), 400, 'JSON malformado'],
        [JSON.stringify({ ...privatePayload, padding: 'z'.repeat(103000) }), 413, 'Payload acima do limite']
    ]) {
        const response = await fetch(`${baseUrl}/api/integrations/conversation`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-integration-token': token },
            body, signal: AbortSignal.timeout(3000)
        });
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { error });
    }

    function post(endpoint, payload, headers = {}) {
        return fetch(`${baseUrl}/api${endpoint}`, {
            method: 'POST',
            signal: AbortSignal.timeout(3000),
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(payload)
        });
    }
    const rejected = await post('/login', { email, password }, { origin: 'http://example.invalid' });
    assert.equal(rejected.status, 403);
    const login = await post('/login', { email, password }, { origin });
    assert.equal(login.status, 200);
    const panelHeaders = { origin, cookie: login.headers.get('set-cookie').split(';')[0] };
    const counter = await post('/orders', {
        name: 'Cliente Teste', phone: '11900000000', source: 'counter',
        items: [{ product_id: 1, quantity: 1 }]
    }, panelHeaders);
    assert.equal(counter.status, 201);
    assert.deepEqual(await counter.json(), { id: 1, total_cents: 4500 });
    const simulate = await post('/simulate', { phone: '11900000000', message: 'o de sempre' }, panelHeaders);
    assert.equal(simulate.status, 200);
    assert.deepEqual((await simulate.json()).suggested_items, [{ product_id: 1, quantity: 1 }]);

    const auth = { 'x-integration-token': token };
    const integrationOrder = await post('/integrations/order', {
        name: 'Cliente Teste', phone: '11900000000', source: 'whatsapp-simulated',
        items: [{ product_id: 3, quantity: 1 }]
    }, auth);
    assert.equal(integrationOrder.status, 201);
    assert.deepEqual(await integrationOrder.json(), { id: 2, total_cents: 800 });
    const products = await fetch(`${baseUrl}/api/integrations/products`, { headers: auth, signal: AbortSignal.timeout(3000) });
    assert.equal(products.status, 200);
    assert.equal((await products.json()).find(product => product.id === 1).stock, 9);

    const session_id = 'teste@lid';
    const legacyConfirm = (db, session) => {
        const cart = JSON.parse(db.prepare('SELECT cart_json FROM conversation_carts WHERE session_id=?').pluck().get(session));
        return `confirmar ${cart.offer.code}`;
    };
    const unauthorized = await post('/integrations/conversation', { session_id, message_id: '1', mensagem: 'cardápio' });
    assert.equal(unauthorized.status, 401);
    const command = async (message_id, mensagem) => {
        const reply = await post('/integrations/conversation', { session_id, message_id, mensagem }, auth);
        assert.equal(reply.status, 200);
        return (await reply.json()).resposta;
    };
    await command('1', 'adicionar 2 #1');
    await command('2', 'nome Cliente Conversa');
    await command('3', 'telefone 11900000001');
    await command('fulfillment', 'retirada');
    await command('payment', 'pagamento Pix');
    const summary = await command('4', 'resumo');
    assert.match(summary, /1 - Confirmar pedido/);
    const confirm = '1';

    const db = new Database(databasePath, { fileMustExist: true });
    try {
        db.exec(`
            CREATE TRIGGER fail_http_response BEFORE INSERT ON conversation_messages
            WHEN NEW.message_id = 'retry' BEGIN
                SELECT RAISE(ABORT, 'Cliente Privado 11912345678 segredo-ficticio');
            END;
        `);
        const failed = await post('/integrations/conversation', { session_id, message_id: 'retry', mensagem: confirm }, auth);
        assert.equal(failed.status, 500);
        assert.deepEqual(await failed.json(), { error: 'Erro interno' });
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 2);
        db.exec('DROP TRIGGER fail_http_response');

        const body = JSON.stringify({ session_id, message_id: '5', mensagem: confirm });
        await new Promise((resolve, reject) => {
            const request = http.request(`${baseUrl}/api/integrations/conversation`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...auth }
            }, response => {
                response.destroy();
                if (response.statusCode === 200) resolve();
                else reject(new Error(`Resposta inesperada: ${response.statusCode}`));
            });
            request.on('error', reject);
            request.setTimeout(3000, () => request.destroy(new Error('Timeout no HTTP')));
            request.end(body);
        });
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 3);
        assert.match(await command('5', confirm), /Pedido #3 confirmado.*90,00/);
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 3);
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 7);

        async function storeRequest(endpoint, { method = 'GET', body, admin = false, status = 200 } = {}) {
            const response = await fetch(`${baseUrl}/api${endpoint}`, {
                method, signal: AbortSignal.timeout(3000),
                headers: { 'content-type': 'application/json', origin, ...(admin ? panelHeaders : {}) },
                body: body && JSON.stringify(body)
            });
            assert.equal(response.status, status, endpoint);
            return response.json();
        }
        const settings = {
            name: 'Loja de teste', hours: '18h às 22h', menu_note: '', menu_open: true,
            regions: [{ name: 'Centro', shipping_cents: 600 }], payments: ['Pix']
        };
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        await storeRequest('/products/1', { method: 'PATCH', admin: true, body: { name: 'Galeto da casa', price_cents: 5100, category: 'Aves' } });
        const menu = await storeRequest('/menu');
        assert.equal(menu.products.find(product => product.id === 1).price_cents, 5100);
        assert.equal(menu.products.find(product => product.id === 1).category, 'Aves');
        const oldOrder = await storeRequest('/orders/1', { admin: true });
        assert.equal(oldOrder.items[0].name, 'Galeto');
        assert.equal(oldOrder.items[0].unit_price_cents, 4500);

        const payload = {
            name: 'Cliente Site', phone: '11900000002', fulfillment: 'delivery', payment: 'Pix',
            region: 'Centro', address: 'Rua de Teste, 1', items: [{ product_id: 1, quantity: 2 }],
            shipping_cents: 1, total_cents: 1
        };
        const quoteOptions = { method: 'POST', body: payload, status: 201 };
        const stale = await storeRequest('/menu/quote', quoteOptions);
        assert.equal(stale.total_cents, 10800);
        settings.regions[0].shipping_cents = 800;
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        await storeRequest('/menu/confirm', { method: 'POST', body: { token: stale.token }, status: 409 });
        const reviewed = await storeRequest('/menu/quote', quoteOptions);
        const confirmation = { method: 'POST', body: { token: reviewed.token } };
        const [one, two] = await Promise.all([
            storeRequest('/menu/confirm', confirmation), storeRequest('/menu/confirm', confirmation)
        ]);
        assert.deepEqual(one, { id: 4, status: 'pending', total_cents: 11000 });
        assert.deepEqual(two, one);
        const orders = await storeRequest('/orders', { admin: true });
        assert.deepEqual(orders.map(row => row.source), ['site', 'whatsapp', 'whatsapp-simulated', 'counter']);
        assert.deepEqual(orders.map(row => row.payment_status), ['pending', 'pending', null, null]);
        assert.equal(orders[0].payment_method, 'Pix');
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 5);
        assert.equal(db.prepare('SELECT COUNT(*) FROM stock_movements WHERE product_id=1 AND reason=?').pluck().get('Venda'), 3);
        await storeRequest('/orders/4/status', { method: 'PATCH', admin: true, body: { status: 'confirmed' } });
        const tracking = await storeRequest('/menu/status', confirmation);
        assert.deepEqual(tracking, { ...one, status: 'confirmed' });
        assert.equal((await storeRequest('/orders/4', { admin: true })).details.address, payload.address);
        await storeRequest('/products/1/movements', { method: 'POST', admin: true, body: { delta: -6, reason: 'Contagem' }, status: 409 });
        await storeRequest('/products/1/movements', { method: 'POST', admin: true, body: { delta: 2, reason: 'Reposição' }, status: 201 });
        const movements = await storeRequest('/stock/movements', { admin: true });
        assert.equal(movements[0].balance, 7);
        assert.equal(movements[0].reason, 'Reposição');
        await storeRequest('/products/1', { method: 'PATCH', admin: true, body: { active: false } });
        assert.ok(!(await storeRequest('/menu')).products.some(product => product.id === 1));
        const operationalSummary = await storeRequest('/dashboard', { admin: true });
        assert.equal(operationalSummary.today, 3);
        assert.equal(operationalSummary.received_today_cents, 0);
        assert.equal(operationalSummary.orders_pending_payment, 2);
        assert.equal(operationalSummary.orders_without_payment, 1);
        assert.equal(operationalSummary.channels.reduce((sum, channel) => sum + channel.count, 0), 3);

        // Run the sanitized workflow's Code node against Gemini-shaped fixtures.
        const workflow = JSON.parse(fs.readFileSync(new URL('../../../docs/n8n/galetobot-kodie-gemini-ia.json', import.meta.url), 'utf8'));
        assert.equal(workflow.active, false);
        assert.equal(workflow.nodes.length, 9);
        assert.ok(workflow.nodes.every(node => !node.credentials));
        const codeNode = workflow.nodes.find(node => node.name === 'Code in JavaScript');
        const normalizeNode = workflow.nodes.find(node => node.name === 'Preparar resposta HTTP');
        const prompt = workflow.nodes.find(node => node.name === 'Message a model').parameters.messages.values[0].content;
        const renderPrompt = new Function('$json', '$', `return (${prompt.slice(3, -2)});`);
        assert.match(renderPrompt({ body: { use_model: true } },
            () => ({ first: () => ({ json: { body: { mensagem: 'Entrega e Pix' } } }) })),
        /delivery sem value[\s\S]*Entrega e Pix/);
        const preparePayload = new Function('$', '$input', codeNode.parameters.jsCode);
        const formatNode = new Function('$', '$input', normalizeNode.parameters.jsCode);
        const formatResponse = (output, context) => formatNode(
            () => ({ first: () => ({ json: context }) }),
            { first: () => ({ json: output }) }
        )[0].json;
        const commercialSession = 'cliente-comercial@lid';
        let messageId = 0;
        async function conversation(text, actions, { id = String(++messageId), session = commercialSession, modelFailed = false } = {}) {
            const body = { session_id: session, message_id: id, mensagem: text };
            const prepared = await post('/integrations/conversation/context', body, auth);
            assert.equal(prepared.status, 200);
            const context = await prepared.json();
            assert.equal(Object.hasOwn(context, 'pix_key'), false);
            const model = modelFailed ? { error: 'Modelo indisponível' } : {
                content: { parts: [{ thought: true, text: 'ignorar' }, { text: JSON.stringify({ actions }) }] }
            };
            const envelope = { statusCode: prepared.status, body: context };
            const input = preparePayload(name => ({ first: () => ({ json: name === 'Webhook' ? { body } : envelope }) }), {
                first: () => ({ json: model })
            })[0].json;
            let output = input;
            if (!input.skip_api) {
                const response = await post('/integrations/conversation', input, auth);
                assert.equal(response.status, 200);
                output = { statusCode: response.status, body: await response.json() };
            }
            const rendered = formatResponse(output, envelope);
            assert.equal(rendered.statusCode, 200);
            return { result: rendered.body, context };
        }
        const say = async (...args) => (await conversation(...args)).result.resposta;
        await storeRequest('/products/1', { method: 'PATCH', admin: true, body: { active: true, name: 'Galeto' } });
        settings.regions.push({ name: 'Presidente Médici', shipping_cents: 900 });
        settings.pix_key = 'chave-demo@example.invalid';
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        assert.equal(Object.hasOwn((await storeRequest('/menu')).settings, 'pix_key'), false);
        assert.match(await say('Como faço um pedido?', [{ type: 'faq', value: 'pedir' }]), /confirma o resumo/);
        assert.match(await say('Qual é o prazo?', [{ type: 'faq', value: 'prazo' }]), /pendente de configuração/);
        assert.match(await say('Quanto custa o Galeto?', [{ type: 'price', value: 'Galeto' }]), /51,00/);
        assert.match(await say('Tem Pizza?', [{ type: 'availability', value: 'Pizza' }]), /Não encontrei/);
        assert.match(await say('frete Morro do Meio'), /Presidente Médici.*9,00/);
        assert.match(await say('frete Bairro Desconhecido'), /atendente/);
        settings.region_aliases = [{ alias: 'Morro do Meio', regiao: 'Centro' }];
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        assert.match(await say('frete Morro do Meio'), /Qual região.*Centro.*Presidente Médici/);
        settings.region_aliases = [];
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        const add = [{ type: 'add', value: 'galetos', quantity: 2 }, { type: 'add', value: 'arroz', quantity: 1 }];
        const built = await say('Quero dois galetos e um arroz.', add, { id: 'batch' });
        assert.match(built, /2 × Galeto/);
        assert.match(built, /1 × Arroz/);
        assert.equal(await say('Quero dois galetos e um arroz.', add, { id: 'batch' }), built);
        assert.equal((await conversation('qual meu carrinho?', [], { session: 'outro-cliente@lid' })).context.cart.items.length, 0);
        assert.match(await say('Só um galeto', [{ type: 'change', value: 'galeto', quantity: 1 }]), /1 × Galeto/);
        assert.match(await say('entrega Morro do Meio'), /9,00/);
        await say('endereço Rua Exemplo, 12');
        await say('nome Cliente Comercial');
        await say('telefone 11900000003');
        await say('pagamento Pix');
        const pix = await say('Me passa a chave?', [{ type: 'pix' }], { id: 'pix-request' });
        assert.match(pix, /chave-demo@example.invalid/);
        assert.match(pix, /não confirma o pagamento/);
        assert.ok(!db.prepare('SELECT response FROM conversation_messages').pluck().all().some(reply => reply.includes(settings.pix_key)));
        settings.pix_key = 'nova-chave-demo@example.invalid';
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        assert.match(await say('Me passa a chave?', [{ type: 'pix' }], { id: 'pix-request' }), /nova-chave-demo@example.invalid/);
        const commercialQuote = await say('resumo');
        assert.match(commercialQuote, /68,00/);
        const commercialConfirm = legacyConfirm(db, commercialSession);
        assert.match(commercialQuote, /1 - Confirmar pedido/);
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 4);
        const invalid = await post('/integrations/conversation', {
            session_id: commercialSession, message_id: 'fake-confirm', mensagem: 'olá',
            interpretacao: { actions: [{ type: 'confirm', value: commercialConfirm }] }
        }, auth);
        assert.equal(invalid.status, 400);
        assert.match(await say('frase incompreensível', [], { modelFailed: true }), /Não consegui interpretar/);
        const validContext = { statusCode: 200, body: { use_model: false } };
        assert.equal(formatResponse({ error: 'API desligada' }, validContext).statusCode, 502);
        const rejectedContext = await post('/integrations/conversation/context', {
            session_id: commercialSession, message_id: 'auth-check', mensagem: 'Como faço um pedido?'
        }, { 'x-integration-token': 'token-incorreto' });
        assert.equal(rejectedContext.status, 401);
        const rejectedEnvelope = { statusCode: rejectedContext.status, body: await rejectedContext.json() };
        assert.deepEqual(preparePayload(() => ({ first: () => ({ json: rejectedEnvelope }) }), {})[0].json, { skip_api: true });
        const diagnosed = formatResponse({ skip_api: true }, rejectedEnvelope);
        assert.equal(diagnosed.statusCode, 401);
        assert.equal(diagnosed.body.etapa, 'contexto');
        assert.match(diagnosed.body.error, /x-integration-token/);
        assert.equal(formatResponse(rejectedEnvelope, validContext).body.etapa, 'conversa');
        const transfer = await say('Quero falar com um atendente');
        assert.match(transfer, /pausado/);
        const silenced = await conversation(commercialConfirm, []);
        assert.deepEqual(silenced.result, { resposta: '', suprimir_resposta: true });
        assert.equal(silenced.context.use_model, false);
        assert.deepEqual((await conversation('Sim', [])).result, { resposta: '', suprimir_resposta: true });
        assert.deepEqual(formatResponse({ skip_api: true }, { statusCode: 200, body: silenced.context }).body,
            { resposta: '', suprimir_resposta: true });
        const activeHandoffs = await storeRequest('/conversation-handoffs', { admin: true });
        assert.deepEqual(activeHandoffs.map(entry => entry.session_id), [commercialSession]);
        await storeRequest('/conversation-handoffs/resume', { method: 'POST', body: { session_id: commercialSession }, status: 401 });
        await storeRequest('/conversation-handoffs/resume', { method: 'POST', body: { session_id: commercialSession }, admin: true });
        assert.deepEqual(await storeRequest('/conversation-handoffs', { admin: true }), []);
        assert.match(await say(commercialConfirm), /Nenhum resumo vigente/);
        assert.match(await say('resumo'), /1 - Confirmar pedido/);
        const newConfirm = legacyConfirm(db, commercialSession);
        assert.ok(newConfirm && newConfirm !== commercialConfirm);
        assert.match(await say(newConfirm), /Pedido #5 confirmado.*68,00/);
        assert.match(await say(newConfirm), /Pedido #5 confirmado/);
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 5);
        const commercialOrder = await storeRequest('/orders/5', { admin: true });
        assert.equal(commercialOrder.details.region, 'Presidente Médici');
        assert.equal(commercialOrder.details.shipping_cents, 900);
        assert.equal(commercialOrder.source, 'whatsapp');
        assert.equal((await storeRequest('/orders/3', { admin: true })).details.shipping_cents, 0);
        assert.equal(db.prepare('SELECT COUNT(*) FROM stock_movements WHERE order_id=5').pluck().get(), 2);
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 6);
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=3').pluck().get(), 6);

        // Reproduce the WhatsApp sequence through the existing workflow nodes and isolated API.
        const session = 'regressao-entrega@lid';
        const talk = (text, actions) => conversation(text, actions, { session });
        await storeRequest('/products/1', { method: 'PATCH', admin: true, body: { price_cents: 4500 } });
        await storeRequest('/products/3', { method: 'PATCH', admin: true, body: { price_cents: 800 } });
        const farofa = await storeRequest('/products', { method: 'POST', admin: true, status: 201,
            body: { name: 'Farofa', price_cents: 1000, stock: 8 } });
        const hungry = await talk('To com fome', [{ type: 'menu' }]);
        assert.equal(hungry.context.use_model, true);
        assert.match(hungry.result.resposta, /Galeto.*45,00.*estoque/);
        const items = [
            { type: 'add', value: 'galeto', quantity: '1', price_cents: 1 },
            { type: 'add', value: 'farofa', quantity: 1 },
            { type: 'add', value: 'arroz', quantity: 1 }
        ];
        const basket = await talk('Quero um galeto com farofa e um arroz.', items);
        assert.match(basket.result.resposta, /63,00.*[\s\S]*entrega ou retirada/);

        const regions = settings.regions;
        settings.regions = [];
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        const unavailable = await talk('Quero entrega');
        assert.equal(unavailable.context.use_model, false);
        assert.match(unavailable.result.resposta, /entrega está indisponível/);
        settings.regions = regions;
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        const delivery = await talk('Quero entrega');
        assert.match(delivery.result.resposta, /Qual é o seu bairro/);
        const pixChoice = await talk('Quero pagar via Pix');
        assert.match(pixChoice.result.resposta, /Pagamento: Pix.*bairro/);
        assert.match((await talk('resumo')).result.resposta, /Entrega\nPagamento: Pix\nSubtotal sem frete:.*63,00/);

        const batch = await talk('Entrega e vou pagar no Pix. Meu nome é Cliente Teste e meu telefone é (11) 90000-0042.', [
            { type: 'delivery', value: null, quantity: null },
            { type: 'name', value: 'Cliente Teste', quantity: null },
            { type: 'phone', value: '(11) 90000-0042' },
            { type: 'payment', value: 'Pix', quantity: null },
            { type: 'confirm', value: 'inventado' }
        ]);
        assert.equal(batch.context.use_model, true);
        assert.equal(batch.context.cart.needs_region, true);
        assert.match(batch.result.resposta, /Pagamento: Pix[\s\S]*Qual é o seu bairro/);
        assert.doesNotMatch(batch.result.resposta, /Qual é o seu (telefone|nome)|confirmar|inválida/);
        const neighborhood = await talk('Morro do Meio', [{ type: 'delivery', value: 'Morro do Meio' }]);
        assert.equal(neighborhood.context.cart.needs_name, false);
        assert.equal(neighborhood.context.cart.needs_phone, false);
        assert.match(neighborhood.result.resposta, /Presidente Médici:.*9,00[\s\S]*endereço/);
        const complete = (await talk('Rua de Teste, 42', [{ type: 'address', value: 'Rua de Teste, 42' }])).result.resposta;
        assert.match(complete, /Presidente Médici.*9,00[\s\S]*Rua de Teste, 42[\s\S]*Pagamento: Pix[\s\S]*63,00[\s\S]*72,00/);
        assert.match(complete, /1 - Confirmar pedido/);
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 5);
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').pluck().get(farofa.id), 8);
        assert.match((await talk('Pode confirmar')).result.resposta, /Pedido #6 confirmado.*72,00/);
        assert.match((await talk('Pode confirmar')).result.resposta, /Envie resumo/);
        const delivered = await storeRequest('/orders/6', { admin: true });
        assert.equal(delivered.details.region, 'Presidente Médici');
        assert.equal(delivered.details.payment, 'Pix');
        assert.equal(delivered.details.shipping_cents, 900);
        assert.equal(delivered.status, 'pending');
        assert.equal(delivered.payment.status, 'pending');
        assert.equal(oldOrder.payment, null);
        const markPayment = { method: 'PATCH', body: { status: 'received' } };
        await storeRequest('/orders/6/status', { method: 'PATCH', admin: true, body: { status: 'confirmed' } });
        await storeRequest('/orders/6/payment', { ...markPayment, status: 401 });
        const invalidOrigin = await fetch(`${baseUrl}/api/orders/6/payment`, {
            method: 'PATCH', headers: { ...panelHeaders, 'content-type': 'application/json', origin: 'http://localhost:9999' },
            body: JSON.stringify(markPayment.body)
        });
        assert.equal(invalidOrigin.status, 403);
        assert.equal((await storeRequest('/orders/6', { admin: true })).payment.status, 'pending');
        const received = await storeRequest('/orders/6/payment', { ...markPayment, admin: true });
        assert.equal(received.status, 'received');
        assert.ok(received.received_at && received.received_by);
        assert.deepEqual(await storeRequest('/orders/6/payment', { ...markPayment, admin: true }), received);
        assert.equal(db.prepare("SELECT COUNT(*) FROM audit WHERE action='pix_received'").pluck().get(), 1);
        assert.equal((await storeRequest('/orders/6', { admin: true })).status, 'confirmed');
        const receivedSummary = await storeRequest('/dashboard', { admin: true });
        assert.equal(receivedSummary.received_today_cents, 7200);
        assert.equal(receivedSummary.received_today, 1);
        assert.ok(receivedSummary.total_cents > receivedSummary.received_today_cents);
        assert.equal((await storeRequest('/orders', { admin: true }))[0].id, 6);
        assert.equal(db.prepare('SELECT COUNT(*) FROM stock_movements WHERE order_id=6').pluck().get(), 3);
        assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').pluck().get(farofa.id), 7);
        db.prepare("UPDATE orders SET created_at=datetime('now','-3 days') WHERE id=6").run();
        const laterReceipt = await storeRequest('/dashboard', { admin: true });
        assert.equal(laterReceipt.total_cents, receivedSummary.total_cents - 7200);
        assert.equal(laterReceipt.received_today_cents, 7200);
        db.exec(`WITH RECURSIVE sample(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM sample WHERE i<115)
            INSERT INTO orders(source,status,total_cents) SELECT 'site','pending',1000 FROM sample`);
        const lane = (await storeRequest('/orders?view=board&status=pending&channel=site', { admin: true })).lanes[0];
        assert.equal(lane.total, 115);
        assert.equal(lane.items.length, 20);
        const nextPage = await storeRequest(`/orders?view=list&status=pending&channel=site&before=${lane.next}`, { admin: true });
        assert.equal(nextPage.items.length, 25);
        assert.ok(nextPage.items.every(row => row.id < lane.next));
        const byNumber = await storeRequest('/orders?view=list&q=%236', { admin: true });
        assert.equal(byNumber.items[0].fulfillment, 'delivery');
        await storeRequest('/orders?view=board&before=2', { admin: true, status: 400 });
        const png = await sharp({ create: { width: 1350, height: 36, channels: 3, background: '#ea580c' } }).png().toBuffer();
        const upload = (bytes, headers = panelHeaders, type = 'image/png') => fetch(baseUrl + '/api/products/1/photo', {
            method: 'POST', headers: { origin, ...headers, 'content-type': type }, body: bytes
        });
        assert.equal((await upload(png, {})).status, 401);
        assert.equal((await upload(png, { ...panelHeaders, origin: 'https://invalid.example' })).status, 403);
        assert.equal((await upload(Buffer.from('<svg/>'))).status, 422);
        assert.equal((await upload(png, panelHeaders, 'image/jpeg')).status, 422);
        const huge = await sharp({ create: { width: 4097, height: 1, channels: 3, background: '#000' } }).png().toBuffer();
        assert.equal((await upload(huge)).status, 422);
        const uploaded = await upload(png);
        assert.equal(uploaded.status, 201);
        const { url: image } = await uploaded.json();
        const served = await fetch(baseUrl + image);
        const info = await sharp(Buffer.from(await served.arrayBuffer())).metadata();
        assert.equal(info.format, 'webp');
        assert.equal(info.width, 1200);
        assert.equal((await storeRequest('/menu')).products.find(product => product.id === 1).image_url, image);
        const { url: replacement } = await (await upload(png)).json();
        assert.notEqual(replacement, image);
        assert.equal((await fetch(baseUrl + image)).status, 404);
        assert.equal((await storeRequest('/products/1/photo', { method: 'DELETE', admin: true })).url, '');
        assert.equal((await fetch(baseUrl + replacement)).status, 404);
        const uploadLogo = await fetch(baseUrl + '/api/settings/logo', {
            method: 'POST', headers: { ...panelHeaders, origin, 'content-type': 'image/png' }, body: png
        });
        assert.equal(uploadLogo.status, 201);
        const { url: logo } = await uploadLogo.json();
        await storeRequest('/settings', { method: 'PUT', body: { ...settings, brand_theme: 'carvao', pickup_enabled: false }, admin: true });
        await storeRequest('/settings', { method: 'PUT', body: settings, admin: true });
        const publicSettings = (await storeRequest('/menu')).settings;
        assert.equal(publicSettings.logo_url, logo);
        assert.equal(publicSettings.brand_theme, 'carvao');
        assert.equal(publicSettings.pickup_enabled, false);
        await storeRequest('/settings', { method: 'PUT', body: { ...settings, human_contact_url: 'http://example.invalid' }, admin: true, status: 400 });
        await storeRequest('/settings/logo', { method: 'DELETE', admin: true });
        assert.equal((await fetch(baseUrl + logo)).status, 404);
        const clients = await storeRequest('/customers?q=11900000042&sort=recent', { admin: true });
        assert.equal(clients.length, 1);
        assert.equal(clients[0].ordered_cents, 7200);
        assert.ok(clients[0].last_order_at);
        const auditedStock = await storeRequest('/stock/movements', { admin: true });
        assert.ok(auditedStock.some(movement => movement.order_id === 6 && movement.source === 'whatsapp'));
    } finally {
        db.close();
    }
});
