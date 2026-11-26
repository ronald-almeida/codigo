import { api, money, friendlyError } from './shared.js';

async function loadReceipt() {
  try {
    const receipt = await api('/api/receipt');
    if (receipt.status !== 'PAID') throw new Error('O pagamento ainda não foi confirmado.');
    document.getElementById('receipt-amount').textContent = `${money(receipt.amount)} · Pix`;
    document.getElementById('receipt-id').textContent = `Referência da compra: ${receipt.id}`;
    document.getElementById('release-time').textContent = '24 horas';
    document.getElementById('whatsapp-link').href = receipt.whatsappUrl;
    document.getElementById('refund-link').href = receipt.refundUrl;
    document.getElementById('verifying').hidden = true;
    document.getElementById('receipt').hidden = false;
  } catch (error) {
    document.getElementById('verification-message').textContent = friendlyError(error);
    document.querySelector('.loading-ring').hidden = true;
    document.querySelector('.verification h1').textContent = 'Vamos conferir sua compra';
    if (error.status === 409 || error.status === 429 || error.status === 502) setTimeout(loadReceipt, Math.max(30, error.retryAfter || 30) * 1000);
  }
}
loadReceipt();
