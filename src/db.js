import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptKey, generateWebhookSecret } from './security.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'nesppay.db');

mkdirSync(DATA_DIR, { recursive: true });

let dbInstance = null;

export function getDb() {
  if (dbInstance) return dbInstance;

  dbInstance = new DatabaseSync(DB_PATH);
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA synchronous = NORMAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  initSchema(dbInstance);
  migrateSchema(dbInstance);
  migrateLegacyJson(dbInstance);

  return dbInstance;
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateSchema(db) {
  ensureColumn(db, 'accounts', 'token_expires_at', 'TEXT');
  ensureColumn(db, 'invoices', 'access_token', 'TEXT');
  ensureColumn(db, 'invoices', 'expires_at', 'TEXT');

  // Existing rows predate these columns: give them a usable token and a
  // bounded lifetime instead of leaving them valid forever.
  const tokenExpiry = new Date(Date.now() + config.tokenTtlDays * 86400000).toISOString();

  db.prepare('UPDATE accounts SET token_expires_at = ? WHERE token IS NOT NULL AND token_expires_at IS NULL')
    .run(tokenExpiry);

  const missingTokens = db.prepare('SELECT id FROM invoices WHERE access_token IS NULL').all();
  if (missingTokens.length > 0) {
    const stmt = db.prepare('UPDATE invoices SET access_token = ? WHERE id = ?');
    for (const { id } of missingTokens) stmt.run(randomBytes(32).toString('hex'), id);
  }

  // Derive expiry from the invoice's own creation time so old rows do not get
  // a fresh window just because the column was added later.
  const missingExpiry = db.prepare('SELECT id, created_at FROM invoices WHERE expires_at IS NULL').all();
  if (missingExpiry.length > 0) {
    const stmt = db.prepare('UPDATE invoices SET expires_at = ? WHERE id = ?');
    for (const { id, created_at } of missingExpiry) {
      const created = Date.parse(created_at);
      const base = Number.isFinite(created) ? created : Date.now();
      stmt.run(new Date(base + config.invoiceTtlMinutes * 60000).toISOString(), id);
    }
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      company_code TEXT UNIQUE NOT NULL,
      company_name TEXT,
      company_description TEXT,
      wallet_address TEXT,
      wallet_private_key_enc TEXT,
      btc_address TEXT,
      btc_wif_enc TEXT,
      ltc_address TEXT,
      ltc_wif_enc TEXT,
      webhook_url TEXT,
      webhook_secret TEXT,
      token TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);
    CREATE INDEX IF NOT EXISTS idx_accounts_token ON accounts(token);
    CREATE INDEX IF NOT EXISTS idx_accounts_company_code ON accounts(company_code);

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      coin TEXT NOT NULL DEFAULT 'ETH',
      address TEXT NOT NULL,
      private_key_enc TEXT NOT NULL,
      expected_amount_wei TEXT NOT NULL DEFAULT '0',
      company_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sender TEXT,
      paid_amount_wei TEXT,
      paid_tx_hash TEXT,
      confirmed_at TEXT,
      forwarded_tx_hash TEXT,
      refunded_tx_hash TEXT,
      settled_amount_wei TEXT,
      error TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
    CREATE INDEX IF NOT EXISTS idx_invoices_company_code ON invoices(company_code);
    CREATE INDEX IF NOT EXISTS idx_invoices_address ON invoices(address);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      company_code TEXT NOT NULL,
      invoice_id TEXT,
      event TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER,
      attempts INTEGER NOT NULL DEFAULT 1,
      success INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      payload TEXT NOT NULL,
      response_body TEXT,
      created_at TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_company ON webhook_deliveries(company_code);
    CREATE INDEX IF NOT EXISTS idx_webhook_created ON webhook_deliveries(created_at);
  `);
}

function migrateLegacyJson(db) {
  const accountsJson = join(DATA_DIR, 'accounts.json');
  if (existsSync(accountsJson)) {
    try {
      const data = JSON.parse(readFileSync(accountsJson, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO accounts (
            id, email, password_hash, company_code, company_name, company_description,
            wallet_address, wallet_private_key_enc, btc_address, btc_wif_enc,
            ltc_address, ltc_wif_enc, webhook_url, webhook_secret, token, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const a of data) {
          stmt.run(
            a.id,
            a.email,
            a.passwordHash,
            a.companyCode,
            a.companyName || '',
            a.companyDescription || '',
            a.walletAddress || null,
            encryptKey(a.walletPrivateKey),
            a.btcAddress || null,
            encryptKey(a.btcWif),
            a.ltcAddress || null,
            encryptKey(a.ltcWif),
            a.webhookUrl || null,
            a.webhookSecret || generateWebhookSecret(),
            a.token || null,
            a.createdAt || new Date().toISOString()
          );
        }
        console.log(`[db] Migrated ${data.length} accounts from JSON to SQLite.`);
      }
      renameSync(accountsJson, `${accountsJson}.migrated`);
    } catch (e) {
      console.error('[db] Error migrating accounts.json:', e.message);
    }
  }

  const invoicesJson = join(DATA_DIR, 'invoices.json');
  if (existsSync(invoicesJson)) {
    try {
      const data = JSON.parse(readFileSync(invoicesJson, 'utf8'));
      if (Array.isArray(data) && data.length > 0) {
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO invoices (
            id, coin, address, private_key_enc, expected_amount_wei, company_code,
            status, sender, paid_amount_wei, paid_tx_hash, confirmed_at,
            forwarded_tx_hash, refunded_tx_hash, settled_amount_wei, error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const i of data) {
          stmt.run(
            i.id,
            i.coin || 'ETH',
            i.address,
            encryptKey(i.privateKey),
            i.expectedAmountWei || '0',
            i.companyCode || null,
            i.status || 'pending',
            i.sender || null,
            i.paidAmountWei || null,
            i.paidTxHash || null,
            i.confirmedAt || null,
            i.forwardedTxHash || null,
            i.refundedTxHash || null,
            i.settledAmountWei || null,
            i.error || null,
            i.createdAt || new Date().toISOString()
          );
        }
        console.log(`[db] Migrated ${data.length} invoices from JSON to SQLite.`);
      }
      renameSync(invoicesJson, `${invoicesJson}.migrated`);
    } catch (e) {
      console.error('[db] Error migrating invoices.json:', e.message);
    }
  }
}
