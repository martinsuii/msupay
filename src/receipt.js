import PDFDocument from 'pdfkit';
import { fromUnits } from './coins.js';

const BLUE = '#4338ca';
const INK = '#1f2937';
const MUTED = '#6b7280';
const GREEN = '#16a34a';

function field(doc, label, value, y) {
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label.toUpperCase(), 40, y, { width: 160 });
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(value ?? '—', 200, y, { width: 210 });
}

function amount(units, coin) {
  return units && units !== '0' ? `${fromUnits(units, coin)} ${coin}` : null;
}

export function buildReceipt(invoice, { mainAddress }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const coin = invoice.coin || 'ETH';
    const networkLabel = coin === 'ETH' ? 'Ethereum' : `${coin}`;

    // Header
    doc.circle(40, 48, 7).fill(BLUE);
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK).text('MSU Pay', 54, 38);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Payment receipt', 54, 55);

    doc.moveDown(2);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text('Payment Receipt');
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(`${networkLabel} · ${coin}`);

    doc.moveDown(1.5);
    const amountStr = invoice.paidAmountWei ? fromUnits(invoice.paidAmountWei, coin) : '0';
    doc.font('Helvetica-Bold').fontSize(28).fillColor(BLUE).text(`${amountStr} ${coin}`);
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('Amount received');

    doc.moveDown(3);

    const statusLabel =
      invoice.status === 'forwarded' ? 'Completed'
      : invoice.status === 'refunded' ? 'Refunded'
      : invoice.status;

    const rows = [
      ['Receipt ID', invoice.id],
      ['Status', statusLabel],
      ['Created', invoice.createdAt ? new Date(invoice.createdAt).toLocaleString() : null],
      ['Confirmed', invoice.confirmedAt ? new Date(invoice.confirmedAt).toLocaleString() : null],
      ['Expected', amount(invoice.expectedAmountWei, coin)],
      ['Sender', invoice.sender],
      ['Deposit address', invoice.address],
      ['Settled to', mainAddress ?? null],
      ['Payment tx', invoice.paidTxHash],
      ['Settled tx', invoice.forwardedTxHash],
      ['Refund tx', invoice.refundedTxHash],
    ];

    let y = doc.y;
    for (const [label, value] of rows) {
      field(doc, label, value, y);
      y += 30;
    }

    doc.moveDown(1);
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
      .text(`This receipt was generated automatically by MSU Pay on ${networkLabel}.`, 40, y, { width: 340, align: 'center' });

    doc.end();
  });
}
