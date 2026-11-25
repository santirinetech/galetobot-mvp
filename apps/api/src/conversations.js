import { randomUUID } from 'node:crypto';
import { customerSchema, MAX_ITEM_QUANTITY, MAX_ORDER_ITEMS, OrderUnavailableError } from './orders.js';
import { cashIntent, confirmationIntent, confirmationPattern, handoffReply, isCancellation, isDirectCommand, isHumanRequest, knowledge, modelContext, normalize, orderChoice, resolveRegion, simpleCheckoutCommand, unclearReply } from './commercial.js';

export const CART_TTL_MS = 30 * 60 * 1000;
export const CART_CLEANUP_INTERVAL_MS = 60 * 1000;

const formatMoney = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const money = cents => formatMoney.format(cents / 100);
const emptyCart = () => ({ state: 'IDLE', items: [], name: '', phone: '', offer: null, fulfillment: '', region: '', address: '', payment: '' });
const help = 'Use cardápio, adicionar 2 Galeto, alterar 1 Galeto, remover Galeto, resumo ou cancelar.';
const askForSummary = 'Envie resumo para revisar o pedido.';
const muted = { resposta: '', suprimir_resposta: true };
const pixMarker = '\u0000PIX_CONFIGURADO\u0000';

function findProduct(products, label, currentItems) {
    const byId = /^#(\d+)$/.exec(label);
    const name = normalize(label);
    const available = products.filter(product => !currentItems || currentItems.some(item => item.product_id === product.id));
    if (byId) return available.filter(product => product.id === Number(byId[1]));
    const exact = available.filter(product => normalize(product.name) === name);
    return exact.length || !name.endsWith('s') ? exact : available.filter(product => normalize(product.name) === name.slice(0, -1));
}

function itemCommand(cart, { action, quantity, label }, products, quoteOrder) {
    if (action !== 'remover' && (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY)) {
        return `Informe uma quantidade de 1 a ${MAX_ITEM_QUANTITY}.`;
    }

    const candidates = findProduct(products, label, action === 'adicionar' ? null : cart.items);
    if (!candidates.length) return 'Produto inexistente ou indisponível para essa ação. Consulte cardápio.';
    if (candidates.length > 1) return 'Há mais de um produto com esse nome. Consulte cardápio e use #ID.';

    const product = candidates[0];
    const previous = cart.items.find(item => item.product_id === product.id);
    const nextQuantity = action === 'adicionar' ? (previous?.quantity ?? 0) + quantity : quantity;
    if (nextQuantity > MAX_ITEM_QUANTITY) return `O limite por produto é ${MAX_ITEM_QUANTITY} unidades.`;
    const items = cart.items.filter(item => item.product_id !== product.id);
    if (nextQuantity) items.push({ product_id: product.id, quantity: nextQuantity });
    if (items.length > MAX_ORDER_ITEMS) return `O carrinho aceita até ${MAX_ORDER_ITEMS} produtos diferentes.`;
    if (nextQuantity && (!previous || nextQuantity > previous.quantity)) {
        quoteOrder([{ product_id: product.id, quantity: nextQuantity }]);
    }

    cart.state = 'BUILDING_CART';
    cart.items = items;
    cart.offer = null;
    return `Carrinho atualizado. ${askForSummary}`;
}

function summary(cart, quote, timestamp, instructions = '') {
    const rows = quote.lines.map(line => `${line.quantity} × ${line.name} (${money(line.unit_price_cents)} cada)`);
    if (quote.checkout) {
        const { fulfillment, region, shipping_cents, payment } = quote.checkout;
        rows.push(fulfillment === 'delivery' ? `Entrega em ${region} · frete ${money(shipping_cents)}\nEndereço: ${quote.checkout.address}` : 'Retirada no estabelecimento', `Pagamento: ${payment}`);
        if (quote.checkout.cash_tendered_cents != null) rows.push(`Valor entregue: ${money(quote.checkout.cash_tendered_cents)}`);
        if (quote.checkout.change_cents != null) rows.push(`Troco: ${money(quote.checkout.change_cents)}`);
    } else if (instructions) {
        if (cart.fulfillment) rows.push(cart.fulfillment === 'delivery' ? 'Entrega' : 'Retirada no estabelecimento');
        if (cart.payment) rows.push(`Pagamento: ${cart.payment}`);
    }
    if (quote.checkout) rows.push(`Subtotal: ${money(quote.subtotal_cents)}`);
    rows.push(`${instructions && !quote.checkout ? 'Subtotal sem frete' : 'Total'}: ${money(quote.total_cents)}`);
    if (instructions) rows.push(instructions);
    if (!instructions && !customerSchema.safeParse(cart).success) {
        rows.push('Informe seus dados com “nome Seu Nome” e “telefone DDD+número” (somente dígitos).');
    }
    if (instructions) return rows.join('\n');
    if (!customerSchema.safeParse(cart).success) return [...rows, askForSummary].join('\n');

    if (quote.checkout) rows.push(`Cliente: ${cart.name} · ${cart.phone}`);
    const snapshot = JSON.stringify(quote);
    if (cart.offer?.snapshot !== snapshot || !cart.offer.expiresAt || cart.offer.expiresAt <= timestamp) {
        cart.offer = { code: randomUUID(), orderKey: `whatsapp:${randomUUID()}`, snapshot, expiresAt: timestamp + CART_TTL_MS };
    }
    cart.state = 'AWAITING_CONFIRMATION';
    rows.push('1 - Confirmar pedido\n2 - Alterar pedido\n3 - Cancelar pedido');
    return rows.join('\n');
}

export function createConversationService(db, { quoteOrder, createOrder }, { now = Date.now, checkout = null } = {}) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_carts (
            session_id TEXT PRIMARY KEY,
            cart_json TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS conversation_messages (
            session_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            response TEXT NOT NULL,
            PRIMARY KEY (session_id, message_id)
        );
        CREATE TABLE IF NOT EXISTS conversation_confirmations (
            session_id TEXT NOT NULL,
            code TEXT NOT NULL,
            order_id INTEGER NOT NULL REFERENCES orders(id),
            response TEXT NOT NULL,
            PRIMARY KEY (session_id, code)
        );
        CREATE INDEX IF NOT EXISTS conversation_carts_expiry ON conversation_carts(expires_at);
    `);

    const loadCart = db.prepare('SELECT cart_json, expires_at FROM conversation_carts WHERE session_id=?');
    const deleteExpiredCarts = db.prepare('DELETE FROM conversation_carts WHERE expires_at <= ?');
    const saveCart = db.prepare(`
        INSERT INTO conversation_carts (session_id, cart_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET cart_json=excluded.cart_json, expires_at=excluded.expires_at
    `);
    const loadMessage = db.prepare('SELECT response FROM conversation_messages WHERE session_id=? AND message_id=?').pluck();
    const saveMessage = db.prepare('INSERT INTO conversation_messages VALUES (?, ?, ?)');
    const muteMessage = db.prepare("INSERT OR IGNORE INTO conversation_messages VALUES (?, ?, '')");
    const loadConfirmation = db.prepare('SELECT response FROM conversation_confirmations WHERE session_id=? AND code=?').pluck();
    const saveConfirmation = db.prepare('INSERT INTO conversation_confirmations VALUES (?, ?, ?, ?)');
    const allProducts = db.prepare('SELECT id, name, price_cents, stock, active FROM products ORDER BY name, id');
    let paused, pause, resume, handoffs;
    if (checkout) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS conversation_handoffs (
                session_id TEXT PRIMARY KEY, requested_at INTEGER NOT NULL,
                resumed_at INTEGER, resumed_by INTEGER
            );
        `);
        paused = db.prepare('SELECT 1 FROM conversation_handoffs WHERE session_id=? AND resumed_at IS NULL').pluck();
        pause = db.prepare(`INSERT INTO conversation_handoffs (session_id,requested_at) VALUES (?,?)
            ON CONFLICT(session_id) DO UPDATE SET requested_at=excluded.requested_at,resumed_at=NULL,resumed_by=NULL`);
        resume = db.prepare('UPDATE conversation_handoffs SET resumed_at=?,resumed_by=? WHERE session_id=? AND resumed_at IS NULL');
        handoffs = db.prepare('SELECT session_id,requested_at FROM conversation_handoffs WHERE resumed_at IS NULL ORDER BY requested_at');
    }

    function describeRegion(input) {
        const matches = resolveRegion(checkout.settings(), input);
        if (matches.length === 1) {
            const [{ name, shipping_cents }] = matches;
            return `Entrega em ${name}: ${money(shipping_cents)}.`;
        }
        return regionError(matches);
    }

    function regionError(matches) {
        return matches.length
            ? `Qual região você quis dizer? ${matches.map(region => region.name).join(' ou ')}.`
            : 'Não encontrei esse bairro nas regiões cadastradas. Confira o nome ou envie “atendente”.';
    }

    function activateHandoff(cart, sessionId) {
        pause.run(sessionId, now());
        cart.offer = null;
        if (cart.state === 'AWAITING_CONFIRMATION') cart.state = 'BUILDING_CART';
        return handoffReply;
    }

    function checkoutInstructions(cart) {
        if (!checkout) return '';
        const { regions, payments } = checkout.settings();
        if (!cart.fulfillment) {
            return regions.length ? 'Você prefere entrega ou retirada?' : 'A entrega está indisponível no momento. Você prefere retirar na loja?';
        }
        if (cart.fulfillment === 'delivery') {
            if (!regions.length) return 'A entrega está indisponível no momento. Você prefere retirar na loja?';
            if (!regions.some(region => region.name === cart.region)) return 'Qual é o seu bairro?';
            if (!cart.address) return 'Qual é o endereço para entrega (rua, número e complemento, se houver)?';
        }
        if (!payments.includes(cart.payment)) return `Como prefere pagar? ${payments.join(', ')}.`;
        return '';
    }

    function nextQuestion(cart) {
        return checkoutInstructions(cart) || (!cart.name ? 'Qual é o seu nome?' :
            !cart.phone ? 'Qual é o seu telefone com DDD?' : '');
    }

    function confirm(cart, sessionId, code, source) {
        if (cart.state !== 'AWAITING_CONFIRMATION' || cart.offer?.code !== code) {
            return `Nenhum resumo vigente para esse código. ${askForSummary}`;
        }
        if (cart.offer.expiresAt <= now()) {
            cart.offer = null;
            cart.state = 'BUILDING_CART';
            return `O resumo expirou. ${askForSummary}`;
        }
        const missing = nextQuestion(cart);
        if (!cart.items.length || missing || !customerSchema.safeParse(cart).success) {
            cart.offer = null;
            cart.state = 'BUILDING_CART';
            return missing || askForSummary;
        }
        const quote = checkout ? checkout.summarize(cart) : quoteOrder(cart.items);
        if (cart.offer.snapshot !== JSON.stringify(quote)) {
            return `O resumo mudou. Revise os itens e os preços.\n${summary(cart, quote, now())}`;
        }
        const order = createOrder({
            name: cart.name,
            phone: cart.phone,
            source,
            items: cart.items,
            external_key: cart.offer.orderKey
        }, quote.checkout);
        const response = `Pedido #${order.id} confirmado. Total: ${money(order.total_cents)}.`;
        saveConfirmation.run(sessionId, code, order.id, response);
        Object.assign(cart, emptyCart(), { state: 'CONFIRMED', orderId: order.id });
        return response;
    }

    function applyMessage(cart, sessionId, text, code, batch = false, source = 'whatsapp') {
        const cash = checkout && cashIntent(text);
        const barePix = checkout && /^pix[.!]?$/.test(normalize(text));
        if (cash?.invalid) return 'Informe um valor válido em reais. Exemplo: dinheiro, troco para 60.';
        if (cash) text = 'pagamento Dinheiro';
        if (barePix && cart.items.length) text = 'pagamento Pix';
        if (checkout) text = simpleCheckoutCommand(text) ?? text;
        const command = normalize(text);
        const choice = orderChoice(text);
        if (code) return confirm(cart, sessionId, code, source);
        if (checkout && isHumanRequest(text)) return activateHandoff(cart, sessionId);
        if (confirmationIntent(text) || choice === '1') {
            return cart.state === 'AWAITING_CONFIRMATION' && cart.offer?.code
                ? confirm(cart, sessionId, cart.offer.code, source)
                : 'Envie resumo para revisar os itens antes de confirmar.';
        }
        if (/^alterar pedido[.!]?$/.test(command) || (choice === '2' && cart.state === 'AWAITING_CONFIRMATION')) {
            if (cart.state === 'CONFIRMED') return 'O pedido já foi registrado. Fale com a loja para alterá-lo.';
            cart.offer = null;
            cart.state = 'BUILDING_CART';
            return `Diga o que deseja alterar. ${help}`;
        }
        if (isCancellation(text) || /^cancelar pedido[.!]?$/.test(command) ||
            (choice === '3' && cart.state === 'AWAITING_CONFIRMATION')) {
            if (cart.state === 'CONFIRMED') return 'O pedido já foi registrado. Fale com a loja para cancelá-lo.';
            Object.assign(cart, emptyCart(), { state: 'CANCELLED' });
            return 'Carrinho cancelado.';
        }
        if (command === 'cardapio') {
            const products = allProducts.all().filter(product => product.active);
            return products.map(p => `#${p.id} ${p.name} — ${money(p.price_cents)} (${p.stock} em estoque)`).join('\n')
                || 'Nenhum produto disponível no cardápio.';
        }
        if (checkout && command === 'formas de pagamento') return `Formas cadastradas: ${checkout.settings().payments.join(', ')}.`;
        if (barePix && !cart.items.length) return pixMarker;
        if (checkout && command.startsWith('frete ')) return describeRegion(text.replace(/^frete\s+/iu, ''));
        if (command === 'resumo') {
            if (!cart.items.length) return 'O carrinho está vazio.';
            const instructions = checkoutInstructions(cart);
            const quote = checkout && !instructions ? checkout.summarize(cart) : quoteOrder(cart.items);
            if (checkout && instructions && cart.fulfillment === 'delivery') {
                const region = checkout.settings().regions.find(region => region.name === cart.region);
                if (region) return summary(cart, quote, now(), `${describeRegion(region.name)} ${instructions}`);
            }
            return summary(cart, quote, now(), checkout ? nextQuestion(cart) : '');
        }
        const fulfillment = /^(entrega|endere[cç]o|pagamento)[ \t]+([^\r\n]+)$/i.exec(text);
        if (checkout && (['retirada', 'entrega'].includes(command) || fulfillment)) {
            if (!cart.items.length) return 'Adicione um produto antes de escolher entrega ou retirada.';
            const value = fulfillment?.[2].trim() ?? '';
            const field = fulfillment && normalize(fulfillment[1]);
            if (command === 'retirada') {
                Object.assign(cart, { fulfillment: 'pickup', region: '', address: '' });
            } else if (command === 'entrega' || field === 'entrega') {
                const settings = checkout.settings();
                if (!settings.regions.length) return 'A entrega está indisponível no momento. Você prefere retirar na loja?';
                if (value) {
                    const matches = resolveRegion(settings, value);
                    if (matches.length !== 1) return regionError(matches);
                    const [region] = matches;
                    Object.assign(cart, { address: cart.region === region.name || !cart.region ? cart.address : '', region: region.name });
                }
                cart.fulfillment = 'delivery';
            } else if (field === 'endereco') {
                if (cart.fulfillment !== 'delivery' || value.length > 180) return 'Escolha entrega e informe um endereço válido.';
                cart.address = value;
            } else {
                const payment = checkout.settings().payments.find(entry => normalize(entry) === normalize(value));
                if (!payment) return 'Forma de pagamento indisponível.';
                cart.payment = payment;
                if (cash) Object.assign(cart, cash);
                else {
                    delete cart.cash_tendered_cents;
                    delete cart.no_change;
                }
            }
            cart.offer = null;
            cart.state = 'BUILDING_CART';
            const next = batch ? '' : nextQuestion(cart) || askForSummary;
            if (field === 'entrega') return `${describeRegion(cart.region)} ${next}`;
            if (field !== 'pagamento') return next;
            const paymentNote = normalize(cart.payment) === 'pix' ? ` ${pixMarker}` : '';
            if (!batch && !nextQuestion(cart)) {
                return `Pagamento: ${cart.payment}.${paymentNote}\n${applyMessage(cart, sessionId, 'resumo', null)}`;
            }
            return `Pagamento: ${cart.payment}.${paymentNote} ${next}`.trimEnd();
        }

        const change = /^(adicionar|alterar)[ \t]+(\d+)[ \t]+([^\r\n]+)$/i.exec(text);
        const remove = /^remover[ \t]+([^\r\n]+)$/i.exec(text);
        if (change || remove) {
            const action = change ? change[1].toLowerCase() : 'remover';
            const quantity = change ? Number(change[2]) : 0;
            const label = change ? change[3] : remove[1];
            const products = allProducts.all().filter(product => action !== 'adicionar' || product.active);
            return itemCommand(cart, { action, quantity, label }, products, quoteOrder);
        }

        const details = /^(nome|telefone)[ \t]+([^\r\n]+)$/i.exec(text);
        if (details) {
            if (!cart.items.length) return 'Adicione um produto antes de informar seus dados.';
            const field = details[1].toLowerCase() === 'nome' ? 'name' : 'phone';
            const parsed = customerSchema.shape[field].safeParse(details[2].trim());
            if (!parsed.success) return field === 'phone' ? 'Informe o telefone com DDD (10 ou 11 dígitos).' : 'Informe um nome de até 100 caracteres.';
            cart[field] = parsed.data;
            cart.offer = null;
            cart.state = 'BUILDING_CART';
            return batch ? '' : `Dados recebidos. ${(checkout && nextQuestion(cart)) || askForSummary}`;
        }
        return help;
    }

    function applyInterpretation(cart, sessionId, text, actions) {
        const responses = [];
        let itemsChanged = false;
        let detailsChanged = false;
        const priority = type => ['add', 'change', 'remove'].includes(type) ? 0 :
            ['delivery', 'pickup'].includes(type) ? 1 : 2;
        if (actions.some(action => action.type === 'human')) return activateHandoff(cart, sessionId);
        for (const action of actions.toSorted((a, b) => priority(a.type) - priority(b.type))) {
            const { type, value } = action;
            if (type === 'summary') continue;
            try {
                let response;
                if (type === 'greeting') response = 'Olá! Posso apresentar o cardápio e ajudar com seu pedido.';
                else if (type === 'clarify') response = unclearReply;
                else if (type === 'faq') {
                    const answer = value === 'horario' ? checkout.settings().hours : knowledge.faq[value].resposta;
                    response = answer || 'Esta informação está pendente de configuração. Envie “atendente”.';
                } else if (['price', 'availability'].includes(type)) {
                    const candidates = findProduct(allProducts.all().filter(p => p.active), value);
                    if (candidates.length !== 1) response = candidates.length
                        ? 'Encontrei mais de um produto. Consulte o cardápio e informe o #ID.'
                        : 'Não encontrei esse produto no cardápio.';
                    else {
                        const [product] = candidates;
                        response = type === 'price'
                            ? `${product.name} custa ${money(product.price_cents)}.`
                            : `${product.name}: ${product.stock ? `${product.stock} disponível(is)` : 'esgotado'}.`;
                    }
                } else {
                    const keyword = { menu: 'cardápio', pickup: 'retirada', payments: 'formas de pagamento', pix: 'pix', summary: 'resumo',
                        add: 'adicionar', change: 'alterar', remove: 'remover', delivery: 'entrega', shipping: 'frete', payment: 'pagamento',
                        name: 'nome', address: 'endereço', phone: 'telefone' }[type];
                    const evidence = type === 'phone' ? text.replace(/\D/g, '').includes(value) :
                        type === 'delivery' && !value ? /\bentreg(?:a|ar|uem)\b/.test(normalize(text)) :
                            value && normalize(text).includes(normalize(value));
                    if (['name', 'address', 'phone', 'delivery', 'shipping', 'add', 'change', 'remove', 'payment'].includes(type) && !evidence) {
                        response = 'Informe esse dado ou o nome do item na sua mensagem para eu conferir.';
                    } else {
                        const before = JSON.stringify(cart);
                        response = type === 'pix' ? pixMarker :
                            applyMessage(cart, sessionId, [keyword, action.quantity, value].filter(Boolean).join(' '), null, true).trim();
                        const changed = before !== JSON.stringify(cart);
                        itemsChanged ||= changed && priority(type) === 0;
                        detailsChanged ||= changed && priority(type) !== 0;
                    }
                }
                if (response && !response.startsWith('Carrinho atualizado.')) responses.push(response);
            } catch (error) {
                if (!(error instanceof OrderUnavailableError)) throw error;
                responses.push(error.message);
            }
        }
        const question = cart.items.length ? nextQuestion(cart) : '';
        if (itemsChanged || actions.some(action => action.type === 'summary') || (detailsChanged && !question)) {
            try { responses.push(applyMessage(cart, sessionId, 'resumo', null)); }
            catch (error) {
                if (!(error instanceof OrderUnavailableError)) throw error;
                responses.push(error.message);
            }
        }
        else if (detailsChanged && question && !responses.some(response => response.includes(question))) responses.push(question);
        const combinedPix = responses.some(response => response !== pixMarker && response.includes(pixMarker));
        return [...new Set(combinedPix ? responses.filter(response => response !== pixMarker) : responses)].join('\n')
            || (cart.items.length && question) || unclearReply;
    }

    function renderResponse(response) {
        if (!response.includes(pixMarker)) return { resposta: response };
        const { pix_key, payments } = checkout.settings();
        const pix = pix_key && payments.some(payment => normalize(payment) === 'pix')
            ? `Chave Pix cadastrada: ${pix_key}. O envio da chave não confirma o pagamento. A equipe vai verificar o recebimento.`
            : 'A chave Pix está indisponível no momento. A equipe pode orientar você sobre o pagamento.';
        return { resposta: response.replaceAll(pixMarker, () => pix) };
    }

    const prepareMessage = db.transaction(({ session_id, message_id, mensagem }) => {
        if (paused?.get(session_id)) {
            muteMessage.run(session_id, message_id);
            return { use_model: false, suppress: true };
        }
        const previous = loadMessage.get(session_id, message_id);
        if (previous === '' || previous === handoffReply) return { use_model: false, suppress: true };
        if (previous !== undefined || isDirectCommand(mensagem)) {
            return { use_model: false };
        }
        const row = loadCart.get(session_id);
        const cart = row?.expires_at > now() ? JSON.parse(row.cart_json) : emptyCart();
        const products = allProducts.all().filter(product => product.active);
        const settings = checkout.settings();
        return {
            use_model: true,
            knowledge: modelContext(),
            products: products.map(({ id, name }) => ({ id, name })),
            regions: settings.regions.map(region => region.name),
            region_aliases: [...knowledge.aliases_regiao, ...(settings.region_aliases ?? [])]
                .filter(alias => settings.regions.some(region => normalize(region.name) === normalize(alias.regiao))),
            payments: settings.payments,
            cart: { items: cart.items, fulfillment: cart.fulfillment, needs_region: cart.fulfillment === 'delivery' &&
                !settings.regions.some(region => region.name === cart.region), needs_address: cart.fulfillment === 'delivery' && !cart.address,
                needs_name: !cart.name, needs_phone: !cart.phone, needs_payment: !cart.payment }
        };
    }).immediate;

    const processMessage = db.transaction(({ session_id, message_id, mensagem, interpretacao }, source = 'whatsapp') => {
        if (paused?.get(session_id)) {
            muteMessage.run(session_id, message_id);
            return muted;
        }
        const previous = loadMessage.get(session_id, message_id);
        if (previous === '' || previous === handoffReply) return muted;
        if (previous !== undefined) return renderResponse(previous);

        const text = mensagem.trim();
        const code = confirmationPattern.exec(text)?.[1].toLowerCase();
        let response = code ? loadConfirmation.get(session_id, code) : undefined;
        if (response === undefined) {
            const timestamp = now();
            const stored = loadCart.get(session_id);
            const expired = stored && stored.expires_at <= timestamp;
            const cart = stored && !expired ? JSON.parse(stored.cart_json) : emptyCart();
            const confirming = code || confirmationIntent(text) || orderChoice(text) === '1';
            if (expired && confirming) {
                response = 'O carrinho expirou. Adicione os produtos novamente.';
            } else {
                try {
                    response = checkout && !isDirectCommand(text)
                        ? interpretacao ? applyInterpretation(cart, session_id, text, interpretacao.actions) : unclearReply
                        : applyMessage(cart, session_id, text, code, false, source);
                } catch (error) {
                    if (!(error instanceof OrderUnavailableError)) throw error;
                    if (confirming || normalize(text) === 'resumo') {
                        cart.offer = null;
                        cart.state = 'BUILDING_CART';
                    }
                    response = `${error.message}. Revise os itens do carrinho.`;
                }
                if (expired) response = `O carrinho anterior expirou. ${response}`;
            }
            saveCart.run(session_id, JSON.stringify(cart), timestamp + CART_TTL_MS);
        }
        saveMessage.run(session_id, message_id, response);
        return renderResponse(response);
    });

    return {
        processMessage: processMessage.immediate,
        prepareMessage: checkout ? prepareMessage : null,
        readResponse(sessionId, messageId) {
            const response = loadMessage.get(sessionId, messageId);
            return response === undefined ? null : response === '' ? muted : renderResponse(response);
        },
        view(sessionId) {
            const row = loadCart.get(sessionId);
            const cart = row?.expires_at > now() ? JSON.parse(row.cart_json) : emptyCart();
            const result = { state: paused?.get(sessionId) ? 'HUMAN' : cart.state, items: [], subtotal_cents: null,
                shipping_cents: null, total_cents: null, order_id: cart.state === 'CONFIRMED' ? cart.orderId ?? null : null };
            if (!cart.items.length) return result;
            const catalog = new Map(allProducts.all().map(product => [product.id, product]));
            result.items = cart.items.map(({ product_id, quantity }) => ({
                product_id, quantity, name: catalog.get(product_id)?.name ?? 'Produto indisponível'
            }));
            try {
                const quote = quoteOrder(cart.items);
                result.subtotal_cents = quote.total_cents;
                const region = checkout?.settings().regions.find(item => item.name === cart.region);
                result.shipping_cents = cart.fulfillment === 'pickup' ? 0 :
                    cart.fulfillment === 'delivery' ? region?.shipping_cents ?? null : null;
                if (result.shipping_cents !== null) result.total_cents = quote.total_cents + result.shipping_cents;
            } catch (error) {
                if (!(error instanceof OrderUnavailableError)) throw error;
                result.unavailable = true;
            }
            return result;
        },
        listHandoffs: () => handoffs?.all() ?? [],
        resumeHandoff: (sessionId, userId) => Boolean(resume?.run(now(), userId, sessionId).changes),
        cleanupExpiredCarts: () => deleteExpiredCarts.run(now()).changes
    };
}
