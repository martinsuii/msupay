import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { getDb } from './db.js';
import { findByCode } from './accounts.js';
import { config } from './config.js';

const RETRY_DELAYS = [2000, 10000, 30000, 120000]; // 2s, 10s, 30s, 2m

function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('::ffff:')
  );
}

function isPrivateAddress(ip) {
  if (isIP(ip) === 4) return isPrivateIpv4(ip);
  if (isIP(ip) === 6) return isPrivateIpv6(ip);
  return true;
}

// Rejects URLs that would make the server talk to itself, private networks,
// or cloud metadata endpoints (SSRF).
export async function validateWebhookUrl(rawUrl) {
  if (!rawUrl) return null;
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new Error('webhook URL is not valid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('webhook URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('webhook URL must not contain credentials');
  }
  if (config.allowPrivateWebhooks || process.env.ALLOW_PRIVATE_WEBHOOKS === '1') return url.toString();

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('webhook URL must point to a public host');
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('webhook URL must point to a public host');
    return url.toString();
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('webhook host could not be resolved');
  }
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('webhook URL must point to a public host');
  }
  return url.toString();
}

export function signWebhookPayload(payloadStr, secret) {
  if (!secret) return '';
  return createHmac('sha256', secret).update(payloadStr).digest('hex');
}

export function publicInvoice(inv) {
  if (!inv) return null;
  const { privateKey, private_key_enc, accessToken, ...safe } = inv;
  return safe;
}

function rowToDelivery(r) {
  return {
    id: r.id,
    companyCode: r.company_code,
    invoiceId: r.invoice_id,
    event: r.event,
    url: r.url,
    statusCode: r.status_code,
    attempts: r.attempts,
    success: Boolean(r.success),
    error: r.error,
    payload: JSON.parse(r.payload || '{}'),
    responseBody: r.response_body,
    createdAt: r.created_at,
    lastAttemptAt: r.last_attempt_at,
  };
}

export function getWebhookDeliveries(companyCode, limit = 50) {
  if (!companyCode) return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE company_code = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(companyCode, limit);

  return rows.map(rowToDelivery);
}

// Admin view across every merchant.
export function listAllWebhookDeliveries(limit = 500) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM webhook_deliveries
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  return rows.map(rowToDelivery);
}

export function countWebhookDeliveries() {
  const db = getDb();
  return db.prepare('SELECT COUNT(*) AS count FROM webhook_deliveries').get().count;
}

async function executeDelivery({ deliveryId, url, secret, event, payloadStr, attempt = 1, companyCode, invoiceId }) {
  const db = getDb();
  const signature = signWebhookPayload(payloadStr, secret);
  const now = new Date().toISOString();

  let statusCode = null;
  let responseBody = null;
  let errorMsg = null;
  let success = false;

  try {
    await validateWebhookUrl(url);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-MSUPay-Signature': `sha256=${signature}`,
        'X-MSUPay-Event': event,
        'X-MSUPay-Delivery-ID': deliveryId,
        'User-Agent': 'MSUPay-Webhook/1.0',
      },
      body: payloadStr,
      redirect: 'manual',
      signal: AbortSignal.timeout(6000),
    });

    statusCode = res.status;
    const text = await res.text().catch(() => '');
    responseBody = text.slice(0, 500); // store snippet
    if (res.ok) {
      success = true;
    } else {
      errorMsg = `HTTP ${statusCode}: ${responseBody.slice(0, 100)}`;
    }
  } catch (err) {
    errorMsg = err.message || 'Connection failed';
  }

  try {
    const updateStmt = db.prepare(`
      UPDATE webhook_deliveries SET
        status_code = ?,
        attempts = ?,
        success = ?,
        error = ?,
        response_body = ?,
        last_attempt_at = ?
      WHERE id = ?
    `);

    updateStmt.run(
      statusCode,
      attempt,
      success ? 1 : 0,
      errorMsg,
      responseBody,
      now,
      deliveryId
    );
  } catch (e) {
    console.error('[webhook] Failed to update delivery record:', e.message);
  }

  if (!success && attempt < RETRY_DELAYS.length + 1) {
    const delay = RETRY_DELAYS[attempt - 1];
    console.log(`[webhook ${deliveryId}] Delivery failed (${errorMsg}), retrying in ${delay / 1000}s (attempt ${attempt + 1})...`);
    setTimeout(() => {
      executeDelivery({
        deliveryId,
        url,
        secret,
        event,
        payloadStr,
        attempt: attempt + 1,
        companyCode,
        invoiceId,
      }).catch((e) => console.error('[webhook retry error]', e));
    }, delay);
  }

  return { success, statusCode, error: errorMsg, responseBody };
}

export function dispatchInvoiceEvent(event, invoice) {
  if (!invoice || !invoice.companyCode) return;

  const account = findByCode(invoice.companyCode);
  if (!account || !account.webhookUrl) return;

  const deliveryId = randomUUID();
  const eventName = `invoice.${event}`;
  const now = new Date().toISOString();

  const payload = {
    id: `evt_${randomUUID()}`,
    event: eventName,
    createdAt: now,
    companyCode: invoice.companyCode,
    data: {
      invoice: publicInvoice(invoice),
    },
  };

  const payloadStr = JSON.stringify(payload);
  const db = getDb();

  try {
    const insertStmt = db.prepare(`
      INSERT INTO webhook_deliveries (
        id, company_code, invoice_id, event, url, status_code,
        attempts, success, error, payload, response_body,
        created_at, last_attempt_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      deliveryId,
      invoice.companyCode,
      invoice.id,
      eventName,
      account.webhookUrl,
      null,
      1,
      0,
      null,
      payloadStr,
      null,
      now,
      now
    );
  } catch (e) {
    console.error('[webhook] Failed to create delivery record:', e.message);
    return;
  }

  executeDelivery({
    deliveryId,
    url: account.webhookUrl,
    secret: account.webhookSecret,
    event: eventName,
    payloadStr,
    attempt: 1,
    companyCode: invoice.companyCode,
    invoiceId: invoice.id,
  }).catch((e) => console.error('[webhook execution error]', e));
}

export async function sendTestWebhook(companyCode) {
  if (!companyCode) throw new Error('Company code is required');
  const account = findByCode(companyCode);
  if (!account) throw new Error('Merchant account not found');
  if (!account.webhookUrl) throw new Error('No webhook URL configured for this merchant');

  const deliveryId = randomUUID();
  const eventName = 'ping';
  const now = new Date().toISOString();

  const payload = {
    id: `evt_${randomUUID()}`,
    event: eventName,
    createdAt: now,
    companyCode: account.companyCode,
    data: {
      message: 'This is a test webhook from MSU Pay.',
      merchant: {
        companyCode: account.companyCode,
        companyName: account.companyName,
      },
    },
  };

  const payloadStr = JSON.stringify(payload);
  const db = getDb();

  const insertStmt = db.prepare(`
    INSERT INTO webhook_deliveries (
      id, company_code, invoice_id, event, url, status_code,
      attempts, success, error, payload, response_body,
      created_at, last_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    deliveryId,
    account.companyCode,
    null,
    eventName,
    account.webhookUrl,
    null,
    1,
    0,
    null,
    payloadStr,
    null,
    now,
    now
  );

  return executeDelivery({
    deliveryId,
    url: account.webhookUrl,
    secret: account.webhookSecret,
    event: eventName,
    payloadStr,
    attempt: 1,
    companyCode: account.companyCode,
    invoiceId: null,
  });
}
