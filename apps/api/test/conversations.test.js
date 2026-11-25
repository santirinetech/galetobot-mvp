import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { initializeDatabase } from '../src/database.js';
import { CART_TTL_MS, createConversationService } from '../src/conversations.js';
import { conversationHandler, integrationAuth } from '../src/integrations.js';
import { createOrderService, orderSchema } from '../src/orders.js';
import { createStoreCheckout } from '../src/store.js';

const session = '123456789012@lid';
const phone = '11900000000';

function fixture(t, enableStore = false) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'galetobot-conversations-'));
    const options = {
        projectRoot, enableStore,
        email: 'teste@example.invalid',
        password: 'senha-ficticia-123'
    };
    let timestamp = 1000;
    let nextId = 0;
    let db = initializeDatabase({ ...options, allowCreate: true });
    const createService = db => {
        const orders = createOrderService(db, { enableStore });
        return createConversationService(db, orders, { now: () => timestamp,
            checkout: enableStore ? createStoreCheckout(db, orders) : null });
    };
    let service = createService(db);
    t.after(() => {
        if (db.open) db.close();
        fs.rmSync(projectRoot, { recursive: true, force: true });
    });
    return {
        options,
        get db() { return db; },
        get service() { return service; },
        advance(ms) { timestamp += ms; },
        restart() {
            db.close();
            db = initializeDatabase(options);
            service = createService(db);
        },
        send(mensagem, message_id = String(++nextId), session_id = session) {
            return service.processMessage({ mensagem, message_id, session_id }).resposta;
        }
    };
}

test('Pix avança a coleta, pode ser trocado por cartão e confirma sem registrar recebimento', t => {
    const f = fixture(t, true);
    f.db.prepare('INSERT INTO store_settings VALUES(1,?)').run(JSON.stringify({
        menu_open: true, regions: [], payments: ['Pix', 'Cartão'], pix_key: 'chave-fixture@example.invalid'
    }));
    f.send('adicionar 1 Galeto');
    f.send('retirada');
    const pix = f.send('Pix');
    assert.match(pix, /chave-fixture@example.invalid/);
    assert.match(pix, /A equipe vai verificar/);
    assert.match(pix, /Qual é o seu nome/);
    assert.match(f.send('nome Cliente Teste'), /Qual é o seu telefone/);
    f.send(`telefone ${phone}`);
    const previous = confirmation(f, f.send('resumo'));
    const card = f.send('Cartão');
    assert.match(card, /Pagamento: Cartão/);
    assert.doesNotMatch(card, /chave-fixture/);
    assert.match(f.send(previous), /Nenhum resumo vigente/);
    assert.match(f.send('Tudo certo', 'confirm-card'), /Pedido #1 confirmado/);
    assert.match(f.send('Tudo certo', 'confirm-card'), /Pedido #1 confirmado/);
    assert.match(f.send('Pode fechar'), /Envie resumo/);
    assert.deepEqual(f.db.prepare('SELECT method,status FROM order_payments').get(), { method: 'Cartão', status: 'pending' });
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 9);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM stock_movements').pluck().get(), 1);
    assert.ok(!f.db.prepare('SELECT response FROM conversation_messages').pluck().all().some(row => row.includes('chave-fixture')));
});

test('dinheiro calcula troco com frete e invalida a aprovação se a entrega mudar', t => {
    const f = fixture(t, true);
    const settings = { menu_open: true, payments: ['Dinheiro'], regions: [{ name: 'Centro', shipping_cents: 700 }] };
    const update = f.db.prepare('INSERT OR REPLACE INTO store_settings VALUES(1,?)');
    update.run(JSON.stringify(settings));
    f.send('adicionar 1 Galeto');
    f.send('entrega Centro');
    f.send('endereço Rua Teste, 10');
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    assert.match(f.send('Dinheiro, troco para 50'), /cobrir o total com frete/);
    assert.match(f.send('Vou pagar com 0'), /valor válido/);
    assert.match(f.send('Dinheiro, troco para 60'), /Valor entregue: R\$\s*60,00[\s\S]*Troco: R\$\s*8,00/);
    settings.regions[0].shipping_cents = 800;
    update.run(JSON.stringify(settings));
    assert.match(f.send('Sim'), /resumo mudou[\s\S]*Troco: R\$\s*7,00/);
    assert.equal(orderCount(f.db), 0);
    assert.match(f.send('Vou pagar com R$ 100,50'), /Troco: R\$\s*47,50/);
    assert.match(f.send('1 - Confirmar pedido'), /Pedido #1 confirmado.*53,00/);
    const payment = f.db.prepare('SELECT method,status,cash_tendered_cents,change_cents FROM order_payments').get();
    assert.deepEqual(payment, { method: 'Dinheiro', status: 'pending', cash_tendered_cents: 10050, change_cents: 4750 });
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 9);
});

test('sem troco, alteração e cancelamento usam apenas a oferta vigente', t => {
    const f = fixture(t, true);
    f.send('adicionar 1 Galeto');
    f.send('retirada');
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    assert.match(f.send('Não preciso de troco'), /Troco: R\$\s*0,00/);
    assert.match(f.send('2'), /deseja alterar/);
    assert.match(f.send('Confirmar pedido'), /Envie resumo/);
    f.send('resumo');
    assert.match(f.send('3 - Cancelar pedido'), /Carrinho cancelado/);
    assert.match(f.send('Sim'), /Envie resumo/);
    assert.equal(orderCount(f.db), 0);
    f.send('adicionar 1 Galeto');
    f.send('retirada');
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    f.send('Não preciso de troco');
    assert.match(f.send('Confirmar pedido'), /Pedido #1 confirmado/);
    assert.deepEqual(f.db.prepare('SELECT cash_tendered_cents,change_cents FROM order_payments').get(),
        { cash_tendered_cents: null, change_cents: 0 });
});

test('consultas ao cardápio não prolongam a validade do resumo', t => {
    const f = fixture(t);
    offer(f);
    f.advance(CART_TTL_MS - 1);
    f.send('cardápio');
    f.advance(1);
    assert.match(f.send('Pode confirmar'), /O resumo expirou/);
    assert.equal(orderCount(f.db), 0);
    assert.match(f.send('resumo'), /1 - Confirmar pedido/);
    assert.match(f.send('Sim'), /Pedido #1 confirmado/);
});

function confirmation(f, response) {
    assert.match(response, /1 - Confirmar pedido/);
    assert.doesNotMatch(response, /[0-9a-f]{8}-[0-9a-f-]{27}/i);
    const cart = JSON.parse(f.db.prepare('SELECT cart_json FROM conversation_carts WHERE session_id=?').pluck().get(session));
    assert.ok(cart.offer.code);
    return `confirmar ${cart.offer.code}`;
}

function offer(f, items = 'adicionar 2 Galeto') {
    f.send(items);
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    return confirmation(f, f.send('resumo'));
}

function orderCount(db) {
    return db.prepare('SELECT COUNT(*) AS count FROM orders').get().count;
}

test('carrinho edita itens e confirma com preço de catálogo, telefone informado e baixa atômica', t => {
    const f = fixture(t);
    assert.match(f.send('cardápio'), /#1 Galeto.*45,00.*10 em estoque/);
    f.send('adicionar 2 Galeto');
    f.send('adicionar 1 galeto');
    f.send('alterar 2 #1');
    f.send('adicionar 1 Salpicao');
    f.send('remover Salpicão');
    f.send('adicionar 1 feijao tropeiro');
    const noDetails = f.send('resumo');
    assert.match(noDetails, /102,00/);
    assert.doesNotMatch(noDetails, /confirmar [0-9a-f]/);
    assert.match(f.send('telefone 123456789012'), /10 ou 11 dígitos/);
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    const summary = f.send('resumo');
    assert.match(summary, /2 × Galeto.*45,00/);
    assert.match(summary, /1 × Feijão tropeiro.*12,00/);
    assert.equal(orderCount(f.db), 0);

    const result = f.send(confirmation(f, summary));
    assert.match(result, /Pedido #1 confirmado.*102,00/);
    assert.deepEqual(f.db.prepare('SELECT source,total_cents FROM orders').get(), { source: 'whatsapp', total_cents: 10200 });
    assert.deepEqual(f.db.prepare('SELECT name,phone FROM customers').get(), { name: 'Cliente Teste', phone });
    assert.deepEqual(f.db.prepare('SELECT product_id,quantity,unit_price_cents FROM order_items ORDER BY product_id').raw().all(),
        [[1, 2, 4500], [2, 1, 1200]]);
    assert.deepEqual(f.db.prepare('SELECT stock FROM products ORDER BY id').pluck().all(), [8, 4, 8, 2]);
});

test('produto inexistente, ambíguo, esgotado e estoque insuficiente não entram no carrinho', t => {
    const f = fixture(t);
    assert.match(f.send('adicionar 1 Pizza'), /inexistente/);
    assert.match(f.send('adicionar 3 Salpicão'), /somente 2/);
    f.db.prepare('UPDATE products SET stock=0 WHERE id=1').run();
    assert.match(f.send('adicionar 1 Galeto'), /somente 0/);
    f.db.prepare("INSERT INTO products(name,price_cents,stock) VALUES('Arroz', 1000, 10)").run();
    assert.match(f.send('adicionar 1 Arroz'), /mais de um/);
    assert.equal(f.send('resumo'), 'O carrinho está vazio.');
    assert.match(f.send('adicionar 1 #3'), /atualizado/);
    assert.match(f.send('resumo'), /8,00/);
    assert.equal(orderCount(f.db), 0);
});

test('estoque alterado no balcão antes da confirmação bloqueia o pedido inteiro', t => {
    const f = fixture(t);
    const confirm = offer(f);
    createOrderService(f.db).createOrder({
        name: 'Cliente Balcão', phone: '11900000001', source: 'counter',
        items: [{ product_id: 1, quantity: 9 }]
    });
    assert.match(f.send(confirm), /somente 1/);
    assert.equal(orderCount(f.db), 1);
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM customers WHERE phone=?').pluck().get(phone), 0);
    assert.match(f.send(confirm), /Nenhum resumo vigente/);
    assert.match(f.send('alterar 1 Galeto'), /atualizado/);
    assert.match(f.send(confirmation(f, f.send('resumo'))), /Pedido #2 confirmado/);
});

test('mudanças de preço com mesmo total exigem novo código e usam valores atuais', t => {
    const f = fixture(t);
    offer(f, 'adicionar 1 Galeto');
    f.send('adicionar 1 Arroz');
    const before = confirmation(f, f.send('resumo'));
    f.db.exec('UPDATE products SET price_cents=4600 WHERE id=1; UPDATE products SET price_cents=700 WHERE id=3');
    const updated = f.send(before);
    assert.match(updated, /resumo mudou/);
    assert.match(updated, /53,00/);
    const after = confirmation(f, updated);
    assert.notEqual(before, after);
    assert.match(f.send(before), /Nenhum resumo vigente/);
    assert.equal(orderCount(f.db), 0);
    assert.match(f.send(after), /Pedido #1 confirmado/);
    assert.deepEqual(f.db.prepare('SELECT unit_price_cents FROM order_items ORDER BY product_id').pluck().all(), [4600, 700]);
});

test('confirmação sem carrinho, ambígua, de outra sessão ou de resumo antigo não registra pedido', t => {
    const f = fixture(t);
    assert.match(f.send('confirmar 00000000-0000-0000-0000-000000000000'), /Nenhum resumo vigente/);
    assert.match(f.send('Sim'), /Envie resumo/);
    const before = offer(f);
    for (const text of [ `não ${before}`, `${before}?`, `${before}\ncancelar`]) {
        assert.doesNotMatch(f.send(text), /Pedido #\d+ confirmado/);
    }
    assert.match(f.send(before, 'outside', 'outra@lid'), /Nenhum resumo vigente/);
    assert.match(f.send('Tudo certo', 'outside-natural', 'outra@lid'), /Envie resumo/);
    f.send('alterar 1 Galeto');
    const after = confirmation(f, f.send('resumo'));
    assert.notEqual(before, after);
    assert.match(f.send(before), /Nenhum resumo vigente/);
    assert.equal(orderCount(f.db), 0);
});

test('reenvio e confirmação duplicada persistem entre reinicializações e novos carrinhos', t => {
    const f = fixture(t);
    const added = f.send('adicionar 1 Galeto', 'add');
    f.restart();
    assert.equal(f.send('adicionar 1 Galeto', 'add'), added);
    f.send('nome Cliente Teste');
    f.send(`telefone ${phone}`);
    const summary = f.send('resumo', 'summary');
    const confirm = confirmation(f, summary);
    assert.match(summary, /1 × Galeto/);
    f.restart();
    assert.equal(f.send('resumo', 'summary'), summary);
    const receipt = f.send(confirm, 'confirm');
    f.restart();
    assert.equal(f.send(confirm, 'confirm'), receipt);
    f.send('adicionar 1 Arroz');
    assert.equal(f.send(confirm, 'confirmation-again'), receipt);
    assert.equal(orderCount(f.db), 1);
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 9);
    assert.match(f.send('resumo'), /1 × Arroz/);
});

test('cancelamento e expiração invalidam confirmação e limpam os dados da sessão', t => {
    const f = fixture(t);
    const cancelled = offer(f);
    assert.equal(f.send('cancelar'), 'Carrinho cancelado.');
    assert.match(f.send(cancelled), /Nenhum resumo vigente/);
    const expired = offer(f);
    f.advance(CART_TTL_MS);
    assert.match(f.send(expired), /expirou/);
    assert.match(f.send('resumo'), /vazio/);
    assert.equal(orderCount(f.db), 0);
    const cart = JSON.parse(f.db.prepare('SELECT cart_json FROM conversation_carts WHERE session_id=?').pluck().get(session));
    assert.equal(cart.phone, '');
    assert.equal(cart.name, '');
    const confirm = offer(f);
    f.send(confirm);
    assert.match(f.send('cancelar'), /já foi registrado/);
    assert.equal(orderCount(f.db), 1);
});

test('falha temporária ao persistir a resposta desfaz pedido, cliente e baixa e permite reenvio', t => {
    const f = fixture(t);
    const confirm = offer(f);
    f.db.exec(`
        CREATE TRIGGER temporary_message_failure BEFORE INSERT ON conversation_messages
        WHEN NEW.message_id = 'retry'
        BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;
    `);
    assert.throws(() => f.send(confirm, 'retry'), /falha simulada/);
    assert.equal(orderCount(f.db), 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM customers').pluck().get(), 0);
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 10);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM conversation_confirmations').pluck().get(), 0);
    f.db.exec('DROP TRIGGER temporary_message_failure');
    assert.match(f.send(confirm, 'retry'), /Pedido #1 confirmado/);
    assert.equal(orderCount(f.db), 1);
});

test('serviço compartilhado mantém retorno e replay de balcão e simulador', t => {
    const f = fixture(t);
    const { createOrder } = createOrderService(f.db);
    for (const [i, source] of ['counter', 'whatsapp-simulated'].entries()) {
        const input = orderSchema.parse({
            source, name: 'Cliente Teste', phone, external_key: `teste-key-${i}`,
            items: [{ product_id: 1, quantity: 1 }, { product_id: 1, quantity: 2 }]
        });
        assert.deepEqual(createOrder(input), { id: i + 1, total_cents: 13500 });
        assert.deepEqual(createOrder(input), { id: i + 1, total_cents: 13500, replayed: true });
    }
    assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 4);
});

test('entrada de integração exige token, identificadores e retorna resposta sem usar preço enviado', t => {
    const f = fixture(t);
    const oldToken = process.env.WEBHOOK_TOKEN;
    t.after(() => {
        if (oldToken === undefined) delete process.env.WEBHOOK_TOKEN;
        else process.env.WEBHOOK_TOKEN = oldToken;
    });
    process.env.WEBHOOK_TOKEN = 'token-ficticio-do-teste';
    const handler = conversationHandler(f.service);
    function request(body, token) {
        const req = { body, get: () => token };
        const result = { statusCode: 200 };
        const res = {
            status(code) { result.statusCode = code; return this; },
            json(data) { result.body = data; }
        };
        integrationAuth(req, res, () => handler(req, res));
        return result;
    }
    const body = { session_id: session, message_id: 'http-id', mensagem: 'cardápio', price_cents: 1 };
    assert.equal(request(body, '').statusCode, 401);
    assert.equal(request({ ...body, message_id: '' }, process.env.WEBHOOK_TOKEN).statusCode, 400);
    const success = request(body, process.env.WEBHOOK_TOKEN);
    assert.equal(success.statusCode, 200);
    assert.match(success.body.resposta, /45,00/);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM conversation_messages').pluck().get(), 1);
});

test('telefone informado no WhatsApp preserva o cadastro existente e o balcão ainda pode atualizá-lo', t => {
    const f = fixture(t);
    const orders = createOrderService(f.db);
    const input = { name: 'Nome Original', phone, items: [{ product_id: 1, quantity: 1 }], source: 'counter' };
    orders.createOrder(input);
    f.send(offer(f));
    assert.deepEqual(f.db.prepare('SELECT id,name FROM customers').get(), { id: 1, name: 'Nome Original' });
    assert.deepEqual(f.db.prepare('SELECT customer_id FROM orders ORDER BY id').pluck().all(), [1, 1]);
    orders.createOrder({ ...input, name: 'Nome Atualizado', source: 'whatsapp-simulated' });
    assert.equal(f.db.prepare('SELECT name FROM customers').pluck().get(), 'Nome Atualizado');
});

test('renomear produto sem alterar preço invalida o resumo antigo', t => {
    const f = fixture(t);
    const before = offer(f);
    f.db.prepare('UPDATE products SET name=? WHERE id=1').run('Galeto Assado');
    const revised = f.send(before);
    assert.match(revised, /resumo mudou/);
    assert.match(revised, /2 × Galeto Assado/);
    const after = confirmation(f, revised);
    assert.notEqual(before, after);
    assert.match(f.send(before), /Nenhum resumo vigente/);
    assert.equal(orderCount(f.db), 0);
    assert.match(f.send(after), /Pedido #1 confirmado/);
});

test('limpeza remove carrinho abandonado sem retorno e preserva pedidos e deduplicação', t => {
    const f = fixture(t);
    const confirm = offer(f);
    const receipt = f.send(confirm, 'receipt');
    f.send('adicionar 1 Galeto', 'add-other', 'abandonado@lid');
    f.send('nome Cliente Abandonado', 'name-other', 'abandonado@lid');
    f.send(`telefone ${phone}`, 'phone-other', 'abandonado@lid');
    f.advance(CART_TTL_MS - 1);
    assert.equal(f.service.cleanupExpiredCarts(), 0);
    f.advance(1);
    assert.equal(f.service.cleanupExpiredCarts(), 2);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM conversation_carts').pluck().get(), 0);
    assert.equal(orderCount(f.db), 1);
    assert.equal(f.send(confirm, 'receipt'), receipt);
    assert.equal(f.send(confirm), receipt);
    assert.match(f.send('adicionar 1 Galeto', 'add-other', 'abandonado@lid'), /Carrinho atualizado/);
    assert.equal(f.send('resumo', 'summary-after', 'abandonado@lid'), 'O carrinho está vazio.');
    assert.equal(orderCount(f.db), 1);
});

test('quatro conexões SQLite simultâneas gravam um único pedido, recibo e baixa', { timeout: 15000 }, async t => {
    const f = fixture(t);
    offer(f);
    const mensagem = 'Pode fechar';
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const modules = ['database', 'orders', 'conversations'].map(name => new URL(`../src/${name}.js`, import.meta.url).href);
    const script = `
        import { parentPort, workerData } from 'node:worker_threads';
        const { initializeDatabase } = await import(workerData.modules[0]);
        const { createOrderService } = await import(workerData.modules[1]);
        const { createConversationService } = await import(workerData.modules[2]);
        const db = initializeDatabase(workerData.options);
        try {
            const service = createConversationService(db, createOrderService(db), { now: () => 1000 });
            parentPort.postMessage('ready');
            const gate = new Int32Array(workerData.gate);
            if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') throw new Error('Timeout no início simultâneo');
            parentPort.postMessage(service.processMessage(workerData.body));
        } finally { db.close(); }
    `;
    const workers = [];
    const exits = [];
    try {
        await Promise.all(['same', 'same', 'other', 'another'].map(message_id => {
            const worker = new Worker(new URL('data:text/javascript,' + encodeURIComponent(script)), {
                execArgv: [],
                workerData: { modules, options: f.options, gate: gate.buffer, body: { session_id: session, message_id, mensagem } }
            });
            workers.push(worker);
            exits.push(once(worker, 'exit'));
            return once(worker, 'message').then(([message]) => assert.equal(message, 'ready'));
        }));
        const replies = workers.map(worker => once(worker, 'message'));
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
        const results = (await Promise.all(replies)).flat();
        assert.equal(new Set(results.map(result => result.resposta)).size, 2);
        assert.ok(results.some(result => /Pedido #1 confirmado/.test(result.resposta)));
        assert.ok(results.some(result => /Envie resumo/.test(result.resposta)));
        for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
        assert.equal(orderCount(f.db), 1);
        assert.equal(f.db.prepare('SELECT COUNT(*) FROM order_items').pluck().get(), 1);
        assert.equal(f.db.prepare('SELECT COUNT(*) FROM conversation_confirmations').pluck().get(), 1);
        assert.equal(f.db.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 8);
    } finally {
        await Promise.all(workers.map(worker => worker.terminate()));
    }
});
