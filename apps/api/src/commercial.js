import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const knowledge = JSON.parse(readFileSync(new URL('./knowledge.json', import.meta.url), 'utf8'));
export const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/gu, ' ').trim();

const value = max => z.string().trim().min(1).max(max).regex(/^[^\p{Cc}]+$/u);
const noFields = ['greeting', 'menu', 'pickup', 'payments', 'pix', 'summary', 'human', 'clarify'];
export const interpretationSchema = z.object({
    actions: z.array(z.discriminatedUnion('type', [
        ...noFields.map(type => z.strictObject({ type: z.literal(type) })),
        z.strictObject({ type: z.enum(['price', 'availability', 'remove']), value: value(80) }),
        z.strictObject({ type: z.enum(['add', 'change']), value: value(80), quantity: z.number().int().min(1).max(100) }),
        z.strictObject({ type: z.literal('delivery'), value: value(100).optional() }),
        z.strictObject({ type: z.enum(['shipping', 'payment', 'name']), value: value(100) }),
        z.strictObject({ type: z.literal('address'), value: value(180) }),
        z.strictObject({ type: z.literal('phone'), value: z.string().regex(/^\d{10,11}$/) }),
        z.strictObject({ type: z.literal('faq'), value: z.enum(Object.keys(knowledge.faq)) })
    ])).min(1).max(12)
}).strict();

export const confirmationPattern = /^confirmar ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
export const isHumanRequest = text => /^(?:(?:quero|preciso|gostaria de) falar com (?:um |uma |o |a )?)?(?:atendente(?: humano)?|atendimento humano)[.!]?$/.test(normalize(text));
export const isCancellation = text => /^(?:cancelar|cancelar carrinho|quero cancelar(?: o carrinho| o atendimento| meu pedido)?)[.!]?$/.test(normalize(text));
export const asksConfirmation = text => /^(?:confirmar(?: pedido)?|confirmo(?: o pedido)?|sim|pode confirmar)[.!]?$/.test(normalize(text));
export const orderChoice = text => /^(1(?:\s*[-–]\s*confirmar pedido)?|2(?:\s*[-–]\s*alterar pedido)?|3(?:\s*[-–]\s*cancelar pedido)?)[.!]?$/
    .exec(normalize(text))?.[1][0];
export function confirmationIntent(text) {
    return asksConfirmation(text) || /^(?:pode fechar|tudo certo)[.!]?$/.test(normalize(text));
}

export function cashIntent(text) {
    const command = normalize(text).replace(/[.!]$/, '');
    if (/^(?:dinheiro[, ]+)?(?:sem troco|nao preciso de troco)$/.test(command)) {
        return { cash_tendered_cents: null, no_change: true };
    }
    const amount = /^(?:(?:pagamento )?dinheiro[, ]+)?troco (?:para|pra)\s*(.*)$/.exec(command)
        ?? /^(?:eu )?vou pagar com (?=r\$|[\d+-])(.*)$/.exec(command);
    if (!amount) return null;
    const money = /^(?:r\$\s*)?(\d{1,7}|\d{1,3}(?:\.\d{3}){1,2})(?:,(\d{1,2}))?$/.exec(amount[1]);
    const cents = money && Number(money[1].replaceAll('.', '')) * 100 + Number((money[2] ?? '').padEnd(2, '0'));
    return cents > 0 && cents <= 100_000_000 ? { cash_tendered_cents: cents, no_change: false } : { invalid: true };
}

export function simpleCheckoutCommand(text) {
    const command = normalize(text).replace(/[.!]+$/, '');
    if (/^(?:(?:eu )?quero |prefiro )?entrega$/.test(command)) return 'entrega';
    if (/^(?:(?:eu )?quero |prefiro )?retirada$/.test(command)) return 'retirada';
    if (/^(?:(?:eu )?(?:quero pagar|vou pagar|pago) (?:via|no|com|por|em) )pix$/.test(command)) return 'pagamento Pix';
    if (/^(?:vou de|prefiro) pix$/.test(command)) return 'pagamento Pix';
    if (/^cartao$/.test(command)) return 'pagamento Cartão';
    if (/^dinheiro$/.test(command)) return 'pagamento Dinheiro';
    return null;
}
export function isDirectCommand(text) {
    const command = normalize(text);
    return isHumanRequest(text) || isCancellation(text) || confirmationIntent(text) || orderChoice(text) || cashIntent(text) ||
        /^alterar pedido[.!]?$/.test(command) || confirmationPattern.test(text) ||
        simpleCheckoutCommand(text) !== null ||
        /^(?:cardapio|resumo|retirada|pix|formas de pagamento)[.!]?$/.test(command) ||
        (/^(?:(?:adicionar|alterar) \d+|remover|entrega|frete|endereco|pagamento|nome|telefone) .+$/u.test(command) &&
            !/(?:[,;]|\be\b)\s*(?:vou pagar|quero|meu nome|meu telefone|pagamento|telefone|nome|pix|entrega|retirada|endereco)\b/.test(command));
}

export function resolveRegion(settings, input) {
    const query = normalize(input).replace(/[.!?]+$/, '');
    const targets = new Set([query]);
    for (const alias of [...knowledge.aliases_regiao, ...(settings.region_aliases ?? [])]) {
        if (normalize(alias.alias) === query) targets.add(normalize(alias.regiao));
    }
    return settings.regions.filter(region => targets.has(normalize(region.name)));
}

export function modelContext() {
    return {
        faq: Object.fromEntries(Object.entries(knowledge.faq).map(([id, entry]) => [id, entry.pergunta])),
        rules: knowledge.regras
    };
}

export const handoffReply = 'Solicitação registrada. O atendimento automático foi pausado para esta conversa.';
export const unclearReply = 'Não consegui interpretar com segurança. Você pode enviar “cardápio”, “resumo” ou “atendente”.';
