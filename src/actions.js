// Sending quotes, invoices and payment reminders.
import { getSettings, getQuote, getInvoice, setQuoteStatus, markInvoiceSent, setInvoiceField } from './db.js';
import { renderQuote, renderInvoice } from './render.js';
import { quoteEmail, invoiceEmail, reminderEmail, REMINDER_STEPS } from './emails.js';
import { htmlToPdf } from './pdf.js';
import { send } from './mailer.js';
import { addDays, today } from './dates.js';

export async function sendQuote(db, id) {
  const s = getSettings(db);
  const q = getQuote(db, id);
  const pdf = await htmlToPdf(renderQuote(q, s));
  const result = await send(db, s, quoteEmail(q, s), { filename: `Hover-Guy-Quote-${q.number}.pdf`, content: pdf });
  if (q.status === 'draft') setQuoteStatus(db, id, 'sent');
  return result;
}

export async function invoicePdf(db, s, inv) {
  return { filename: `Hover-Guy-Invoice-${inv.number}.pdf`, content: await htmlToPdf(renderInvoice(inv, s)) };
}

export async function sendInvoice(db, id) {
  const s = getSettings(db);
  const inv = getInvoice(db, id);
  if (inv.status === 'void') throw new Error('This invoice is void.');
  const result = await send(db, s, invoiceEmail(inv, s), await invoicePdf(db, s, inv));
  markInvoiceSent(db, id);
  return result;
}

// The date (in the business timezone) an invoice was first emailed.
const sentDate = (inv, tz) => today(tz, new Date(`${inv.sent_at.replace(' ', 'T')}Z`));

/**
 * Works out which reminder, if any, an invoice needs today.
 * Only the latest step that has come due is sent; earlier ones that were missed
 * (server off, invoice sent late) are marked skipped so clients never get a burst of emails.
 */
export function reminderPlan(inv, s, todayIso) {
  if (!s.reminders_enabled || inv.status !== 'sent' || inv.balance <= 0) return null;
  if (inv.reminders_paused || !inv.client.reminders_enabled || !inv.sent_at) return null;
  const done = new Set(inv.reminders.map((r) => r.step));
  const sentOn = sentDate(inv, s.timezone);
  const due = REMINDER_STEPS
    .map((r) => ({ ...r, date: addDays(inv.due_on, r.offset) }))
    .filter((r) => r.date <= todayIso && !done.has(r.step));
  if (!due.length) return null;
  const send = due.at(-1);
  // A step falling on or before the day the invoice went out is covered by the invoice email itself.
  const sendIt = send.date > sentOn;
  return {
    send: sendIt ? send : null,
    skip: (sendIt ? due.slice(0, -1) : due).map((r) => r.step),
  };
}

export async function runReminders(db, { now = new Date(), log = console.log } = {}) {
  const s = getSettings(db);
  const t = today(s.timezone, now);
  const ids = db.prepare(`SELECT id FROM invoices WHERE status = 'sent'`).all().map((r) => r.id);
  const report = { date: t, sent: [], skipped: [], failed: [] };
  const record = db.prepare('INSERT OR IGNORE INTO reminders (invoice_id, step, status, on_date, detail) VALUES (?,?,?,?,?)');

  for (const id of ids) {
    const inv = getInvoice(db, id);
    const plan = reminderPlan(inv, s, t);
    if (!plan) continue;
    for (const step of plan.skip) {
      record.run(id, step, 'skipped', t, 'Superseded by a later reminder');
      report.skipped.push({ number: inv.number, step });
    }
    if (!plan.send) continue;
    const step = plan.send.step;
    try {
      const msg = reminderEmail(inv, s, step, t);
      const res = await send(db, s, msg, await invoicePdf(db, s, inv));
      record.run(id, step, 'sent', t, res.mode === 'outbox' ? 'Saved to outbox (test mode)' : `Emailed ${msg.to}`);
      if (step === 'final_30') setInvoiceField(db, id, 'needs_attention', 1);
      report.sent.push({ number: inv.number, step, to: msg.to, mode: res.mode });
      log(`Reminder ${step} for ${inv.number} -> ${msg.to} (${res.mode})`);
    } catch (e) {
      // Not recorded, so it is retried on the next run.
      report.failed.push({ number: inv.number, step, error: e.message });
      log(`Reminder ${step} for ${inv.number} failed: ${e.message}`);
    }
  }
  return report;
}
