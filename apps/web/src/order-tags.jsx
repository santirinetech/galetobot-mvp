import React from 'react';
import { statuses } from './client.js';
import { Tag } from './design-system.jsx';

export const orderTones = { pending: 'warn', confirmed: 'info', preparing: 'accent', ready: 'success', completed: 'neutral' };

export function OrderTag({ status }) {
    return <Tag tone={orderTones[status]}>{statuses[status] || 'Situação desconhecida'}</Tag>;
}

export function PaymentTag({ status }) {
    if (status === 'received') return <Tag tone="success">Recebido</Tag>;
    if (status === 'pending') return <Tag>A receber</Tag>;
    return <Tag>Sem registro</Tag>;
}
