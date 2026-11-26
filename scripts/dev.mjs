import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHandler } from '../api/index.js';

const root = resolve('public');
const routes = { '/': 'index.html', '/obrigado': 'obrigado.html', '/privacidade': 'privacidade.html' };
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const handle = createHandler();
const server = createServer(async (req, res) => {
  try {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 8192) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET','HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    const file = resolve(root, routes[url.pathname] ?? `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Página não encontrada'); }
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${server.address().port}`));
