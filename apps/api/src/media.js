import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import rateLimit from 'express-rate-limit';
import sharp from 'sharp';

const prefix = '/api/media/';
const mediaName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const formats = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const maxBytes = 5 * 1024 * 1024;
const limit = () => rateLimit({ windowMs: 60_000, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false });
const imageBody = express.raw({ limit: maxBytes, inflate: false, type: Object.keys(formats) });

class MediaError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

export function createMedia(db, directory) {
    const root = resolve(directory);
    const reference = db.prepare(`SELECT EXISTS(SELECT 1 FROM products WHERE image_url=?)
        OR EXISTS(SELECT 1 FROM store_settings WHERE json_valid(value) AND json_extract(value,'$.logo_url')=?)`).pluck();
    let processing = 0;
    async function create(buffer, mime) {
        if (!Buffer.isBuffer(buffer) || !buffer.length || !Object.hasOwn(formats, mime)) {
            throw new MediaError(415, 'Envie uma imagem JPEG, PNG ou WebP.');
        }
        if (processing >= 2) throw new MediaError(429, 'Aguarde a conclusão dos outros uploads.');
        processing++;
        let optimized;
        try {
            const pipeline = sharp(buffer, { failOn: 'warning', limitInputPixels: 16_000_000 });
            const info = await pipeline.metadata();
            if (info.format !== formats[mime] || !info.width || !info.height ||
                info.width > 4096 || info.height > 4096 || (info.pages ?? 1) > 1) throw new Error();
            optimized = await pipeline.rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 82 }).toBuffer();
        } catch {
            throw new MediaError(422, 'Imagem inválida ou acima dos limites. Use até 4096 px por lado, 16 MP e sem animação.');
        } finally { processing--; }
        const name = randomUUID() + '.webp';
        await mkdir(root, { recursive: true, mode: 0o700 });
        await writeFile(resolve(root, name), optimized, { flag: 'wx', mode: 0o600 });
        return prefix + name;
    }

    async function removeIfUnused(url) {
        if (!url?.startsWith(prefix)) return;
        const name = url.slice(prefix.length);
        if (!mediaName.test(name) || reference.get(url, url)) return;
        await unlink(resolve(root, name)).catch(error => {
            if (error.code !== 'ENOENT') console.error('Falha ao limpar imagem sem referência.');
        });
    }

    function serve(req, res, next) {
        const { name } = req.params;
        const url = prefix + name;
        if (!mediaName.test(name) || !reference.get(url, url)) return res.sendStatus(404);
        res.type('webp').set('Cache-Control', 'public, max-age=300');
        return res.sendFile(name, { root, dotfiles: 'deny' }, error => {
            if (error && !res.headersSent) {
                if (error.code === 'ENOENT') return res.sendStatus(404);
                return next(error);
            }
        });
    }

    function routes(router, path, auth, csrf, read, write) {
        router.post(path, auth, csrf, limit(), imageBody, async (req, res, next) => {
            let url;
            try {
                if (read(req) === undefined) return res.status(404).json({ error: 'Registro não encontrado.' });
                url = await create(req.body, req.get('content-type')?.split(';')[0].trim().toLowerCase());
                const previous = read(req);
                write(req, url);
                await removeIfUnused(previous);
                return res.status(201).json({ url });
            } catch (error) {
                await removeIfUnused(url);
                if (error instanceof MediaError) return res.status(error.status).json({ error: error.message });
                return next(error);
            }
        });
        router.delete(path, auth, csrf, async (req, res, next) => {
            try {
                const previous = read(req);
                if (previous === undefined) return res.status(404).json({ error: 'Registro não encontrado.' });
                write(req, '');
                await removeIfUnused(previous);
                return res.json({ url: '' });
            } catch (error) { return next(error); }
        });
    }

    return { serve, routes, removeIfUnused };
}
