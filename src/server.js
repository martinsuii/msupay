import express from 'express';
import { formatEther } from 'ethers';
import QRCode from 'qrcode';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { mainAddress, createProvider, processExistingInvoice, payInvoice, cancelInvoice } from './processor.js';
import { newInvoice } from './wallet.js';
import {
  getInvoice,
  listInvoices,
  deleteInvoicesByCompanyCode,
  deleteWebhookDeliveriesByCompanyCode,
  expireStaleInvoices,
} from './store.js';
import { buildReceipt } from './receipt.js';
import { sweepTo } from './forward.js';
import { signPayinfo, verifyPayinfo, encodeB64url, decodeB64url } from './payinfo.js';
import { COINS, toUnits, fromUnits, qrUri } from './coins.js';
import { getEurRates } from './rates.js';
import { getDb } from './db.js';
import { handleInvoiceSSE } from './events.js';
import { getWebhookDeliveries, sendTestWebhook, validateWebhookUrl } from './webhooks.js';
import { rateLimit } from './ratelimit.js';
import { minifiedStatic } from './minified-static.js';
import { generateWebhookSecret, getSigningApiKey } from './security.js';
import {
  createAccount,
  findByEmail,
  findByToken,
  findByCode,
  verifyPassword,
  updateAccount,
  deleteAccount,
  publicAccount,
  ensureSeedAccount,
  rotateKnownDefaultPassword,
} from './accounts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
}
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Log every request: method, path, status, duration.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(minifiedStatic(PUBLIC_DIR));
app.use(express.static(PUBLIC_DIR));

// The payment page lives at /pay (payinfo comes from the query string).
app.get('/pay', (req, res) => {
  if (!req.query.payinfo) {
    return res.redirect('/');
  }
  res.sendFile(join(PUBLIC_DIR, 'pay.html'));
});

// Documentation page.
app.get('/docs', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'docs.html'));
});

// Pay link tester page.
app.get('/paytester', (req, res) => {
  res.sendFile(join(PUBLIC_DIR, 'paytester.html'));
});

// Legal pages.
app.get('/terms', (req, res) => res.sendFile(join(PUBLIC_DIR, 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(join(PUBLIC_DIR, 'privacy.html')));

// Account pages.
app.get('/register', (req, res) => res.sendFile(join(PUBLIC_DIR, 'register.html')));
app.get('/login', (req, res) => res.sendFile(join(PUBLIC_DIR, 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(join(PUBLIC_DIR, 'dashboard.html')));

const authLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'auth' });
const signLimiter = rateLimit({ windowMs: 60_000, max: 30, name: 'sign' });
const invoiceLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'invoice' });
const actionLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'action' });

function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function requireAuth(req, res, next) {
  const account = findByToken(bearerToken(req));
  if (!account) return res.status(401).json({ error: 'unauthorized' });
  req.account = account;
  next();
}

function internalError(res, error, context) {
  console.error(`[${context}]`, error);
  return res.status(500).json({ error: 'internal error' });
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// A payer holds the per-invoice capability token returned when the invoice was
// created; a merchant may act on invoices belonging to their company.
function invoiceAuthorized(req, invoice) {
  const account = findByToken(bearerToken(req));
  if (account && invoice.companyCode && account.companyCode === invoice.companyCode) return true;
  const provided = req.headers['x-invoice-token'];
  return Boolean(invoice.accessToken) && safeEqual(String(provided || ''), invoice.accessToken);
}

app.post('/api/register', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }
  if (!password || String(password).length < 12) {
    return res.status(400).json({ error: 'password must be at least 12 characters' });
  }
  if (findByEmail(email)) {
    return res.status(409).json({ error: 'email is already registered' });
  }
  const account = createAccount({ email, password });
  res.status(201).json({ token: account.token, account: publicAccount(account) });
});

app.post('/api/login', authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const account = findByEmail(email);
  if (!account || !verifyPassword(password, account.passwordHash)) {
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const token = randomUUID();
  const tokenExpiresAt = new Date(Date.now() + config.tokenTtlDays * 86400000).toISOString();
  updateAccount(account.id, { token, tokenExpiresAt });
  res.json({ token, account: publicAccount({ ...account, token, tokenExpiresAt }) });
});

app.post('/api/logout', requireAuth, (req, res) => {
  updateAccount(req.account.id, { token: null, tokenExpiresAt: null });
  res.json({ ok: true });
});

app.get('/api/account', requireAuth, (req, res) => {
  const account = publicAccount(req.account);
  const earningsWei = listInvoices()
    .filter((i) => i.companyCode === req.account.companyCode && i.status === 'forwarded' && (i.coin === 'ETH' || !i.coin))
    .reduce((sum, i) => sum + BigInt(i.settledAmountWei || i.paidAmountWei || '0'), 0n);
  res.json({ account, earningsWei: earningsWei.toString(), earningsEth: formatEther(earningsWei) });
});

app.put('/api/company', requireAuth, (req, res) => {
  const { companyName, companyDescription } = req.body || {};
  const patch = {};
  if (companyName !== undefined) patch.companyName = String(companyName).slice(0, 80);
  if (companyDescription !== undefined) patch.companyDescription = String(companyDescription).slice(0, 300);
  const updated = updateAccount(req.account.id, patch);
  res.json({ account: publicAccount(updated) });
});

// Public lookup used by the payment page to show a merchant's name from its code.
app.get('/api/company/:code', (req, res) => {
  const account = findByCode(req.params.code);
  if (!account) return res.status(404).json({ error: 'company not found' });
  res.json({ companyCode: account.companyCode, companyName: account.companyName || account.companyCode });
});

// Webhook management routes
app.get('/api/webhook/config', requireAuth, (req, res) => {
  res.json({
    webhookUrl: req.account.webhookUrl,
    webhookSecret: req.account.webhookSecret,
  });
});

app.put('/api/webhook/config', requireAuth, async (req, res) => {
  const { webhookUrl, regenerateSecret } = req.body || {};
  const patch = {};
  if (webhookUrl !== undefined) {
    if (!webhookUrl) {
      patch.webhookUrl = null;
    } else {
      try {
        patch.webhookUrl = await validateWebhookUrl(String(webhookUrl).trim());
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
  }
  if (regenerateSecret) {
    patch.webhookSecret = generateWebhookSecret();
  }
  const updated = updateAccount(req.account.id, patch);
  res.json({
    webhookUrl: updated.webhookUrl,
    webhookSecret: updated.webhookSecret,
  });
});

app.get('/api/webhook/deliveries', requireAuth, (req, res) => {
  const deliveries = getWebhookDeliveries(req.account.companyCode, 50);
  res.json({ deliveries });
});

app.post('/api/webhook/test', requireAuth, actionLimiter, async (req, res) => {
  try {
    const result = await sendTestWebhook(req.account.companyCode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Merchant transaction history.
app.get('/api/transactions', requireAuth, (req, res) => {
  const txs = listInvoices()
    .filter((i) => i.companyCode === req.account.companyCode)
    .map(publicInvoice)
    .reverse();
  res.json({ transactions: txs });
});

// Withdraw the merchant wallet balance to an external address.
app.post('/api/withdraw', requireAuth, actionLimiter, async (req, res) => {
  const { toAddress } = req.body || {};
  if (!toAddress || !/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return res.status(400).json({ error: 'a valid destination address is required' });
  }
  const provider = createProvider();
  try {
    const { hash } = await sweepTo({
      provider,
      privateKey: req.account.walletPrivateKey,
      toAddress,
      gasPriceGwei: config.gasPriceGwei,
      gasLimit: config.forwardGasLimit,
    });
    res.json({ txHash: hash });
  } catch (e) {
    return internalError(res, e, 'withdraw');
  }
});

// Permanently delete the account and all of its invoices.
app.delete('/api/account', requireAuth, (req, res) => {
  deleteInvoicesByCompanyCode(req.account.companyCode);
  deleteWebhookDeliveriesByCompanyCode(req.account.companyCode);
  deleteAccount(req.account.id);
  res.json({ ok: true });
});

// Export the merchant's wallet credentials for import into a wallet app.
app.get('/api/wallet/credentials', requireAuth, (req, res) => {
  const a = req.account;
  res.json({
    ETH: { address: a.walletAddress, privateKey: a.walletPrivateKey },
    BTC: { address: a.btcAddress, privateKey: a.btcWif },
    LTC: { address: a.ltcAddress, privateKey: a.ltcWif },
  });
});

// Never leak private keys or invoice capability tokens through public APIs.
function publicInvoice(inv) {
  if (!inv) return null;
  const { privateKey, accessToken, ...safe } = inv;
  return safe;
}

function fmt(units, coin) {
  return `${fromUnits(units, coin || 'ETH')} ${coin || 'ETH'}`;
}

function logUpdate(stage, inv) {
  switch (stage) {
    case 'created':
      console.log(`[invoice ${inv.id}] (${inv.coin || 'ETH'}) address ${inv.address}`);
      if (inv.expectedAmountWei && inv.expectedAmountWei !== '0') {
        console.log(`[invoice ${inv.id}] expecting ${fmt(inv.expectedAmountWei, inv.coin)}`);
      }
      break;
    case 'detected':
      console.log(`[invoice ${inv.id}] payment received: ${fmt(inv.paidAmountWei, inv.coin)}`);
      break;
    case 'confirming':
      console.log(`[invoice ${inv.id}] confirming (depth ${inv.depth}/${config.confirmations})`);
      break;
    case 'paid':
      console.log(`[invoice ${inv.id}] confirmed — waiting for user choice (sender: ${inv.sender ?? 'unknown'})`);
      break;
    case 'underpaid':
      console.log(`[invoice ${inv.id}] UNDERPAID — received ${fmt(inv.paidAmountWei, inv.coin)}, expected ${fmt(inv.expectedAmountWei, inv.coin)}`);
      break;
    case 'forwarded':
      console.log(`[invoice ${inv.id}] settled (company: ${inv.companyCode ?? 'global'}) tx=${inv.forwardedTxHash}`);
      break;
    case 'forward_failed':
      console.log(`[invoice ${inv.id}] forward failed: ${inv.error}`);
      break;
    case 'refunded':
      console.log(`[invoice ${inv.id}] cancelled -> refunded to ${inv.sender} tx=${inv.refundedTxHash}`);
      break;
    case 'refund_failed':
      console.log(`[invoice ${inv.id}] refund failed: ${inv.error}`);
      break;
    case 'explorer_error':
      console.log(`[invoice ${inv.id}] could not resolve sender: ${inv.error}`);
      break;
    case 'expired':
      console.log(`[invoice ${inv.id}] expired before payment`);
      break;
  }
}

app.get('/api/status', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/invoices', requireAuth, (req, res) => {
  const invoices = listInvoices()
    .filter((i) => i.companyCode === req.account.companyCode)
    .map(publicInvoice);
  res.json(invoices);
});

app.get('/api/invoice/:id', (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  res.json(publicInvoice(inv));
});

// Real-time Server-Sent Events (SSE) stream for invoice updates
app.get('/api/invoice/:id/events', (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  handleInvoiceSSE(req, res, inv.id, publicInvoice(inv));
});

// Sign a payinfo so it can't be tampered with. CORS enabled so the café
// (separate origin) can generate signed links.
app.use('/api/sign', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/api/sign', signLimiter, (req, res) => {
  const { companyCode, product, customerName, customerInfo, eur } = req.body || {};
  if (!companyCode || eur == null || eur === '' || isNaN(Number(eur)) || Number(eur) <= 0) {
    return res.status(400).json({ error: 'companyCode and a valid eur price are required' });
  }
  const code = String(companyCode).toUpperCase().trim();
  const account = findByToken(bearerToken(req));
  const keyOk = safeEqual(String(req.headers['x-sign-key'] || ''), getSigningApiKey());
  const merchantOk = account && account.companyCode === code;
  if (!keyOk && !merchantOk) {
    return res.status(401).json({ error: 'signing requires merchant authentication or a valid sign API key' });
  }
  const merchant = findByCode(code);
  if (!merchant) return res.status(404).json({ error: 'company not found' });

  const fields = { companyCode: code, eur: String(eur) };
  if (product) fields.product = String(product);
  if (customerName) fields.customerName = String(customerName);
  if (customerInfo) fields.customerInfo = String(customerInfo);
  res.json({ payinfo: encodeB64url(signPayinfo(fields)) });
});

// Current EUR rates per coin, used by the payment page to preview amounts.
app.get('/api/rates', async (req, res) => {
  try {
    res.json(await getEurRates());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/invoice', invoiceLimiter, async (req, res) => {
  let info;
  try {
    info = decodeB64url(req.body?.payinfo);
  } catch {
    return res.status(400).json({ error: 'invalid payinfo' });
  }
  if (!verifyPayinfo(info)) {
    return res.status(400).json({ error: 'payinfo signature is invalid' });
  }
  const coin = (req.body?.coin || 'ETH').toUpperCase();
  if (!COINS[coin]) {
    return res.status(400).json({ error: 'unsupported coin' });
  }
  const eur = Number(info.eur);
  if (!eur || eur <= 0) {
    return res.status(400).json({ error: 'invalid amount' });
  }

  // Convert the signed EUR price to the payer's chosen coin, server-side.
  let rates;
  try {
    rates = await getEurRates();
  } catch {
    return res.status(502).json({ error: 'exchange rates unavailable, please retry' });
  }
  const coinAmount = (eur / rates[coin]).toFixed(coin === 'ETH' ? 18 : 8);
  const expectedAmount = toUnits(coinAmount, coin);
  if (BigInt(expectedAmount) <= 0n) {
    return res.status(400).json({ error: 'amount is too small for the selected coin' });
  }

  const invoice = newInvoice({ expectedAmount, companyCode: info.companyCode || null, coin });
  processExistingInvoice(invoice.id, { onUpdate: logUpdate })
    .then(() => {})
    .catch((e) => console.error('[processor]', e));

  res.status(201).json({ ...publicInvoice(invoice), accessToken: invoice.accessToken });
});

app.post('/api/invoice/:id/pay', actionLimiter, async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (!invoiceAuthorized(req, inv)) return res.status(403).json({ error: 'forbidden' });
  try {
    const updated = await payInvoice(inv.id, { onUpdate: logUpdate });
    res.json(publicInvoice(updated));
  } catch (e) {
    return internalError(res, e, 'pay');
  }
});

app.post('/api/invoice/:id/cancel', actionLimiter, async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (!invoiceAuthorized(req, inv)) return res.status(403).json({ error: 'forbidden' });
  try {
    const updated = await cancelInvoice(inv.id, { onUpdate: logUpdate });
    res.json(publicInvoice(updated));
  } catch (e) {
    return internalError(res, e, 'cancel');
  }
});

app.get('/api/invoice/:id/receipt', invoiceLimiter, async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  try {
    const pdf = await buildReceipt(inv, { mainAddress: mainAddress() });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="msupay-receipt-${inv.id.slice(0, 8)}.pdf"`);
    res.send(pdf);
  } catch (e) {
    return internalError(res, e, 'receipt');
  }
});

// QR code of the payment request (EIP-681 for ETH, BIP-21 for BTC/LTC).
app.get('/api/invoice/:id/qr', invoiceLimiter, async (req, res) => {
  const inv = getInvoice(req.params.id);
  if (!inv) return res.status(404).json({ error: 'not found' });
  const uri = qrUri(inv.coin || 'ETH', inv.address, inv.expectedAmountWei);
  try {
    const buf = await QRCode.toBuffer(uri, {
      width: 320,
      margin: 2,
      color: { dark: '#1f2937', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch (e) {
    return internalError(res, e, 'qr');
  }
});

app.listen(config.port, () => {
  getDb();
  rotateKnownDefaultPassword();
  ensureSeedAccount();
  const expired = expireStaleInvoices();
  if (expired > 0) console.log(`[invoices] marked ${expired} stale invoice(s) as expired`);

  console.log(`payment processor backend running at http://localhost:${config.port}`);
  console.log(`main account: ${mainAddress()}`);
  console.log(`confirmations required: ${config.confirmations}`);
  console.log(`rpc: ${config.rpcUrl}`);

  // Resume any invoices left in a pending state from a previous run.
  const pending = listInvoices().filter((i) => i.status === 'pending');
  if (pending.length === 0) {
    console.log('no pending invoices to resume');
  }
  for (const inv of pending) {
    console.log(`[invoice ${inv.id}] resuming pending invoice ${inv.address}`);
    processExistingInvoice(inv.id, { onUpdate: logUpdate })
      .then(() => {})
      .catch((e) => console.error('[processor]', e));
  }
});
