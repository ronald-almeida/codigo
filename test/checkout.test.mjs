import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHandler } from '../api/index.js';
import { validCPF, validateCustomer, seal, unseal, normalizeStatus, retrySeconds, issuePix, checkPix, newOrder, PRODUCT } from '../lib/checkout.js';

const env = { NEXUM_CHAT_ID: 'test-account', NEXUM_API_CREDENTIAL: 'test-credential', CHECKOUT_SESSION_SECRET: 'test-secret-only-not-for-production-123456789', WHATSAPP_URL: 'https://wa.me/5575988393742', NEXUM_ORIGIN: 'https://nexumpaybot.com' };
const customer = { name: 'João da Conceição', email: 'test@example.com', emailConfirmation: 'test@example.com', document: '091.157.510-31', phone: '(75) 99999-9999' };
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const request = (path, { method = 'GET', cookie, body, origin = 'https://checkout.example.com' } = {}) => new Request(`https://checkout.example.com${path}`, { method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const getCookie = result => result.headers.get('set-cookie').split(';')[0];

test('CPF check digits, name normalization and email confirmation', () => {
  assert.equal(validCPF(customer.document), true);
  for (const cpf of ['11111111111', '12345678900', '', '09115751032']) assert.equal(validCPF(cpf), false);
  assert.deepEqual(validateCustomer(customer), { generatedName: 'Joao da Conceicao', generatedEmail: 'test@example.com', generatedDocument: '09115751031' });
  assert.throws(() => validateCustomer({ ...customer, emailConfirmation: 'other@example.com' }));
  assert.throws(() => validateCustomer({ ...customer, name: 'Joao 2 Silva' }));
});

test('encrypted session hides payer data, rejects tampering, expiry and another key', () => {
  const order = newOrder(validateCustomer(customer));
  const token = seal(order, env);
  assert.equal(token.includes('test@example.com'), false);
  assert.equal(unseal(token, env).id, order.id);
  assert.equal(unseal('x' + token.slice(1), env), null);
  assert.equal(unseal(token, env, order.expires + 1), null);
  assert.equal(unseal(token, { ...env, CHECKOUT_SESSION_SECRET: 'another-test-secret-with-more-than-32-characters' }), null);
});

test('only server price is used, credentials stay server-side and retries reuse identical body/key', async () => {
  const calls = [];
  const handle = createHandler({ env, fetcher: async (url, options) => { calls.push({ url, ...options }); return response({ ok: true, tx_id: 'test_tx', amount: 247, status: 'PENDING', qr_code_text: 'TEST-NOT-A-PAYABLE-PIX', qr_code_base64: 'aGVsbG8=', expires_in_seconds: 86400 }); } });
  const prepared = await handle(request('/api/order', { method: 'POST', body: { ...customer, amount: 0.01 } }));
  assert.equal(prepared.status, 201);
  const cookie = getCookie(prepared);
  assert.match(prepared.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(prepared.headers.get('set-cookie'), /Secure/);
  const first = await handle(request('/api/pix', { method: 'POST', cookie, body: {} }));
  const result = await first.json();
  assert.equal(result.amount, PRODUCT.amount);
  assert.equal(result.status, 'PENDING');
  assert.equal(JSON.stringify(result).includes(env.NEXUM_API_CREDENTIAL), false);
  await handle(request('/api/pix', { method: 'POST', cookie: getCookie(first), body: {} }));
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(JSON.parse(calls[0].body).amount, 247);
  assert.equal(calls[0].headers.Origin, env.NEXUM_ORIGIN);
  assert.equal(calls[0].headers['X-API-Credential'], env.NEXUM_API_CREDENTIAL);
});

test('PROCESSING/202 preserves tx_id and returns no fake confirmation', async () => {
  const order = newOrder(validateCustomer(customer));
  const result = await issuePix(order, env, async () => response({ ok: true, tx_id: 'processing_tx', status: 'PROCESSING', reconciliation_required: true }, 202));
  assert.equal(result.processing, true);
  assert.equal(result.txId, 'processing_tx');
  assert.equal(result.status, 'PENDING');
  assert.equal(result.qrCode, null);
});

test('timeout can retry the original prepared order and never changes idempotency key', async () => {
  const keys = [];
  const handle = createHandler({ env, fetcher: async (url, options) => { keys.push(options.headers['Idempotency-Key']); throw new Error('timeout'); } });
  const prepared = await handle(request('/api/order', { method: 'POST', body: customer }));
  const first = await handle(request('/api/pix', { method: 'POST', cookie: getCookie(prepared), body: {} }));
  assert.equal(first.status, 502);
  await handle(request('/api/pix', { method: 'POST', cookie: getCookie(first), body: {} }));
  assert.equal(keys[0], keys[1]);
});

test('non-JSON provider errors log only protocol metadata and preserve the order for recovery', async t => {
  const log = t.mock.method(console, 'error', () => {});
  const keys = [];
  const handle = createHandler({ env, fetcher: async (url, options) => {
    keys.push(options.headers['Idempotency-Key']);
    if (keys.length === 1) return new Response('<html>private upstream details test-credential</html>', { status: 502, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return response({ ok: true, tx_id: 'recovered_tx', amount: 247, qr_code_text: 'TEST-NOT-A-PAYABLE-PIX' });
  } });
  const prepared = await handle(request('/api/order', { method: 'POST', body: customer }));
  const failure = await handle(request('/api/pix', { method: 'POST', cookie: getCookie(prepared), body: {} }));
  assert.equal(failure.status, 502);
  assert.equal(failure.headers.get('retry-after'), '30');
  assert.deepEqual(log.mock.calls[0].arguments, ['nexum_invalid_response', { operation: 'create_pix', status: 502, contentType: 'text/html' }]);
  assert.equal(JSON.stringify(await failure.json()).includes('private upstream'), false);
  const recovered = await handle(request('/api/pix', { method: 'POST', cookie: getCookie(failure), body: {} }));
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).txId, 'recovered_tx');
  assert.equal(keys[0], keys[1]);
});

test('status polling enforces cooldown, confirms expected amount and deduplicates concurrent reads', async () => {
  let calls = 0;
  const order = { ...newOrder(validateCustomer(customer)), txId: randomUUID() };
  const fetcher = async () => { calls++; return response({ ok: true, tx_id: order.txId, status: 'PAID', amount: 247 }); };
  const copies = [structuredClone(order), structuredClone(order)];
  await Promise.all(copies.map(copy => checkPix(copy, env, fetcher)));
  assert.equal(calls, 1);
  assert.equal(copies[0].status, 'PAID');
  assert.equal(copies[0].customer, undefined);
  await checkPix(copies[0], env, fetcher);
  assert.equal(calls, 1);
});

test('confirmation rejects wrong transaction, underpayment, missing amount and unknown statuses', async () => {
  for (const data of [{ status: 'PAID', amount: 1 }, { status: 'PAID' }, { status: 'PAID', amount: 247, tx_id: 'unrelated' }]) {
    const order = { ...newOrder(validateCustomer(customer)), txId: randomUUID() };
    await assert.rejects(checkPix(order, env, async () => response({ ok: true, tx_id: order.txId, ...data })));
    assert.equal(order.status, 'PENDING');
  }
  assert.equal(normalizeStatus('unrecognized-status'), 'PENDING');
  assert.equal(normalizeStatus('REFUNDED'), 'REFUNDED');
  assert.equal(normalizeStatus('APPROVED'), 'PAID');
});

test('Retry-After is respected, including HTTP date format', async () => {
  const order = { ...newOrder(validateCustomer(customer)), txId: randomUUID() };
  const now = Date.now();
  await assert.rejects(checkPix(order, env, async () => response({}, 429, { 'Retry-After': '120' }), now), error => error.status === 429 && error.retryAfter === 120);
  assert.equal(order.nextCheckAt, now + 120000);
  assert.equal(retrySeconds(new Date(now + 120000).toUTCString(), now) >= 119, true);
});

test('receipt needs a verified payment and no query param or forged cookie bypasses it', async () => {
  const handle = createHandler({ env, fetcher: async () => { throw new Error('should not be called'); } });
  assert.equal((await handle(request('/api/receipt?paid=true'))).status, 401);
  assert.equal((await handle(request('/api/receipt', { cookie: 'codigo_checkout=forged' }))).status, 401);
  const prepared = await handle(request('/api/order', { method: 'POST', body: customer }));
  assert.equal((await handle(request('/api/receipt', { cookie: getCookie(prepared) }))).status, 409);
  const order = { ...newOrder(validateCustomer(customer)), txId: 'paid', status: 'PAID', nextCheckAt: Date.now() + 30000 };
  const receipt = await handle(request('/api/receipt', { cookie: `codigo_checkout=${seal(order, env)}` }));
  const data = await receipt.json();
  assert.equal(data.releaseHours, 24);
  assert.equal(data.whatsappUrl, 'https://wa.me/5575988393742');
  assert.equal(data.refundUrl, 'https://reembolso-de-alunos.vercel.app/');
});

test('cross-origin posts, malformed payload and unknown secret fail closed', async () => {
  const handle = createHandler({ env });
  assert.equal((await handle(request('/api/order', { method: 'POST', origin: 'https://attacker.example', body: customer }))).status, 403);
  assert.equal((await handle(request('/api/order', { method: 'POST', body: null }))).status, 400);
  const unavailable = createHandler({ env: {} });
  assert.equal((await unavailable(request('/api/config'))).status, 200);
  assert.equal((await unavailable(request('/api/order', { method: 'POST', body: customer }))).status, 503);
});

test('an active charge cannot be replaced or reset; expired charge permits a new order', async () => {
  const handle = createHandler({ env });
  const unconfirmed = newOrder(validateCustomer(customer));
  assert.equal((await handle(request('/api/reset', { method: 'POST', cookie: `codigo_checkout=${seal(unconfirmed, env)}`, body: {} }))).status, 409);
  const order = { ...newOrder(validateCustomer(customer)), txId: 'active', nextCheckAt: Date.now() + 30000 };
  const cookie = `codigo_checkout=${seal(order, env)}`;
  const prepared = await handle(request('/api/order', { method: 'POST', cookie, body: { ...customer, email: 'changed@example.com' } }));
  assert.equal((await prepared.json()).id, order.id);
  assert.equal((await handle(request('/api/reset', { method: 'POST', cookie, body: {} }))).status, 409);
  order.status = 'EXPIRED';
  const reset = await handle(request('/api/reset', { method: 'POST', cookie: `codigo_checkout=${seal(order, env)}`, body: {} }));
  assert.equal(reset.status, 200);
  assert.match(reset.headers.get('set-cookie'), /Max-Age=0/);
});

test('Vercel rewrite routes dispatch correctly', async () => {
  const handle = createHandler({ env });
  const result = await handle(request('/api?route=config'));
  assert.equal((await result.json()).product.amount, 247);
});

test('release deadline stays consistent in checkout config and paid receipt', async () => {
  for (const hours of ['2', '48', 'invalid']) {
    const settings = { ...env, ACCESS_RELEASE_HOURS: hours };
    const handle = createHandler({ env: settings });
    const expected = 24;
    assert.equal((await (await handle(request('/api/config'))).json()).releaseHours, expected);
    const order = { ...newOrder(validateCustomer(customer)), txId: randomUUID(), status: 'PAID', nextCheckAt: Date.now() + 30000 };
    const receipt = await handle(request('/api/receipt', { cookie: `codigo_checkout=${seal(order, settings)}` }));
    assert.equal((await receipt.json()).releaseHours, expected);
  }
});

test('phone with DDD is required and invalid submissions never reach the payment provider', async () => {
  const handle = createHandler({ env, fetcher: async () => { assert.fail('invalid customer must not reach Nexum'); } });
  for (const phone of [undefined, null, '', '   ', '12', '999999999', '(00) 99999-9999']) {
    const result = await handle(request('/api/order', { method: 'POST', body: { ...customer, phone } }));
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error, 'Informe um celular válido com DDD.');
    assert.equal(result.headers.has('set-cookie'), false);
  }
  for (const phone of ['75999999999', '(75) 99999-9999', '(75) 3333-4444']) {
    assert.deepEqual(validateCustomer({ ...customer, phone }), validateCustomer(customer));
  }
});

test('cancelled, failed, expired and refunded payments never produce a receipt', async () => {
  const handle = createHandler({ env });
  for (const status of ['PENDING', 'FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED']) {
    const order = { ...newOrder(validateCustomer(customer)), txId: randomUUID(), status, nextCheckAt: Date.now() + 30000 };
    const receipt = await handle(request('/api/receipt', { cookie: `codigo_checkout=${seal(order, env)}` }));
    assert.equal(receipt.status, 409);
  }
});
