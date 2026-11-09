import nodemailer from 'nodemailer';
import { config } from './config.js';
import { findByCode } from './accounts.js';
import { updateInvoiceNotification } from './store.js';
import { getSmtpConfig } from './settings.js';
import { fromUnits } from './coins.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function dashboardUrl() {
  return `${config.publicBaseUrl}/dashboard`;
}

function createTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: Boolean(smtp.secure),
    requireTLS: Boolean(smtp.requireTls),
    auth: smtp.user ? { user: smtp.user, pass: smtp.password || '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

export async function sendMail({ to, subject, text, html }) {
  const smtp = getSmtpConfig();
  if (!smtp.enabled) throw new Error('SMTP is not configured');
  const transport = createTransport(smtp);
  return transport.sendMail({
    from: smtp.fromName
      ? { name: smtp.fromName, address: smtp.fromEmail }
      : smtp.fromEmail,
    to,
    subject,
    text,
    html,
  });
}

export async function sendTestEmail(to) {
  const smtp = getSmtpConfig();
  if (!smtp.enabled) throw new Error('Enable and save SMTP settings first');
  const target = String(to || smtp.fromEmail || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
    throw new Error('A valid recipient email is required');
  }
  const info = await sendMail({
    to: target,
    subject: 'MSU Pay SMTP test',
    text: 'This is a test email from your MSU Pay SMTP configuration.',
    html: '<p>This is a test email from your <strong>MSU Pay</strong> SMTP configuration.</p>',
  });
  return { ok: true, messageId: info.messageId, to: target };
}

function amountLabel(invoice) {
  const coin = invoice.coin || 'ETH';
  const units = invoice.paidAmountWei || invoice.expectedAmountWei || '0';
  try {
    return `${fromUnits(units, coin)} ${coin}`;
  } catch {
    return `${units} ${coin}`;
  }
}

// Sends the merchant a "you got paid" email exactly once per invoice. Failures
// are recorded on the invoice so the admin page can surface them.
export async function notifyInvoicePaid(invoice) {
  try {
    if (!invoice?.id || invoice.status !== 'paid') return { skipped: true };
    if (invoice.notifyStatus === 'sent') return { skipped: true };

    const smtp = getSmtpConfig();
    if (!smtp.enabled) {
      updateInvoiceNotification(invoice.id, { status: 'skipped', error: 'SMTP is not configured' });
      return { skipped: true };
    }

    const account = invoice.companyCode ? findByCode(invoice.companyCode) : null;
    if (!account?.email) {
      updateInvoiceNotification(invoice.id, {
        status: 'skipped',
        error: invoice.companyCode ? 'Merchant account has no email address' : 'Invoice has no merchant company code',
      });
      return { skipped: true };
    }

    const company = account.companyName || account.companyCode;
    const amount = amountLabel(invoice);
    const url = dashboardUrl();
    const subject = `Your business got a payment — ${company}`;
    const text = [
      `Hi ${company},`,
      '',
      'Your business just received a confirmed payment.',
      '',
      `Amount: ${amount}`,
      `Invoice: ${invoice.id}`,
      `Company code: ${invoice.companyCode}`,
      `Status: ${invoice.status}`,
      '',
      'Open your dashboard to settle or refund the payment:',
      url,
      '',
      'This is an automated message from MSU Pay. Please do not reply.',
    ].join('\n');
    const html = `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;line-height:1.5;color:#1f2937;max-width:560px">
        <p>Hi ${escapeHtml(company)},</p>
        <p>Your business just received a confirmed payment.</p>
        <table style="border-collapse:collapse;margin:18px 0">
          <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Amount</td><td><strong>${escapeHtml(amount)}</strong></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Invoice</td><td><code>${escapeHtml(invoice.id)}</code></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Company code</td><td><code>${escapeHtml(invoice.companyCode)}</code></td></tr>
          <tr><td style="padding:4px 14px 4px 0;color:#6b7280">Status</td><td>${escapeHtml(invoice.status)}</td></tr>
        </table>
        <p><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;border-radius:10px;background:#4338ca;color:#fff;text-decoration:none">Open dashboard</a></p>
        <p style="font-size:12px;color:#6b7280">This is an automated message from MSU Pay. Please do not reply.</p>
      </div>
    `.trim();

    try {
      const info = await sendMail({ to: account.email, subject, text, html });
      updateInvoiceNotification(invoice.id, { status: 'sent', sentAt: new Date().toISOString(), error: null });
      console.log(`[mail] payment notification sent for invoice ${invoice.id} to ${account.email}`);
      return { sent: true, messageId: info.messageId };
    } catch (e) {
      updateInvoiceNotification(invoice.id, { status: 'failed', error: String(e.message).slice(0, 500) });
      console.error(`[mail] payment notification failed for invoice ${invoice.id}:`, e.message);
      return { failed: true, error: e.message };
    }
  } catch (e) {
    console.error('[mail] payment notification error:', e.message);
    return { failed: true, error: e.message };
  }
}
