import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import { Wallet, parseUnits, formatUnits } from 'ethers';

const ECPair = ECPairFactory(tinysecp);

// Litecoin mainnet network parameters (not bundled with bitcoinjs-lib).
export const LITECOIN_NETWORK = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: { public: 0x019da462, private: 0x019d9cfe },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

export const COINS = {
  ETH: { symbol: 'ETH', decimals: 18, api: null },
  BTC: { symbol: 'BTC', decimals: 8, network: bitcoin.networks.bitcoin, api: 'btc' },
  LTC: { symbol: 'LTC', decimals: 8, network: LITECOIN_NETWORK, api: 'ltc' },
};

export function isUtxoCoin(coin) {
  return coin === 'BTC' || coin === 'LTC';
}

// Generates a fresh keypair + address for a coin. Returns the private key in a
// coin-appropriate encoding (hex for ETH, WIF for BTC/LTC).
export function generateCoinKey(coin) {
  if (coin === 'ETH') {
    const w = Wallet.createRandom();
    return { address: w.address, privateKey: w.privateKey };
  }
  const network = COINS[coin].network;
  const kp = ECPair.makeRandom({ network });
  const { address } = bitcoin.payments.p2wpkh({ pubkey: kp.publicKey, network });
  return { address, privateKey: kp.toWIF() };
}

// Decimal amount string -> base-unit string (wei / satoshi / litoshi).
export function toUnits(amountStr, coin) {
  const decimals = COINS[coin].decimals;
  if (coin === 'ETH') return parseUnits(String(amountStr), decimals).toString();
  return String(Math.round(parseFloat(amountStr) * 10 ** decimals));
}

// Base-unit string -> decimal amount string.
export function fromUnits(amountStr, coin) {
  if (coin === 'ETH') return formatUnits(amountStr, 'ether');
  return (Number(amountStr) / 10 ** COINS[coin].decimals)
    .toFixed(8)
    .replace(/\.?0+$/, '');
}

// BIP-21 (BTC/LTC) or EIP-681 (ETH) payment URI for the QR code.
export function qrUri(coin, address, amountUnits) {
  if (coin === 'ETH') {
    let uri = `ethereum:${address}@1`;
    if (amountUnits && amountUnits !== '0') uri += `?value=${amountUnits}`;
    return uri;
  }
  let uri = `${coin.toLowerCase()}:${address}`;
  if (amountUnits && amountUnits !== '0') uri += `?amount=${fromUnits(amountUnits, coin)}`;
  return uri;
}
