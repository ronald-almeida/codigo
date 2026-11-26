import { api, money, friendlyError } from './shared.js';

const $ = id => document.getElementById(id);
const form = $('buyer-form');
const personal = form.querySelector('.personal');
const terminal = new Set(['FAILED', 'CANCELLED', 'EXPIRED', 'REFUNDED']);
const generationError = 'Não foi possível gerar o Pix. Tente novamente.';
let currentOrder = null;
let busy = false;
let available = false;
let timer;
let countdown;
let nextCheckAt = 0;
let expiresAt = null;

function showError(id, message) {
  $(id).textContent = typeof message === 'string' ? message : friendlyError(message);
  $(id).hidden = false;
}
function clearError(id) { $(id).hidden = true; $(id).textContent = ''; }
function setGenerating(value) {
  busy = value;
  form.setAttribute('aria-busy', String(value));
  $('pay-button').disabled = value || !available;
  $('initial-copy-button').disabled = value || !available;
  $('pay-button').querySelector('span').textContent = value ? 'Gerando Pix…' : 'Gerar código QR';
}
function stopPolling() {
  clearTimeout(timer);
  clearInterval(countdown);
  countdown = null;
}
function clearForm() {
  stopPolling();
  currentOrder = null;
  form.reset();
  form.hidden = false;
  personal.hidden = false;
  form.noValidate = false;
  personal.querySelectorAll('input').forEach(input => { input.readOnly = false; });
  $('pix-panel').hidden = true;
  clearError('form-error');
}
function consumeStatus(data) {
  currentOrder = data;
  if (data.status === 'PAID') {
    stopPolling();
    location.replace('/obrigado');
    return true;
  }
  if (terminal.has(data.status)) {
    stopPolling();
    form.hidden = false;
    personal.hidden = false;
    personal.querySelectorAll('input').forEach(input => { input.readOnly = false; });
    form.noValidate = false;
    $('pix-panel').hidden = true;
    const messages = {
      FAILED: 'Não foi possível gerar o Pix. Tente novamente.',
      CANCELLED: 'Este Pix foi cancelado. Você pode gerar um novo código.',
      EXPIRED: 'Este Pix expirou. Você pode gerar um novo código.',
      REFUNDED: 'Este pagamento foi reembolsado. Você pode iniciar uma nova compra.',
    };
    showError('form-error', messages[data.status]);
    return true;
  }
  return false;
}
function schedule(seconds = 30) {
  clearTimeout(timer);
  const delay = Math.max(30, Number(seconds) || 30) * 1000;
  nextCheckAt = Date.now() + delay;
  timer = setTimeout(checkPayment, delay);
}
function updateCountdown() {
  if (!expiresAt) return;
  const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  const hours = Math.floor(left / 3600), minutes = Math.floor(left % 3600 / 60), seconds = left % 60;
  $('expiry').textContent = left > 0
    ? 'Validade do Pix: ' + (hours > 0 ? hours + 'h ' : '') + String(minutes).padStart(2, '0') + 'min ' + String(seconds).padStart(2, '0') + 's'
    : 'O prazo deste código terminou. Aguarde a confirmação automática.';
  if (left === 0) { $('code-area').hidden = true; $('qr-area').hidden = true; }
}
async function generatePix({ values, focus = false, copy = false } = {}) {
  if (busy) return;
  setGenerating(true);
  clearError('form-error');
  let creating = false;
  try {
    if (currentOrder && terminal.has(currentOrder.status)) {
      await api('/api/reset', {});
      currentOrder = null;
    }
    currentOrder = await api('/api/order', { ...values, orderId: currentOrder?.id });
    if (consumeStatus(currentOrder)) return;
    creating = true;
    const data = await api('/api/pix', values);
    if (consumeStatus(data)) return;
    if (data.processing || !data.txId || typeof data.qrCode !== 'string' || !data.qrCode.trim()) {
      throw new Error(generationError);
    }

    // Only switch screens once a usable Pix code has actually been received.
    expiresAt = data.expiresAt;
    $('pix-code').value = data.qrCode;
    $('code-area').hidden = false;
    $('qr-area').hidden = !data.qrImage;
    if (data.qrImage) $('qr-image').src = data.qrImage;
    clearError('pix-error');
    $('payment-status').textContent = 'Aguardando pagamento. A confirmação é automática.';
    form.hidden = true;
    $('pix-panel').hidden = false;
    form.reset();
    updateCountdown();
    schedule(data.retryAfter || 30);
    countdown ??= setInterval(updateCountdown, 1000);
    if (copy) await copyCode();
    if (focus) { $('pix-heading').focus(); $('pix-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  } catch (error) {
    stopPolling();
    form.hidden = false;
    $('pix-panel').hidden = true;
    if (error.order) consumeStatus(error.order);
    if (error.retryFresh) {
      currentOrder = null;
      form.noValidate = false;
      personal.querySelectorAll('input').forEach(input => { input.readOnly = false; });
    }
    showError('form-error', creating ? generationError : error);
    if (focus) $('form-error').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } finally { setGenerating(false); }
}
async function checkPayment() {
  if ($('pix-panel').hidden) return;
  if (busy || document.hidden) { schedule(30); return; }
  busy = true;
  try {
    const data = await api('/api/status');
    if (consumeStatus(data)) return;
    clearError('pix-error');
    $('payment-status').textContent = 'Aguardando pagamento. A confirmação é automática.';
    schedule(data.retryAfter || 30);
  } catch (error) {
    showError('pix-error', 'Não foi possível atualizar a confirmação agora. Tentaremos novamente automaticamente.');
    schedule(error.retryAfter || 30);
  } finally { setGenerating(false); }
}

$('document').addEventListener('input', event => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 11);
  event.target.value = digits.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !available) return;
  const values = Object.fromEntries(new FormData(form));
  if (values.email.trim().toLowerCase() !== values.emailConfirmation.trim().toLowerCase()) {
    showError('form-error', 'Os e-mails precisam ser iguais.');
    $('emailConfirmation').focus(); return;
  }
  await generatePix({ values, focus: true, copy: event.submitter?.id === 'initial-copy-button' });
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('pix-panel').hidden && currentOrder?.txId && Date.now() >= nextCheckAt) checkPayment();
});

async function init() {
  try {
    const config = await api('/api/config');
    document.querySelectorAll('[data-price]').forEach(element => { element.textContent = money(config.product.amount); });
    available = config.available;
    if (!available) {
      $('availability').textContent = 'O pagamento está temporariamente indisponível. Tente novamente mais tarde.';
      $('availability').hidden = false;
      return;
    }
    setGenerating(false);
  } catch {
    available = false;
    setGenerating(false);
    $('availability').textContent = 'Não foi possível carregar o pagamento. Atualize a página para tentar novamente.';
    $('availability').hidden = false;
  }
}
clearForm();
window.addEventListener('pageshow', event => {
  if (event.persisted) { clearForm(); setGenerating(false); }
  else form.reset();
});
init();
