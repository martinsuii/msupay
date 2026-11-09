import { getDb } from './db.js';
import { encryptKey, decryptKey } from './security.js';
import { config } from './config.js';

function rowToInvoice(row) {
  if (!row) return null;
  return {
    id: row.id,
    coin: row.coin,
    address: row.address,
    privateKey: decryptKey(row.private_key_enc),
    expectedAmountWei: row.expected_amount_wei,
    companyCode: row.company_code,
    status: row.status,
    sender: row.sender,
    paidAmountWei: row.paid_amount_wei,
    paidTxHash: row.paid_tx_hash,
    confirmedAt: row.confirmed_at,
    forwardedTxHash: row.forwarded_tx_hash,
    refundedTxHash: row.refunded_tx_hash,
    settledAmountWei: row.settled_amount_wei,
    error: row.error,
    accessToken: row.access_token,
    expiresAt: row.expires_at,
    notifyStatus: row.notify_status || null,
    notifySentAt: row.notify_sent_at || null,
    notifyError: row.notify_error || null,
    createdAt: row.created_at,
  };
}

export function createInvoice(invoice) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO invoices (
      id, coin, address, private_key_enc, expected_amount_wei, company_code,
      status, sender, paid_amount_wei, paid_tx_hash, confirmed_at,
      forwarded_tx_hash, refunded_tx_hash, settled_amount_wei, error,
      access_token, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    invoice.id,
    invoice.coin || 'ETH',
    invoice.address,
    encryptKey(invoice.privateKey),
    invoice.expectedAmountWei || '0',
    invoice.companyCode || null,
    invoice.status || 'pending',
    invoice.sender || null,
    invoice.paidAmountWei || null,
    invoice.paidTxHash || null,
    invoice.confirmedAt || null,
    invoice.forwardedTxHash || null,
    invoice.refundedTxHash || null,
    invoice.settledAmountWei || null,
    invoice.error || null,
    invoice.accessToken || null,
    invoice.expiresAt || null,
    invoice.createdAt || new Date().toISOString()
  );

  return invoice;
}

export function getInvoice(id) {
  if (!id) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  return rowToInvoice(row);
}

export function updateInvoice(id, patch) {
  const db = getDb();
  const current = getInvoice(id);
  if (!current) return null;

  const updated = { ...current, ...patch };

  const stmt = db.prepare(`
    UPDATE invoices SET
      coin = ?,
      address = ?,
      private_key_enc = ?,
      expected_amount_wei = ?,
      company_code = ?,
      status = ?,
      sender = ?,
      paid_amount_wei = ?,
      paid_tx_hash = ?,
      confirmed_at = ?,
      forwarded_tx_hash = ?,
      refunded_tx_hash = ?,
      settled_amount_wei = ?,
      error = ?,
      access_token = ?,
      expires_at = ?,
      notify_status = ?,
      notify_sent_at = ?,
      notify_error = ?
    WHERE id = ?
  `);

  stmt.run(
    updated.coin || 'ETH',
    updated.address,
    encryptKey(updated.privateKey),
    updated.expectedAmountWei || '0',
    updated.companyCode || null,
    updated.status || 'pending',
    updated.sender || null,
    updated.paidAmountWei || null,
    updated.paidTxHash || null,
    updated.confirmedAt || null,
    updated.forwardedTxHash || null,
    updated.refundedTxHash || null,
    updated.settledAmountWei || null,
    updated.error || null,
    updated.accessToken || null,
    updated.expiresAt || null,
    updated.notifyStatus || null,
    updated.notifySentAt || null,
    updated.notifyError || null,
    id
  );

  return getInvoice(id);
}

// Record the outcome of the merchant payment email without touching the rest
// of the invoice row (and without generating a new invoice version).
export function updateInvoiceNotification(id, { status = null, sentAt = null, error = null } = {}) {
  if (!id) return false;
  const db = getDb();
  const result = db.prepare(`
    UPDATE invoices
    SET notify_status = ?, notify_sent_at = COALESCE(?, notify_sent_at), notify_error = ?
    WHERE id = ?
  `).run(status, sentAt, error, id);
  return (result.changes ?? 0) > 0;
}

export function listInvoices() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM invoices ORDER BY created_at ASC').all();
  return rows.map(rowToInvoice);
}

export function deleteInvoicesByCompanyCode(companyCode) {
  if (!companyCode) return;
  const db = getDb();
  db.prepare('DELETE FROM invoices WHERE company_code = ?').run(companyCode);
}

export function deleteWebhookDeliveriesByCompanyCode(companyCode) {
  if (!companyCode) return;
  const db = getDb();
  db.prepare('DELETE FROM webhook_deliveries WHERE company_code = ?').run(companyCode);
}

// Any pending invoice whose deadline passed is no longer watched/settled.
export function expireStaleInvoices() {
  const db = getDb();
  const now = Date.now();
  const ttlMs = config.invoiceTtlMinutes * 60000;
  const rows = db.prepare("SELECT id, created_at, expires_at FROM invoices WHERE status = 'pending'").all();
  const stmt = db.prepare("UPDATE invoices SET status = 'expired', error = 'Invoice expired before payment' WHERE id = ?");
  let expired = 0;
  for (const row of rows) {
    const deadline = row.expires_at
      ? Date.parse(row.expires_at)
      : Date.parse(row.created_at) + ttlMs;
    if (!Number.isFinite(deadline) || deadline <= now) {
      stmt.run(row.id);
      expired += 1;
    }
  }
  return expired;
}
