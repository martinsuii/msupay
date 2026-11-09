# MSU Pay

MSU Pay is a self-hosted cryptocurrency payment processor. It creates a fresh
deposit address for every invoice, watches it on-chain, waits for
confirmations, and lets the payer or merchant settle the funds to the merchant
wallet or refund them to the sender. Payments are priced in EUR and converted
to ETH, BTC, or LTC at invoice creation.

It ships with a hosted checkout page, a merchant dashboard, signed payment
links, real-time status updates (SSE), HMAC-signed webhooks with retries, PDF
receipts, QR codes, and a small demo storefront (the "café").

> **Status:** early-stage (v0.1.0), single-process reference implementation.
> Read [Security model](#security-model) and
> [Known limitations](#known-limitations) before using it with real money.

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Payment flow](#payment-flow)
- [API reference](#api-reference)
- [Webhooks](#webhooks)
- [Invoice statuses](#invoice-statuses)
- [Security model](#security-model)
- [Project layout](#project-layout)
- [Development](#development)
- [Demo café](#demo-café)
- [Known limitations](#known-limitations)

---

## Features

- **Per-invoice deposit addresses** — a fresh keypair and address for every
  payment, with no address reuse.
- **ETH, BTC, and LTC** on mainnet. Amounts are derived server-side from the
  signed EUR price and current rates.
- **Signed payment links** — HMAC-SHA256 `payinfo` tokens prevent amount and
  merchant tampering; links can be generated server-side or with a merchant
  bearer token.
- **Hosted checkout** at `/pay` with QR codes (EIP-681 for ETH, BIP-21 for
  BTC/LTC), injected-wallet payments, live status, and optional success/failure
  redirects.
- **Confirmation tracking** with configurable depth, plus underpayment
  detection.
- **Settle or refund** — after confirmation the payer (or merchant) can forward
  the funds to the merchant wallet or return them to the sender.
- **Webhooks** for every invoice event, signed with a per-merchant secret,
  retried with backoff, and logged in the dashboard.
- **Merchant workspace** at `/dashboard`: company profile, payment links,
  transactions, earnings, wallet export, ETH withdrawal, webhook settings and
  delivery history.
- **PDF receipts** and QR images for every invoice.
- **Encrypted key storage** — wallet and invoice private keys are encrypted at
  rest with AES-256-GCM.
- **Zero build step for the backend** — plain ESM Node.js, Express, SQLite via
  `node:sqlite`; the browser assets are minified with esbuild.

---

## How it works

```
Merchant                         MSU Pay                          Payer
   |                               |                                |
   |-- POST /api/sign ------------>|                                |
   |<-- payinfo (signed EUR) ------|                                |
   |-- share /pay?payinfo=... -------------------------------------->|
   |                               |<-- POST /api/invoice ----------|
   |                               |--- fresh address + accessToken->|
   |                               |<-- on-chain transfer -----------|
   |                               |  detect -> confirm -> paid      |
   |                               |--- SSE / webhook events ------->|
   |                               |<-- POST .../pay or .../cancel --|
   |<-- settlement to merchant ----|---- refund to sender ---------->|
```

1. The merchant signs a EUR amount for its company code and shares the
   resulting payment link.
2. The payer opens `/pay`, picks a coin, and creates an invoice. MSU Pay
   converts the signed EUR amount using live rates, generates a new address,
   and returns an invoice capability token (`accessToken`).
3. MSU Pay watches the address, reports `detected`/`confirming` over SSE and
   webhooks, and stops at `paid` (or `underpaid`).
4. The payer chooses **Pay** to sweep the deposit to the merchant wallet, or
   **Cancel** to refund the sender. The merchant can perform the same actions
   with its bearer token.
5. The merchant can later withdraw ETH from its MSU Pay wallet to an external
   address, or export the wallet keys.

---

## Requirements

- **Node.js 22.5 or newer** (uses the built-in `node:sqlite` module). Node 24+
  is recommended.
- An **Ethereum mainnet JSON-RPC endpoint** (`RPC_URL`); an optional WebSocket
  endpoint (`RPC_WS_URL`) for faster block updates.
- An Etherscan-compatible explorer API for ETH sender resolution
  (`EXPLORER_API_URL`, Blockscout by default).
- Outbound HTTPS access to the BTC/LTC explorers (mempool.space and
  litecoinspace.org by default) and CoinGecko for EUR rates.
- For production: HTTPS (reverse proxy), a trusted RPC provider, and backups of
  the `data/` directory.

---

## Quick start

```bash
cp .env.example .env
# edit .env: at minimum set RPC_URL and MAIN_PRIVATE_KEY
npm install
npm start
```

`npm start` runs `npm run build` first (it minifies `public/**` into
`public/**/*.min.js` / `*.min.css`) and then starts the server at
<http://localhost:3000>.

- Register a merchant at <http://localhost:3000/register> (password: 12+
  characters) or via `POST /api/register`.
- The response/dashboard shows your **company code** — use it in payment links.
- Configure a webhook URL in the dashboard.
- Health check: `curl http://localhost:3000/api/status` → `{"ok":true}`.
- Interactive docs: `/docs`; payment-link tester: `/paytester`.

The database `data/msupay.db` is created on first start. Unless configured
through the environment, the secrets `data/master.key`, `data/payinfo-secret`,
and `data/sign.key` are generated automatically on first use. **Back these
up.** Losing `master.key` makes the encrypted wallet keys unrecoverable.

---

## Configuration

All settings are environment variables, loaded from `.env` by `dotenv`.
See [`.env.example`](.env.example) for the annotated template.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port for the backend and frontend. |
| `RPC_URL` | **required** | Ethereum JSON-RPC URL (mainnet). |
| `RPC_WS_URL` | — | Optional WebSocket RPC; falls back to HTTP on failure. |
| `MAIN_PRIVATE_KEY` | **required** | Private key of the global fallback settlement account, used for invoices without a company code. Required at startup even when all invoices belong to merchants. |
| `MASTER_ENCRYPTION_KEY` | generated | 32-byte hex key (or passphrase) for AES-256-GCM encryption of private keys; otherwise `data/master.key`. |
| `CONFIRMATIONS` | `3` | Confirmations required before an invoice becomes `paid`. |
| `POLL_INTERVAL_MS` | `3000` | Address polling interval in milliseconds. |
| `EXPLORER_API_URL` | `https://eth.blockscout.com` | Etherscan-compatible API used to resolve the ETH sender for refunds. |
| `BTC_API_URL` | `https://mempool.space/api` | BTC explorer/API (mempool.space compatible). |
| `LTC_API_URL` | `https://litecoinspace.org/api` | LTC explorer/API. |
| `GAS_PRICE_GWEI` | network fee data | Fixed max fee for ETH forwards/refunds. |
| `FORWARD_GAS_LIMIT` | `21000` | Gas limit for ETH forwards, refunds, and withdrawals. |
| `INVOICE_TTL_MINUTES` | `60` | Lifetime of a pending invoice before it expires. |
| `TOKEN_TTL_DAYS` | `30` | Merchant bearer-token lifetime. |
| `PAYINFO_SECRET` | generated | Secret for signing payment links; otherwise `data/payinfo-secret`. |
| `SIGN_API_KEY` | generated | Server-to-server key accepted by `POST /api/sign` as `x-sign-key`; otherwise `data/sign.key`. |
| `ALLOW_PRIVATE_WEBHOOKS` | off | **Development only.** Allows webhook targets on localhost/private networks. |
| `TRUST_PROXY` | off | Set when behind a reverse proxy so rate limiting sees real client IPs (hop count, subnet, or CIDR). |
| `CAFE_PORT` | `3001` | Port for the demo café storefront. |
| `MSUPAY_URL` | `http://localhost:3000` | MSU Pay URL used by the café. |
| `CAFE_COMPANY_CODE` | `NESPCFE` | Merchant company code used by the café. |
| `MSUPAY_SIGN_KEY` | `SIGN_API_KEY` / `data/sign.key` | Café-side signing key. |
| `SEED_DEMO_ACCOUNT` | off | Set to `1` to create the demo merchant `NESPCFE`; requires the two variables below. |
| `SEED_DEMO_EMAIL` | — | Demo merchant email. |
| `SEED_DEMO_PASSWORD` | — | Demo merchant password (12+ characters). |

Generated secrets and the database live in `data/`, which is gitignored.

---

## Payment flow

### 1. Create a merchant

```bash
curl -sX POST http://localhost:3000/api/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"merchant@example.com","password":"a-long-password"}'
```

The response contains a bearer `token` and the account, including its
`companyCode` and generated ETH/BTC/LTC deposit addresses. Store the token
server-side. `POST /api/login` issues a new token.

### 2. Sign a payment request

```bash
curl -sX POST http://localhost:3000/api/sign \
  -H 'Authorization: Bearer $TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"companyCode":"ABC12345","eur":"2.50","product":"Coffee"}'
```

Response: `{"payinfo":"<base64url token>"}`. The signed fields are
`companyCode`, `eur`, and optional `product`, `customerName`, and
`customerInfo`. Anyone holding `SIGN_API_KEY` may also call this endpoint with
`X-Sign-Key: <key>` instead of a bearer token; keep that key server-side.

### 3. Send the payer to checkout

```
https://your-host/pay?payinfo=<payinfo>
```

Optional redirects are base64url-encoded query parameters:

- `returns` — redirect after the invoice is `forwarded` (success).
- `returnf` — redirect after the invoice is `refunded` (cancelled).

These redirect values are **not** part of the signed payload; treat them as UX
hints, not as trusted data.

### 4. Create the invoice

The checkout page does this, but you can do it from your server:

```bash
curl -sX POST http://localhost:3000/api/invoice \
  -H 'Content-Type: application/json' \
  -d '{"payinfo":"<payinfo>","coin":"BTC"}'
```

`coin` is `ETH` (default), `BTC`, or `LTC`. The response includes `id`,
`address`, `expectedAmountWei` (base units: wei, satoshi, or litoshi),
`status`, `expiresAt`, and the payer capability `accessToken`. The amount is
locked at creation; later rate changes do not affect it. The `accessToken` is
returned only here and never by `GET /api/invoice/:id`.

### 5. Watch the payment

Connect to the public SSE stream for live updates:

```bash
curl -N http://localhost:3000/api/invoice/<id>/events
```

Events are sent as `event: status` with a JSON `{stage, invoice}` body. If SSE
is unavailable, poll `GET /api/invoice/<id>`.

### 6. Settle or refund

```bash
# Payer capability:
curl -sX POST http://localhost:3000/api/invoice/<id>/pay \
  -H "X-Invoice-Token: $ACCESS_TOKEN"

# Or merchant authentication:
curl -sX POST http://localhost:3000/api/invoice/<id>/cancel \
  -H "Authorization: Bearer $TOKEN"
```

`pay` sweeps the confirmed deposit to the merchant's wallet for that coin (or
the global main address for legacy invoices without a company code). `cancel`
refunds the sender. Refunds require a resolved sender.

Withdraw ETH from the merchant wallet to an external address:

```bash
curl -sX POST http://localhost:3000/api/withdraw \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toAddress":"0x..."}'
```

BTC and LTC merchant wallets are funded directly; export their keys from the
dashboard or `GET /api/wallet/credentials` to move funds.

---

## API reference

All request and response bodies are JSON (`Content-Type: application/json`),
except QR (PNG), receipts (PDF), and SSE. Errors are `{"error":"..."}` with a
4xx/5xx status. API responses are sent with `Cache-Control: no-store`.

### Authentication

| Mechanism | Header | Used for |
| --- | --- | --- |
| Merchant bearer token | `Authorization: Bearer <token>` | Merchant account actions and its own invoices. Expires after `TOKEN_TTL_DAYS`. |
| Invoice capability | `X-Invoice-Token: <accessToken>` | `pay` / `cancel` for exactly one invoice. Returned only by `POST /api/invoice`. |
| Signing key | `X-Sign-Key: <SIGN_API_KEY>` | Server-to-server `POST /api/sign`. Never send it to a browser. |

Rate limits are per IP and in-memory: auth endpoints 10/min, sign 30/min,
invoice creation 20/min, and pay/cancel/webhook-test/withdraw 20/min. `429`
responses include `Retry-After`.

### Public endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/status` | Liveness check. |
| `GET` | `/api/rates` | EUR price per coin (`{ETH,BTC,LTC}`), cached 60s. |
| `GET` | `/api/company/:code` | Public merchant display name for a company code. |
| `POST` | `/api/register` | Create a merchant. Body: `email`, `password` (12+ chars). |
| `POST` | `/api/login` | Issue a new bearer token. Body: `email`, `password`. |
| `POST` | `/api/invoice` | Create an invoice from a signed payinfo. Body: `payinfo`, `coin`. |
| `GET` | `/api/invoice/:id` | Public invoice view (never includes keys or `accessToken`). |
| `GET` | `/api/invoice/:id/events` | SSE stream of invoice updates. |
| `GET` | `/api/invoice/:id/qr` | PNG QR code of the payment request. |
| `GET` | `/api/invoice/:id/receipt` | PDF receipt (A5). |

### Merchant endpoints (bearer token)

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/logout` | Invalidate the current token. |
| `GET` | `/api/account` | Account details plus ETH earnings (`earningsWei`, `earningsEth`). |
| `PUT` | `/api/company` | Update `companyName` (80 chars) and `companyDescription` (300 chars). |
| `GET` | `/api/invoices` | All invoices for the merchant. |
| `GET` | `/api/transactions` | Invoice history shaped for the dashboard. |
| `GET` | `/api/wallet/credentials` | Export ETH/BTC/LTC addresses and private keys. **Sensitive.** |
| `POST` | `/api/withdraw` | Sweep the merchant ETH wallet to `toAddress`. |
| `DELETE` | `/api/account` | Delete the account, its invoices, and webhook deliveries. Irreversible. |
| `GET` | `/api/webhook/config` | Read the webhook URL and signing secret. |
| `PUT` | `/api/webhook/config` | Set `webhookUrl` (or null) and/or `regenerateSecret: true`. |
| `GET` | `/api/webhook/deliveries` | Last 50 delivery attempts. |
| `POST` | `/api/webhook/test` | Send a signed `ping` event to the configured URL. |
| `POST` | `/api/sign` | Sign a payment request (bearer token or `X-Sign-Key`). |

### Payer / merchant invoice actions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `POST` | `/api/invoice/:id/pay` | Bearer or `X-Invoice-Token` | Sweep a `paid`/`forward_failed` invoice to the merchant. |
| `POST` | `/api/invoice/:id/cancel` | Bearer or `X-Invoice-Token` | Refund a `paid`, `underpaid`, or `forward_failed` invoice to the sender. |

Settlement and refund actions are idempotent only in the sense that they return
the current invoice when the status is not actionable. Do **not** blindly retry
a `5xx` money action; refresh the invoice first.

### Pages

| Path | Purpose |
| --- | --- |
| `/` | Landing page. |
| `/register`, `/login` | Merchant onboarding and sign-in. |
| `/dashboard` | Merchant workspace. |
| `/pay?payinfo=...` | Hosted checkout (redirects to `/` without a payinfo). |
| `/paytester` | Payment-link builder for signed-in merchants. |
| `/docs` | Short in-app API documentation. |
| `/terms`, `/privacy` | Legal pages. |

---

## Webhooks

Configure a URL in the dashboard or with `PUT /api/webhook/config`. MSU Pay
POSTs JSON to it for every event on an invoice that belongs to the merchant.

### Headers

| Header | Value |
| --- | --- |
| `X-MSUPay-Signature` | `sha256=<hex HMAC-SHA256 of the raw body>` |
| `X-MSUPay-Event` | e.g. `invoice.paid` |
| `X-MSUPay-Delivery-ID` | UUID of this delivery |
| `User-Agent` | `MSUPay-Webhook/1.0` |

### Payload

```json
{
  "id": "evt_<uuid>",
  "event": "invoice.paid",
  "createdAt": "2026-01-01T12:00:00.000Z",
  "companyCode": "ABC12345",
  "data": {
    "invoice": {
      "id": "<invoice uuid>",
      "coin": "ETH",
      "address": "0x...",
      "expectedAmountWei": "2500000000000000",
      "paidAmountWei": "2500000000000000",
      "status": "paid",
      "sender": "0x...",
      "paidTxHash": "0x...",
      "confirmedAt": "2026-01-01T12:00:00.000Z",
      "expiresAt": "2026-01-01T13:00:00.000Z",
      "createdAt": "2026-01-01T11:55:00.000Z"
    }
  }
}
```

### Verify the signature

Verify against the **raw** request body before parsing it, and use a
constant-time comparison:

```js
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const app = express();

app.post(
  '/webhooks/msupay',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const provided = req.get('X-MSUPay-Signature') || '';
    const expected =
      'sha256=' +
      createHmac('sha256', process.env.MSUPAY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('hex');

    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(400).end();
    }

    const event = JSON.parse(req.body.toString('utf8'));
    // Handle event.event, then acknowledge quickly.
    res.status(200).end();
  },
);
```

### Events

`invoice.created`, `invoice.detected`, `invoice.confirming`, `invoice.paid`,
`invoice.underpaid`, `invoice.forwarded`, `invoice.forward_failed`,
`invoice.refunded`, `invoice.refund_failed`, `invoice.expired`,
`invoice.explorer_error`, plus `ping` from the dashboard test button.

`invoice.confirming` can be delivered multiple times as depth increases.
Unknown events should be ignored for forward compatibility.

### Delivery and retries

A delivery is successful on any 2xx response. Failed deliveries are retried up
to four more times after 2s, 10s, 30s, and 2m (five attempts total). Every
attempt, status code, and response snippet is stored and shown in the
dashboard. Retry timers are in-memory, so pending retries are lost on restart;
the delivery log remains.

Webhook URLs are validated before every attempt: HTTP/HTTPS only, no embedded
credentials, and no localhost, private, link-local, or cloud-metadata
addresses. `ALLOW_PRIVATE_WEBHOOKS=1` disables this check for local
development.

---

## Invoice statuses

| Status | Meaning | Typical action |
| --- | --- | --- |
| `pending` | Waiting for the on-chain transfer; watched until `expiresAt`. | Show address/QR; listen for updates. |
| `paid` | Confirmed at the required depth and not underpaid. | Offer Pay (settle) or Cancel (refund). |
| `underpaid` | Confirmed, but less than the signed amount. | Refund or reconcile manually; cannot be settled via `pay`. |
| `forwarded` | Settled to the merchant wallet. | Fulfil the order; webhook `invoice.forwarded`. |
| `refunded` | Returned to the sender. | Cancel the order; webhook `invoice.refunded`. |
| `expired` | Deadline passed before payment. | Create a new invoice. |
| `forward_failed` | Settlement transaction failed. | Inspect `error`; may retry `pay` or refund. |
| `refund_failed` | Refund transaction failed. | Inspect `error`; surface to support. |

`expectedAmountWei`, `paidAmountWei`, and `settledAmountWei` are strings in the
coin's base unit (wei for ETH, satoshi for BTC, litoshi for LTC).

---

## Security model

- **Private keys at rest** are encrypted with AES-256-GCM using a master key
  from `MASTER_ENCRYPTION_KEY` or a generated `data/master.key` (mode `0600`).
  Invoice keys are decrypted only in memory when forwarding or refunding.
- **Passwords** are hashed with scrypt and a random salt; comparisons use
  `timingSafeEqual`. Login tokens are random UUIDs with a configurable TTL and
  are invalidated by logout.
- **Invoice capability tokens** are 32 random bytes, compared in constant
  time, and stripped from all public invoice responses.
- **Payment links** are HMAC-SHA256 signed over canonical JSON with a
  server-side secret; invalid or tampered tokens are rejected at invoice
  creation.
- **Webhook SSRF protection** blocks private networks, localhost, and metadata
  endpoints, does not follow redirects, and re-validates on each attempt.
- **HTTP hardening**: no `X-Powered-By`, `nosniff`, `X-Frame-Options: DENY`,
  same-origin referrer policy, `no-store` for APIs, 64 KB JSON body limit, and
  per-IP rate limits.
- **Public views** never expose private keys, webhook secrets, or invoice
  capability tokens. Webhook secrets are shown only to the authenticated
  merchant.

Operational rules:

- Serve MSU Pay over **HTTPS** and set `TRUST_PROXY` when behind a proxy.
- `GET /api/wallet/credentials` returns plaintext private keys; it requires a
  bearer token but no password re-entry. Protect the dashboard and tokens
  accordingly.
- Keep `MAIN_PRIVATE_KEY`, `MASTER_ENCRYPTION_KEY`, `PAYINFO_SECRET`,
  `SIGN_API_KEY`, and `data/` out of version control and client-side code.
- Back up `data/` (database and secret files) securely. Losing `master.key`
  permanently loses access to encrypted wallet keys.
- Never enable `ALLOW_PRIVATE_WEBHOOKS` in production.

---

## Project layout

```
.
├── src/
│   ├── server.js        # Express app, HTTP API, static pages
│   ├── config.js        # environment configuration
│   ├── db.js            # SQLite schema, migrations, legacy JSON import
│   ├── store.js         # invoice persistence
│   ├── accounts.js      # merchants, auth, company codes, demo seed
│   ├── security.js      # AES-GCM key encryption, secrets, signing key
│   ├── payinfo.js       # signed payment-link payloads
│   ├── wallet.js        # per-invoice key/address generation
│   ├── processor.js     # invoice lifecycle, settlement, refunds
│   ├── watcher.js       # ETH/BTC/LTC deposit detection and confirmations
│   ├── forward.js       # ETH sweeping
│   ├── btc.js           # BTC/LTC explorer, UTXO sweep
│   ├── explorer.js      # ETH sender lookup (Etherscan-compatible)
│   ├── rates.js         # CoinGecko EUR rates with cache
│   ├── coins.js         # coin metadata, unit conversion, QR URIs
│   ├── webhooks.js      # signing, delivery, retries, SSRF validation
│   ├── events.js        # SSE broker
│   ├── ratelimit.js     # in-memory fixed-window limiter
│   ├── receipt.js       # PDF receipts
│   ├── minified-static.js
│   ├── index.js         # legacy CLI helpers
│   └── cafe-server.js   # demo storefront server
├── public/              # landing, checkout, dashboard, docs, café
├── scripts/build-public.mjs  # esbuild minifier
├── scratch/             # ad-hoc test suite and endpoint smoke test
├── data/                # SQLite DB and generated secrets (gitignored)
└── .env.example
```

---

## Development

```bash
npm run build     # minify public JS/CSS into *.min.*
npm start         # build, then start MSU Pay on :3000
npm run cafe      # build, then start the demo café on :3001
npm run invoice   # CLI: create and watch an ETH invoice
npm run watch     # CLI: re-attach to the most recent pending invoice
```

Edit files under `public/` and rebuild; do not edit `*.min.js` / `*.min.css`
(they are generated and gitignored). `npm start` and `npm run cafe` run the
build automatically.

Smoke tests (no framework):

```bash
node scratch/test-suite.js   # encryption, SQLite store, webhooks, SSE
node scratch/test-server.js  # starts the server on :3099 and hits endpoints
node --check src/server.js   # syntax check
```

Both scripts use the real `data/` database and create test accounts, invoices,
and webhook deliveries. Do not run them against a production database.

---

## Demo café

`npm run cafe` starts a small storefront at <http://localhost:3001> that prices
items in EUR and creates MSU Pay payment links through its own `/api/sign`
proxy, so the signing key never reaches the browser.

Register a merchant, then set `CAFE_COMPANY_CODE` to its company code and
`MSUPAY_URL` to your MSU Pay origin. Alternatively, enable the seeded demo
merchant with `SEED_DEMO_ACCOUNT=1`, `SEED_DEMO_EMAIL`, and
`SEED_DEMO_PASSWORD`; it is created with company code `NESPCFE`. There are no
built-in demo credentials.

---

## Known limitations

- **ETH confirmation depth** is measured from the first block in which a
  non-zero balance was observed, not from the deposit transaction's block. For
  high-value payments, use a dedicated indexer.
- **Sender resolution** for refunds depends on the block explorer. ETH uses an
  Etherscan-compatible API; BTC/LTC use the first input of the latest
  transaction. If the sender cannot be resolved, `cancel` fails and the funds
  must be handled manually.
- **Single process only.** SSE subscribers, watchers, invoice locks, rate
  limits, and webhook retry timers are in memory. Running multiple instances
  can double-sweep invoices and breaks rate limiting and live updates.
- **Expiry** is enforced only while a watcher is running and at startup; an
  invoice that expires while the process is down is marked `expired` on the
  next start.
- **Webhook retries** do not survive a restart, deliveries are unbounded, and
  there is no pruning or manual replay endpoint.
- **Exchange rates** come from CoinGecko's public API (60s cache, stale
  fallback); the amount is locked at invoice creation, but rate availability is
  a dependency for creating new invoices.
- **ETH-only withdrawals.** BTC/LTC must be moved using exported wallet keys.
- **No password reset or email verification.** Account deletion is immediate
  and irreversible.
- **Redirect URLs** (`returns`, `returnf`) are unsigned UX hints.
- **Unspent deposits** on `pending` invoices after expiry are not swept
  automatically; the invoice must be recreated or funds handled manually.
- The webhook URL check resolves DNS before connecting; DNS rebinding remains a
  theoretical TOCTOU risk, and redirects are blocked.

For production, additionally consider: an external job queue for webhooks and
watchers, a shared rate-limit store, database backups, monitoring/alerting,
structured audit logs, a dedicated chain indexer, and a security review of the
key-management and withdrawal flows.
