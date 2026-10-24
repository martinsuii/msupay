import { EventEmitter } from 'node:events';

const invoiceEmitter = new EventEmitter();
invoiceEmitter.setMaxListeners(200);

export function broadcastInvoiceUpdate(invoiceId, stage, invoice) {
  if (!invoiceId) return;
  invoiceEmitter.emit(`invoice:${invoiceId}`, { stage, invoice });
}

export function handleInvoiceSSE(req, res, invoiceId, initialData = null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.flushHeaders?.();

  // Send initial data if available
  if (initialData) {
    res.write(`event: status\ndata: ${JSON.stringify({ stage: initialData.status, invoice: initialData })}\n\n`);
  }

  const listener = ({ stage, invoice }) => {
    res.write(`event: status\ndata: ${JSON.stringify({ stage, invoice })}\n\n`);
  };

  const eventKey = `invoice:${invoiceId}`;
  invoiceEmitter.on(eventKey, listener);

  // Keep-alive heartbeat every 15 seconds
  const pingTimer = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(pingTimer);
    invoiceEmitter.off(eventKey, listener);
  });
}
