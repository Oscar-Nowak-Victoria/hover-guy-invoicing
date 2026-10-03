// Email wording, in the brand voice: precise, calm, polite and firm about money.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { money } from './money.js';
import { longDate, addDays } from './dates.js';
import { esc } from './render.js';

const logoPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'brand', 'hover-guy-logo-horizontal-reverse.png');
const logoCid = 'hover-guy-logo@hoverguy';

const firstName = (c) => (c.contact_name || '').trim().split(/\s+/)[0] || 'there';
const amount = (s, cents) => `${s.currency} ${money(cents)}`;

function paymentLines(s, number) {
  return [
    ['Account name', s.bank_account_name],
    ['BSB', s.bank_bsb || '(add in Settings)'],
    ['Account no.', s.bank_account_number || '(add in Settings)'],
    ['Reference', number],
  ];
}

// Builds plain-text and HTML versions from the same paragraphs.
function compose(s, { paragraphs, payment }) {
  const sign = [s.sender_name, s.business_name].filter(Boolean);
  const text = [
    ...paragraphs,
    payment ? `Payment details\n${payment.map(([k, v]) => `${k}: ${v}`).join('\n')}` : null,
    sign.join('\n'),
  ].filter(Boolean).join('\n\n');

  const p = (t) => `<p style="margin:0 0 16px">${esc(t).replace(/\n/g, '<br>')}</p>`;
  const html = `<!doctype html><html><body style="margin:0;background:#EEF1F5">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1F5;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14223B">
  <tr><td style="background:#14223B;padding:20px 28px"><img src="cid:${logoCid}" alt="${esc(s.business_name)}" width="180" style="display:block;width:180px;height:auto;border:0"></td></tr>
  <tr><td style="padding:28px">
    ${paragraphs.map(p).join('\n')}
    ${payment ? `<table role="presentation" cellpadding="0" cellspacing="0" style="background:#EEF1F5;width:100%;margin:0 0 16px"><tr><td style="padding:16px 18px">
      <div style="font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;color:#8A96A8;margin-bottom:8px">PAYMENT DETAILS</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#14223B">
        ${payment.map(([k, v]) => `<tr><td style="padding:2px 16px 2px 0;color:#8A96A8">${esc(k)}</td><td style="padding:2px 0">${esc(v)}</td></tr>`).join('')}
      </table></td></tr></table>` : ''}
    ${p(sign.join('\n'))}
  </td></tr>
  <tr><td style="border-top:3px solid #FF6A13;padding:14px 28px;font-size:12px;color:#8A96A8">Certified pilots for your fleet.</td></tr>
</table></td></tr></table></body></html>`;

  return { text, html, inlineAttachments: [{ filename: 'hover-guy-logo.png', content: readFileSync(logoPath), cid: logoCid }] };
}

export function quoteEmail(q, s) {
  const c = q.client;
  return {
    kind: 'quote', quote_id: q.id, to: c.email,
    subject: `Quote ${q.number}: ${q.title}`,
    ...compose(s, {
      paragraphs: [
        `Hi ${firstName(c)},`,
        `Thanks for the brief. Quote ${q.number} for ${amount(s, q.total)} (including ${s.tax_label}) is attached, valid until ${longDate(q.valid_until)}.`,
        'Reply to this email to accept, or with any changes.',
      ],
    }),
  };
}

export function invoiceEmail(inv, s) {
  const c = inv.client;
  return {
    kind: 'invoice', invoice_id: inv.id, to: c.accounts_email || c.email,
    subject: `Invoice ${inv.number} from ${s.business_name}, due ${longDate(inv.due_on)}`,
    ...compose(s, {
      paragraphs: [
        `Hi ${firstName(c)},`,
        `Invoice ${inv.number} for ${amount(s, inv.balance)} is attached${inv.title ? ` (${inv.title})` : ''}. Payment is due on ${longDate(inv.due_on)}.`,
      ],
      payment: paymentLines(s, inv.number),
    }),
  };
}

export const REMINDER_STEPS = [
  { step: 'pre_due', offset: -3, label: '3 days before due' },
  { step: 'due', offset: 0, label: 'On the due date' },
  { step: 'overdue_7', offset: 7, label: '7 days overdue' },
  { step: 'overdue_14', offset: 14, label: '14 days overdue' },
  { step: 'final_30', offset: 30, label: 'Final notice, 30 days overdue' },
];

export function reminderEmail(inv, s, step, todayIso) {
  const c = inv.client;
  const owed = amount(s, inv.balance);
  const due = longDate(inv.due_on);
  const part = inv.paid > 0 ? ` (balance remaining after ${amount(s, inv.paid)} received)` : '';
  const copy = {
    pre_due: {
      subject: `Invoice ${inv.number} due ${due}`,
      body: [`A reminder that invoice ${inv.number} for ${owed}${part} is due on ${due}. Payment details are below and the invoice is attached.`],
    },
    due: {
      subject: `Invoice ${inv.number} due today`,
      body: [`Invoice ${inv.number} for ${owed}${part} is due today. Payment details are below. If it's already on its way, thank you and please ignore this.`],
    },
    overdue_7: {
      subject: `Invoice ${inv.number} is 7 days overdue`,
      body: [`Invoice ${inv.number} for ${owed}${part} was due on ${due} and is now 7 days overdue. Please arrange payment, or reply with an expected payment date. Invoice attached.`],
    },
    overdue_14: {
      subject: `Invoice ${inv.number} is 14 days overdue`,
      body: [`Invoice ${inv.number} for ${owed}${part} was due on ${due} and is now 14 days overdue. Please arrange payment, or reply with an expected payment date. Invoice attached.`],
    },
    final_30: {
      subject: `Final notice: invoice ${inv.number}`,
      body: [`Invoice ${inv.number} for ${owed}${part} is now 30 days overdue. Please settle it by ${longDate(addDays(todayIso, 7))}.`, "If there's a problem with the invoice, reply and I'll sort it out."],
    },
  }[step];
  return {
    kind: `reminder:${step}`, invoice_id: inv.id, to: c.accounts_email || c.email,
    subject: copy.subject,
    ...compose(s, { paragraphs: [`Hi ${firstName(c)},`, ...copy.body], payment: paymentLines(s, inv.number) }),
  };
}

// Sent only to the accounts address, to prove the mailbox connection works.
export function testEmail(s) {
  return {
    kind: 'test',
    subject: `Test email from ${s.business_name} invoicing`,
    ...compose(s, {
      paragraphs: [
        'This is a test from your invoicing app.',
        `If you can read this, ${s.email} is connected. Quotes, invoices and reminders will arrive looking like this, with the PDF attached.`,
      ],
    }),
  };
}
