import { fetchUtxoInfo } from './btc.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class InvoiceExpiredError extends Error {
  constructor() {
    super('Invoice expired before payment');
    this.name = 'InvoiceExpiredError';
  }
}

function checkDeadline(deadline) {
  if (deadline && Date.now() >= deadline) throw new InvoiceExpiredError();
}

async function waitEthPayment({ provider, address, confirmations, pollIntervalMs, onStatus, deadline }) {
  if (onStatus) onStatus('watching', { address });
  let seenBalance = null;
  let firstSeenBlock = null;

  while (true) {
    checkDeadline(deadline);
    const balance = await provider.getBalance(address);
    if (balance > 0n && seenBalance === null) {
      seenBalance = balance;
      firstSeenBlock = await provider.getBlockNumber();
      if (onStatus) onStatus('detected', { address, amountUnits: balance.toString() });
    }

    if (seenBalance !== null) {
      const latest = await provider.getBlockNumber();
      const depth = latest - firstSeenBlock + 1;
      if (onStatus) onStatus('confirming', { depth, needed: confirmations });
      if (depth >= confirmations) {
        return { balanceUnits: seenBalance.toString(), confirmations: depth };
      }
    }

    await sleep(pollIntervalMs);
  }
}

async function waitUtxoPayment({ coin, address, confirmations, pollIntervalMs, onStatus, deadline }) {
  if (onStatus) onStatus('watching', { address });
  while (true) {
    checkDeadline(deadline);
    let info = { balance: 0, confirmations: 0 };
    try {
      info = await fetchUtxoInfo(coin, address);
    } catch {
      /* transient explorer error; keep polling */
    }

    if (info.balance > 0) {
      if (onStatus) onStatus('detected', { address, amountUnits: String(info.balance) });
      if (onStatus) onStatus('confirming', { depth: info.confirmations, needed: confirmations });
      if (info.confirmations >= confirmations) {
        return { balanceUnits: String(info.balance), confirmations: info.confirmations };
      }
    }

    await sleep(pollIntervalMs);
  }
}

export async function waitForPayment({ provider, coin = 'ETH', address, confirmations, pollIntervalMs, onStatus, deadline }) {
  if (coin === 'ETH') {
    return waitEthPayment({ provider, address, confirmations, pollIntervalMs, onStatus, deadline });
  }
  return waitUtxoPayment({ coin, address, confirmations, pollIntervalMs, onStatus, deadline });
}
