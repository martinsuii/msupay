import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  rpcUrl: required('RPC_URL'),
  rpcWsUrl: process.env.RPC_WS_URL || undefined,
  masterEncryptionKey: process.env.MASTER_ENCRYPTION_KEY || undefined,
  mainPrivateKey: required('MAIN_PRIVATE_KEY'),
  confirmations: Number(process.env.CONFIRMATIONS ?? 3),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 3000),
  explorerBaseUrl: process.env.EXPLORER_API_URL ?? 'https://eth.blockscout.com',
  btcApiBase: process.env.BTC_API_URL ?? 'https://mempool.space/api',
  ltcApiBase: process.env.LTC_API_URL ?? 'https://litecoinspace.org/api',
  gasPriceGwei: process.env.GAS_PRICE_GWEI
    ? Number(process.env.GAS_PRICE_GWEI)
    : undefined,
  forwardGasLimit: Number(process.env.FORWARD_GAS_LIMIT ?? 21000),
  invoiceTtlMinutes: Number(process.env.INVOICE_TTL_MINUTES ?? 60),
  tokenTtlDays: Number(process.env.TOKEN_TTL_DAYS ?? 30),
  allowPrivateWebhooks: process.env.ALLOW_PRIVATE_WEBHOOKS === '1',
};

