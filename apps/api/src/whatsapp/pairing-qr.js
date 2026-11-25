import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const { L } = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

export const qrLifetime = 45_000;

export function qrImage(text) {
    const qr = new QRCode(-1, L);
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount() + 8;
    const runs = [];
    qr.modules.forEach((row, y) => {
        let start = -1;
        for (let x = 0; x <= row.length; x++) {
            if (row[x]) {
                if (start < 0) start = x;
            } else if (start >= 0) {
                runs.push(`M${start + 4} ${y + 4}h${x - start}v1h-${x - start}z`);
                start = -1;
            }
        }
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path fill="#fff" d="M0 0h${size}v${size}H0z"/><path d="${runs.join(' ')}"/></svg>`;
    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}
