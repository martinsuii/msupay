import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const MASTER_KEY_FILE = join(DATA_DIR, 'master.key');

let cachedMasterKey = null;

export function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;

  if (process.env.MASTER_ENCRYPTION_KEY) {
    const raw = process.env.MASTER_ENCRYPTION_KEY.trim();
    if (raw.length === 64) {
      cachedMasterKey = Buffer.from(raw, 'hex');
    } else {
      cachedMasterKey = Buffer.from(raw.padEnd(32, '0').slice(0, 32), 'utf8');
    }
    return cachedMasterKey;
  }

  if (existsSync(MASTER_KEY_FILE)) {
    const hex = readFileSync(MASTER_KEY_FILE, 'utf8').trim();
    cachedMasterKey = Buffer.from(hex, 'hex');
    return cachedMasterKey;
  }

  mkdirSync(DATA_DIR, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_FILE, key.toString('hex'), { mode: 0o600 });
  cachedMasterKey = key;
  return cachedMasterKey;
}

/**
 * Encrypts a private key using AES-256-GCM.
 * Output format: <iv_hex>:<tag_hex>:<ciphertext_hex>
 */
export function encryptKey(plaintext) {
  if (!plaintext) return null;
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  
  let encrypted = cipher.update(String(plaintext), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypts a private key encrypted with AES-256-GCM.
 * If the input is not encrypted (e.g. unencrypted legacy string), returns as-is.
 */
export function decryptKey(encryptedStr) {
  if (!encryptedStr) return null;
  if (typeof encryptedStr !== 'string') return encryptedStr;

  const parts = encryptedStr.split(':');
  if (parts.length !== 3) {
    throw new Error('Failed to decrypt private key: invalid encrypted value format');
  }

  const [ivHex, tagHex, cipherHex] = parts;
  if (ivHex.length !== 24 || tagHex.length !== 32 || !/^[0-9a-f]+$/i.test(cipherHex)) {
    // Invalid IV/tag lengths for AES-256-GCM (12-byte IV, 16-byte tag)
    throw new Error('Failed to decrypt private key: invalid encrypted value format');
  }

  try {
    const key = getMasterKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    // If decryption fails (e.g. key changed), throw informative error
    throw new Error(`Failed to decrypt private key: ${err.message}`);
  }
}

export function generateWebhookSecret() {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

const SIGN_KEY_FILE = join(DATA_DIR, 'sign.key');

// Shared key used by trusted first-party callers (the cafe server) to request
// signed payinfo. Persisted so restarts don't invalidate the integration.
export function getSigningApiKey() {
  if (process.env.SIGN_API_KEY) return process.env.SIGN_API_KEY;
  if (existsSync(SIGN_KEY_FILE)) return readFileSync(SIGN_KEY_FILE, 'utf8').trim();
  mkdirSync(DATA_DIR, { recursive: true });
  const key = randomBytes(32).toString('hex');
  writeFileSync(SIGN_KEY_FILE, key, { mode: 0o600 });
  return key;
}
