import { formatEther } from 'ethers';
import { processInvoice, processExistingInvoice } from './processor.js';
import { listInvoices } from './store.js';

const [cmd] = process.argv.slice(2);

if (cmd === 'invoice') {
  processInvoice({ onUpdate: logUpdate }).catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === 'watch') {
  const open = listInvoices().filter((i) => i.status === 'pending').at(-1);
  if (!open) {
    console.error('No pending invoice. Run `npm run invoice` first.');
    process.exit(1);
  }
  console.log(`watching ${open.address} (id ${open.id})`);
  processExistingInvoice(open.id, { onUpdate: logUpdate }).catch((e) => { console.error(e); process.exit(1); });
} else {
  console.log('usage: npm run invoice   # create + watch + forward (CLI)');
  console.log('       npm run watch     # re-attach to last pending invoice');
  console.log('       npm start         # run the backend server + frontend');
}

function logUpdate(stage, inv) {
  switch (stage) {
    case 'created':
      console.log(`\n[invoice] ${inv.id}`);
      console.log(`  pay to: ${inv.address}`);
      if (inv.expectedAmountWei && inv.expectedAmountWei !== '0') {
        console.log(`  amount : ${formatEther(inv.expectedAmountWei)} ETH`);
      }
      break;
    case 'detected':
      console.log(`  [+] payment received: ${formatEther(inv.paidAmountWei)} ETH`);
      break;
    case 'confirming':
      console.log(`  ... confirming (depth ${inv.depth})`);
      break;
    case 'paid':
      console.log('  [+] confirmed');
      break;
    case 'forwarded':
      console.log(`  [+] forwarded  tx: ${inv.forwardedTxHash}`);
      break;
    case 'forward_failed':
      console.log(`  [!] forward failed: ${inv.error}`);
      break;
  }
}
