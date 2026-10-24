const $ = (sel) => document.querySelector(sel);

const token = localStorage.getItem('nesppay_token');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
}

function roundEth(str, maxDec = 5) {
  const n = Number(str);
  if (!Number.isFinite(n)) return String(str);
  let out = n.toFixed(maxDec);
  out = out.replace(/\.?0+$/, '');
  if (out === '' || out === '-0') out = '0';
  return out;
}

function statusLabel(s) {
  return {
    pending: 'Pending',
    paid: 'Received',
    underpaid: 'Underpaid',
    forwarded: 'Completed',
    refunded: 'Refunded',
    expired: 'Expired',
    forward_failed: 'Failed',
    refund_failed: 'Failed',
  }[s] || s;
}

function coinSymbol(coin) {
  return { ETH: 'Ξ', BTC: '₿', LTC: 'Ł' }[coin] || 'Ξ';
}

function txExplorer(coin, hash) {
  if (coin === 'BTC') return `https://mempool.space/tx/${hash}`;
  if (coin === 'LTC') return `https://litecoinspace.org/tx/${hash}`;
  return `https://etherscan.io/tx/${hash}`;
}

function renderTransactions(txs) {
  const list = $('#txList');
  if (!txs || txs.length === 0) {
    list.innerHTML = '<p class="tx-empty">No transactions yet.</p>';
    return;
  }
  list.innerHTML = '';
  txs.forEach((t) => {
    const coin = t.coin || 'ETH';
    const div = coin === 'ETH' ? 1e18 : 1e8;
    const amount = t.paidAmountWei
      ? roundEth(Number(t.paidAmountWei) / div)
      : t.expectedAmountWei
        ? roundEth(Number(t.expectedAmountWei) / div)
        : '0';
    const hash = t.forwardedTxHash || t.refundedTxHash || t.paidTxHash;
    const item = document.createElement('div');
    item.className = 'tx-item';
    item.innerHTML = `
      <div class="tx-top">
        <span class="tx-amount">${coinSymbol(coin)} ${amount}</span>
        <span class="tx-status ${escapeHtml(t.status)}">${escapeHtml(statusLabel(t.status))}</span>
      </div>
      <div class="tx-meta">
        ${hash ? `<a href="${escapeHtml(txExplorer(coin, hash))}" target="_blank" rel="noopener">${escapeHtml(shortAddr(hash))} ↗</a>` : ''}
        <span class="tx-date">${escapeHtml(t.createdAt ? new Date(t.createdAt).toLocaleString() : '')}</span>
      </div>
    `;
    list.appendChild(item);
  });
}

function renderWebhookDeliveries(deliveries) {
  const list = $('#webhookDeliveryList');
  if (!list) return;
  if (!deliveries || deliveries.length === 0) {
    list.innerHTML = '<p class="tx-empty">No webhook deliveries yet.</p>';
    return;
  }
  list.innerHTML = '';
  deliveries.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'delivery-item';
    const isSuccess = d.success;
    item.innerHTML = `
      <div class="delivery-top">
        <span class="delivery-event">${escapeHtml(d.event)}</span>
        <span class="delivery-status ${isSuccess ? 'success' : 'failed'}">
          ${escapeHtml(isSuccess ? 'Delivered (' + (d.statusCode || '200') + ')' : (d.statusCode ? 'HTTP ' + d.statusCode : 'Failed'))}
        </span>
      </div>
      <div class="delivery-meta">
        <span>${escapeHtml(d.url)} (Attempt ${escapeHtml(d.attempts)})</span>
        <span>${escapeHtml(d.lastAttemptAt ? new Date(d.lastAttemptAt).toLocaleTimeString() : '')}</span>
      </div>
      ${d.error ? `<div style="font-size:0.75rem; color:var(--danger);">${escapeHtml(d.error)}</div>` : ''}
    `;
    list.appendChild(item);
  });
}

async function loadWebhookConfig() {
  try {
    const res = await fetch('/api/webhook/config', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const { webhookUrl, webhookSecret } = await res.json();
      if ($('#webhookUrl')) $('#webhookUrl').value = webhookUrl || '';
      if ($('#webhookSecret')) $('#webhookSecret').textContent = webhookSecret || '—';
    }

    const delRes = await fetch('/api/webhook/deliveries', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (delRes.ok) {
      const { deliveries } = await delRes.json();
      renderWebhookDeliveries(deliveries);
    }
  } catch (e) {
    console.error('[webhook load error]', e);
  }
}

async function load() {
  const res = await fetch('/api/account', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    window.location.href = '/login';
    return;
  }
  if (!res.ok) throw new Error('failed to load account');
  const { account, earningsEth } = await res.json();
  $('#email').textContent = account.email;
  $('#topEmail').textContent = account.email;
  $('#companyCode').textContent = account.companyCode;
  $('#companyNameTitle').textContent = account.companyName || 'merchant';
  $('#walletAddress').textContent = account.walletAddress ? shortAddr(account.walletAddress) : '—';
  $('#walletAddressBig').textContent = account.walletAddress || '—';
  $('#btcAddress').textContent = account.btcAddress || '—';
  $('#ltcAddress').textContent = account.ltcAddress || '—';
  $('#earnings').textContent = `Ξ ${roundEth(earningsEth ?? '0')}`;
  $('#companyName').value = account.companyName || '';
  $('#companyDescription').value = account.companyDescription || '';

  await loadWebhookConfig();

  const tres = await fetch('/api/transactions', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (tres.ok) {
    const { transactions } = await tres.json();
    $('#txCount').textContent = transactions.length;
    renderTransactions(transactions);
  }
}

if (!token) {
  window.location.href = '/login';
} else {
  load().catch(() => {});
}

$('#copyBtn').addEventListener('click', () => {
  const code = $('#companyCode').textContent;
  navigator.clipboard.writeText(code);
  $('#copyBtn').textContent = 'Copied!';
  setTimeout(() => ($('#copyBtn').textContent = 'Copy'), 1500);
});

$('#copyWalletBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#walletAddressBig').textContent);
  $('#copyWalletBtn').textContent = 'Copied!';
  setTimeout(() => ($('#copyWalletBtn').textContent = 'Copy'), 1500);
});

const copyWebhookSecretBtn = $('#copyWebhookSecretBtn');
if (copyWebhookSecretBtn) {
  copyWebhookSecretBtn.addEventListener('click', () => {
    const secret = $('#webhookSecret').textContent;
    if (secret && secret !== '—') {
      navigator.clipboard.writeText(secret);
      copyWebhookSecretBtn.textContent = 'Copied!';
      setTimeout(() => (copyWebhookSecretBtn.textContent = 'Copy'), 1500);
    }
  });
}

const regenWebhookSecretBtn = $('#regenWebhookSecretBtn');
if (regenWebhookSecretBtn) {
  regenWebhookSecretBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to regenerate your webhook secret? Existing webhooks will need the new secret.')) return;
    try {
      const res = await fetch('/api/webhook/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ regenerateSecret: true }),
      });
      if (res.ok) {
        const data = await res.json();
        $('#webhookSecret').textContent = data.webhookSecret;
      }
    } catch (e) {
      alert('Failed to regenerate secret: ' + e.message);
    }
  });
}

const saveWebhookBtn = $('#saveWebhookBtn');
if (saveWebhookBtn) {
  saveWebhookBtn.addEventListener('click', async () => {
    saveWebhookBtn.disabled = true;
    saveWebhookBtn.textContent = 'Saving…';
    const msg = $('#webhookSaveMsg');
    if (msg) msg.style.display = 'none';

    try {
      const url = $('#webhookUrl').value.trim();
      const res = await fetch('/api/webhook/config', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ webhookUrl: url }),
      });
      if (res.ok) {
        if (msg) {
          msg.textContent = 'Webhook URL saved ✓';
          msg.style.color = '#10b981';
          msg.style.display = 'block';
          setTimeout(() => { if (msg) msg.style.display = 'none'; }, 2500);
        }
      }
    } catch (e) {
      if (msg) {
        msg.textContent = 'Failed to save URL';
        msg.style.color = 'var(--danger)';
        msg.style.display = 'block';
      }
    } finally {
      saveWebhookBtn.disabled = false;
      saveWebhookBtn.textContent = 'Save URL';
    }
  });
}

const testWebhookBtn = $('#testWebhookBtn');
if (testWebhookBtn) {
  testWebhookBtn.addEventListener('click', async () => {
    const statusEl = $('#webhookTestStatus');
    testWebhookBtn.disabled = true;
    testWebhookBtn.textContent = 'Sending…';
    if (statusEl) {
      statusEl.className = 'test-status';
      statusEl.textContent = 'Sending test ping…';
    }

    try {
      const res = await fetch('/api/webhook/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (statusEl) {
          statusEl.className = 'test-status success';
          statusEl.textContent = `Ping delivered successfully (HTTP ${data.statusCode}) ✓`;
        }
      } else {
        if (statusEl) {
          statusEl.className = 'test-status error';
          statusEl.textContent = data.error || (data.statusCode ? `Server returned HTTP ${data.statusCode}` : 'Failed to deliver ping');
        }
      }
      const delRes = await fetch('/api/webhook/deliveries', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (delRes.ok) {
        const { deliveries } = await delRes.json();
        renderWebhookDeliveries(deliveries);
      }
    } catch (e) {
      if (statusEl) {
        statusEl.className = 'test-status error';
        statusEl.textContent = e.message || 'Connection error';
      }
    } finally {
      testWebhookBtn.disabled = false;
      testWebhookBtn.textContent = 'Send test ping';
    }
  });
}

document.querySelectorAll('.copy-btn[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = document.getElementById(btn.dataset.copy);
    navigator.clipboard.writeText(target ? target.textContent : '');
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
});

document.querySelectorAll('.side-link').forEach((link) => {
  link.addEventListener('click', () => {
    document.querySelectorAll('.side-link').forEach((l) => l.classList.remove('active'));
    link.classList.add('active');
  });
});

$('#saveBtn').addEventListener('click', async () => {
  const btn = $('#saveBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/company', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        companyName: $('#companyName').value.trim(),
        companyDescription: $('#companyDescription').value.trim(),
      }),
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    if (!res.ok) throw new Error('save failed');
    const saved = $('#saved');
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 2000);
  } catch {
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
});

$('#withdrawBtn').addEventListener('click', async () => {
  const toAddress = $('#withdrawAddress').value.trim();
  const msg = $('#withdrawMsg');
  msg.classList.remove('show');
  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    msg.textContent = 'Enter a valid destination address.';
    msg.classList.add('show');
    return;
  }
  const btn = $('#withdrawBtn');
  btn.disabled = true;
  btn.textContent = 'Withdrawing…';
  try {
    const res = await fetch('/api/withdraw', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ toAddress }),
    });
    const data = await res.json();
    if (!res.ok) {
      msg.textContent = data.error || 'Withdraw failed.';
      msg.classList.add('show');
      return;
    }
    msg.textContent = `Sent ✓ ${data.txHash.slice(0, 10)}…`;
    msg.classList.add('show');
    $('#withdrawAddress').value = '';
  } catch {
    msg.textContent = 'Connection error.';
    msg.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Withdraw all';
  }
});

$('#exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/wallet/credentials', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const creds = await res.json();
    $('#expEthAddr').textContent = creds.ETH.address;
    $('#expEthKey').textContent = creds.ETH.privateKey;
    $('#expBtcAddr').textContent = creds.BTC.address;
    $('#expBtcKey').textContent = creds.BTC.privateKey;
    $('#expLtcAddr').textContent = creds.LTC.address;
    $('#expLtcKey').textContent = creds.LTC.privateKey;
    $('#exportModal').classList.remove('hidden');
  } catch {
    /* ignore */
  }
});

$('#exportClose').addEventListener('click', () => {
  $('#exportModal').classList.add('hidden');
});

$('#exportModal').addEventListener('click', (e) => {
  if (e.target === $('#exportModal')) $('#exportModal').classList.add('hidden');
});

$('#logoutBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* clear locally even if the server is unreachable */
  }
  localStorage.removeItem('nesppay_token');
  window.location.href = '/';
});

$('#deleteBtn').addEventListener('click', () => {
  $('#deleteConfirm').classList.remove('hidden');
});

$('#deleteCancel').addEventListener('click', () => {
  $('#deleteConfirm').classList.add('hidden');
});

$('#deleteConfirmBtn').addEventListener('click', async () => {
  const btn = $('#deleteConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    const res = await fetch('/api/account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      localStorage.removeItem('nesppay_token');
      window.location.href = '/';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Yes, delete my account';
  } catch {
    btn.disabled = false;
    btn.textContent = 'Yes, delete my account';
  }
});
