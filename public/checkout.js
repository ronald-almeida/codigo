import { api, money, friendlyError } from './shared.js';

const $ = id => document.getElementById(id);
const form = $('buyer-form');
let currentOrder = null;
let busy = false;
let timer;
let countdown;
let nextCheckAt = 0;
let pollDelay = 30000;
let expiresAt = null;
let copyOnCreate = false;

function showError(id, error) { $(id).textContent = friendlyError(error); $(id).hidden = false; }
function clearError(id) { $(id).hidden = true; $(id).textContent = ''; }
function showPanel() {
  form.hidden = true;
  $('pix-panel').hidden = false;
}
function schedule(seconds = 30) {
  clearTimeout(timer);
  pollDelay = Math.max(30, Number(seconds) || 30) * 1000;
  nextCheckAt = Date.now() + pollDelay;
  timer = setTimeout(checkPayment, pollDelay);
  updateCountdown();
}
function updateCountdown() {
  const remaining = Math.ceil((nextCheckAt - Date.now()) / 1000);
  $('check-button').disabled = busy || remaining > 0;
  $('check-button').textContent = remaining > 0 ? `Consultar pagamento em ${remaining}s` : 'Consultar pagamento';
  if (expiresAt) {
    const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    const hours = Math.floor(left / 3600), minutes = Math.floor(left % 3600 / 60), seconds = left % 60;
    $('expiry').textContent = left > 0 ? `Validade do Pix: ${hours > 0 ? `${hours}h ` : ''}${String(minutes).padStart(2, '0')}min ${String(seconds).padStart(2, '0')}s`
      : 'O prazo deste código terminou. Estamos conferindo o status antes de permitir outra cobrança.';
    if (left === 0) { $('code-area').hidden = true; $('qr-area').hidden = true; }
  }
}
function consumeStatus(data) {
  currentOrder = data;
  if (data.status === 'PAID') {
    clearTimeout(timer); clearInterval(countdown);
    $('payment-status').textContent = 'Pagamento confirmado! Abrindo sua página de obrigado…';
    location.replace('/obrigado');
    return true;
  }
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED'].includes(data.status)) {
    clearTimeout(timer); clearInterval(countdown);
    const messages = { FAILED: 'Não foi possível concluir esse pagamento.', CANCELLED: 'Esta cobrança foi cancelada.', EXPIRED: 'Este Pix expirou.', REFUNDED: 'O pagamento desta cobrança foi reembolsado.' };
    $('payment-status').textContent = messages[data.status];
    $('code-area').hidden = true; $('qr-area').hidden = true; $('check-button').hidden = true; $('retry-button').hidden = true; $('reset-button').hidden = false;
    return true;
  }
  return false;
}
async function recoverPix({ focus = false } = {}) {
  if (busy) return;
  busy = true;
  showPanel();
  clearError('pix-error');
  $('retry-button').hidden = true;
  $('payment-status').textContent = 'Preparando sua cobrança Pix…';
  try {
    const data = await api('/api/pix', {});
    if (consumeStatus(data)) return;
    expiresAt = data.expiresAt;
    if (data.qrCode) {
      $('pix-code').value = data.qrCode;
      $('code-area').hidden = false;
      if (copyOnCreate) { copyOnCreate = false; await copyCode(); }
    }
    if (data.qrImage) { $('qr-image').src = data.qrImage; $('qr-area').hidden = false; }
    $('payment-status').textContent = data.qrCode ? 'Aguardando pagamento. A confirmação é automática.' : 'O banco está preparando sua cobrança. Aguarde e recupere o código sem criar um novo pedido.';
    if (!data.qrCode) $('retry-button').hidden = false;
    schedule(Math.max(30, data.retryAfter || 30));
    countdown ??= setInterval(updateCountdown, 1000);
    if (focus) { $('pix-heading').focus(); $('pix-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (error) {
    showError('pix-error', error);
    $('payment-status').textContent = 'Sua cobrança foi preservada. Use o botão abaixo para tentar novamente.';
    $('retry-button').hidden = false;
    if (currentOrder?.txId) schedule(error.retryAfter || 30);
  } finally { busy = false; updateCountdown(); }
}
async function checkPayment() {
  if (busy) { schedule(30); return; }
  if (document.hidden) { schedule(30); return; }
  busy = true;
  clearError('pix-error');
  updateCountdown();
  try {
    const data = await api('/api/status');
    if (consumeStatus(data)) return;
    $('payment-status').textContent = data.txId ? 'Aguardando pagamento. A confirmação é automática.' : 'Recupere sua cobrança para continuar.';
    if (data.txId) schedule(Math.max(30, data.retryAfter || 30));
  } catch (error) {
    showError('pix-error', error);
    schedule(error.retryAfter || 30);
  } finally { busy = false; updateCountdown(); }
}

$('document').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 11);
  event.target.value = digits.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  copyOnCreate = event.submitter?.id === 'initial-copy-button';
  clearError('form-error');
  const values = Object.fromEntries(new FormData(form));
  if (values.email.trim().toLowerCase() !== values.emailConfirmation.trim().toLowerCase()) {
    showError('form-error', new Error('Os e-mails precisam ser iguais.'));
    $('emailConfirmation').focus(); return;
  }
  busy = true; $('pay-button').disabled = true; $('initial-copy-button').disabled = true; $('pay-button').querySelector('span').textContent = 'Preparando pagamento…';
  try {
    // The preparation response saves an encrypted HttpOnly cookie BEFORE issuing Pix.
    // A lost charge response can then be recovered with the same idempotency key/body.
    currentOrder = await api('/api/order', values);
    form.reset();
    busy = false;
    await recoverPix({ focus: true });
  } catch (error) { showError('form-error', error); }
  finally { busy = false; $('pay-button').disabled = false; $('initial-copy-button').disabled = false; $('pay-button').querySelector('span').textContent = 'Gerar código QR'; }
});
async function copyCode() {
  try {
    await navigator.clipboard.writeText($('pix-code').value);
    $('copy-feedback').textContent = 'Código copiado! Cole no aplicativo do seu banco.';
    $('copy-button').textContent = 'Código Pix copiado';
  } catch {
    $('pix-code').focus(); $('pix-code').select();
    $('copy-feedback').textContent = 'Selecione e copie o código acima para colar no seu banco.';
  }
}
$('copy-button').addEventListener('click', copyCode);
$('check-button').addEventListener('click', () => { if (Date.now() >= nextCheckAt) checkPayment(); });
$('retry-button').addEventListener('click', () => recoverPix());
$('reset-button').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('reset-button').disabled = true;
  try { await api('/api/reset', {}); location.replace('/'); }
  catch (error) { showError('pix-error', error); }
  finally { busy = false; $('reset-button').disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentOrder?.txId && !['PAID','EXPIRED','FAILED','CANCELLED','REFUNDED'].includes(currentOrder.status) && Date.now() >= nextCheckAt) checkPayment();
});

async function init() {
  try {
    const config = await api('/api/config');
    document.querySelectorAll('[data-price]').forEach(element => { element.textContent = money(config.product.amount); });
    document.querySelectorAll('[data-release]').forEach(element => { element.textContent = '24 horas'; });
    if (!config.available) {
      $('availability').textContent = 'O pagamento está temporariamente indisponível. Tente novamente mais tarde.';
      $('availability').hidden = false;
      return;
    }
    const order = await api('/api/order');
    if (order.hasOrder) {
      showPanel();
      if (!consumeStatus(order)) await recoverPix();
    } else { $('pay-button').disabled = false; $('initial-copy-button').disabled = false; }
  } catch (error) {
    $('availability').textContent = 'Não foi possível carregar o pagamento. Atualize a página para tentar novamente.';
    $('availability').hidden = false;
  }
}
init();
