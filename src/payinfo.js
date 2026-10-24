import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SECRET_FILE = join(DATA_DIR, 'payinfo-secret');

// Stable signing secret: env override, else a persisted file (so previously
// issued links keep working across restarts).
function getSecret() {
  if (process.env.PAYINFO_SECRET) return process.env.PAYINFO_SECRET;
  if (existsSync(SECRET_FILE)) return readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

// Canonical form: keys sorted, so signing is independent of field order.
function canonicalize(obj) {
  const out = {};
  Object.keys(obj)
    .sort()
    .forEach((k) => {
      out[k] = obj[k];
    });
  return out;
}

function hmac(obj) {
  return createHmac('sha256', getSecret())
    .update(JSON.stringify(canonicalize(obj)))
    .digest('hex');
}

export function signPayinfo(fields) {
  const payload = canonicalize(fields);
  return { ...payload, sig: hmac(payload) };
}

export function verifyPayinfo(obj) {
  if (!obj || typeof obj.sig !== 'string' || obj.sig.length !== 64) return false;
  const { sig, ...rest } = obj;
  const expected = hmac(rest);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encodeB64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeB64url(str) {
  const b64 = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}
