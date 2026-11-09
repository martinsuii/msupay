import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ADMIN_KEY_FILE = join(DATA_DIR, 'admin.key');
const ADMIN_COOKIE = 'msupay_admin';

let cachedKey = null;
let keySource = null;

function sessionTtlMs() {
  const hours = Number(process.env.ADMIN_SESSION_HOURS || 12);
  const safeHours = Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 12;
  return safeHours * 3600_000;
}

// A long random key is generated once at data/admin.key. Operators may instead
// provide ADMIN_SECRET_KEY, but it must still be long enough to be safe.
export function getAdminKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = (process.env.ADMIN_SECRET_KEY || '').trim();
  if (fromEnv) {
    if (fromEnv.length < 32) {
      throw new Error('ADMIN_SECRET_KEY must be at least 32 characters long');
    }
    keySource = 'env';
    cachedKey = fromEnv;
    return cachedKey;
  }

  if (existsSync(ADMIN_KEY_FILE)) {
    const stored = readFileSync(ADMIN_KEY_FILE, 'utf8').trim();
    if (stored.length >= 32) {
      keySource = 'file';
      cachedKey = stored;
      return cachedKey;
    }
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const generated = randomBytes(48).toString('base64url');
  writeFileSync(ADMIN_KEY_FILE, generated, { mode: 0o600 });
  console.log(`[admin] generated a new admin key at ${ADMIN_KEY_FILE}`);
  keySource = 'file';
  cachedKey = generated;
  return cachedKey;
}

export function adminKeySource() {
  return keySource || (process.env.ADMIN_SECRET_KEY ? 'env' : 'file');
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest();
}

export function verifyAdminKey(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  // Hash first so timingSafeEqual always compares equal-length buffers.
  return timingSafeEqual(sha256(candidate), sha256(getAdminKey()));
}

function signPayload(payload) {
  return createHmac('sha256', getAdminKey()).update(payload).digest('base64url');
}

function createSessionToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ iat: now, exp: now + sessionTtlMs() })).toString('base64url');
  return `${payload}.${signPayload(payload)}`;
}

function verifySessionToken(token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = signPayload(payload);
  if (provided.length !== expected.length) return false;
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > Date.now();
  } catch {
    return false;
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return proto === 'https';
}

function serializeCookie(req, value, maxAgeSeconds) {
  const parts = [
    `${ADMIN_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

export function hasAdminSession(req) {
  const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
  return verifySessionToken(token);
}

export function startAdminSession(req, res) {
  const maxAgeSeconds = Math.floor(sessionTtlMs() / 1000);
  res.setHeader('Set-Cookie', serializeCookie(req, createSessionToken(), maxAgeSeconds));
}

export function endAdminSession(req, res) {
  res.setHeader('Set-Cookie', serializeCookie(req, '', 0));
}

export function requireAdmin(req, res, next) {
  if (!hasAdminSession(req)) return res.status(401).json({ error: 'admin authentication required' });
  next();
}
