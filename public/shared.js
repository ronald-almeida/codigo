export const money = value => Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Não foi possível concluir a solicitação.');
    error.retryAfter = Number(response.headers.get('retry-after') || data.retryAfter || 30);
    error.status = response.status;
    error.order = data.order;
    error.retryFresh = data.retryFresh === true;
    throw error;
  }
  return data;
}
export function friendlyError(error) {
  return ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name)
    ? 'Não foi possível conectar ao pagamento. Verifique sua internet e tente novamente.'
    : error.message;
}
