import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import { COINS, isUtxoCoin } from './coins.js';
import { config } from './config.js';

const ECPair = ECPairFactory(tinysecp);

// mempool.space (BTC) / litecoinspace.org (LTC) — free, keyless, generous.
function apiBase(coin) {
  return coin === 'BTC' ? config.btcApiBase : config.ltcApiBase;
}

async function tipHeight(coin) {
  const res = await fetch(`${apiBase(coin)}/blocks/tip/height`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('explorer error');
  return parseInt(await res.text(), 10);
}

// Fetch unspent outputs + balance + confirmation depth for a BTC/LTC address.
export async function fetchUtxoInfo(coin, address) {
  const [utxoRes, tip] = await Promise.all([
    fetch(`${apiBase(coin)}/address/${address}/utxo`, { signal: AbortSignal.timeout(8000) }),
    tipHeight(coin),
  ]);
  if (!utxoRes.ok) throw new Error('explorer error');
  const raw = await utxoRes.json();
  const utxos = (Array.isArray(raw) ? raw : []).map((u) => {
    const confirmed = !!u.status?.confirmed;
    return {
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmations: confirmed ? tip - u.status.block_height + 1 : 0,
    };
  });
  const balance = utxos.reduce((s, u) => s + u.value, 0);
  const confirmations = utxos.length ? Math.min(...utxos.map((u) => u.confirmations)) : 0;
  return { utxos, balance, confirmations };
}

// Returns the sender (first input address) of the most recent incoming tx.
export async function fetchSender(coin, address) {
  const res = await fetch(`${apiBase(coin)}/address/${address}/txs`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const txs = await res.json();
  if (!Array.isArray(txs) || !txs.length) return null;
  const txRes = await fetch(`${apiBase(coin)}/tx/${txs[0].txid}`, { signal: AbortSignal.timeout(8000) });
  if (!txRes.ok) return null;
  const tx = await txRes.json();
  return tx?.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
}

function estimateFee(rate, inputCount, outputCount) {
  const vbytes = inputCount * 68 + outputCount * 31 + 11;
  return vbytes * rate;
}

async function feeRate(coin) {
  try {
    const res = await fetch(`${apiBase(coin)}/v1/fees/recommended`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const f = await res.json();
      const sat = f.halfHourFee || f.fastestFee || f.economyFee || f.minimumFee;
      if (sat && sat > 0) return sat;
    }
  } catch {
    /* fall through to a conservative default */
  }
  return coin === 'BTC' ? 8 : 12;
}

// Sweeps the full balance (minus fee) from an invoice key to a destination.
export async function sweepUtxo({ coin, privateKeyWif, toAddress }) {
  if (!isUtxoCoin(coin)) throw new Error(`sweepUtxo only supports BTC/LTC, got ${coin}`);
  const network = COINS[coin].network;
  const kp = ECPair.fromWIF(privateKeyWif, network);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network });

  const { utxos } = await fetchUtxoInfo(coin, address);
  if (!utxos.length) throw new Error('Nothing to send: no UTXOs');

  const script = bitcoin.address.toOutputScript(address, network);
  const psbt = new bitcoin.Psbt({ network });
  let total = 0n;
  for (const u of utxos) {
    psbt.addInput({
      hash: u.txid,
      index: u.vout,
      witnessUtxo: { script, value: BigInt(u.value) },
    });
    total += BigInt(u.value);
  }

  const fee = BigInt(estimateFee(await feeRate(coin), utxos.length, 2));
  const send = total - fee;
  if (send <= 0n) throw new Error('Balance too small to cover the network fee');

  psbt.addOutput({ address: toAddress, value: send });
  psbt.signAllInputs(kp);
  const tx = psbt.finalizeAllInputs().extractTransaction();
  const raw = tx.toHex();

  const res = await fetch(`${apiBase(coin)}/tx`, { method: 'POST', body: raw, signal: AbortSignal.timeout(15000) });
  const txid = (await res.text()).trim();
  if (!res.ok) throw new Error(txid || 'broadcast failed');
  return { hash: txid, value: send.toString() };
}
