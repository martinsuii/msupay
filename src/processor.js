import { JsonRpcProvider, WebSocketProvider, Wallet } from 'ethers';
import { config } from './config.js';
import { newInvoice } from './wallet.js';
import { waitForPayment, InvoiceExpiredError } from './watcher.js';
import { sweepTo } from './forward.js';
import { sweepUtxo, fetchSender as fetchUtxoSender } from './btc.js';
import { fetchIncomingTransactions } from './explorer.js';
import { getInvoice, updateInvoice } from './store.js';
import { findByCode } from './accounts.js';
import { isUtxoCoin } from './coins.js';
import { dispatchInvoiceEvent } from './webhooks.js';
import { broadcastInvoiceUpdate } from './events.js';

export function createProvider() {
  if (config.rpcWsUrl) {
    try {
      return new WebSocketProvider(config.rpcWsUrl);
    } catch (e) {
      console.warn('[provider] Failed to connect WebSocket RPC, falling back to HTTP:', e.message);
    }
  }
  return new JsonRpcProvider(config.rpcUrl);
}

export function mainAddress() {
  return new Wallet(config.mainPrivateKey).address;
}

// One watcher per invoice and one money action at a time, so concurrent
// requests cannot double-sweep the same deposit.
const activeWatchers = new Set();
const invoiceLocks = new Map();

async function withInvoiceLock(id, fn) {
  if (invoiceLocks.has(id)) throw new Error('Another operation is already in progress for this invoice');
  invoiceLocks.set(id, true);
  try {
    return await fn();
  } finally {
    invoiceLocks.delete(id);
  }
}

function notify(stage, invoice, onUpdate) {
  if (!invoice) return;
  onUpdate?.(stage, invoice);
  broadcastInvoiceUpdate(invoice.id, stage, invoice);
  dispatchInvoiceEvent(stage, invoice);
}

function watchCallbacks(onUpdate, invoice) {
  return {
    onStatus: (stage, info) => {
      if (stage === 'detected') {
        const updated = { ...invoice, paidAmountWei: info.amountUnits };
        notify('detected', updated, onUpdate);
      } else if (stage === 'confirming' && (info.depth === 1 || info.depth % 2 === 0 || info.depth >= config.confirmations)) {
        const updated = { ...invoice, depth: info.depth };
        notify('confirming', updated, onUpdate);
      }
    },
  };
}

// Creates an invoice, then watches until the payment is confirmed. Stops at
// "paid" and waits for the user to choose Pay or Cancel.
export async function processInvoice({ expectedAmount, coin, companyCode, onUpdate } = {}) {
  const invoice = newInvoice({ expectedAmount, coin, companyCode });
  return processExistingInvoice(invoice.id, { onUpdate });
}

// Resume watching an already-created invoice (e.g. on restart). Ends at "paid".
export async function processExistingInvoice(id, { onUpdate } = {}) {
  const invoice = getInvoice(id);
  if (!invoice) throw new Error(`invoice ${id} not found`);
  if (invoice.status !== 'pending') return invoice;
  if (activeWatchers.has(id)) return invoice;

  const deadline = invoice.expiresAt ? Date.parse(invoice.expiresAt) : null;
  if (deadline && deadline <= Date.now()) {
    const expired = updateInvoice(id, { status: 'expired', error: 'Invoice expired before payment' });
    notify('expired', expired, onUpdate);
    return expired;
  }

  activeWatchers.add(id);
  try {
    const provider = createProvider();
    notify('created', invoice, onUpdate);

    let result;
    try {
      result = await waitForPayment({
        provider,
        coin: invoice.coin || 'ETH',
        address: invoice.address,
        confirmations: config.confirmations,
        pollIntervalMs: config.pollIntervalMs,
        deadline,
        ...watchCallbacks(onUpdate, invoice),
      });
    } catch (e) {
      if (e instanceof InvoiceExpiredError) {
        const expired = updateInvoice(id, { status: 'expired', error: e.message });
        notify('expired', expired, onUpdate);
        return expired;
      }
      throw e;
    }

  // Identify the sender so a refund is possible.
  let sender = null;
  let paidTxHash = null;
  try {
    if (isUtxoCoin(invoice.coin)) {
      sender = await fetchUtxoSender(invoice.coin, invoice.address);
    } else {
      const txs = await fetchIncomingTransactions(invoice.address);
      if (txs.length > 0) {
        sender = txs[0].from;
        paidTxHash = txs[0].hash;
      }
    }
  } catch (e) {
    notify('explorer_error', { ...invoice, error: String(e.message) }, onUpdate);
  }

  // Reject underpayments: the received amount must meet the signed amount.
  const expected = BigInt(invoice.expectedAmountWei || '0');
  const received = BigInt(result.balanceUnits);
  const underpaid = expected > 0n && received < expected;

  const finalStatus = underpaid ? 'underpaid' : 'paid';
  const updatedInvoice = updateInvoice(id, {
    status: finalStatus,
    paidAmountWei: result.balanceUnits,
    sender,
    paidTxHash,
    confirmedAt: new Date().toISOString(),
  });

    notify(finalStatus, updatedInvoice, onUpdate);
    return updatedInvoice;
  } finally {
    activeWatchers.delete(id);
  }
}

// User chose PAY: sweep the funds to the merchant's wallet.
export async function payInvoice(id, { onUpdate } = {}) {
  return withInvoiceLock(id, () => payInvoiceLocked(id, { onUpdate }));
}

async function payInvoiceLocked(id, { onUpdate } = {}) {
  const invoice = getInvoice(id);
  if (!invoice) throw new Error(`invoice ${id} not found`);
  if (invoice.status !== 'paid' && invoice.status !== 'forward_failed') return invoice;

  const coin = invoice.coin || 'ETH';
  const provider = createProvider();
  try {
    // Settle to the merchant's own wallet (linked by company code), falling
    // back to the global main account for legacy invoices without a code.
    const acct = invoice.companyCode ? findByCode(invoice.companyCode) : null;
    let toAddress;
    if (coin === 'ETH') toAddress = acct?.walletAddress || mainAddress();
    else if (coin === 'BTC') toAddress = acct?.btcAddress;
    else toAddress = acct?.ltcAddress;
    if (!toAddress) throw new Error(`No ${coin} wallet for this merchant`);

    let hash;
    let value;
    if (isUtxoCoin(coin)) {
      ({ hash, value } = await sweepUtxo({ coin, privateKeyWif: invoice.privateKey, toAddress }));
    } else {
      ({ hash, value } = await sweepTo({
        provider,
        privateKey: invoice.privateKey,
        toAddress,
        gasPriceGwei: config.gasPriceGwei,
        gasLimit: config.forwardGasLimit,
      }));
    }
    const updated = updateInvoice(id, { status: 'forwarded', forwardedTxHash: hash, settledAmountWei: value });
    notify('forwarded', updated, onUpdate);
    return updated;
  } catch (e) {
    const failed = updateInvoice(id, { status: 'forward_failed', error: String(e.message) });
    notify('forward_failed', failed, onUpdate);
    return failed;
  }
}

// User chose CANCEL: refund the funds back to the sender.
export async function cancelInvoice(id, { onUpdate } = {}) {
  return withInvoiceLock(id, () => cancelInvoiceLocked(id, { onUpdate }));
}

async function cancelInvoiceLocked(id, { onUpdate } = {}) {
  const invoice = getInvoice(id);
  if (!invoice) throw new Error(`invoice ${id} not found`);
  if (!['paid', 'underpaid', 'forward_failed'].includes(invoice.status)) return invoice;
  if (!invoice.sender) throw new Error('Cannot refund: sender unknown');

  const coin = invoice.coin || 'ETH';
  const provider = createProvider();
  try {
    let hash;
    if (isUtxoCoin(coin)) {
      ({ hash } = await sweepUtxo({ coin, privateKeyWif: invoice.privateKey, toAddress: invoice.sender }));
    } else {
      ({ hash } = await sweepTo({
        provider,
        privateKey: invoice.privateKey,
        toAddress: invoice.sender,
        gasPriceGwei: config.gasPriceGwei,
        gasLimit: config.forwardGasLimit,
      }));
    }
    const updated = updateInvoice(id, { status: 'refunded', refundedTxHash: hash });
    notify('refunded', updated, onUpdate);
    return updated;
  } catch (e) {
    const failed = updateInvoice(id, { status: 'refund_failed', error: String(e.message) });
    notify('refund_failed', failed, onUpdate);
    return failed;
  }
}
