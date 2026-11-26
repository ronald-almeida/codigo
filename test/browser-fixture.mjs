// Local-only browser fixture. It never calls Nexum and is not imported by api/.
// This fixture is deliberately outside public/ and is never part of production.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHandler } from '../api/index.js';
const env = { NEXUM_CHAT_ID: 'local-test', NEXUM_API_CREDENTIAL: 'local-test', CHECKOUT_SESSION_SECRET: 'local-browser-test-secret-never-use-in-production', WHATSAPP_URL: 'https://wa.me/5575988393742' };
let status = 'PENDING';
let mode = 'success';
let attempts = [];
let statusChecks = 0;
const sampleQr = (await readFile(new URL('./sample-qr.png', import.meta.url))).toString('base64');
const handle = createHandler({ env, fetcher: async (url, options) => {
  if (url.endsWith('/pix/create')) {
    attempts.push({ key: options.headers['Idempotency-Key'], body: options.body });
    if (mode === 'failure') return Response.json({ ok: false }, { status: 502 });
    if (mode === 'processing') return Response.json({ ok: true, tx_id: 'local_test_transaction', reconciliation_required: true }, { status: 202 });
    if (mode === 'missing-code') return Response.json({ ok: true, tx_id: 'local_test_transaction', amount: 247 });
    return Response.json({ ok: true, tx_id: 'local_test_transaction', amount: 247, status: 'PENDING', qr_code_text: 'PREVIA LOCAL - NAO E PIX - NAO PAGAR', qr_code_base64: sampleQr, expires_in_seconds: 86400 });
  }
  statusChecks++;
  if (mode === 'status-failure') return Response.json({ ok: false }, { status: 502 });
  return Response.json({ ok: true, tx_id: 'local_test_transaction', status, amount: 247 });
} });
const root = resolve('public');
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/fixture/reset') { status = 'PENDING'; mode = 'success'; attempts = []; statusChecks = 0; res.writeHead(302, { 'Set-Cookie': 'codigo_checkout=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0', Location: '/' }); res.end(); return; }
    if (url.pathname === '/fixture/mode') {
      const requested = url.searchParams.get('value');
      if (!['success', 'failure', 'processing', 'missing-code', 'status-failure'].includes(requested)) { res.writeHead(400).end(); return; }
      mode = requested; res.end(mode); return;
    }
    if (url.pathname === '/fixture/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ attempts: attempts.length, statusChecks, sameOrder: new Set(attempts.map(attempt => attempt.key)).size === 1, sameBody: new Set(attempts.map(attempt => attempt.body)).size === 1 })); return;
    }
    if (url.pathname === '/fixture/paid') { status = 'PAID'; res.end('Local test now returns PAID.'); return; }
    if (url.pathname === '/fixture/pending') { status = 'PENDING'; res.end('Local test now returns PENDING.'); return; }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const result = await handle(new Request(url, { method: req.method, headers: req.headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }));
      res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(await result.text()); return;
    }
    const routes = { '/': 'index.html', '/obrigado': 'obrigado.html', '/privacidade': 'privacidade.html' };
    const file = resolve(root, routes[url.pathname] || `.${url.pathname}`);
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(extname(file) === '.html' ? data.toString().replace('<body>', '<body><div class="demo-banner">PRÉVIA DE TESTE · Nenhum pagamento real</div>') : data);
  } catch { res.writeHead(404).end(); }
}).listen(4186, '127.0.0.1', () => console.log('Local test only (no real payment): http://127.0.0.1:4186'));
