import { Wallet, parseUnits } from 'ethers';

// Sends the full balance (minus gas) from an invoice wallet to any address.
// Used both to forward to the main account and to refund a sender.
export async function sweepTo({ provider, privateKey, toAddress, gasPriceGwei, gasLimit }) {
  const signer = new Wallet(privateKey, provider);
  const balance = await provider.getBalance(signer.address);
  if (balance <= 0n) throw new Error('Nothing to send: balance is zero');

  const feeData = await provider.getFeeData();
  let maxFeePerGas;
  let maxPriorityFeePerGas;
  if (gasPriceGwei != null) {
    maxFeePerGas = parseUnits(String(gasPriceGwei), 'gwei');
    maxPriorityFeePerGas = maxFeePerGas;
  } else {
    maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
    maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? maxFeePerGas;
  }
  if (maxFeePerGas == null) throw new Error('Could not determine network gas price');

  const gasCost = maxFeePerGas * BigInt(gasLimit);
  const value = balance - gasCost;
  if (value <= 0n) throw new Error('Balance too small to cover gas');

  const tx = {
    to: toAddress,
    value,
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  };

  const response = await signer.sendTransaction(tx);
  return { hash: response.hash, value: value.toString() };
}
