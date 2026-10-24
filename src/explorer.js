import { config } from './config.js';

// Fetches incoming value transfers for an address from a block explorer that
// exposes an Etherscan-compatible API (Blockscout on mainnet by default).
export async function fetchIncomingTransactions(address) {
  const url = `${config.explorerBaseUrl}/api?module=account&action=txlist&address=${address}&sort=desc`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  if (data.status !== '1' || !Array.isArray(data.result)) return [];
  const target = address.toLowerCase();
  return data.result.filter(
    (t) => t.to && t.to.toLowerCase() === target && BigInt(t.value) > 0n,
  );
}

// Returns the `from` address of the most recent incoming transfer.
export async function fetchSender(address) {
  const txs = await fetchIncomingTransactions(address);
  return txs[0]?.from ?? null;
}
