import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Inbox, LoaderCircle, Utensils, X } from 'lucide-react';
import { statuses } from './client.js';

export function Brand() {
    return <div className="brand"><span className="brand-icon"><Utensils size={20} /></span><strong>GaletoBot</strong></div>;
}

export function Notice({ children, kind = 'error', onRetry }) {
    const Icon = kind === 'success' ? CheckCircle2 : AlertCircle;
    return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
        <Icon size={19} /><span>{children}</span>
        {onRetry && <button type="button" className="secondary small" onClick={onRetry}>Tentar novamente</button>}
    </div>;
}

export function Loading({ children = 'Carregando…' }) {
    return <div className="loading" role="status"><LoaderCircle className="spinner" size={20} />{children}</div>;
}

export function Empty({ children }) {
    return <div className="empty"><Inbox size={26} /><p>{children}</p></div>;
}

export function Badge({ children, tone = 'neutral' }) {
    return <span className={`badge ${tone}`}>{children}</span>;
}

export function OrderStatus({ status }) {
    const tone = { pending: 'warning', confirmed: 'info', preparing: 'info', ready: 'success', completed: 'neutral' }[status];
    return <Badge tone={tone}>{statuses[status] || status}</Badge>;
}

export function formatDate(value, options = { dateStyle: 'short', timeStyle: 'short' }) {
    if (!value) return '—';
    const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
    return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', ...options });
}

export function Dialog({ title, onClose, children }) {
    const ref = useRef(null);
    useEffect(() => {
        const dialog = ref.current;
        dialog.showModal();
        return () => dialog.close();
    }, []);
    return <dialog ref={ref} className="dialog" aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }}>
        <header className="dialog-header"><h2>{title}</h2>
            <button type="button" className="icon-button secondary" aria-label="Fechar" onClick={onClose}><X size={21} /></button>
        </header>
        <div className="dialog-body">{children}</div>
    </dialog>;
}

export function ProductPhoto({ url, name, className = '' }) {
    const [failed, setFailed] = useState(null);
    return <div className={`product-photo ${className}`}>
        {url && failed !== url ? <img src={url} alt={name} onError={() => setFailed(url)} loading="lazy" referrerPolicy="no-referrer" />
            : <Utensils size={23} aria-hidden="true" />}
    </div>;
}
