const $ = (sel) => document.querySelector(sel);

const createBtn = $('#createBtn');
const payForm = $('#payForm');
const amountInput = $('#amount');
const amountSymbol = $('#amountSymbol');
const amountEur = $('#amountEur');
const titleEl = $('#title');
const subtitleEl = $('#subtitle');
const customerLine = $('#customerLine');
const walletRow = $('#walletRow');
const invoiceSection = $('#invoice');
const addressRow = $('#addressRow');
const addressEl = $('#address');
const qrWrap = $('#qrWrap');
const qrImg = $('#qrImg');
const statusEl = $('#status');
const statusIcon = $('#statusIcon');
const copyBtn = $('#copyBtn');
const actions = $('#actions');
const cancelBtn = $('#cancelBtn');
const payBtn = $('#payBtn');
const explorerEl = $('#explorer');
const receiptBtn = $('#receiptBtn');
const errorOverlay = $('#errorOverlay');
const retryBtn = $('#retryBtn');
const paramError = $('#paramError');
const paramErrorMsg = $('#paramErrorMsg');
const connectBtn = $('#connectBtn');
const walletAddress = $('#walletAddress');
const walletError = $('#walletError');
const walletPayBtn = $('#walletPayBtn');

let currentId = null;
let currentAccessToken = null;
let pollTimer = null;
let qrInvoiceId = null;
let walletAccount = null;
let currentExpectedWei = '0';
let currentStatus = null;
let merchantCompanyCode = null;
let merchantEur = null;
let selectedCoin = 'ETH';
let rates = null;
let hideAddress = false;

const COIN_SYMBOLS = { ETH: 'Ξ', BTC: '₿', LTC: 'Ł' };

async function loadRates() {
  try {
    const res = await fetch('/api/rates');
    if (res.ok) rates = await res.json();
  } catch {
    /* keep null; amounts show as '—' */
  }
  updateCoinUI();
}

function coinAmount(coin) {
  if (!merchantEur || !rates || !rates[coin]) return null;
  return (merchantEur / rates[coin]).toFixed(8).replace(/\.?0+$/, '');
}

function refreshWalletButtons() {
  const isEth = selectedCoin === 'ETH';
  walletRow.classList.toggle('hidden', !isEth);
  walletPayBtn.classList.toggle('hidden', !(isEth && walletAccount));
}

function updateCoinUI() {
  const amt = coinAmount(selectedCoin);
  amountSymbol.textContent = COIN_SYMBOLS[selectedCoin] || 'Ξ';
  amountInput.textContent = amt || '—';
  refreshWalletButtons();
}

function selectCoin(coin) {
  selectedCoin = coin;
  document.querySelectorAll('.coin-opt').forEach((b) => b.classList.toggle('active', b.dataset.coin === coin));
  updateCoinUI();
}

const STATUS_LABELS = {
  pending: 'Waiting for payment…',
  paid: 'Payment received',
  underpaid: 'Underpaid — amount received is too low',
  forwarded: 'Payment complete',
  refunded: 'Payment refunded',
  expired: 'Invoice expired',
  forward_failed: 'Payment failed',
  refund_failed: 'Refund failed',
};

const params = new URLSearchParams(location.search);

function b64Decode(b64) {
  const s = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64ToObj(b64) {
  return JSON.parse(b64Decode(b64));
}

function safeUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

async function resolveCompany(code) {
  try {
    const res = await fetch(`/api/company/${encodeURIComponent(code)}`);
    if (res.ok) {
      const c = await res.json();
      if (c.companyName && c.companyName !== code) titleEl.textContent = c.companyName;
    }
  } catch {
    /* keep the code as the title */
  }
}

const payinfoParam = params.get('payinfo');

function showParamError(msg) {
  payForm.classList.add('gone');
  paramErrorMsg.textContent = msg;
  paramError.classList.remove('hidden');
}

if (!payinfoParam) {
  showParamError('This payment link is missing its payment details.');
} else {
  let invalid = null;
  try {
    const info = b64ToObj(payinfoParam);
    const hasCompany = info.companyCode || info.company;
    const eurOk = info.eur != null && info.eur !== '' && !isNaN(Number(info.eur)) && Number(info.eur) > 0;
    if (!info.sig) {
      invalid = 'This payment link is not signed and may have been tampered with.';
    } else if (!hasCompany) {
      invalid = 'This payment link has no company code.';
    } else if (!eurOk) {
      invalid = 'This payment link has an invalid amount.';
    } else {
      merchantEur = Number(info.eur);
      if (info.companyCode) {
        merchantCompanyCode = info.companyCode;
        titleEl.textContent = info.companyCode;
        resolveCompany(info.companyCode);
      } else {
        titleEl.textContent = info.company;
      }
      if (info.product) subtitleEl.textContent = info.product;
      const cust = [info.customerName, info.customerInfo].filter(Boolean).join(' · ');
      if (cust) {
        customerLine.textContent = cust;
        customerLine.classList.remove('hidden');
      }
      amountEur.textContent = `≈ €${merchantEur.toFixed(2)}`;
      loadRates();
    }
  } catch {
    invalid = 'This payment link could not be decoded.';
  }
  if (invalid) showParamError(invalid);
}

// Optional return URLs (base64-encoded). `returns` = success, `returnf` = cancelled.
let returnSuccessUrl = null;
let returnFailUrl = null;
try {
  const rs = params.get('returns');
  if (rs) returnSuccessUrl = safeUrl(b64Decode(rs));
} catch {}
try {
  const rf = params.get('returnf');
  if (rf) returnFailUrl = safeUrl(b64Decode(rf));
} catch {}

function setStatus(status, errorMsg) {
  statusEl.className = 'status';
  if (status === 'pending') statusEl.classList.add('waiting');
  if (status === 'underpaid') statusEl.classList.add('warn');
  if (status.endsWith('failed')) statusEl.classList.add('failed');
  statusEl.textContent = STATUS_LABELS[status] ?? status;
  if (errorMsg) statusEl.textContent += ' — ' + errorMsg;

  statusIcon.className = 'status-icon';
  if (status === 'pending') statusIcon.classList.add('spinning');
  else if (status === 'paid') statusIcon.classList.add('choice');
  else if (status === 'underpaid') statusIcon.classList.add('choice');
  else if (status === 'forwarded') statusIcon.classList.add('done');
  else if (status === 'refunded') statusIcon.classList.add('refunded');
  else if (status === 'expired') statusIcon.classList.add('failed');
}

function explorerUrl(coin, hash) {
  if (coin === 'ETH') return `https://etherscan.io/tx/${hash}`;
  if (coin === 'BTC') return `https://mempool.space/tx/${hash}`;
  return `https://litecoinspace.org/tx/${hash}`;
}

function showInvoice(inv) {
  currentId = inv.id;
  currentStatus = inv.status;
  currentExpectedWei = inv.expectedAmountWei || '0';
  addressEl.textContent = inv.address;
  invoiceSection.classList.remove('hidden');
  setStatus(inv.status, inv.error);

  addressRow.classList.toggle('collapsed', !(inv.status === 'pending' && !hideAddress));
  qrWrap.classList.toggle('hidden', !(inv.status === 'pending' && !hideAddress));
  if (inv.status === 'pending' && !hideAddress && qrInvoiceId !== inv.id) {
    qrInvoiceId = inv.id;
    qrImg.src = `/api/invoice/${inv.id}/qr`;
  }
  actions.classList.toggle('hidden', !['paid', 'underpaid', 'forward_failed'].includes(inv.status));
  payBtn.classList.toggle('hidden', !['paid', 'forward_failed'].includes(inv.status));

  const finished = inv.status === 'forwarded' || inv.status === 'refunded' || inv.status === 'expired' || inv.status.endsWith('failed');
  payForm.classList.toggle('gone', finished);

  const txHash = inv.forwardedTxHash || inv.refundedTxHash || inv.paidTxHash;
  if (txHash) {
    explorerEl.href = explorerUrl(inv.coin || 'ETH', txHash);
    explorerEl.classList.remove('hidden');
  }

  const completed = inv.status === 'forwarded' || inv.status === 'refunded';
  if (completed) {
    receiptBtn.href = `/api/invoice/${inv.id}/receipt`;
    receiptBtn.classList.remove('hidden');
  }

  maybeRedirect(inv.status);
}

let redirectScheduled = false;
function maybeRedirect(status) {
  if (redirectScheduled) return;
  const url = status === 'forwarded' ? returnSuccessUrl : status === 'refunded' ? returnFailUrl : null;
  if (!url) return;
  redirectScheduled = true;
  statusEl.textContent = 'Redirecting…';
  setTimeout(() => {
    window.location.href = url;
  }, 2000);
}

let sseSource = null;

function stopStream() {
  if (sseSource) {
    sseSource.close();
    sseSource = null;
  }
  stopPolling();
}

function startStream(id) {
  stopStream();
  if (typeof EventSource !== 'undefined') {
    try {
      sseSource = new EventSource(`/api/invoice/${id}/events`);
      sseSource.addEventListener('status', (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data && data.invoice) {
            showInvoice(data.invoice);
            if (['forwarded', 'refunded', 'forward_failed', 'refund_failed'].includes(data.invoice.status)) {
              stopStream();
            }
          }
        } catch (err) {
          console.error('[sse parse error]', err);
        }
      });
      sseSource.onerror = () => {
        // Fall back to polling if SSE drops
        if (sseSource) {
          sseSource.close();
          sseSource = null;
        }
        startPolling();
      };
      return;
    } catch {
      /* fallback to polling */
    }
  }
  startPolling();
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

async function fetchJSON(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new Error('connection');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function showConnectionError() {
  errorOverlay.classList.remove('hidden');
}
function hideConnectionError() {
  errorOverlay.classList.add('hidden');
}

function ripple(e) {
  const btn = e.currentTarget;
  const span = btn.querySelector('.ripple');
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  span.style.width = span.style.height = size + 'px';
  span.style.left = (e.clientX - rect.left - size / 2) + 'px';
  span.style.top = (e.clientY - rect.top - size / 2) + 'px';
  span.style.animation = 'none';
  void span.offsetWidth;
  span.style.animation = '';
}

async function createInvoice(direct = false) {
  hideAddress = direct;
  createBtn.classList.add('gone');
  walletPayBtn.classList.add('gone');
  createBtn.disabled = true;
  createBtn.querySelector('.pay-btn-label').textContent = 'Creating…';

  try {
    const inv = await fetchJSON('/api/invoice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payinfo: payinfoParam, coin: selectedCoin }),
    });
    currentAccessToken = inv.accessToken || null;
    showInvoice(inv);
    startStream(inv.id);
    if (direct) await payWithWallet();
  } catch (e) {
    createBtn.classList.remove('gone');
    walletPayBtn.classList.remove('gone');
    createBtn.disabled = false;
    createBtn.querySelector('.pay-btn-label').textContent = 'Pay';
    if (e.status === 400) {
      showParamError(e.message || 'This payment link is invalid.');
    } else {
      showConnectionError();
    }
  }
}

async function sendAction(action) {
  try {
    const inv = await fetchJSON(`/api/invoice/${currentId}/${action}`, {
      method: 'POST',
      headers: currentAccessToken ? { 'X-Invoice-Token': currentAccessToken } : {},
    });
    showInvoice(inv);
    if (inv.status === 'forwarded' || inv.status === 'refunded' || inv.status.endsWith('failed')) stopStream();
  } catch (e) {
    stopStream();
    showConnectionError();
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    if (!currentId) return;
    try {
      const inv = await fetchJSON(`/api/invoice/${currentId}`);
      showInvoice(inv);
      if (inv.status === 'forwarded' || inv.status === 'refunded' || inv.status.endsWith('failed')) stopStream();
    } catch (e) {
      stopStream();
      showConnectionError();
    }
  }, 2500);
}

async function retry() {
  hideConnectionError();
  if (currentId) {
    try {
      const inv = await fetchJSON(`/api/invoice/${currentId}`);
      showInvoice(inv);
      startStream(inv.id);
    } catch (e) {
      showConnectionError();
    }
  } else {
    createBtn.classList.remove('gone');
    createBtn.disabled = false;
    createBtn.querySelector('.pay-btn-label').textContent = 'Pay';
  }
}


// ---------- Injected wallet (MetaMask etc.) ----------
const MAINNET_CHAIN_ID = '0x1';

function hasProvider() {
  return typeof window.ethereum !== 'undefined';
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function showWalletError(msg) {
  walletError.textContent = msg;
  walletError.classList.remove('hidden');
}

function updateWalletUI() {
  if (walletAccount) {
    connectBtn.textContent = 'Connected';
    connectBtn.classList.add('connected');
    walletAddress.textContent = shortAddr(walletAccount);
    walletAddress.classList.remove('hidden');
  } else {
    connectBtn.textContent = 'Connect Wallet';
    connectBtn.classList.remove('connected');
    walletAddress.classList.add('hidden');
  }
  refreshWalletButtons();
}

async function ensureMainnet() {
  try {
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (chainId !== MAINNET_CHAIN_ID) {
      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: MAINNET_CHAIN_ID }],
        });
      } catch {
        await window.ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: MAINNET_CHAIN_ID,
            chainName: 'Ethereum',
            rpcUrls: ['https://ethereum-rpc.publicnode.com'],
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          }],
        });
      }
    }
  } catch {
    /* network switch failed or cancelled */
  }
}

async function connectWallet() {
  walletError.classList.add('hidden');
  if (!hasProvider()) {
    showWalletError('No wallet detected — install MetaMask and refresh.');
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    walletAccount = accounts[0] || null;
    updateWalletUI();
    await ensureMainnet();
  } catch {
    /* user rejected the connection */
  }
}

async function payWithWallet() {
  if (!walletAccount || !currentId) return;
  const tx = { from: walletAccount, to: addressEl.textContent };
  if (currentExpectedWei && currentExpectedWei !== '0') {
    tx.value = '0x' + BigInt(currentExpectedWei).toString(16);
  }
  walletPayBtn.disabled = true;
  walletPayBtn.textContent = 'Sending…';
  try {
    await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    statusEl.textContent = 'Transaction sent — confirming…';
  } catch (e) {
    if (e && e.code === 4001) statusEl.textContent = 'Payment cancelled in wallet';
    else statusEl.textContent = 'Wallet transaction failed';

    // Bring back the address/QR and the wallet button so the payer can retry
    // or pay manually instead of being stuck waiting on a cancelled payment.
    hideAddress = false;
    addressRow.classList.remove('collapsed');
    qrWrap.classList.remove('hidden');
    if (qrInvoiceId !== currentId) {
      qrInvoiceId = currentId;
      qrImg.src = `/api/invoice/${currentId}/qr`;
    }
    walletPayBtn.classList.remove('gone');
    walletPayBtn.classList.toggle('hidden', !walletAccount);

    setTimeout(() => setStatus('pending'), 2500);
  } finally {
    walletPayBtn.disabled = false;
    walletPayBtn.textContent = 'Pay with wallet';
  }
}

createBtn.addEventListener('click', () => createInvoice(false));
createBtn.addEventListener('click', ripple);
payBtn.addEventListener('click', () => sendAction('pay'));
cancelBtn.addEventListener('click', () => sendAction('cancel'));
retryBtn.addEventListener('click', retry);
connectBtn.addEventListener('click', connectWallet);
walletPayBtn.addEventListener('click', () => createInvoice(true));
document.querySelectorAll('.coin-opt').forEach((b) => {
  b.addEventListener('click', () => selectCoin(b.dataset.coin));
});
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(addressEl.textContent);
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
});

if (hasProvider()) {
  window.ethereum.on('accountsChanged', (accounts) => {
    walletAccount = accounts[0] || null;
    updateWalletUI();
  });
  window.ethereum.on('chainChanged', () => {
    /* keep it simple: user can reconnect/switch manually */
  });
  window.ethereum.request({ method: 'eth_accounts' }).then((accounts) => {
    if (accounts && accounts[0]) {
      walletAccount = accounts[0];
      updateWalletUI();
    }
  }).catch(() => {});
}
