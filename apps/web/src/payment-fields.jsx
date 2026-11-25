import React from 'react';

export const emptyPayment = { method: '', cash: '', noChange: false };

export function paymentPayload({ method, cash, noChange }) {
    if (!method) return {};
    if (method.toLowerCase() !== 'dinheiro') return { payment: method };
    if (noChange) return { payment: method, no_change: true };
    if (!cash.trim()) return { payment: method };
    const match = /^(\d{1,7})(?:,(\d{1,2}))?$/.exec(cash.trim());
    if (!match) throw new Error('Informe o valor em reais. Exemplo: 60,50.');
    const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
    if (cents <= 0 || cents > 100_000_000) throw new Error('Informe um valor válido para o dinheiro entregue.');
    return { payment: method, cash_tendered_cents: cents };
}

export function PaymentFields({ payments, value, onChange, required = false }) {
    return <>
        <label>Pagamento<select required={required} value={value.method} onChange={e => onChange({ ...emptyPayment, method: e.target.value })}>
            <option value="">{required ? 'Selecione' : 'Não informado'}</option>
            {payments.map(method => <option key={method}>{method}</option>)}
        </select></label>
        {value.method.toLowerCase() === 'dinheiro' && <>
            <label><input type="checkbox" checked={value.noChange}
                onChange={e => onChange({ ...value, noChange: e.target.checked, cash: '' })} /> Não precisa de troco</label>
            {!value.noChange && <label>Valor entregue para troco
                <input inputMode="decimal" value={value.cash} placeholder="Ex. 60,50"
                    onChange={e => onChange({ ...value, cash: e.target.value })} />
            </label>}
        </>}
    </>;
}
