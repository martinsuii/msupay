import http from 'node:http';

async function testHttpEndpoints() {
  console.log('Testing running server HTTP endpoints...');
  // Import server module (starts listening on PORT or 3000)
  process.env.PORT = '3099';
  process.env.RPC_URL = 'https://ethereum-rpc.publicnode.com';
  process.env.MAIN_PRIVATE_KEY = '1111111111111111111111111111111111111111111111111111111111111111';

  await import('../src/server.js');
  await new Promise((r) => setTimeout(r, 1000));

  const base = 'http://localhost:3099';

  // 1. Test /api/status
  const statusRes = await fetch(`${base}/api/status`);
  const statusData = await statusRes.json();
  console.log('Status endpoint:', statusData);
  if (!statusRes.ok || statusData.ok !== true) throw new Error('Status endpoint failed');

  // 2. Test /api/rates
  const ratesRes = await fetch(`${base}/api/rates`);
  const ratesData = await ratesRes.json();
  console.log('Rates endpoint:', ratesData);
  if (!ratesRes.ok || !ratesData.ETH) throw new Error('Rates endpoint failed');

  // 3. Test /api/register
  const email = `merchant_${Date.now()}@example.com`;
  const regRes = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1234' }),
  });
  const regData = await regRes.json();
  console.log('Register endpoint:', regData.account?.companyCode, regData.token ? 'token received' : 'no token');
  if (!regRes.ok || !regData.token) throw new Error('Register failed');

  const token = regData.token;

  // 4. Test /api/webhook/config (GET)
  const whConfRes = await fetch(`${base}/api/webhook/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const whConf = await whConfRes.json();
  console.log('Webhook config GET:', whConf);
  if (!whConfRes.ok || !whConf.webhookSecret) throw new Error('Webhook config failed');

  // 5. Test /api/webhook/config (PUT URL)
  const whPutRes = await fetch(`${base}/api/webhook/config`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ webhookUrl: 'https://example.com/hook' }),
  });
  const whPutData = await whPutRes.json();
  console.log('Webhook config PUT:', whPutData);
  if (!whPutRes.ok || whPutData.webhookUrl !== 'https://example.com/hook') throw new Error('Webhook URL update failed');

  // 6. Test /api/webhook/deliveries
  const whDelivRes = await fetch(`${base}/api/webhook/deliveries`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const whDelivData = await whDelivRes.json();
  console.log('Webhook deliveries count:', whDelivData.deliveries?.length);
  if (!whDelivRes.ok || !Array.isArray(whDelivData.deliveries)) throw new Error('Webhook deliveries list failed');

  // 7. Test /api/sign and /api/invoice
  const signRes = await fetch(`${base}/api/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      companyCode: regData.account.companyCode,
      product: 'Test Coffee',
      eur: '5.00',
    }),
  });
  const signData = await signRes.json();
  console.log('Sign endpoint payinfo token generated');
  if (!signRes.ok || !signData.payinfo) throw new Error('Sign endpoint failed');

  const invRes = await fetch(`${base}/api/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payinfo: signData.payinfo, coin: 'ETH' }),
  });
  const invData = await invRes.json();
  console.log('Created invoice:', invData.id, invData.address, invData.coin);
  if (!invRes.ok || !invData.id) throw new Error('Invoice creation failed');

  // 8. Test /api/invoice/:id/events SSE endpoint
  console.log('Testing SSE stream connection...');
  const sseReq = http.get(`${base}/api/invoice/${invData.id}/events`, (res) => {
    console.log('SSE status code:', res.statusCode, 'Content-Type:', res.headers['content-type']);
    if (res.statusCode !== 200 || !res.headers['content-type'].includes('text/event-stream')) {
      throw new Error('SSE connection failed');
    }
    res.on('data', (chunk) => {
      console.log('Received SSE chunk:', chunk.toString().trim());
      sseReq.destroy();
      console.log('\n🎉 ALL HTTP ENDPOINTS & SSE STREAM VERIFIED SUCCESSFULLY!');
      process.exit(0);
    });
  });
}

testHttpEndpoints().catch((e) => {
  console.error('Server test error:', e);
  process.exit(1);
});
