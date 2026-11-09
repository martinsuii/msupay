# AGENTS.md — Integrating MSU Pay

This file is for developers and coding agents integrating a project with the MSU Pay payment processor. It covers the supported integration contract, not the internal implementation.

## Rules

- Never hardcode merchant tokens, private keys, webhook secrets, or the signing key in source, fixtures, or client-side code.
- Keep all signing requests server-side. The browser must never receive the merchant Bearer token or the `x-sign-key`.
- Always verify the `X-MSUPay-Signature` header against the raw request body before trusting a webhook.
- Treat `accessToken` from invoice creation as a payer capability. Send it only as `X-Invoice-Token` to that invoice's `pay`/`cancel` endpoints.
- Do not infer a merchant's code. Fetch it from the account or configuration.
- Handle `401`, `403`, `404`, `409`, `429`, and `5xx` explicitly. Do not retry non-idempotent money actions blindly.
- Do not add wallet-related secrets to logs, analytics, or error trackers.
- Changes to `public/**` source files require `npm run build`; edit sources, never `*.min.js` / `*.min.css`.

## Local setup

```bash
cp .env.example .env    # configure RPC_URL and MAIN_PRIVATE_KEY
npm install
npm start               # http://localhost:3000
npm run cafe            # optional demo storefront on :3001
```

Environment values relevant to integrators:

| Variable | Purpose |
| --- | --- |
| `PORT` | MSU Pay HTTP port |
| `PUBLIC_BASE_URL` | Public origin used in links inside merchant payment emails |
| `ADMIN_SECRET_KEY` | Long key for `/admin` (min 32 chars); auto-generated at `data/admin.key` if unset |
| `SIGN_API_KEY` | Server-to-server key for `/api/sign`; auto-generated at `data/sign.key` if unset |
| `MSUPAY_SIGN_KEY` | Café-side copy of the signing key |
| `TOKEN_TTL_DAYS` | Merchant Bearer token lifetime |
| `INVOICE_TTL_MINUTES` | Pending invoice lifetime |
| `ALLOW_PRIVATE_WEBHOOKS` | Development only; allows localhost/private webhook targets |

## Integration flow

1. **Register a merchant** (`POST /api/register`) or log in (`POST /api/login`). Store the returned `token` server-side.
2. **Sign a payment request** (`POST /api/sign`) with `Authorization: Bearer <token>` and the merchant's `companyCode`. The response contains an opaque `payinfo` token.
3. **Send the customer** to `/pay?payinfo=<payinfo>` with optional base64url `returns` / `returnf` redirects.
4. **Receive webhooks** on your server and verify signatures.
5. **Settle or refund** with `POST /api/invoice/:id/pay` or `/cancel`. From the payment page, use the invoice `accessToken`; from your server, use the merchant Bearer token.

### Sign and create

```http
POST /api/sign
Authorization: Bearer <merchant-token>
Content-Type: application/json

{ "companyCode": "ABC12345", "eur": "2.50", "product": "Coffee" }
```

```http
POST /api/invoice
Content-Type: application/json

{ "payinfo": "<payinfo>", "coin": "ETH" }
```

`coin` is `ETH`, `BTC`, or `LTC`. Amounts are derived server-side from the signed EUR value and current rates. A successful response includes `id`, `address`, `expectedAmountWei`, `status`, `expiresAt`, and `accessToken`.

### Pay or cancel

```http
POST /api/invoice/<id>/pay
X-Invoice-Token: <accessToken>
```

```http
POST /api/invoice/<id>/cancel
Authorization: Bearer <merchant-token>
```

A merchant Bearer token also authorizes its own invoices. Never expose an invoice `accessToken` to a third party.

### Webhooks

Configure the URL in the dashboard. Every delivery is a JSON POST with:

- `X-MSUPay-Signature: sha256=<hex>`
- `X-MSUPay-Event`
- `X-MSUPay-Delivery-ID`

Verify HMAC-SHA256 over the **raw** body using the merchant webhook secret, with a constant-time comparison. Return 2xx to acknowledge; non-2xx responses are retried with backoff.

Example events: `invoice.detected`, `invoice.confirming`, `invoice.paid`, `invoice.underpaid`, `invoice.forwarded`, `invoice.refunded`, `invoice.expired`, `invoice.forward_failed`, `invoice.refund_failed`. Treat unknown events as forward-compatible.

## Status handling

| Status | Meaning | Recommended action |
| --- | --- | --- |
| `pending` | Awaiting payment | Show address/QR; keep listening |
| `paid` | Confirmed, awaiting choice | Offer pay or refund |
| `underpaid` | Amount below the signed total | Offer refund or reconciliation |
| `forwarded` | Settled to merchant | Fulfil the order |
| `refunded` | Refunded to payer | Cancel the order |
| `expired` | Deadline passed before payment | Request a new invoice |
| `forward_failed` / `refund_failed` | On-chain action failed | Surface to support; do not auto-retry blindly |

## Development commands

```bash
npm run build     # minify public JS/CSS into *.min.*
npm start         # builds, then starts the server
npm run cafe      # builds, then starts the demo storefront
node scratch/test-suite.js   # storage, crypto, webhook, SSE checks
node --check src/<file>.js   # syntax check
```

## Known limitations

- ETH confirmations are counted from first-observed balance, not the deposit transaction's block. Use a dedicated indexer for high-value production use.
- Rate limiting is in-memory and single-process.
- Pending invoice watchers resume on restart and stop at `expiresAt`.
- The bundled demo account is disabled unless `SEED_DEMO_ACCOUNT=1` and explicit demo credentials are set.
