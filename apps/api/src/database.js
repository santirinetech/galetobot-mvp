import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { initializeStoreSchema } from './store-schema.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

function canonicalPath(filename) {
    try {
        fs.lstatSync(filename);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(filename);
        if (parent === filename) throw error;
        return path.join(canonicalPath(parent), path.basename(filename));
    }
    return fs.realpathSync.native(filename);
}

function inside(directory, filename) {
    const relative = path.relative(directory, filename);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function selectRuntimeDatabase(mode, env, { projectRoot = repositoryRoot, tempRoot = os.tmpdir() } = {}) {
    const root = canonicalPath(projectRoot);
    const demo = path.join(root, 'apps', 'api', 'data', 'demo');
    const temp = canonicalPath(tempRoot);
    const backup = path.join(root, 'backups-local');
    const allowCreate = env.NODE_ENV !== 'production' && env.DATABASE_ALLOW_CREATE === '1';

    if (mode === 'operational' || mode === 'hosted') {
        if (!env.DATABASE_PATH?.trim()) throw new Error('O modo operacional exige DATABASE_PATH explícito');
        const filename = resolveDatabasePath({ projectRoot: root, databasePath: env.DATABASE_PATH });
        const target = canonicalPath(filename);
        if ([demo, temp, backup].some(directory => inside(directory, filename) || inside(canonicalPath(directory), target))) {
            throw new Error('O modo operacional exige um banco fora dos diretórios de demonstração, testes e backups');
        }
        return { databasePath: target, allowCreate: false };
    }

    if (mode !== 'development' && mode !== 'test') throw new Error('Modo de banco desconhecido');
    if (mode === 'test' && !env.DATABASE_PATH?.trim()) throw new Error('O modo de teste exige DATABASE_PATH temporário');
    const configuredPath = mode === 'test' ? env.DATABASE_PATH : (env.DEMO_DATABASE_PATH ?? path.join(demo, 'galeto-demo.db'));
    const filename = resolveDatabasePath({ projectRoot: root, databasePath: configuredPath });
    const target = canonicalPath(filename);
    const scope = mode === 'test' ? temp : demo;
    const protectedPaths = [
        path.join(root, 'apps', 'api', 'data', 'galeto-dev.db'),
        path.join(root, 'apps', 'api', 'apps', 'api', 'data', 'galeto-dev.db'),
        backup
    ];
    if (!inside(scope, filename) || !inside(scope, target) ||
        protectedPaths.some(protectedPath => inside(protectedPath, filename) || inside(canonicalPath(protectedPath), target))) {
        throw new Error('Banco fora do diretório isolado ou reservado para operação/backup');
    }
    if (isDatabaseFile(target) && fs.statSync(target).nlink > 1) {
        throw new Error('Banco isolado não pode ser um arquivo com links físicos');
    }
    return { databasePath: target, allowCreate };
}

function isDatabaseFile(filename) {
    try {
        if (fs.statSync(filename).isFile()) return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
    throw new Error(`O caminho do banco deve apontar para um arquivo: ${filename}`);
}

export function resolveDatabasePath({ databasePath, projectRoot = repositoryRoot } = {}) {
    if (databasePath !== undefined) {
        if (!databasePath.trim()) throw new Error('DATABASE_PATH está vazio');
        if (process.platform === 'win32' && /^[a-z]:(?![\\/])/i.test(databasePath)) {
            throw new Error('DATABASE_PATH deve ser absoluto ou relativo à raiz do repositório');
        }
        return path.resolve(projectRoot, databasePath);
    }

    const standard = path.join(projectRoot, 'apps', 'api', 'data', 'galeto-dev.db');
    const legacy = path.join(projectRoot, 'apps', 'api', 'apps', 'api', 'data', 'galeto-dev.db');
    const existing = [standard, legacy].filter(isDatabaseFile);

    if (existing.length > 1) {
        throw new Error(`Dois bancos encontrados: "${standard}" e "${legacy}". Defina DATABASE_PATH para escolher o banco correto.`);
    }

    return existing[0] ?? standard;
}

export function initializeDatabase({ databasePath, projectRoot, email, password, allowCreate = false, enableStore = false }) {
    if (!email || !password || password === 'ALTERE_PARA_UMA_SENHA_FORTE' || password.length < 12) {
        throw new Error('Configure ADMIN_EMAIL e ADMIN_PASSWORD forte (mín. 12 caracteres) no ambiente da API. Desenvolvimento carrega .env.development e operação carrega .env.');
    }

    const filename = resolveDatabasePath({ databasePath, projectRoot });
    const fileMustExist = isDatabaseFile(filename);
    if (!fileMustExist) {
        if (!allowCreate) {
            throw new Error(`Banco SQLite não encontrado: "${filename}". Confira DATABASE_PATH. Para criar um banco de desenvolvimento/teste, use DATABASE_ALLOW_CREATE=1.`);
        }
        fs.mkdirSync(path.dirname(filename), { recursive: true });
    }

    const db = new Database(filename, { fileMustExist });
    try {
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        db.transaction(() => {
            db.exec(`
            CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,price_cents INTEGER NOT NULL CHECK(price_cents>=0),stock INTEGER NOT NULL CHECK(stock>=0),active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,phone TEXT UNIQUE NOT NULL,name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,customer_id INTEGER,source TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',total_cents INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,external_key TEXT UNIQUE,FOREIGN KEY(customer_id) REFERENCES customers(id));
            CREATE TABLE IF NOT EXISTS order_items(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL,product_id INTEGER NOT NULL,quantity INTEGER NOT NULL,unit_price_cents INTEGER NOT NULL,FOREIGN KEY(order_id) REFERENCES orders(id),FOREIGN KEY(product_id) REFERENCES products(id));
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,action TEXT NOT NULL,detail TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
            `);
            if (enableStore) initializeStoreSchema(db);
            const initialProducts = [
                ['Galeto', 4500, 10],
                ['Feijão tropeiro', 1200, 5],
                ['Arroz', 800, 8],
                ['Salpicão', 1000, 2]
            ];
            if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
                const addProduct = db.prepare('INSERT INTO products(name,price_cents,stock) VALUES(?,?,?)');
                for (const product of initialProducts) addProduct.run(...product);
            }
            if (!db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
                const passwordHash = bcrypt.hashSync(password, 12);
                db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)').run(email, passwordHash);
            }
        }).immediate();
        return db;
    } catch (error) {
        db.close();
        throw error;
    }
}
