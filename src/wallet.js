import { getAddress } from 'ethers';
import { randomUUID, randomBytes } from 'node:crypto';
import { createInvoice } from './store.js';
import { generateCoinKey } from './coins.js';
import { config } from './config.js';

// Generates a fresh keypair per invoice and persists it. The private key is
// stored so the service can sign the forward/refund transaction later.
export function newInvoice({ expectedAmount, companyCode, coin = 'ETH' }) {
  const { address, privateKey } = generateCoinKey(coin);
  const invoice = {
    id: randomUUID(),
    coin,
    address: coin === 'ETH' ? getAddress(address) : address,
    privateKey,
    expectedAmountWei: String(expectedAmount ?? '0'),
    companyCode: companyCode ?? null,
    status: 'pending',
    accessToken: randomBytes(32).toString('hex'),
    expiresAt: new Date(Date.now() + config.invoiceTtlMinutes * 60000).toISOString(),
    createdAt: new Date().toISOString(),
    sender: null,
    paidTxHash: null,
    confirmedAt: null,
    forwardedTxHash: null,
    refundedTxHash: null,
    settledAmountWei: null,
  };
  return createInvoice(invoice);
}
