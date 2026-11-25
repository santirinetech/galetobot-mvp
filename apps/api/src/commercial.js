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
export function simpleCheckoutCommand(text) {
    const command = normalize(text).replace(/[.!]+$/, '');
    if (/^(?:(?:eu )?quero |prefiro )?entrega$/.test(command)) return 'entrega';
    if (/^(?:(?:eu )?quero |prefiro )?retirada$/.test(command)) return 'retirada';
    if (/^(?:(?:eu )?quero pagar|vou pagar|pago) (?:via|no|com|por) pix$/.test(command)) return 'pagamento Pix';
    return null;
}
export function isDirectCommand(text) {
    const command = normalize(text);
    return isHumanRequest(text) || isCancellation(text) || asksConfirmation(text) || confirmationPattern.test(text) ||
        simpleCheckoutCommand(text) !== null ||
        /^(?:cardapio|resumo|retirada|pix|formas de pagamento)$/.test(command) ||
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
