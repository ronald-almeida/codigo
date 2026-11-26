import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

export const PRODUCT = Object.freeze({ name: 'Black Vitalícia | Combo de Oratória', author: 'Porto Holding', amount: 247, currency: 'BRL' });
export const REFUND_URL = 'https://reembolso-de-alunos.vercel.app/';
const COOKIE = 'codigo_checkout';
const LIFE = 7 * 24 * 60 * 60 * 1000;
const API_BASE = 'https://api.nexumpaybot.com';
const PAID = new Set(['PAID', 'APPROVED', 'COMPLETED', 'SUCCESS', 'CONFIRMED', 'COMPLETO']);
const FAILED = new Set(['FAILED', 'FAIL', 'ERROR', 'REJECTED', 'REFUNDED']);

export class CheckoutError extends Error {
  constructor(message, status = 400, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}

export function configuration(env = process.env) {
  let whatsapp = null;
  try {
    const url = new URL(env.WHATSAPP_URL || 'https://wa.me/5575988393742');
    if (url.protocol === 'https:' && ['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'www.whatsapp.com'].includes(url.hostname)) whatsapp = url.href;
  } catch { /* Configuration is optional until the account owner supplies it. */ }
  return { ready: Boolean(env.NEXUM_CHAT_ID && env.NEXUM_API_CREDENTIAL && env.CHECKOUT_SESSION_SECRET?.length >= 32 && whatsapp), whatsapp };
}

export function validCPF(value) {
  const cpf = String(value ?? '').replace(/\D/g, '');
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const length of [9, 10]) {
    const sum = [...cpf.slice(0, length)].reduce((total, digit, index) => total + Number(digit) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    if ((remainder === 10 ? 0 : remainder) !== Number(cpf[length])) return false;
  }
  return true;
}

export function validateCustomer(input) {
  const name = String(input.name ?? '').trim().replace(/\s+/g, ' ');
  const generatedName = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’\-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^[A-Za-z]+(?: [A-Za-z]+)+$/.test(generatedName) || name.length > 120) throw new CheckoutError('Informe seu nome completo, sem números ou símbolos.');
  const email = String(input.email ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CheckoutError('Informe um e-mail válido.');
  if (email !== String(input.emailConfirmation ?? '').trim().toLowerCase()) throw new CheckoutError('Os e-mails precisam ser iguais.');
  const document = String(input.document ?? '').replace(/\D/g, '');
  if (!validCPF(document)) throw new CheckoutError('Informe um CPF válido.');
  const phone = String(input.phone ?? '').replace(/\D/g, '');
  if (!/^[1-9]{2}\d{8,9}$/.test(phone)) throw new CheckoutError('Informe um celular válido com DDD.');
  // Phone is required for form validation; the documented Nexum payload has no phone field.
  return { generatedName, generatedEmail: email, generatedDocument: document };
}

export function normalizeStatus(status) {
  const value = String(status ?? 'UNKNOWN').toUpperCase();
  if (PAID.has(value)) return 'PAID';
  if (FAILED.has(value)) return value === 'REFUNDED' ? 'REFUNDED' : 'FAILED';
  if (['CANCELLED', 'CANCELED'].includes(value)) return 'CANCELLED';
  if (value === 'EXPIRED') return 'EXPIRED';
  return 'PENDING';
}

function key(env) {
  if (!env.CHECKOUT_SESSION_SECRET || env.CHECKOUT_SESSION_SECRET.length < 32) throw new CheckoutError('O pagamento está temporariamente indisponível. Tente novamente mais tarde.', 503);
  return createHash('sha256').update(env.CHECKOUT_SESSION_SECRET).digest();
}

export function seal(session, env = process.env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(session), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function unseal(value, env = process.env, now = Date.now()) {
  try {
    if (!value || value.length > 6000) return null;
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(env), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const session = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    if (!session.id || !session.expires || session.expires <= now) return null;
    return session;
  } catch { return null; }
}

export function readSession(request, env) {
  const token = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  return unseal(token, env);
}

export function cookieHeader(session, request, env) {
  const secure = new URL(request.url).protocol === 'https:' || env.VERCEL;
  return `${COOKIE}=${seal(session, env)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((session.expires - Date.now()) / 1000))}${secure ? '; Secure' : ''}`;
}

export function newOrder(customer, now = Date.now()) {
  return { id: `codigo-${randomUUID()}`, expires: now + LIFE, createdAt: now, amount: PRODUCT.amount, customer, status: 'PENDING', nextCheckAt: 0 };
}

export function publicOrder(order) {
  return {
    id: order.id, txId: order.txId ?? null, amount: order.amount,
    status: order.status, expiresAt: order.pixExpiresAt ?? null,
    retryAfter: Math.max(0, Math.ceil(((order.nextCheckAt ?? 0) - Date.now()) / 1000)),
    hasOrder: true,
  };
}

// Returned only to the buyer's own checkout session, never in status/receipt data.
export function checkoutOrder(order) {
  return { ...publicOrder(order), buyer: order.buyer ?? (order.customer ? {
    name: order.customer.generatedName, email: order.customer.generatedEmail,
    document: order.customer.generatedDocument, phone: '',
  } : null) };
}

export function retrySeconds(value, now = Date.now()) {
  const number = Number(value);
  const seconds = value && Number.isFinite(number) ? number : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(30, Math.ceil(seconds)) : 30;
}

export async function nexum(path, { method = 'GET', body, idempotencyKey } = {}, env = process.env, fetcher = fetch) {
  if (!env.NEXUM_CHAT_ID || !env.NEXUM_API_CREDENTIAL) throw new CheckoutError('O pagamento está temporariamente indisponível. Tente novamente mais tarde.', 503);
  const headers = {
    'Origin': env.NEXUM_ORIGIN || 'https://nexumpaybot.com',
    'X-API-Chat-Id': env.NEXUM_CHAT_ID.trim(),
    'X-API-Credential': env.NEXUM_API_CREDENTIAL.trim(),
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let response;
  try { response = await fetcher(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(18000), redirect: 'error', cache: 'no-store' }); }
  catch (cause) {
    const knownCodes = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_CHAR']);
    const code = cause.cause?.code || cause.code;
    const reason = knownCodes.has(code) ? code
      : /bytestring|invalid.*header|header.*invalid/i.test(cause.message) ? 'INVALID_CREDENTIAL_HEADER'
      : cause.cause?.message === 'unexpected redirect' ? 'UNEXPECTED_REDIRECT'
      : cause.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED';
    console.error('nexum_request_failed', { operation: path.split('/')[3], reason });
    const error = new CheckoutError(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(reason)
      ? 'O serviço Pix está temporariamente indisponível. Seus dados foram mantidos. Tente novamente mais tarde.'
      : 'Não foi possível conectar ao serviço Pix. Seus dados continuam preenchidos; tente gerar novamente.', 502, 30);
    error.code = reason;
    throw error;
  }
  if (response.status === 429) throw new CheckoutError('Aguarde um momento antes de consultar novamente.', 429, retrySeconds(response.headers.get('retry-after')));
  let data;
  try { data = await response.json(); } catch {
    // Record only protocol metadata: never payer data, credentials or provider bodies.
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    console.error('nexum_invalid_response', {
      operation: path === '/api/public/pix/create' ? 'create_pix' : 'check_pix',
      status: response.status,
      contentType: ['application/json', 'text/html', 'text/plain'].includes(type) ? type : 'other',
    });
    throw new CheckoutError('O serviço de pagamento não respondeu corretamente. Tente novamente.', 502, 30);
  }
  if (!response.ok || data.ok === false) {
    // Provider bodies may include personal details or credentials. Never relay/log them.
    console.error('nexum_rejected_request', { operation: path.split('/')[3], status: response.status });
    const error = new CheckoutError(response.status === 409
      ? 'O Pix ainda está sendo preparado. Aguarde alguns segundos e clique em gerar novamente.'
      : [401, 403].includes(response.status)
        ? 'O serviço Pix está indisponível no momento. Tente novamente em instantes.'
        : [400, 422].includes(response.status)
          ? 'O serviço de pagamento recusou os dados. Confira nome, e-mail e CPF e tente novamente.'
          : 'O serviço de pagamento não conseguiu gerar o Pix. Tente gerar novamente em instantes.', response.status === 409 ? 409 : 502, 30);
    error.creationRejected = [400, 401, 403, 422].includes(response.status);
    throw error;
  }
  return { data, httpStatus: response.status };
}

export async function issuePix(order, env, fetcher) {
  const { data, httpStatus } = await nexum('/api/public/pix/create', {
    method: 'POST', idempotencyKey: order.id,
    // The fixed order body is stored in an authenticated encrypted cookie BEFORE this call.
    body: { amount: order.amount, ...order.customer, externalReference: order.id },
  }, env, fetcher);
  if (typeof data.tx_id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.tx_id)) throw new CheckoutError('A cobrança ainda não retornou um identificador válido. Tente novamente.', 502, 30);
  if (order.txId && data.tx_id !== order.txId) throw new CheckoutError('Não foi possível validar a cobrança. Entre em contato com o suporte.', 502);
  if (data.amount != null && Math.round(Number(data.amount) * 100) !== Math.round(order.amount * 100)) throw new CheckoutError('Não foi possível validar o valor da cobrança.', 502);
  order.txId = data.tx_id;
  const returnedStatus = normalizeStatus(data.status);
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(returnedStatus)) order.status = returnedStatus;
  // Creating a charge never grants access: confirmation uses the status endpoint.
  order.nextCheckAt = Date.now() + 30000;
  if (!order.pixExpiresAt && Number(data.expires_in_seconds) > 0) order.pixExpiresAt = order.createdAt + Number(data.expires_in_seconds) * 1000;
  const rawImage = String(data.qr_code_base64 ?? '').replace(/^data:image\/(?:png|jpeg);base64,/, '');
  const qrImage = /^[a-zA-Z0-9+/=\r\n]+$/.test(rawImage) && rawImage.length < 1000000 ? `data:image/png;base64,${rawImage}` : null;
  return { ...publicOrder(order), qrCode: typeof data.qr_code_text === 'string' ? data.qr_code_text : null, qrImage, processing: httpStatus === 202 || Boolean(data.reconciliation_required) };
}

// Opportunistic per-instance deduplication; encrypted cookie timestamps and provider
// Retry-After also apply across reloads. The provider remains the persistent ledger.
const checks = new Map();
export async function checkPix(order, env, fetcher, now = Date.now()) {
  if (!order.txId) return publicOrder(order);
  if (order.nextCheckAt > now) return publicOrder(order);
  for (const [id, entry] of checks) if (entry.expires <= now) checks.delete(id);
  let entry = checks.get(order.txId);
  if (!entry) {
    const promise = nexum(`/api/public/pix/status/${encodeURIComponent(order.txId)}`, {}, env, fetcher);
    entry = { promise, expires: now + 30000 };
    checks.set(order.txId, entry);
    if (checks.size > 1000) checks.delete(checks.keys().next().value);
  }
  try {
    const { data } = await entry.promise;
    if (data.tx_id !== order.txId) throw new CheckoutError('Não foi possível validar a transação.', 502);
    const status = normalizeStatus(data.status);
    if (status === 'PAID' && Math.round(Number(data.amount) * 100) !== Math.round(order.amount * 100)) throw new CheckoutError('Não foi possível validar o valor do pagamento.', 502);
    order.status = status;
    order.nextCheckAt = now + 30000;
    if (status === 'PAID') {
      order.confirmedAt ??= now;
      // Remove payer data once no create retry will be needed.
      delete order.customer;
      delete order.buyer;
    }
    return publicOrder(order);
  } catch (error) {
    order.nextCheckAt = now + (error.retryAfter || 30) * 1000;
    throw error;
  }
}
