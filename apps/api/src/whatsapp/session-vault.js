import { copyFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, sep } from 'node:path';

const slot = /^session-[0-9a-f-]{36}$/;

export function createSessionVault(root) {
    const privateRoot = join(root, '.galeto');
    const pointer = join(privateRoot, 'active.json');

    async function init() {
        await mkdir(root, { recursive: true, mode: 0o700 });
        await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    }

    async function readActive() {
        let saved;
        try { saved = await readFile(pointer, 'utf8'); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const legacy = await readdir(root, { withFileTypes: true });
            return legacy.some(file => file.isFile() && file.name.endsWith('.json')) ? root : null;
        }
        const value = JSON.parse(saved);
        if (value === null) return null;
        if (typeof value !== 'string' || !slot.test(value)) throw new Error('Invalid session pointer');
        return join(privateRoot, value);
    }

    async function setActive(directory) {
        const prefix = privateRoot + sep;
        const name = directory === null ? null : directory.startsWith(prefix) ? directory.slice(prefix.length) : '';
        if (name !== null && !slot.test(name)) throw new Error('Invalid session directory');
        const next = join(privateRoot, '.next-' + randomUUID());
        await writeFile(next, JSON.stringify(name), { flag: 'wx', mode: 0o600 });
        await rename(next, pointer);
    }

    async function stage() {
        const directory = join(privateRoot, 'session-' + randomUUID());
        await mkdir(directory, { mode: 0o700 });
        return directory;
    }

    async function backup(directory) {
        const saved = join(privateRoot, 'backup-' + randomUUID());
        await mkdir(saved, { mode: 0o700 });
        for (const file of await readdir(directory, { withFileTypes: true })) {
            if (!file.name.endsWith('.json')) continue;
            if (!file.isFile()) throw new Error('Unsupported session entry');
            // The enclosing directory is only traversable by the owner.
            await copyFile(join(directory, file.name), join(saved, file.name));
        }
    }

    async function account(directory) {
        const data = JSON.parse(await readFile(join(directory, 'creds.json'), 'utf8'));
        if (typeof data?.me?.id !== 'string' || !data.me.id) throw new Error('Unregistered session');
        return data.me.id;
    }

    return { init, readActive, setActive, stage, backup, account };
}
