import { CheckoutError, PRODUCT, REFUND_URL, configuration, validateCustomer, readSession, cookieHeader, newOrder, publicOrder, issuePix, checkPix } from '../lib/checkout.js';

export function createHandler({ env = process.env, fetcher = fetch } = {}) {
  return async function handle(request) {
    let session;
    const headers = new Headers({ 'Cache-Control': 'no-store, private', 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    function respond(data, status = 200) {
      if (session) headers.set('Set-Cookie', cookieHeader(session, request, env));
      return new Response(JSON.stringify(data), { status, headers });
    }
    try {
      const url = new URL(request.url);
      const pathname = url.pathname.replace(/\/$/, '');
      const path = pathname === '/api' && url.searchParams.has('route') ? `/api/${url.searchParams.get('route')}` : pathname;
      if (path === '/api/config' && request.method === 'GET') {
        return respond({ product: PRODUCT, available: configuration(env).ready, releaseHours: 24 });
      }
      if (path === '/api/order' && request.method === 'GET') {
        session = readSession(request, env);
        return respond(session ? publicOrder(session) : { hasOrder: false });
      }
      if (!configuration(env).ready) throw new CheckoutError('O pagamento está temporariamente indisponível. Tente novamente mais tarde.', 503);
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (!origin || origin !== url.origin) throw new CheckoutError('Origem da solicitação inválida.', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CheckoutError('Formato da solicitação inválido.', 415);
      }
      session = readSession(request, env);
      if (path === '/api/order' && request.method === 'POST') {
        if (session) return respond(publicOrder(session));
        const text = await request.text();
        if (text.length > 4096) throw new CheckoutError('Solicitação muito grande.', 413);
        let input;
        try { input = JSON.parse(text); } catch { throw new CheckoutError('Dados inválidos.'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CheckoutError('Dados inválidos.');
        session = newOrder(validateCustomer(input));
        return respond(publicOrder(session), 201);
      }
      if (!session) throw new CheckoutError('Sua sessão não foi encontrada. Volte ao checkout para continuar.', 401);
      if (path === '/api/pix' && request.method === 'POST') {
        if (session.status === 'PAID') return respond(publicOrder(session));
        if (['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'].includes(session.status)) return respond(publicOrder(session));
        return respond(await issuePix(session, env, fetcher));
      }
      if (path === '/api/status' && request.method === 'GET') return respond(await checkPix(session, env, fetcher));
      if (path === '/api/receipt' && request.method === 'GET') {
        await checkPix(session, env, fetcher);
        if (session.status !== 'PAID') throw new CheckoutError('O pagamento ainda não foi confirmado.', 409);
        return respond({ ...publicOrder(session), product: PRODUCT, whatsappUrl: configuration(env).whatsapp, refundUrl: REFUND_URL, releaseHours: 24 });
      }
      if (path === '/api/reset' && request.method === 'POST') {
        if (!session.txId) throw new CheckoutError('Recupere a cobrança atual antes de iniciar outro pedido.', 409);
        if (session.txId) await checkPix(session, env, fetcher);
        if (session.txId && !['FAILED', 'EXPIRED', 'CANCELLED', 'REFUNDED'].includes(session.status)) throw new CheckoutError('A cobrança atual ainda está ativa. Consulte o pagamento antes de criar outra.', 409);
        session = null;
        headers.set('Set-Cookie', 'codigo_checkout=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
        return respond({ ok: true });
      }
      return respond({ error: 'Recurso não encontrado.' }, 404);
    } catch (error) {
      const expected = error instanceof CheckoutError;
      if (!expected) console.error('checkout_unexpected_error', { name: error?.name });
      if (error.retryAfter) headers.set('Retry-After', String(error.retryAfter));
      return respond({ error: expected ? error.message : 'Não foi possível concluir sua solicitação. Tente novamente.', retryAfter: error.retryAfter || 30 }, expected ? error.status : 500);
    }
  };
}

const handle = createHandler();
export const GET = handle;
export const POST = handle;
