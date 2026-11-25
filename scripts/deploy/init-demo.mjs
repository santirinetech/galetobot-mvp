import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase } from '../../apps/api/src/database.js';

const [mode, ...extra] = process.argv.slice(2);
if (mode !== '--new-isolated-demo' || extra.length) {
    throw new Error('Uso: node scripts/deploy/init-demo.mjs --new-isolated-demo');
}
if (!process.env.DATABASE_PATH) throw new Error('Configure DATABASE_PATH para um arquivo novo.');

process.umask(0o077);
const destination = path.resolve(process.env.DATABASE_PATH);
if (fs.existsSync(destination)) throw new Error('O banco já existe.');
const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.sqlite-demo-'));
const candidate = path.join(staging, 'demo.db');
try {
    const db = initializeDatabase({
        databasePath: candidate,
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        allowCreate: true,
        enableStore: true
    });
    try {
        db.pragma('journal_mode = DELETE');
    } finally {
        db.close();
    }
    fs.chmodSync(candidate, 0o600);
    fs.linkSync(candidate, destination);
    console.log('Banco isolado de demonstração criado.');
} finally {
    for (const filename of fs.readdirSync(staging)) fs.unlinkSync(path.join(staging, filename));
    fs.rmdirSync(staging);
}
