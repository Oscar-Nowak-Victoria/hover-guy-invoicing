import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addDays, today } from './dates.js';

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path = process.env.DB_PATH || join(here, '..', 'data', 'hover-guy.db')) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

// Columns added after the first release. CREATE TABLE IF NOT EXISTS won't add them to an existing database.
function migrate(db) {
  const has = new Set(db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name));
  if (!has.has('casa_arn')) db.exec(`ALTER TABLE settings ADD COLUMN casa_arn TEXT NOT NULL DEFAULT ''`);
}

// Checks an ABN with the ATO's published checksum (11 digits, weighted sum divisible by 89).
export function validAbn(abn) {
  const d = String(abn).replace(/\s/g, '');
  if (!/^\d{11}$/.test(d)) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  return [...d].reduce((sum, c, i) => sum + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0) % 89 === 0;
}

export const getSettings = (db) => db.prepare('SELECT * FROM settings WHERE id = 1').get();

export function updateSettings(db, values) {
  const cols = Object.keys(values).filter((k) => k !== 'id' && k !== 'next_number');
  if (!cols.length) return;
  db.prepare(`UPDATE settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = 1`)
    .run(...cols.map((c) => values[c]));
}

export const formatNumber = (n) => `HG-${String(n).padStart(4, '0')}`;

export function nextNumber(db) {
  const { next_number } = db.prepare('UPDATE settings SET next_number = next_number + 1 WHERE id = 1 RETURNING next_number - 1 AS next_number').get();
  return formatNumber(next_number);
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- clients ----------
const CLIENT_COLS = ['company', 'contact_name', 'email', 'accounts_email', 'address', 'abn', 'payment_terms_days', 'reminders_enabled', 'notes'];

export const listClients = (db) => db.prepare(`
  SELECT c.*, (SELECT COUNT(*) FROM invoices i WHERE i.client_id = c.id AND i.status = 'sent') AS open_invoices
  FROM clients c ORDER BY company COLLATE NOCASE`).all();
export const getClient = (db, id) => db.prepare('SELECT * FROM clients WHERE id = ?').get(id);

export function saveClient(db, values, id) {
  const v = CLIENT_COLS.map((c) => values[c] ?? (c === 'reminders_enabled' ? 1 : c === 'payment_terms_days' ? null : ''));
  if (id) {
    db.prepare(`UPDATE clients SET ${CLIENT_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...v, id);
    return Number(id);
  }
  return Number(db.prepare(`INSERT INTO clients (${CLIENT_COLS.join(', ')}) VALUES (${CLIENT_COLS.map(() => '?').join(', ')})`).run(...v).lastInsertRowid);
}

// ---------- rate card ----------
export const listRates = (db, all = false) => db.prepare(`SELECT * FROM rate_card ${all ? '' : 'WHERE active = 1'} ORDER BY id`).all();

export function saveRate(db, r, id) {
  const v = [r.name, r.detail ?? '', r.unit ?? '', r.unit_price, r.taxable ?? 1, r.active ?? 1];
  if (id) return db.prepare('UPDATE rate_card SET name=?, detail=?, unit=?, unit_price=?, taxable=?, active=? WHERE id=?').run(...v, id);
  return db.prepare('INSERT INTO rate_card (name, detail, unit, unit_price, taxable, active) VALUES (?,?,?,?,?,?)').run(...v);
}

// ---------- line items & totals ----------
export const getLines = (db, kind, id) =>
  db.prepare(`SELECT * FROM line_items WHERE ${kind}_id = ? ORDER BY position`).all(id);

function replaceLines(db, kind, id, lines) {
  db.prepare(`DELETE FROM line_items WHERE ${kind}_id = ?`).run(id);
  const ins = db.prepare(`INSERT INTO line_items (${kind}_id, position, description, detail, quantity, unit, unit_price, taxable) VALUES (?,?,?,?,?,?,?,?)`);
  lines.forEach((l, i) => ins.run(id, i + 1, l.description, l.detail ?? '', l.quantity, l.unit ?? '', l.unit_price, l.taxable ?? 1));
}

export const lineAmount = (l) => Math.round(l.quantity * l.unit_price);

export function totals(lines, taxRate) {
  const subtotal = lines.reduce((s, l) => s + lineAmount(l), 0);
  const taxable = lines.filter((l) => l.taxable).reduce((s, l) => s + lineAmount(l), 0);
  const tax = Math.round(taxable * taxRate);
  return { subtotal, tax, total: subtotal + tax };
}

// ---------- quotes ----------
export const listQuotes = (db) => db.prepare(`
  SELECT q.*, c.company FROM quotes q JOIN clients c ON c.id = q.client_id ORDER BY q.id DESC`).all();

export function getQuote(db, id) {
  const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
  if (!q) return null;
  const s = getSettings(db);
  q.client = getClient(db, q.client_id);
  q.lines = getLines(db, 'quote', id);
  Object.assign(q, totals(q.lines, s.tax_rate));
  q.invoice = db.prepare('SELECT id, number FROM invoices WHERE quote_id = ?').get(id) ?? null;
  return q;
}

export function saveQuote(db, values, id) {
  return tx(db, () => {
    const s = getSettings(db);
    const issued = values.issued_on || today(s.timezone);
    const valid = values.valid_until || addDays(issued, s.quote_valid_days);
    const f = [values.client_id, values.title, values.summary ?? '', values.site ?? '', values.job_date || null, issued, valid];
    if (id) {
      db.prepare('UPDATE quotes SET client_id=?, title=?, summary=?, site=?, job_date=?, issued_on=?, valid_until=? WHERE id=?').run(...f, id);
    } else {
      id = Number(db.prepare('INSERT INTO quotes (number, client_id, title, summary, site, job_date, issued_on, valid_until) VALUES (?,?,?,?,?,?,?,?)')
        .run(nextNumber(db), ...f).lastInsertRowid);
    }
    replaceLines(db, 'quote', id, values.lines ?? []);
    return id;
  });
}

export const setQuoteStatus = (db, id, status) =>
  db.prepare(`UPDATE quotes SET status = ?, sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, CURRENT_TIMESTAMP) ELSE sent_at END WHERE id = ?`).run(status, status, id);

export function expireQuotes(db) {
  const s = getSettings(db);
  db.prepare(`UPDATE quotes SET status = 'expired' WHERE status = 'sent' AND valid_until < ?`).run(today(s.timezone));
}

// ---------- invoices ----------
const PAID_SQL = '(SELECT COALESCE(SUM(amount), 0) FROM payments p WHERE p.invoice_id = i.id)';

export function listInvoices(db) {
  const s = getSettings(db);
  return db.prepare(`SELECT i.*, c.company, ${PAID_SQL} AS paid FROM invoices i JOIN clients c ON c.id = i.client_id ORDER BY i.id DESC`).all()
    .map((i) => decorateInvoice(db, i, s));
}

function decorateInvoice(db, inv, s) {
  inv.lines = getLines(db, 'invoice', inv.id);
  Object.assign(inv, totals(inv.lines, s.tax_rate));
  inv.paid ??= db.prepare('SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE invoice_id = ?').get(inv.id).p;
  inv.balance = inv.total - inv.paid;
  inv.overdue = inv.status === 'sent' && inv.balance > 0 && inv.due_on < today(s.timezone);
  inv.display_status = inv.status === 'sent'
    ? (inv.overdue ? 'overdue' : inv.paid > 0 ? 'part paid' : 'sent')
    : inv.status;
  return inv;
}

export function getInvoice(db, id) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return null;
  const s = getSettings(db);
  decorateInvoice(db, inv, s);
  inv.client = getClient(db, inv.client_id);
  inv.quote = inv.quote_id ? db.prepare('SELECT id, number FROM quotes WHERE id = ?').get(inv.quote_id) : null;
  inv.payments = db.prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY received_on').all(id);
  inv.reminders = db.prepare('SELECT * FROM reminders WHERE invoice_id = ? ORDER BY on_date, id').all(id);
  return inv;
}

export function termsFor(db, clientId) {
  const s = getSettings(db);
  const c = getClient(db, clientId);
  return c?.payment_terms_days ?? s.payment_terms_days;
}

export function saveInvoice(db, values, id) {
  return tx(db, () => {
    const s = getSettings(db);
    const issued = values.issued_on || today(s.timezone);
    const due = values.due_on || addDays(issued, termsFor(db, values.client_id));
    const f = [values.client_id, values.client_po ?? '', values.title, values.summary ?? '', issued, due];
    if (id) {
      db.prepare('UPDATE invoices SET client_id=?, client_po=?, title=?, summary=?, issued_on=?, due_on=? WHERE id=?').run(...f, id);
    } else {
      id = Number(db.prepare('INSERT INTO invoices (number, quote_id, client_id, client_po, title, summary, issued_on, due_on) VALUES (?,?,?,?,?,?,?,?)')
        .run(nextNumber(db), values.quote_id ?? null, ...f).lastInsertRowid);
    }
    replaceLines(db, 'invoice', id, values.lines ?? []);
    return id;
  });
}

export function invoiceFromQuote(db, quoteId) {
  const q = getQuote(db, quoteId);
  if (q.invoice) return q.invoice.id;
  const id = saveInvoice(db, {
    quote_id: q.id, client_id: q.client_id, title: q.title,
    summary: q.summary, lines: q.lines,
  });
  setQuoteStatus(db, quoteId, 'accepted');
  return id;
}

export function markInvoiceSent(db, id) {
  db.prepare(`UPDATE invoices SET status = 'sent', sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP) WHERE id = ? AND status = 'draft'`).run(id);
}

export function recordPayment(db, invoiceId, p) {
  return tx(db, () => {
    db.prepare('INSERT INTO payments (invoice_id, amount, received_on, method, reference) VALUES (?,?,?,?,?)')
      .run(invoiceId, p.amount, p.received_on, p.method || 'Bank transfer', p.reference ?? '');
    const inv = getInvoice(db, invoiceId);
    if (inv.balance <= 0 && inv.status === 'sent') {
      db.prepare(`UPDATE invoices SET status = 'paid', needs_attention = 0 WHERE id = ?`).run(invoiceId);
    }
  });
}

export function deletePayment(db, paymentId) {
  return tx(db, () => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p) return;
    db.prepare('DELETE FROM payments WHERE id = ?').run(paymentId);
    const inv = getInvoice(db, p.invoice_id);
    if (inv.status === 'paid' && inv.balance > 0) db.prepare(`UPDATE invoices SET status = 'sent' WHERE id = ?`).run(inv.id);
    return p.invoice_id;
  });
}

export const setInvoiceField = (db, id, field, value) => {
  if (!['reminders_paused', 'needs_attention', 'status'].includes(field)) throw new Error('bad field');
  db.prepare(`UPDATE invoices SET ${field} = ? WHERE id = ?`).run(value, id);
};

export function logEmail(db, e) {
  db.prepare('INSERT INTO emails (kind, quote_id, invoice_id, to_address, subject, mode, file) VALUES (?,?,?,?,?,?,?)')
    .run(e.kind, e.quote_id ?? null, e.invoice_id ?? null, e.to, e.subject, e.mode, e.file ?? null);
}

export const listEmails = (db, limit = 100) => db.prepare('SELECT * FROM emails ORDER BY id DESC LIMIT ?').all(limit);
