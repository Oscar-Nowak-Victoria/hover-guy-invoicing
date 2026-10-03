import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OUTBOX_DIR = mkdtempSync(join(tmpdir(), 'hg-outbox-'));
delete process.env.SEND_MODE;

const db_ = await import('../src/db.js');
const { openDb, updateSettings, saveClient, saveQuote, getQuote, invoiceFromQuote, getInvoice, recordPayment, deletePayment, totals, listEmails } = db_;
const { reminderPlan, runReminders, sendInvoice, sendQuote } = await import('../src/actions.js');
const { closePdf } = await import('../src/pdf.js');
const { money, parseMoney } = await import('../src/money.js');
const { addDays } = await import('../src/dates.js');

const lines = [
  { description: 'Pilot in command, full day', quantity: 1, unit: 'day', unit_price: 55000, taxable: 1 },
  { description: 'Visual observer', quantity: 1, unit: 'day', unit_price: 38000, taxable: 1 },
  { description: 'Site survey', quantity: 2, unit: 'hr', unit_price: 6000, taxable: 1 },
  { description: 'Travel', quantity: 110, unit: 'km', unit_price: 88, taxable: 1 },
];

function fresh() {
  const db = openDb(':memory:');
  updateSettings(db, { email: 'accounts@hoverguy.example', bank_bsb: '000-000', bank_account_number: '12345678' });
  const client = saveClient(db, { company: 'Skyline Survey Pty Ltd', contact_name: 'Priya Shah', email: 'priya@skyline.example', accounts_email: 'accounts@skyline.example' });
  return { db, client };
}

test('money formatting and parsing', () => {
  assert.equal(money(126148), '1,261.48');
  assert.equal(money(5), '0.05');
  assert.equal(parseMoney('$1,261.48'), 126148);
  assert.ok(Number.isNaN(parseMoney('')));
});

test('ABN checksum', () => {
  assert.equal(db_.validAbn('90 473 894 126'), true);
  assert.equal(db_.validAbn('90 473 894 127'), false);
  assert.equal(db_.validAbn('1234'), false);
});

test('new databases start with Hover Guy business details', () => {
  const s = db_.getSettings(openDb(':memory:'));
  assert.equal(s.address, '210a Fussell Street\nBallarat East VIC 3350');
  assert.equal(s.abn, '90 473 894 126');
  assert.equal(s.casa_arn, '1160738');
  assert.equal(s.timezone, 'Australia/Melbourne');
});

test('totals match the sample invoice (AUD, 10% GST)', () => {
  assert.deepEqual(totals(lines, 0.1), { subtotal: 114680, tax: 11468, total: 126148 });
  assert.equal(totals([{ quantity: 1, unit_price: 1000, taxable: 0 }], 0.1).tax, 0);
});

test('quotes and invoices share one HG-0000 sequence, and a quote converts once', () => {
  const { db, client } = fresh();
  const qid = saveQuote(db, { client_id: client, title: 'Roof inspection', lines });
  const q = getQuote(db, qid);
  assert.equal(q.number, 'HG-0001');
  assert.equal(q.total, 126148);
  const iid = invoiceFromQuote(db, qid);
  assert.equal(invoiceFromQuote(db, qid), iid);
  const inv = getInvoice(db, iid);
  assert.equal(inv.number, 'HG-0002');
  assert.equal(inv.total, 126148);
  assert.equal(inv.due_on, addDays(inv.issued_on, 14));
  assert.equal(getQuote(db, qid).status, 'accepted');
});

test('payments mark the invoice paid, and undoing one reopens it', () => {
  const { db, client } = fresh();
  const iid = db_.saveInvoice(db, { client_id: client, title: 'Job', lines });
  db_.markInvoiceSent(db, iid);
  recordPayment(db, iid, { amount: 100000, received_on: '2026-10-10' });
  let inv = getInvoice(db, iid);
  assert.equal(inv.status, 'sent');
  assert.equal(inv.balance, 26148);
  assert.equal(inv.display_status, 'part paid');
  recordPayment(db, iid, { amount: 26148, received_on: '2026-10-11' });
  assert.equal(getInvoice(db, iid).status, 'paid');
  deletePayment(db, getInvoice(db, iid).payments[1].id);
  assert.equal(getInvoice(db, iid).status, 'sent');
});

function sentInvoice(db, client, { issued, due, sentAt }) {
  const iid = db_.saveInvoice(db, { client_id: client, title: 'Job', lines, issued_on: issued, due_on: due });
  db_.markInvoiceSent(db, iid);
  db.prepare('UPDATE invoices SET sent_at = ? WHERE id = ?').run(sentAt, iid);
  return iid;
}

test('reminder schedule: one step at a time, missed steps skipped, nothing once paid', () => {
  const { db, client } = fresh();
  const s = db_.getSettings(db);
  const iid = sentInvoice(db, client, { issued: '2026-10-03', due: '2026-10-17', sentAt: '2026-10-03 00:00:00' });
  const plan = (d) => reminderPlan(getInvoice(db, iid), s, d);

  assert.equal(plan('2026-10-13'), null);
  assert.equal(plan('2026-10-14').send.step, 'pre_due');
  assert.equal(plan('2026-10-17').send.step, 'due');
  // Server was off for a while: only the latest step goes out.
  assert.deepEqual(plan('2026-11-02'), { send: plan('2026-11-02').send, skip: ['pre_due', 'due', 'overdue_7'] });
  assert.equal(plan('2026-11-02').send.step, 'overdue_14');

  db_.setInvoiceField(db, iid, 'reminders_paused', 1);
  assert.equal(plan('2026-11-02'), null);
  db_.setInvoiceField(db, iid, 'reminders_paused', 0);

  recordPayment(db, iid, { amount: 126148, received_on: '2026-10-20' });
  assert.equal(plan('2026-11-02'), null);
});

test('an invoice sent on or after its due date gets no same-day reminder', () => {
  const { db, client } = fresh();
  const s = db_.getSettings(db);
  const iid = sentInvoice(db, client, { issued: '2026-10-01', due: '2026-10-03', sentAt: '2026-10-03 01:00:00' });
  const p = reminderPlan(getInvoice(db, iid), s, '2026-10-03');
  assert.equal(p.send, null);
  assert.deepEqual(p.skip, ['pre_due', 'due']);
});

test('sending saves to the outbox with a PDF attached, and runReminders is idempotent', { timeout: 60000 }, async () => {
  process.env.CHROMIUM_PATH ??= '/opt/pw-browsers/chromium';
  const { db, client } = fresh();
  const qid = saveQuote(db, { client_id: client, title: 'Roof inspection', lines });
  await sendQuote(db, qid);
  const iid = invoiceFromQuote(db, qid);
  await sendInvoice(db, iid);
  db.prepare('UPDATE invoices SET issued_on = ?, due_on = ?, sent_at = ? WHERE id = ?').run('2026-09-01', '2026-09-15', '2026-09-01 00:00:00', iid);

  const now = new Date('2026-09-22T00:00:00Z'); // 22 Sep in Brisbane: 7 days overdue
  const r1 = await runReminders(db, { now, log: () => {} });
  assert.deepEqual(r1.sent.map((x) => x.step), ['overdue_7']);
  assert.deepEqual(r1.skipped.map((x) => x.step), ['pre_due', 'due']);
  const r2 = await runReminders(db, { now, log: () => {} });
  assert.equal(r2.sent.length + r2.skipped.length, 0);

  const emails = listEmails(db);
  assert.deepEqual(emails.map((e) => e.kind).reverse(), ['quote', 'invoice', 'reminder:overdue_7']);
  assert.ok(emails.every((e) => e.mode === 'outbox' && e.to_address));
  const files = readdirSync(process.env.OUTBOX_DIR);
  assert.equal(files.length, 3);
  const eml = readFileSync(join(process.env.OUTBOX_DIR, files.sort().at(-1)), 'utf8');
  assert.match(eml, /Subject: Invoice HG-0002 is 7 days overdue/);
  assert.match(eml, /application\/pdf/);
  assert.match(eml, /To: accounts@skyline\.example/);
  await closePdf();
});
