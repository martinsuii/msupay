import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSigningApiKey } from './security.js';
import { minifiedStatic } from './minified-static.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAFE_DIR = join(__dirname, '..', 'public', 'cafe');

const port = Number(process.env.CAFE_PORT ?? 3001);
const msupayUrl = process.env.MSUPAY_URL ?? 'http://localhost:3000';
const companyCode = process.env.CAFE_COMPANY_CODE ?? 'NESPCFE';
const signKey = process.env.MSUPAY_SIGN_KEY || getSigningApiKey();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(minifiedStatic(CAFE_DIR));
app.use(express.static(CAFE_DIR));

app.get('/api/config', (req, res) => {
  res.json({ msupayUrl, companyCode });
});

// Proxy signing so the server-side key never reaches the browser.
app.post('/api/sign', async (req, res) => {
  try {
    const upstream = await fetch(`${msupayUrl}/api/sign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(signKey ? { 'x-sign-key': signKey } : {}),
      },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(8000),
    });
    const data = await upstream.json().catch(() => ({}));
    res.status(upstream.status).json(data);
  } catch {
    res.status(502).json({ error: 'payment service unavailable' });
  }
});

app.listen(port, () => {
  console.log(`cafe running at http://localhost:${port}`);
  console.log(`payments via MSU Pay at ${msupayUrl}`);
});
