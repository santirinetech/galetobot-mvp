import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { initializeDatabase, resolveDatabasePath } from '../src/database.js';

const admin = { email: 'teste@example.invalid', password: 'senha-ficticia-123' };

function temporaryProject(t) {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'galetobot-'));
    t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));
    return {
        projectRoot,
        standard: path.join(projectRoot, 'apps', 'api', 'data', 'galeto-dev.db'),
        legacy: path.join(projectRoot, 'apps', 'api', 'apps', 'api', 'data', 'galeto-dev.db')
    };
}

function createEmptyDatabase(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    new Database(filename).close();
}

test('usa o legado existente sem criar o banco padrão', t => {
    const { projectRoot, standard, legacy } = temporaryProject(t);
    createEmptyDatabase(legacy);
    const db = initializeDatabase({ projectRoot, ...admin });
    try {
        assert.equal(db.name, legacy);
        assert.equal(fs.existsSync(standard), false);
    } finally {
        db.close();
    }
});

test('interrompe a inicialização com dois candidatos e permite seleção explícita', t => {
    const { projectRoot, standard, legacy } = temporaryProject(t);
    createEmptyDatabase(standard);
    createEmptyDatabase(legacy);
    const before = [standard, legacy].map(file => fs.readFileSync(file));
    assert.throws(() => initializeDatabase({ projectRoot, ...admin }), /Dois bancos encontrados.*DATABASE_PATH/);
    assert.deepEqual([standard, legacy].map(file => fs.readFileSync(file)), before);
    assert.equal(resolveDatabasePath({ projectRoot, databasePath: legacy }), legacy);
    assert.equal(resolveDatabasePath({ projectRoot, databasePath: path.relative(projectRoot, standard) }), standard);
});

test('resolve o mesmo banco com diretórios de execução diferentes', t => {
    const { projectRoot, standard } = temporaryProject(t);
    createEmptyDatabase(standard);
    const moduleUrl = new URL('../src/database.js', import.meta.url).href;
    const script = `
        import { resolveDatabasePath } from ${JSON.stringify(moduleUrl)};
        const projectRoot = process.argv[1];
        console.log(JSON.stringify([
            resolveDatabasePath({ projectRoot }),
            resolveDatabasePath({ projectRoot, databasePath: 'test-data/isolado.db' })
        ]));
    `;
    for (const cwd of [projectRoot, path.dirname(standard)]) {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, projectRoot], {
            cwd,
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), [standard, path.join(projectRoot, 'test-data', 'isolado.db')]);
    }
});

test('cria um banco novo com esquema, catálogo e administrador', t => {
    const { projectRoot, standard } = temporaryProject(t);
    const db = initializeDatabase({ projectRoot, allowCreate: true, ...admin });
    try {
        assert.equal(db.name, standard);
        assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
        assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
        assert.deepEqual(db.prepare('SELECT name, price_cents, stock FROM products ORDER BY id').raw().all(), [
            ['Galeto', 4500, 10],
            ['Feijão tropeiro', 1200, 5],
            ['Arroz', 800, 8],
            ['Salpicão', 1000, 2]
        ]);
        assert.equal(db.prepare('SELECT COUNT(*) FROM orders').pluck().get(), 0);
        const hash = db.prepare('SELECT password_hash FROM users WHERE email=?').pluck().get(admin.email);
        assert.equal(bcrypt.compareSync(admin.password, hash), true);
    } finally {
        db.close();
    }
});

test('reabre um banco explícito isolado preservando estoque, pedidos e senha', t => {
    const { projectRoot, standard, legacy } = temporaryProject(t);
    const databasePath = path.join(projectRoot, 'fixtures', 'isolado.db');
    const db = initializeDatabase({ databasePath, projectRoot, allowCreate: true, ...admin });
    db.prepare('UPDATE products SET stock=7 WHERE id=1').run();
    db.prepare("INSERT INTO customers(id, phone, name) VALUES(1, '00123456789', 'Teste')").run();
    db.prepare("INSERT INTO orders(customer_id, source, total_cents) VALUES(1, 'counter', 4500)").run();
    db.close();

    const reopened = initializeDatabase({ databasePath, projectRoot, ...admin, password: 'outra-senha-ficticia' });
    try {
        assert.equal(reopened.prepare('SELECT stock FROM products WHERE id=1').pluck().get(), 7);
        assert.equal(reopened.prepare('SELECT COUNT(*) FROM products').pluck().get(), 4);
        assert.equal(reopened.prepare('SELECT total_cents FROM orders WHERE customer_id=1').pluck().get(), 4500);
        assert.equal(reopened.prepare('SELECT name FROM customers WHERE id=1').pluck().get(), 'Teste');
        const hash = reopened.prepare('SELECT password_hash FROM users WHERE email=?').pluck().get(admin.email);
        assert.equal(bcrypt.compareSync(admin.password, hash), true);
        assert.equal(fs.existsSync(standard), false);
        assert.equal(fs.existsSync(legacy), false);
    } finally {
        reopened.close();
    }
});

test('rejeita configuração inválida antes de criar um banco', t => {
    const { projectRoot, standard } = temporaryProject(t);
    assert.throws(() => initializeDatabase({ projectRoot, ...admin, password: 'curta' }), /ADMIN_PASSWORD/);
    assert.throws(() => initializeDatabase({ projectRoot, ...admin, databasePath: '' }), /DATABASE_PATH/);
    assert.equal(fs.existsSync(standard), false);
});

test('caminhos ausentes exigem opt-in e não criam arquivos ou diretórios', t => {
    const { projectRoot, standard } = temporaryProject(t);
    const databasePath = path.join(projectRoot, 'erro-de-digitacao', 'novo.db');
    assert.throws(() => initializeDatabase({ projectRoot, ...admin }), /Banco SQLite não encontrado/);
    assert.throws(() => initializeDatabase({ projectRoot, databasePath, ...admin }), /Banco SQLite não encontrado/);
    assert.equal(fs.existsSync(path.dirname(standard)), false);
    assert.equal(fs.existsSync(path.dirname(databasePath)), false);
});
