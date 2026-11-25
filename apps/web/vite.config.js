import { defineConfig } from 'vite';

const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:5173');
const port = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80));
const host = process.env.GALETO_WEB_HOST || (origin.hostname === 'localhost' ? 'localhost' : '127.0.0.1');
const proxy = {
    '/api': {
        target: process.env.GALETO_API_PROXY_TARGET || `http://127.0.0.1:${process.env.PORT || 3000}`,
        changeOrigin: true,
        configure(server) {
            server.on('error', (_error, _request, response) => {
                if (!response || response.headersSent || typeof response.writeHead !== 'function') return;
                response.writeHead(502, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: 'O proxy não conseguiu conectar à API. Confira a porta e o processo do servidor.' }));
            });
        }
    }
};

export default defineConfig({
    clearScreen: false,
    server: { host, port, strictPort: true, proxy },
    preview: { host, port, strictPort: true, proxy }
});
