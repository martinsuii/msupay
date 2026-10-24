import http from 'node:http';
import { getMasterKey, encryptKey, decryptKey, generateWebhookSecret } from '../src/security.js';
import { getDb } from '../src/db.js';
import { createAccount, findByEmail, findByCode, updateAccount } from '../src/accounts.js';
import { createInvoice, getInvoice, updateInvoice, listInvoices } from '../src/store.js';
import { signWebhookPayload, sendTestWebhook, getWebhookDeliveries, dispatchInvoiceEvent } from '../src/webhooks.js';
import { broadcastInvoiceUpdate, handleInvoiceSSE } from '../src/events.js';

// The mock webhook receiver runs on localhost; allow private targets in tests.
process.env.ALLOW_PRIVATE_WEBHOOKS = '1';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    failed++;
  } else {
    console.log(`✅ PASS: ${message}`);
    passed++;
  }
}

async function runTests() {
  console.log('--- 1. Testing AES-256-GCM Key Encryption ---');
  const plaintext = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const encrypted = encryptKey(plaintext);
  assert(encrypted !== plaintext, 'Key is encrypted and not equal to plaintext');
  assert(encrypted.split(':').length === 3, 'Key has iv:tag:ciphertext format');
  const decrypted = decryptKey(encrypted);
  assert(decrypted === plaintext, 'Decrypted key matches original plaintext');

  // Test tampered ciphertext throws error
  const parts = encrypted.split(':');
  parts[2] = parts[2].slice(0, -2) + (parts[2].slice(-2) === 'aa' ? 'bb' : 'aa');
  let tamperCaught = false;
  try {
    decryptKey(parts.join(':'));
  } catch (e) {
    tamperCaught = true;
  }
  assert(tamperCaught, 'Tampered ciphertext is rejected by authentication tag');

  console.log('\n--- 2. Testing SQLite Database & Store Operations ---');
  const db = getDb();
  assert(!!db, 'SQLite DB initialized successfully');

  // Test Account creation with encrypted wallet keys
  const testEmail = `test_${Date.now()}@example.com`;
  const account = createAccount({ email: testEmail, password: 'password123' });
  assert(account && account.email === testEmail, 'Account created in SQLite');
  assert(account.companyCode.length === 8, 'Generated 8-char company code');
  assert(account.walletPrivateKey.startsWith('0x'), 'Account private key decrypted properly in memory');
  assert(account.webhookSecret.startsWith('whsec_'), 'Account has generated webhook secret');

  // Verify raw DB row has encrypted key
  const rawRow = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account.id);
  assert(rawRow.wallet_private_key_enc.split(':').length === 3, 'Wallet private key is encrypted at rest in DB');

  // Test Invoice creation with encrypted key
  const invId = `inv_test_${Date.now()}`;
  const rawKey = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef';
  const invoice = createInvoice({
    id: invId,
    coin: 'ETH',
    address: '0x1111111111111111111111111111111111111111',
    privateKey: rawKey,
    expectedAmountWei: '1000000000000000',
    companyCode: account.companyCode,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  assert(invoice.id === invId, 'Invoice created in SQLite');

  const fetched = getInvoice(invId);
  assert(fetched.privateKey === rawKey, 'Invoice private key is properly decrypted when retrieved');
  const rawInvRow = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invId);
  assert(rawInvRow.private_key_enc !== rawKey, 'Invoice private key is encrypted at rest in DB');

  updateInvoice(invId, { status: 'paid', paidAmountWei: '1000000000000000' });
  const updated = getInvoice(invId);
  assert(updated.status === 'paid', 'Invoice updated to paid');

  console.log('\n--- 3. Testing Webhook Dispatcher & Retries ---');
  let receivedWebhook = null;
  let receivedSignature = null;

  // Start a local mock webhook receiver server
  const mockServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      receivedSignature = req.headers['x-nesppay-signature'];
      receivedWebhook = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => mockServer.listen(0, resolve));
  const mockPort = mockServer.address().port;
  const mockUrl = `http://localhost:${mockPort}/webhook-target`;

  // Set webhook URL on merchant account
  updateAccount(account.id, { webhookUrl: mockUrl });

  // Test Test Ping Webhook
  const testResult = await sendTestWebhook(account.companyCode);
  assert(testResult.success, 'Test webhook delivered successfully');
  assert(receivedWebhook && receivedWebhook.event === 'ping', 'Mock receiver received ping event');

  const expectedSig = 'sha256=' + signWebhookPayload(JSON.stringify(receivedWebhook), account.webhookSecret);
  assert(receivedSignature === expectedSig, 'Webhook signature matches HMAC-SHA256 of payload');

  // Test Invoice Event Dispatch
  receivedWebhook = null;
  dispatchInvoiceEvent('paid', updated);
  // Wait a moment for async delivery
  await new Promise((r) => setTimeout(r, 200));
  assert(receivedWebhook && receivedWebhook.event === 'invoice.paid', 'Invoice event dispatched and received');

  const deliveries = getWebhookDeliveries(account.companyCode);
  assert(deliveries.length >= 2, 'Webhook deliveries recorded in database');
  assert(deliveries[0].success === true, 'Delivery recorded as successful');

  mockServer.close();

  console.log('\n--- 4. Testing SSE Real-time Events ---');
  let sseReceived = false;
  const mockRes = {
    writeHead: () => {},
    write: (data) => {
      if (data.includes('invoice.paid') || data.includes('paid')) {
        sseReceived = true;
      }
    },
    flushHeaders: () => {},
  };
  const mockReq = { on: () => {} };

  handleInvoiceSSE(mockReq, mockRes, invId, updated);
  broadcastInvoiceUpdate(invId, 'paid', updated);
  assert(sseReceived, 'SSE listener received live invoice update');

  console.log(`\n========================================`);
  console.log(`Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
