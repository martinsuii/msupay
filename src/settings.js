import { getDb } from './db.js';
import { decryptKey, encryptKey } from './security.js';

const SMTP_SETTING = 'smtp';

const SMTP_DEFAULTS = {
  enabled: false,
  host: '',
  port: 587,
  secure: false,
  requireTls: true,
  user: '',
  passwordEnc: null,
  fromName: 'MSU Pay',
  fromEmail: '',
};

export function getSetting(key) {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

export function setSetting(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(String(key), String(value), new Date().toISOString());
}

function readSmtpConfig() {
  const raw = getSetting(SMTP_SETTING);
  let saved = {};
  if (raw) {
    try {
      saved = JSON.parse(raw);
    } catch {
      saved = {};
    }
  }
  return { ...SMTP_DEFAULTS, ...saved };
}

// Never expose the stored password or its encrypted form to the browser.
export function getSmtpConfigPublic() {
  const { passwordEnc, ...safe } = readSmtpConfig();
  return { ...safe, hasPassword: Boolean(passwordEnc) };
}

export function getSmtpConfig() {
  const stored = readSmtpConfig();
  return {
    ...stored,
    password: stored.passwordEnc ? decryptKey(stored.passwordEnc) : '',
  };
}

function asBoolean(value, fallback) {
  if (value === undefined) return fallback;
  return value === true || value === 'true' || value === '1' || value === 1;
}

export function saveSmtpConfig(input = {}) {
  const current = readSmtpConfig();
  const next = { ...current };

  if (input.enabled !== undefined) next.enabled = asBoolean(input.enabled, current.enabled);
  if (input.host !== undefined) next.host = String(input.host || '').trim();
  if (input.port !== undefined) next.port = Number(input.port);
  if (input.secure !== undefined) next.secure = asBoolean(input.secure, current.secure);
  if (input.requireTls !== undefined) next.requireTls = asBoolean(input.requireTls, current.requireTls);
  if (input.user !== undefined) next.user = String(input.user || '').trim();
  if (input.fromName !== undefined) next.fromName = String(input.fromName || '').trim().slice(0, 100);
  if (input.fromEmail !== undefined) next.fromEmail = String(input.fromEmail || '').trim();

  if (input.clearPassword) {
    next.passwordEnc = null;
  } else if (typeof input.password === 'string' && input.password.length > 0) {
    next.passwordEnc = encryptKey(input.password);
  }

  if (!Number.isInteger(next.port) || next.port < 1 || next.port > 65535) {
    throw new Error('SMTP port must be a number between 1 and 65535');
  }
  if (next.enabled) {
    if (!next.host) throw new Error('SMTP host is required');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.fromEmail)) {
      throw new Error('A valid noreply From address is required');
    }
  }
  if (next.fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.fromEmail)) {
    throw new Error('From address must be a valid email');
  }

  setSetting(SMTP_SETTING, JSON.stringify(next));
  return getSmtpConfigPublic();
}
