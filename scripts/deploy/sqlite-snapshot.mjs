import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const [source, destination, ...extra] = process.argv.slice(2);
if (!source || !destination || extra.length) {
    throw new Error('Uso: node scripts/deploy/sqlite-snapshot.mjs <origem> <arquivo-novo>');
}

process.umask(0o077);
if (fs.existsSync(destination)) throw new Error('O destino já existe. Escolha um arquivo novo.');
const staging = fs.mkdtempSync(path.join(path.dirname(path.resolve(destination)), '.sqlite-snapshot-'));
const snapshot = path.join(staging, 'snapshot.db');
const requiredTables = ['users', 'products', 'customers', 'orders', 'store_settings', 'stock_movements'];

try {
    // A API de backup do SQLite inclui as transações confirmadas no WAL.
    const db = new Database(path.resolve(source), { readonly: true, fileMustExist: true });
    try {
        await db.backup(snapshot);
    } finally {
        db.close();
    }

    const check = new Database(snapshot, { fileMustExist: true });
    try {
        // Publica um arquivo independente, sem depender de WAL/SHM ao transferi-lo.
        check.pragma('journal_mode = DELETE');
        const tables = new Set(check.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all());
        if (check.pragma('quick_check', { simple: true }) !== 'ok' || requiredTables.some(table => !tables.has(table))) {
            throw new Error('O snapshot falhou na verificação ou não contém a estrutura comercial.');
        }
    } finally {
        check.close();
    }
    fs.chmodSync(snapshot, 0o600);
    fs.linkSync(snapshot, destination);
    console.log('Snapshot consistente criado em arquivo novo.');
} finally {
    for (const filename of fs.readdirSync(staging)) fs.unlinkSync(path.join(staging, filename));
    fs.rmdirSync(staging);
}
