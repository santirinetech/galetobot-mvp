import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

try {
    loadEnvFile(new URL('../.env.development', import.meta.url));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const api = fileURLToPath(new URL('../apps/api/', import.meta.url));
const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
const requireWeb = createRequire(path.join(web, 'package.json'));
const vite = path.join(path.dirname(requireWeb.resolve('vite/package.json')), 'bin', 'vite.js');
const children = [];
let stopping = false;

function stop(code) {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
}

function launch(name, args, cwd) {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
    children.push(child);
    child.on('error', error => { console.error(`Falha ao iniciar ${name}: ${error.message}`); stop(1); });
    child.on('exit', (code, signal) => {
        if (stopping) return;
        console.error(`${name} saiu (${code ?? signal}). Encerrando o ambiente de desenvolvimento.`);
        stop(code ?? 1);
    });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
launch('API', ['src/index.js', '--development'], api);
launch('Vite', [vite], web);
