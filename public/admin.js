const $ = (sel) => document.querySelector(sel);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString();
}

function fmtAmount(units, coin = 'ETH') {
  if (units === null || units === undefined || units === '') return '—';
  try {
    const decimals = coin === 'ETH' ? 18 : 8;
    const base = 10n ** BigInt(decimals);
    const value = BigInt(units);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    const shown = fraction ? `.${fraction.slice(0, 8).replace(/0+$/, '')}` : '';
    return `${whole}${shown} ${coin}`;
  } catch {
    return `${units} ${coin}`;
  }
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : '—';
}

function txExplorer(coin, hash) {
  if (coin === 'BTC') return `https://mempool.space/tx/${hash}`;
  if (coin === 'LTC') return `https://litecoinspace.org/tx/${hash}`;
  return `https://etherscan.io/tx/${hash}`;
}

function statusPill(status) {
  const tone = {
    pending: 'warn',
    paid: 'ok',
    forwarded: 'ok',
    underpaid: 'warn',
    refunded: 'info',
    expired: '',
    forward_failed: 'bad',
    refund_failed: 'bad',
  }[status] || '';
  return `<span class="pill ${tone}">${escapeHtml(status || '—')}</span>`;
}

function notifyPill(status) {
  const tone = { sent: 'ok', failed: 'bad', skipped: 'warn' }[status] || '';
  return `<span class="pill ${tone}">${escapeHtml(status || 'not attempted')}</span>`;
}

function invoiceAmount(inv) {
  const coin = inv.coin || 'ETH';
  return inv.paidAmountWei ? fmtAmount(inv.paidAmountWei, coin) : fmtAmount(inv.expectedAmountWei, coin);
}

function invoiceTx(inv) {
  const coin = inv.coin || 'ETH';
  const hash = inv.forwardedTxHash || inv.refundedTxHash || inv.paidTxHash;
  if (!hash) return '—';
  return `<a href="${escapeHtml(txExplorer(coin, hash))}" target="_blank" rel="noopener"><code>${escapeHtml(shortHash(hash))}</code> ↗</a>`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    if (!path.includes('/api/admin/login')) showLogin();
    throw new Error(data.error || 'admin authentication required');
  }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function showLogin() {
  $('#appView').classList.add('hidden');
  $('#loginView').classList.remove('hidden');
  $('#logoutBtn').classList.add('hidden');
  $('#adminKey').focus();
}

function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#logoutBtn').classList.remove('hidden');
}

function setMsg(el, text, ok) {
  el.textContent = text || '';
  el.classList.toggle('ok', Boolean(ok));
  el.classList.toggle('bad', ok === false);
}

function showSection(name) {
  const valid = ['overview', 'accounts', 'invoices', 'webhooks', 'email'];
  const target = valid.includes(name) ? name : 'overview';
  document.querySelectorAll('.admin-section').forEach((section) => {
    section.classList.toggle('hidden', section.id !== target);
  });
  document.querySelectorAll('.side-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.target === target);
  });
  return target;
}

async function loadOverview() {
  const data = await api('/api/admin/overview');
  $('#ovAccounts').textContent = data.accounts;
  $('#ovInvoices').textContent = data.invoices;
  $('#ovDeliveries').textContent = data.webhookDeliveries;
  $('#ovStatuses').textContent = Object.entries(data.statuses || {})
    .map(([status, count]) => `${status}: ${count}`)
    .join(' · ') || '—';
  $('#ovEth').textContent = fmtAmount(data.volumeWei?.ETH || '0', 'ETH');
  $('#ovBtc').textContent = fmtAmount(data.volumeWei?.BTC || '0', 'BTC');
  $('#ovLtc').textContent = fmtAmount(data.volumeWei?.LTC || '0', 'LTC');

  const invoiceRows = (data.recentInvoices || []).map((inv) => `
    <tr>
      <td>${escapeHtml(fmtDate(inv.createdAt))}</td>
      <td><code>${escapeHtml(inv.companyCode || '—')}</code></td>
      <td>${escapeHtml(invoiceAmount(inv))}</td>
      <td>${statusPill(inv.status)}</td>
      <td>${notifyPill(inv.notifyStatus)}</td>
    </tr>
  `).join('');
  $('#ovRecentInvoices').innerHTML = invoiceRows || '<tr><td colspan="5" class="empty">No invoices yet.</td></tr>';

  const deliveryRows = (data.recentDeliveries || []).map((delivery) => `
    <tr>
      <td>${escapeHtml(fmtDate(delivery.lastAttemptAt || delivery.createdAt))}</td>
      <td><code>${escapeHtml(delivery.event)}</code></td>
      <td><code>${escapeHtml(delivery.companyCode)}</code></td>
      <td>${delivery.success ? '<span class="pill ok">delivered</span>' : '<span class="pill bad">failed</span>'}</td>
    </tr>
  `).join('');
  $('#ovRecentDeliveries').innerHTML = deliveryRows || '<tr><td colspan="4" class="empty">No webhook deliveries yet.</td></tr>';
}

async function loadAccounts() {
  const data = await api('/api/admin/accounts');
  const rows = (data.accounts || []).map((account) => {
    const statuses = Object.entries(account.statuses || {})
      .map(([status, count]) => `${status}: ${count}`)
      .join(', ');
    return `
      <tr>
        <td><strong>${escapeHtml(account.companyName || '—')}</strong></td>
        <td><code>${escapeHtml(account.companyCode)}</code></td>
        <td>${escapeHtml(account.email)}</td>
        <td><code>${escapeHtml(account.walletAddress || '—')}</code></td>
        <td><code>${escapeHtml(account.btcAddress || '—')}</code></td>
        <td><code>${escapeHtml(account.ltcAddress || '—')}</code></td>
        <td>${escapeHtml(account.invoiceCount)}${statuses ? `<br><small>${escapeHtml(statuses)}</small>` : ''}</td>
        <td>${escapeHtml(fmtDate(account.lastInvoiceAt))}</td>
        <td>${escapeHtml(fmtDate(account.createdAt))}</td>
      </tr>
    `;
  }).join('');
  $('#accountsBody').innerHTML = rows || '<tr><td colspan="9" class="empty">No accounts yet.</td></tr>';
}

async function loadInvoices() {
  const params = new URLSearchParams({ limit: '500' });
  const status = $('#invoiceStatus').value.trim();
  const companyCode = $('#invoiceCompany').value.trim();
  const q = $('#invoiceSearch').value.trim();
  if (status) params.set('status', status);
  if (companyCode) params.set('companyCode', companyCode);
  if (q) params.set('q', q);

  const data = await api(`/api/admin/invoices?${params}`);
  const invoices = data.invoices || [];
  const rows = invoices.map((inv) => `
    <tr>
      <td>${escapeHtml(fmtDate(inv.createdAt))}</td>
      <td><code>${escapeHtml(inv.companyCode || '—')}</code></td>
      <td>${escapeHtml(inv.coin || 'ETH')}</td>
      <td>${escapeHtml(fmtAmount(inv.expectedAmountWei, inv.coin || 'ETH'))}</td>
      <td>${escapeHtml(fmtAmount(inv.paidAmountWei, inv.coin || 'ETH'))}</td>
      <td>${statusPill(inv.status)}</td>
      <td>${notifyPill(inv.notifyStatus)}${inv.notifyError ? `<br><small title="${escapeHtml(inv.notifyError)}">${escapeHtml(inv.notifyError.slice(0, 42))}${inv.notifyError.length > 42 ? '…' : ''}</small>` : ''}</td>
      <td><code>${escapeHtml(shortHash(inv.address))}</code></td>
      <td>${invoiceTx(inv)}</td>
    </tr>
  `).join('');
  $('#invoicesBody').innerHTML = rows || '<tr><td colspan="9" class="empty">No matching invoices.</td></tr>';
  const start = invoices.length ? data.offset + 1 : 0;
  $('#invoiceMeta').textContent = `Showing ${start}–${data.offset + invoices.length} of ${data.total}`;
}

async function loadWebhooks() {
  const data = await api('/api/admin/webhooks?limit=500');
  const deliveries = data.deliveries || [];
  const rows = deliveries.map((delivery) => `
    <tr>
      <td>${escapeHtml(fmtDate(delivery.lastAttemptAt || delivery.createdAt))}</td>
      <td><code>${escapeHtml(delivery.event)}</code></td>
      <td><code>${escapeHtml(delivery.companyCode)}</code></td>
      <td class="wrap"><code>${escapeHtml(delivery.url)}</code></td>
      <td>${delivery.success
        ? `<span class="pill ok">delivered ${escapeHtml(delivery.statusCode || 200)}</span>`
        : `<span class="pill bad">${delivery.statusCode ? `HTTP ${escapeHtml(delivery.statusCode)}` : 'failed'}</span>`}</td>
      <td>${escapeHtml(delivery.attempts)}</td>
      <td class="wrap">${escapeHtml(delivery.error || '—')}</td>
    </tr>
  `).join('');
  $('#webhooksBody').innerHTML = rows || '<tr><td colspan="7" class="empty">No webhook deliveries yet.</td></tr>';
  $('#webhookMeta').textContent = `Showing ${deliveries.length} of ${data.total} delivery attempt(s).`;
}

async function loadSmtp() {
  const data = await api('/api/admin/smtp');
  const smtp = data.smtp || {};
  $('#smtpEnabled').checked = Boolean(smtp.enabled);
  $('#smtpHost').value = smtp.host || '';
  $('#smtpPort').value = smtp.port || 587;
  $('#smtpSecure').checked = Boolean(smtp.secure);
  $('#smtpRequireTls').checked = Boolean(smtp.requireTls);
  $('#smtpUser').value = smtp.user || '';
  $('#smtpPassword').value = '';
  $('#smtpPassword').placeholder = smtp.hasPassword
    ? 'Stored password — leave blank to keep it'
    : 'No password stored';
  $('#smtpClearPassword').checked = false;
  $('#smtpFromName').value = smtp.fromName || 'MSU Pay';
  $('#smtpFromEmail').value = smtp.fromEmail || '';
}

async function loadSection(name) {
  try {
    if (name === 'accounts') await loadAccounts();
    else if (name === 'invoices') await loadInvoices();
    else if (name === 'webhooks') await loadWebhooks();
    else if (name === 'email') await loadSmtp();
    else await loadOverview();
  } catch (e) {
    if (e.message === 'admin authentication required') return;
    console.error('[admin load]', e);
    const bodies = {
      overview: ['#ovRecentInvoices', 5],
      accounts: ['#accountsBody', 9],
      invoices: ['#invoicesBody', 9],
      webhooks: ['#webhooksBody', 7],
    };
    const target = bodies[name];
    if (target) {
      $(target[0]).innerHTML = `<tr><td colspan="${target[1]}" class="empty">${escapeHtml(e.message)}</td></tr>`;
    }
    if (name === 'email') setMsg($('#smtpSaveMsg'), e.message, false);
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const key = $('#adminKey').value;
  const button = $('#loginBtn');
  setMsg($('#loginMsg'), '');
  button.disabled = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
    $('#adminKey').value = '';
    showApp();
    await loadSection('overview');
  } catch (e) {
    setMsg($('#loginMsg'), e.message, false);
  } finally {
    button.disabled = false;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
  } catch {
    /* clear the local view even if the request fails */
  }
  showLogin();
});

document.querySelectorAll('.side-link').forEach((link) => {
  link.addEventListener('click', async (event) => {
    event.preventDefault();
    const target = showSection(link.dataset.target);
    history.replaceState(null, '', `#${target}`);
    await loadSection(target);
  });
});

document.querySelectorAll('[data-refresh]').forEach((button) => {
  button.addEventListener('click', () => loadSection(button.dataset.refresh));
});

$('#invoiceFilterBtn').addEventListener('click', () => loadSection('invoices'));
['invoiceStatus', 'invoiceCompany', 'invoiceSearch'].forEach((id) => {
  $(`#${id}`).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadSection('invoices');
  });
});

$('#smtpForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#smtpPassword').value;
  const payload = {
    enabled: $('#smtpEnabled').checked,
    host: $('#smtpHost').value,
    port: Number($('#smtpPort').value),
    secure: $('#smtpSecure').checked,
    requireTls: $('#smtpRequireTls').checked,
    user: $('#smtpUser').value,
    fromName: $('#smtpFromName').value,
    fromEmail: $('#smtpFromEmail').value,
    clearPassword: $('#smtpClearPassword').checked,
  };
  if (password) payload.password = password;

  const button = $('#smtpSaveBtn');
  button.disabled = true;
  setMsg($('#smtpSaveMsg'), 'Saving…');
  try {
    await api('/api/admin/smtp', { method: 'PUT', body: JSON.stringify(payload) });
    await loadSmtp();
    setMsg($('#smtpSaveMsg'), 'SMTP settings saved.', true);
  } catch (e) {
    setMsg($('#smtpSaveMsg'), e.message, false);
  } finally {
    button.disabled = false;
  }
});

$('#smtpTestBtn').addEventListener('click', async () => {
  const button = $('#smtpTestBtn');
  button.disabled = true;
  setMsg($('#smtpTestMsg'), 'Sending…');
  try {
    const result = await api('/api/admin/smtp/test', {
      method: 'POST',
      body: JSON.stringify({ to: $('#smtpTestTo').value }),
    });
    setMsg($('#smtpTestMsg'), `Test sent to ${result.to}.`, true);
  } catch (e) {
    setMsg($('#smtpTestMsg'), e.message, false);
  } finally {
    button.disabled = false;
  }
});

(async function init() {
  try {
    await api('/api/admin/session');
    showApp();
    const initial = showSection(location.hash.slice(1) || 'overview');
    await loadSection(initial);
  } catch {
    showLogin();
  }
})();
