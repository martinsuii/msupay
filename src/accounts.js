import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateCoinKey } from './coins.js';
import { getDb } from './db.js';
import { encryptKey, decryptKey, generateWebhookSecret } from './security.js';
import { config } from './config.js';

function tokenExpiry() {
  return new Date(Date.now() + config.tokenTtlDays * 86400000).toISOString();
}

function rowToAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    companyCode: row.company_code,
    companyName: row.company_name || '',
    companyDescription: row.company_description || '',
    walletAddress: row.wallet_address,
    walletPrivateKey: decryptKey(row.wallet_private_key_enc),
    btcAddress: row.btc_address,
    btcWif: decryptKey(row.btc_wif_enc),
    ltcAddress: row.ltc_address,
    ltcWif: decryptKey(row.ltc_wif_enc),
    webhookUrl: row.webhook_url || null,
    webhookSecret: row.webhook_secret || null,
    token: row.token,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
  };
}

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

// Stable, unique 8-char company code (no ambiguous characters).
function generateCode() {
  const db = getDb();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  while (true) {
    code = Array.from({ length: 8 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const existing = db.prepare('SELECT id FROM accounts WHERE company_code = ?').get(code);
    if (!existing) break;
  }
  return code;
}

export function findByEmail(email) {
  if (!email) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM accounts WHERE email = ?').get(String(email).toLowerCase().trim());
  return rowToAccount(row);
}

export function findByToken(token) {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM accounts WHERE token = ?').get(token);
  if (!row) return null;
  if (row.token_expires_at && Date.parse(row.token_expires_at) <= Date.now()) return null;
  return rowToAccount(row);
}

export function findByCode(code) {
  if (!code) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM accounts WHERE company_code = ?').get(String(code).toUpperCase().trim());
  return rowToAccount(row);
}

export function findById(id) {
  if (!id) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
  return rowToAccount(row);
}

export function createAccount({ email, password }) {
  const db = getDb();
  const eth = generateCoinKey('ETH');
  const btc = generateCoinKey('BTC');
  const ltc = generateCoinKey('LTC');

  const id = randomUUID();
  const cleanEmail = String(email).toLowerCase().trim();
  const passwordHash = hashPassword(password);
  const companyCode = generateCode();
  const token = randomUUID();
  const webhookSecret = generateWebhookSecret();
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO accounts (
      id, email, password_hash, company_code, company_name, company_description,
      wallet_address, wallet_private_key_enc, btc_address, btc_wif_enc,
      ltc_address, ltc_wif_enc, webhook_url, webhook_secret, token,
      token_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    cleanEmail,
    passwordHash,
    companyCode,
    '',
    '',
    eth.address,
    encryptKey(eth.privateKey),
    btc.address,
    encryptKey(btc.privateKey),
    ltc.address,
    encryptKey(ltc.privateKey),
    null,
    webhookSecret,
    token,
    tokenExpiry(),
    createdAt
  );

  return findById(id);
}

export function updateAccount(id, patch) {
  const current = findById(id);
  if (!current) return null;

  const db = getDb();
  const updated = { ...current, ...patch };

  const stmt = db.prepare(`
    UPDATE accounts SET
      email = ?,
      password_hash = ?,
      company_code = ?,
      company_name = ?,
      company_description = ?,
      wallet_address = ?,
      wallet_private_key_enc = ?,
      btc_address = ?,
      btc_wif_enc = ?,
      ltc_address = ?,
      ltc_wif_enc = ?,
      webhook_url = ?,
      webhook_secret = ?,
      token = ?,
      token_expires_at = ?
    WHERE id = ?
  `);

  stmt.run(
    updated.email,
    updated.passwordHash,
    updated.companyCode,
    updated.companyName || '',
    updated.companyDescription || '',
    updated.walletAddress || null,
    encryptKey(updated.walletPrivateKey),
    updated.btcAddress || null,
    encryptKey(updated.btcWif),
    updated.ltcAddress || null,
    encryptKey(updated.ltcWif),
    updated.webhookUrl || null,
    updated.webhookSecret || null,
    updated.token || null,
    updated.tokenExpiresAt || null,
    id
  );

  return findById(id);
}

export function publicAccount(a) {
  if (!a) return null;
  const { passwordHash, token, walletPrivateKey, btcWif, ltcWif, ...safe } = a;
  return safe;
}

export function deleteAccount(id) {
  if (!id) return false;
  const db = getDb();
  const result = db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  return (result.changes ?? 0) > 0;
}

// Opt-in demo merchant. Credentials must come from the environment; there are
// no built-in defaults, so a fresh checkout never ships a known account.
export function ensureSeedAccount() {
  if (process.env.SEED_DEMO_ACCOUNT !== '1') return null;

  const email = (process.env.SEED_DEMO_EMAIL || '').toLowerCase().trim();
  const password = process.env.SEED_DEMO_PASSWORD || '';
  if (!email || password.length < 12) {
    console.warn('[seed] SEED_DEMO_ACCOUNT=1 requires SEED_DEMO_EMAIL and a SEED_DEMO_PASSWORD of at least 12 characters; skipping.');
    return null;
  }

  const db = getDb();
  const existing = findByCode('NESPCFE');
  if (existing) {
    let patch = {};
    if (existing.email !== email) patch.email = email;
    if (!verifyPassword(password, existing.passwordHash)) patch.passwordHash = hashPassword(password);
    if (!existing.webhookSecret) patch.webhookSecret = generateWebhookSecret();
    for (const [addrKey, wifKey, coin] of [
      ['walletAddress', 'walletPrivateKey', 'ETH'],
      ['btcAddress', 'btcWif', 'BTC'],
      ['ltcAddress', 'ltcWif', 'LTC'],
    ]) {
      if (!existing[addrKey] || !existing[wifKey]) {
        const k = generateCoinKey(coin);
        patch[addrKey] = k.address;
        patch[wifKey] = k.privateKey;
      }
    }
    return Object.keys(patch).length > 0 ? updateAccount(existing.id, patch) : existing;
  }

  const eth = generateCoinKey('ETH');
  const btc = generateCoinKey('BTC');
  const ltc = generateCoinKey('LTC');
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO accounts (
      id, email, password_hash, company_code, company_name, company_description,
      wallet_address, wallet_private_key_enc, btc_address, btc_wif_enc,
      ltc_address, ltc_wif_enc, webhook_url, webhook_secret, token,
      token_expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    email,
    hashPassword(password),
    'NESPCFE',
    'Nesp Café',
    'A single perfect cookie and a proper black coffee.',
    eth.address,
    encryptKey(eth.privateKey),
    btc.address,
    encryptKey(btc.privateKey),
    ltc.address,
    encryptKey(ltc.privateKey),
    null,
    generateWebhookSecret(),
    null,
    null,
    createdAt
  );

  return findById(id);
}

// Accounts created by older releases used a password that is public in the
// source. Rotate it once so a deployed instance is not left with a known login.
export function rotateKnownDefaultPassword() {
  const account = findByCode('NESPCFE');
  if (!account || !account.passwordHash) return false;
  if (!verifyPassword('45159rrt', account.passwordHash)) return false;
  updateAccount(account.id, {
    passwordHash: hashPassword(randomBytes(32).toString('hex')),
    token: null,
    tokenExpiresAt: null,
  });
  console.warn('[security] NESPCFE used the old built-in demo password; it has been rotated. Set a new password by re-registering or reset via the dashboard.');
  return true;
}
