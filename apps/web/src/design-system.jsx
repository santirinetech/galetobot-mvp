import React, { useEffect, useId, useRef } from 'react';
import { AlertCircle, Flame, Inbox, X } from 'lucide-react';
import { money } from './client.js';
import './design-system.css';

export function Wordmark({ compact = false }) {
    return <span className="ds-brand"><span className="ds-brand-mark"><Flame size={23} strokeWidth={2.5} aria-hidden="true" /></span>
        {!compact && <strong>Galeto<span>Bot</span></strong>}</span>;
}

export function Button({ children, icon: Icon, variant = 'secondary', className = '', href, ...props }) {
    const classes = `ds-button ds-button--${variant} ${className}`;
    const body = <>{Icon && <Icon size={17} aria-hidden="true" />}{children}</>;
    return href ? <a href={href} className={classes} {...props}>{body}</a> :
        <button type="button" className={classes} {...props}>{body}</button>;
}

export function PageHeading({ title, description, context, actions }) {
    return <header className="ds-page-heading">
        <div>{context && <p className="ds-page-context">{context}</p>}
            <h1>{title}</h1>{description && <p>{description}</p>}</div>
        {actions && <div className="ds-actions">{actions}</div>}
    </header>;
}

export function Surface({ title, actions, children, className = '' }) {
    return <section className={`ds-surface ${className}`}>
        {title && <header className="ds-surface-heading"><h2>{title}</h2>{actions}</header>}{children}
    </section>;
}

export function Tag({ tone = 'neutral', children }) {
    return <span className={`ds-tag ds-tag--${tone}`}><span aria-hidden="true" />{children}</span>;
}

export function ChoiceGroup({ label, options, value, onChange }) {
    return <div className="ds-choices" role="group" aria-label={label}>
        {options.map(({ id, label: text, icon: Icon }) =>
            <Button key={id} variant="choice" icon={Icon} aria-pressed={id === value} onClick={() => onChange(id)}>{text}</Button>)}
    </div>;
}

export function Field({ label, as: Component = 'input', ...props }) {
    return <label className="ds-field"><span>{label}</span><Component {...props} /></label>;
}

export function DataTable({ label, columns, children, className = '' }) {
    return <div className={`ds-table-wrap ${className}`}>
        <table className="ds-table" aria-label={label}>
            <thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
            <tbody>{children}</tbody>
        </table>
    </div>;
}

export function Overlay({ title, onClose, drawer = false, children }) {
    const dialog = useRef(null);
    const titleId = useId();
    useEffect(() => {
        const element = dialog.current;
        element.showModal();
        return () => element.close();
    }, []);
    return <dialog ref={dialog} className={`ds-overlay ${drawer ? 'ds-overlay--drawer' : ''}`} aria-labelledby={titleId}
        onCancel={event => { event.preventDefault(); onClose(); }}>
        <header><h2 id={titleId}>{title}</h2><Button variant="icon" icon={X} onClick={onClose} aria-label="Fechar" /></header>
        <div className="ds-overlay-body">{children}</div>
    </dialog>;
}

export function Feedback({ kind = 'empty', title, children, onRetry }) {
    const Icon = kind === 'error' ? AlertCircle : Inbox;
    return <div className={`ds-feedback ds-feedback--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
        {kind === 'loading' ? <span className="ds-spinner" aria-hidden="true" /> : <Icon size={21} aria-hidden="true" />}
        <div><strong>{title}</strong>{children && <p>{children}</p>}</div>
        {onRetry && <Button onClick={onRetry}>Tentar novamente</Button>}
    </div>;
}

export function Amount({ cents }) {
    const formatted = money(cents);
    return <span className={'ds-amount' + (formatted.length > 15 ? ' ds-amount--long' : '')}>{formatted}</span>;
}
