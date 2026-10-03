// Hover Guy quoting & invoicing: admin web app, plus the daily payment-reminder run.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import * as D from './src/db.js';
import { renderQuote, renderInvoice } from './src/render.js';
import { quoteEmail, invoiceEmail, REMINDER_STEPS } from './src/emails.js';
import { sendQuote, sendInvoice, runReminders, invoicePdf } from './src/actions.js';
import { htmlToPdf } from './src/pdf.js';
import { abrConfigured, lookupAbn, searchNames } from './src/abr.js';
import { sendMode } from './src/mailer.js';
import { money, parseMoney } from './src/money.js';
import { today, shortDate, addDays, daysBetween } from './src/dates.js';
import { layout, esc, pill, cur, pageHead, postButton, field, area, checkbox, select, itemsEditor } from './src/ui.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || (process.env.ADMIN_PASSWORD ? '0.0.0.0' : '127.0.0.1');
if (!process.env.ADMIN_PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
  console.error('Refusing to start: set ADMIN_PASSWORD before making the app reachable from other computers.');
  process.exit(1);
}
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR ?? 9);
const db = D.openDb();

// ---------------------------------------------------------------- helpers

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const notFound = () => { throw new HttpError(404, 'Not found'); };

function readForm(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) reject(new HttpError(413, 'Too large')); });
    req.on('end', () => resolve(new URLSearchParams(data)));
    req.on('error', reject);
  });
}

function linesFromForm(f) {
  const d = f.getAll('li_description'), det = f.getAll('li_detail'), q = f.getAll('li_quantity');
  const u = f.getAll('li_unit'), p = f.getAll('li_price'), t = f.getAll('li_taxable');
  return d.map((desc, i) => ({
    description: desc.trim(), detail: (det[i] ?? '').trim(), quantity: parseFloat(q[i]) || 0,
    unit: (u[i] ?? '').trim(), unit_price: parseMoney(p[i]) || 0, taxable: t[i] === '0' ? 0 : 1,
  })).filter((l) => l.description);
}

const str = (f, k) => (f.get(k) ?? '').trim();
const intOrNull = (v) => (v === '' || v == null ? null : parseInt(v, 10));

function redirect(res, to, flash) {
  const url = flash ? `${to}${to.includes('?') ? '&' : '?'}${flash.err ? 'err' : 'ok'}=${encodeURIComponent(flash.msg)}` : to;
  res.writeHead(303, { Location: url }).end();
}

async function json(res, fn) {
  try {
    const body = JSON.stringify(await fn());
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(body);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.name === 'TimeoutError' ? 'The ABR took too long to answer. Try again.' : e.message }));
  }
}

function html(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store' }).end(body);
}

function flashFrom(url) {
  if (url.searchParams.has('ok')) return { msg: url.searchParams.get('ok') };
  if (url.searchParams.has('err')) return { msg: url.searchParams.get('err'), err: true };
  return null;
}

const MIME = { '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript' };
function serveStatic(res, path) {
  const file = normalize(join(here, 'public', path));
  if (!file.startsWith(join(here, 'public')) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'max-age=3600' }).end(readFileSync(file));
  return true;
}

function authorised(req) {
  const pass = process.env.ADMIN_PASSWORD;
  if (!pass) return true; // only reachable on localhost in this case (see HOST)
  const [scheme, token] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !token) return false;
  const given = Buffer.from(Buffer.from(token, 'base64').toString().split(':').slice(1).join(':'));
  const want = Buffer.from(pass);
  return given.length === want.length && timingSafeEqual(given, want);
}

// ---------------------------------------------------------------- pages

const settings = () => D.getSettings(db);

function dashboard(url) {
  const s = settings();
  D.expireQuotes(db);
  const invoices = D.listInvoices(db);
  const open = invoices.filter((i) => i.status === 'sent');
  const overdue = open.filter((i) => i.overdue);
  const t = today(s.timezone);
  const monthStart = `${t.slice(0, 7)}-01`;
  const paidThisMonth = db.prepare('SELECT COALESCE(SUM(amount),0) AS v FROM payments WHERE received_on >= ?').get(monthStart).v;
  const attention = open.filter((i) => i.needs_attention);
  const quotes = D.listQuotes(db).filter((q) => q.status === 'sent').slice(0, 8);

  const upcoming = open.filter((i) => !i.reminders_paused).map((i) => {
    const inv = D.getInvoice(db, i.id);
    const done = new Set(inv.reminders.map((r) => r.step));
    const next = REMINDER_STEPS.map((r) => ({ ...r, date: addDays(i.due_on, r.offset) })).find((r) => !done.has(r.step) && r.date >= t);
    return next && { inv: i, next };
  }).filter(Boolean).sort((a, b) => a.next.date.localeCompare(b.next.date)).slice(0, 8);

  const invRow = (i) => `<tr>
    <td><a class="row mono" href="/invoices/${i.id}">${esc(i.number)}</a></td><td>${esc(i.company)}</td>
    <td>${shortDate(i.due_on)}${i.overdue ? ` <span class="muted">(${daysBetween(i.due_on, t)}d late)</span>` : ''}</td>
    <td class="num">${money(i.balance)}</td></tr>`;

  const body = `
  ${pageHead('Dashboard', `Today is ${shortDate(t)}`, `<a class="btn" href="/quotes/new">New quote</a><a class="btn primary" href="/invoices/new">New invoice</a>`)}
  <div class="grid g3" style="margin-bottom:20px">
    <div class="stat"><div class="label">Outstanding</div><div class="v">${money(open.reduce((a, i) => a + i.balance, 0))}</div><div class="muted">${open.length} open invoice${open.length === 1 ? '' : 's'}</div></div>
    <div class="stat hot"><div class="label">Overdue</div><div class="v">${money(overdue.reduce((a, i) => a + i.balance, 0))}</div><div class="muted">${overdue.length} invoice${overdue.length === 1 ? '' : 's'}</div></div>
    <div class="stat"><div class="label">Received this month</div><div class="v">${money(paidThisMonth)}</div><div class="muted">${esc(s.currency)}</div></div>
  </div>
  ${!s.email || !s.bank_bsb ? `<div class="notice err">Finish setup: add your accounts email and bank details in <a href="/settings">Settings</a> before sending anything.</div>` : ''}
  ${attention.length ? `<div class="card"><h2>Chase personally</h2><p class="muted" style="margin-top:-6px">Final notice sent and still unpaid. Automatic reminders have stopped for these.</p>
    <table class="list"><tbody>${attention.map(invRow).join('')}</tbody></table></div>` : ''}
  <div class="grid g2">
    <div class="card"><h2>Overdue</h2>${overdue.length ? `<table class="list"><thead><tr><th>Invoice</th><th>Client</th><th>Due</th><th class="num">Owing</th></tr></thead><tbody>${overdue.map(invRow).join('')}</tbody></table>` : '<p class="empty">Nothing overdue.</p>'}</div>
    <div class="card"><h2>Next reminders</h2>${upcoming.length ? `<table class="list"><tbody>${upcoming.map(({ inv, next }) => `<tr><td>${shortDate(next.date)}</td><td><a class="mono" href="/invoices/${inv.id}">${esc(inv.number)}</a></td><td class="muted">${esc(next.label)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No reminders scheduled.</p>'}
      <p class="muted" style="font-size:13px;margin-bottom:0">Reminders run daily from ${REMINDER_HOUR}:00 (${esc(s.timezone)}). <span class="actions" style="display:inline-flex">${postButton('/reminders/run', 'Run now', 'small')}</span></p></div>
    <div class="card"><h2>Quotes awaiting reply</h2>${quotes.length ? `<table class="list"><tbody>${quotes.map((q) => `<tr><td><a class="row mono" href="/quotes/${q.id}">${esc(q.number)}</a></td><td>${esc(q.company)}</td><td class="muted">valid to ${shortDate(q.valid_until)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">No quotes out.</p>'}</div>
  </div>`;
  return layout({ title: 'Dashboard', active: '/', body, flash: flashFrom(url) });
}

// ---------- clients

function abrPanel() {
  if (!abrConfigured()) return `<p class="muted" style="margin-top:0">ABR lookup isn't switched on. Add <span class="mono">ABR_GUID</span> in Railway Variables to fill client details from the Australian Business Register.</p>`;
  return `<div class="abr">
    <span class="label">Find on the Australian Business Register</span>
    <div class="actions"><input id="abrq" placeholder="Business name or ABN" aria-label="Business name or ABN" style="flex:1;min-width:200px"><button type="button" id="abrgo">Search ABR</button></div>
    <div id="abrout" style="margin-top:10px"></div>
  </div>
  <script>
  (() => {
    const q = document.getElementById('abrq'), out = document.getElementById('abrout');
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const form = q.closest('form');
    const set = (name, v) => { const el = form.elements[name]; if (el) el.value = v; };
    async function get(url) {
      const r = await fetch(url, { headers: { Accept: 'application/json' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Lookup failed');
      return d;
    }
    function showDetails(d) {
      const warn = [!d.active && '<span class="pill overdue">ABN ' + esc(d.status || 'not active') + '</span>', !d.gstRegistered && '<span class="pill">Not registered for GST</span>'].filter(Boolean).join(' ');
      out.innerHTML = '<div class="abrhit"><strong>' + esc(d.entityName) + '</strong> ' + warn +
        '<div class="muted">ABN ' + esc(d.abn) + ' · ' + esc(d.entityType) + ' · ' + esc(d.state) + ' ' + esc(d.postcode) + '</div>' +
        (d.businessNames.length ? '<div class="muted">Trading as: ' + d.businessNames.map(esc).join(', ') + '</div>' : '') +
        '<button type="button" class="small primary" id="abruse" style="margin-top:8px">Use these details</button></div>';
      document.getElementById('abruse').onclick = () => {
        set('company', d.entityName);
        set('abn', d.abn);
        const addr = form.elements.address;
        if (addr && !addr.value.trim()) addr.value = (d.state + ' ' + d.postcode).trim();
        const notes = form.elements.notes;
        if (notes && d.businessNames.length && !notes.value.includes('Trading as')) notes.value = ('Trading as: ' + d.businessNames.join(', ') + '\\n' + notes.value).trim();
        out.innerHTML = '<p class="muted">Filled in from the ABR. The register only lists state and postcode, so add the street address.</p>';
        form.elements.contact_name?.focus();
      };
    }
    async function search() {
      const term = q.value.trim();
      if (!term) return;
      out.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const digits = term.replace(/\\D/g, '');
        if (digits.length === 11 && /^[\\d\\s]+$/.test(term)) return showDetails(await get('/abr/abn?abn=' + digits));
        const list = await get('/abr/search?name=' + encodeURIComponent(term));
        if (!list.length) { out.innerHTML = '<p class="muted">No matches. Try fewer words or the ABN.</p>'; return; }
        out.innerHTML = '<table class="list"><tbody>' + list.map((n, i) =>
          '<tr><td><a href="#" data-i="' + i + '">' + esc(n.name) + '</a><br><small class="muted">' + esc(n.nameType) + (n.current ? '' : ' (old name)') + '</small></td><td class="mono">' + esc(n.abn) + '</td><td>' + esc(n.state) + ' ' + esc(n.postcode) + '</td></tr>').join('') + '</tbody></table>';
        out.querySelectorAll('a[data-i]').forEach((a) => a.onclick = async (e) => {
          e.preventDefault();
          out.innerHTML = '<p class="muted">Loading…</p>';
          try { showDetails(await get('/abr/abn?abn=' + list[a.dataset.i].abn.replace(/\\s/g, ''))); } catch (err) { out.innerHTML = '<p class="notice err">' + esc(err.message) + '</p>'; }
        });
      } catch (err) { out.innerHTML = '<p class="notice err">' + esc(err.message) + '</p>'; }
    }
    document.getElementById('abrgo').onclick = search;
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } });
  })();
  </script>`;
}

function clientForm(c = {}) {
  return `<form method="post" class="card">
    ${abrPanel()}
    <div class="row2">${field('company', 'Company', c.company, { required: true })}${field('contact_name', 'Contact name', c.contact_name)}</div>
    <div class="row2">${field('email', 'Email (quotes)', c.email, { type: 'email', required: true })}${field('accounts_email', 'Accounts email (invoices and reminders)', c.accounts_email, { type: 'email', hint: 'Leave blank to use the main email.' })}</div>
    <div class="row2">${area('address', 'Address', c.address)}<div>${field('abn', 'ABN', c.abn)}${field('payment_terms_days', 'Payment terms (days)', c.payment_terms_days ?? '', { type: 'number', hint: `Blank uses the default (${settings().payment_terms_days} days).` })}</div></div>
    ${checkbox('reminders_enabled', 'Send automatic payment reminders to this client', c.reminders_enabled ?? 1)}
    ${area('notes', 'Notes (private)', c.notes)}
    <div class="actions"><button class="primary">Save client</button><a class="btn" href="${c.id ? `/clients/${c.id}` : '/clients'}">Cancel</a></div>
  </form>`;
}

function clientFromForm(f) {
  const abn = str(f, 'abn');
  if (abn && !D.validAbn(abn)) throw new HttpError(400, `ABN "${abn}" doesn't pass the ATO check. Please re-check the 11 digits.`);
  return {
    company: str(f, 'company'), contact_name: str(f, 'contact_name'), email: str(f, 'email'),
    accounts_email: str(f, 'accounts_email'), address: str(f, 'address'), abn: str(f, 'abn'),
    payment_terms_days: intOrNull(str(f, 'payment_terms_days')), reminders_enabled: f.get('reminders_enabled') ? 1 : 0, notes: str(f, 'notes'),
  };
}

function clientsPage(url) {
  const cs = D.listClients(db);
  const body = `${pageHead('Clients', '', '<a class="btn primary" href="/clients/new">New client</a>')}
  <div class="card scroll">${cs.length ? `<table class="list"><thead><tr><th>Company</th><th>Contact</th><th>Email</th><th class="num">Open invoices</th></tr></thead><tbody>
    ${cs.map((c) => `<tr><td><a class="row" href="/clients/${c.id}">${esc(c.company)}</a></td><td>${esc(c.contact_name)}</td><td>${esc(c.accounts_email || c.email)}</td><td class="num">${c.open_invoices}</td></tr>`).join('')}
  </tbody></table>` : '<p class="empty">No clients yet.</p>'}</div>`;
  return layout({ title: 'Clients', active: '/clients', body, flash: flashFrom(url) });
}

function clientPage(id, url) {
  const c = D.getClient(db, id) ?? notFound();
  const s = settings();
  const invs = D.listInvoices(db).filter((i) => i.client_id === c.id);
  const qs = D.listQuotes(db).filter((q) => q.client_id === c.id);
  const body = `${pageHead(esc(c.company), esc(c.contact_name), `<a class="btn" href="/clients/${c.id}/edit">Edit</a><a class="btn" href="/quotes/new?client=${c.id}">New quote</a><a class="btn primary" href="/invoices/new?client=${c.id}">New invoice</a>`)}
  <div class="grid side"><div>
    <div class="card scroll"><h2>Invoices</h2>${invs.length ? `<table class="list"><thead><tr><th>Number</th><th>Job</th><th>Due</th><th>Status</th><th class="num">Owing</th></tr></thead><tbody>${invs.map((i) => `<tr><td><a class="row mono" href="/invoices/${i.id}">${esc(i.number)}</a></td><td>${esc(i.title)}</td><td>${shortDate(i.due_on)}</td><td>${pill(i.display_status)}</td><td class="num">${money(i.balance)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">None yet.</p>'}</div>
    <div class="card scroll"><h2>Quotes</h2>${qs.length ? `<table class="list"><tbody>${qs.map((q) => `<tr><td><a class="row mono" href="/quotes/${q.id}">${esc(q.number)}</a></td><td>${esc(q.title)}</td><td>${pill(q.status)}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">None yet.</p>'}</div>
  </div>
  <div class="card"><dl class="kv">
    <dt>Email</dt><dd>${esc(c.email)}</dd>
    <dt>Accounts</dt><dd>${esc(c.accounts_email || c.email)}</dd>
    <dt>Address</dt><dd>${esc(c.address).replace(/\n/g, '<br>') || '—'}</dd>
    <dt>ABN</dt><dd>${esc(c.abn) || '—'}</dd>
    <dt>Terms</dt><dd>${c.payment_terms_days ?? s.payment_terms_days} days</dd>
    <dt>Reminders</dt><dd>${c.reminders_enabled ? 'On' : 'Off'}</dd>
    ${c.notes ? `<dt>Notes</dt><dd>${esc(c.notes)}</dd>` : ''}
  </dl></div></div>`;
  return layout({ title: c.company, active: '/clients', body, flash: flashFrom(url) });
}

// ---------- quotes & invoices (shared bits)

function clientOptions() {
  return [['', 'Choose a client…'], ...D.listClients(db).map((c) => [c.id, c.company])];
}

function docForm(kind, d, s) {
  const isQ = kind === 'quote';
  const clients = clientOptions();
  return `<form method="post" class="card">
    ${clients.length === 1 ? `<div class="notice err">Add a client first: <a href="/clients/new">new client</a>.</div>` : ''}
    <div class="row2">${select('client_id', 'Client', clients, d.client_id, true)}${field('title', 'Job title', d.title, { required: true, placeholder: 'Roof inspection, Fortitude Valley' })}</div>
    ${field('summary', 'Summary line', d.summary, { placeholder: 'Two-pilot crew, aircraft supplied by client.' })}
    <div class="row2">
      ${field('issued_on', 'Issue date', d.issued_on ?? today(s.timezone), { type: 'date' })}
      ${isQ ? field('valid_until', 'Valid until', d.valid_until ?? '', { type: 'date', hint: `Blank: ${s.quote_valid_days} days after issue.` })
    : field('due_on', 'Due date', d.due_on ?? '', { type: 'date', hint: 'Blank: issue date plus the client\'s payment terms.' })}
    </div>
    <div class="row2">${isQ ? field('job_date', 'Job date', d.job_date ?? '', { type: 'date' }) + field('site', 'Site', d.site) : field('client_po', 'Client PO', d.client_po) + '<div></div>'}</div>
    <h2 style="margin-top:8px">Line items</h2>
    ${itemsEditor(d.lines ?? [], D.listRates(db), s)}
    <div class="actions" style="margin-top:20px"><button class="primary">Save ${kind}</button><a class="btn" href="${d.id ? `/${kind}s/${d.id}` : `/${kind}s`}">Cancel</a></div>
  </form>`;
}

function docFromForm(kind, f) {
  const v = {
    client_id: intOrNull(str(f, 'client_id')), title: str(f, 'title'), summary: str(f, 'summary'),
    issued_on: str(f, 'issued_on'), lines: linesFromForm(f),
  };
  if (!v.client_id || !D.getClient(db, v.client_id)) throw new HttpError(400, 'Choose a client.');
  if (!v.title) throw new HttpError(400, 'Add a job title.');
  if (!v.lines.length) throw new HttpError(400, 'Add at least one line item.');
  if (kind === 'quote') Object.assign(v, { valid_until: str(f, 'valid_until'), job_date: str(f, 'job_date'), site: str(f, 'site') });
  else Object.assign(v, { due_on: str(f, 'due_on'), client_po: str(f, 'client_po') });
  return v;
}

function sendPreview(kind, d, msg, s) {
  const live = sendMode() === 'smtp';
  const body = `${pageHead(`Send ${kind} <span class="mono">${esc(d.number)}</span>`, esc(d.client.company))}
  <div class="card">
    <dl class="kv" style="margin-bottom:16px">
      <dt>From</dt><dd>${esc(s.business_name)} Accounts &lt;${esc(s.email || 'not set')}&gt;</dd>
      <dt>To</dt><dd>${esc(msg.to)}</dd>
      <dt>Copy</dt><dd>${esc(s.email)}</dd>
      <dt>Subject</dt><dd>${esc(msg.subject)}</dd>
      <dt>Attached</dt><dd>Hover-Guy-${kind === 'quote' ? 'Quote' : 'Invoice'}-${esc(d.number)}.pdf</dd>
    </dl>
    <div class="emailpreview">${esc(msg.text)}</div>
    <p class="${live ? '' : 'muted'}">${live ? `This will email <strong>${esc(msg.to)}</strong> now.` : 'Test mode: this saves the email to the Emails page. Nothing is sent to the client.'}</p>
    ${!s.email ? '<div class="notice err">Add your accounts email in Settings first.</div>' : ''}
    <div class="actions">
      <form method="post"><button class="primary"${!s.email ? ' disabled' : ''}>${live ? 'Send now' : 'Save to outbox'}</button></form>
      <a class="btn" href="/${kind}s/${d.id}">Cancel</a>
    </div>
  </div>`;
  return layout({ title: `Send ${d.number}`, active: `/${kind}s`, body });
}

// ---------- quotes

function quotesPage(url) {
  D.expireQuotes(db);
  const s = settings();
  const qs = D.listQuotes(db).map((q) => D.getQuote(db, q.id));
  const body = `${pageHead('Quotes', '', '<a class="btn primary" href="/quotes/new">New quote</a>')}
  <div class="card scroll">${qs.length ? `<table class="list"><thead><tr><th>Number</th><th>Client</th><th>Job</th><th>Valid to</th><th>Status</th><th class="num">Total</th></tr></thead><tbody>
  ${qs.map((q) => `<tr><td><a class="row mono" href="/quotes/${q.id}">${esc(q.number)}</a></td><td>${esc(q.client.company)}</td><td>${esc(q.title)}</td><td>${shortDate(q.valid_until)}</td><td>${pill(q.status)}</td><td class="num">${money(q.total)}</td></tr>`).join('')}
  </tbody></table>` : '<p class="empty">No quotes yet.</p>'}<p class="muted" style="margin-bottom:0;font-size:13px">Totals in ${esc(s.currency)} including ${esc(s.tax_label)}.</p></div>`;
  return layout({ title: 'Quotes', active: '/quotes', body, flash: flashFrom(url) });
}

function quotePage(id, url) {
  const q = D.getQuote(db, id) ?? notFound();
  const s = settings();
  const acts = [
    `<a class="btn" href="/quotes/${q.id}/pdf">PDF</a>`,
    q.status !== 'accepted' ? `<a class="btn" href="/quotes/${q.id}/edit">Edit</a>` : '',
    ['draft', 'sent'].includes(q.status) ? `<a class="btn${q.status === 'draft' ? ' primary' : ''}" href="/quotes/${q.id}/send">${q.status === 'draft' ? 'Send quote' : 'Resend'}</a>` : '',
    q.invoice ? `<a class="btn primary" href="/invoices/${q.invoice.id}">Invoice ${esc(q.invoice.number)}</a>`
      : postButton(`/quotes/${q.id}/invoice`, 'Accepted: create invoice', q.status === 'sent' ? 'primary' : ''),
    ['draft', 'sent'].includes(q.status) ? postButton(`/quotes/${q.id}/status?to=declined`, 'Mark declined') : '',
    q.status === 'draft' && !q.invoice ? postButton(`/quotes/${q.id}/delete`, 'Delete', '', `Delete quote ${q.number}?`) : '',
  ].join('');
  const body = `${pageHead(`Quote <span class="mono">${esc(q.number)}</span> ${pill(q.status)}`, `${esc(q.client.company)} · ${cur(s, q.total)}`, acts)}
  <iframe class="docframe" onload="this.style.height = this.contentDocument.documentElement.scrollHeight + 2 + 'px'" src="/quotes/${q.id}/doc" title="Quote ${esc(q.number)}"></iframe>`;
  return layout({ title: `Quote ${q.number}`, active: '/quotes', body, flash: flashFrom(url) });
}

// ---------- invoices

function invoicesPage(url) {
  const s = settings();
  const filter = url.searchParams.get('show') ?? 'open';
  const all = D.listInvoices(db);
  const list = filter === 'all' ? all : all.filter((i) => (filter === 'open' ? i.status === 'sent' || i.status === 'draft' : filter === 'overdue' ? i.overdue : i.status === filter));
  const tab = (k, l) => `<a class="btn small${filter === k ? ' primary' : ''}" href="/invoices?show=${k}">${l}</a>`;
  const body = `${pageHead('Invoices', '', '<a class="btn primary" href="/invoices/new">New invoice</a>')}
  <div class="actions" style="margin-bottom:12px">${tab('open', 'Open')}${tab('overdue', 'Overdue')}${tab('paid', 'Paid')}${tab('all', 'All')}</div>
  <div class="card scroll">${list.length ? `<table class="list"><thead><tr><th>Number</th><th>Client</th><th>Job</th><th>Due</th><th>Status</th><th class="num">Total</th><th class="num">Owing</th></tr></thead><tbody>
  ${list.map((i) => `<tr><td><a class="row mono" href="/invoices/${i.id}">${esc(i.number)}</a></td><td>${esc(i.company)}</td><td>${esc(i.title)}</td><td>${shortDate(i.due_on)}</td><td>${pill(i.display_status)}${i.needs_attention ? ' ' + pill('attention') : ''}</td><td class="num">${money(i.total)}</td><td class="num">${money(i.status === 'void' ? 0 : i.balance)}</td></tr>`).join('')}
  </tbody></table>` : '<p class="empty">Nothing here.</p>'}<p class="muted" style="margin-bottom:0;font-size:13px">Amounts in ${esc(s.currency)} including ${esc(s.tax_label)}.</p></div>`;
  return layout({ title: 'Invoices', active: '/invoices', body, flash: flashFrom(url) });
}

function invoicePage(id, url) {
  const inv = D.getInvoice(db, id) ?? notFound();
  const s = settings();
  const t = today(s.timezone);
  const plan = inv.status === 'sent' ? REMINDER_STEPS.map((r) => {
    const rec = inv.reminders.find((x) => x.step === r.step);
    return { ...r, date: addDays(inv.due_on, r.offset), rec };
  }) : [];
  const acts = [
    `<a class="btn" href="/invoices/${inv.id}/pdf">PDF</a>`,
    inv.status === 'draft' ? `<a class="btn" href="/invoices/${inv.id}/edit">Edit</a>` : '',
    inv.status === 'draft' ? `<a class="btn primary" href="/invoices/${inv.id}/send">Send invoice</a>` : '',
    inv.status === 'sent' ? `<a class="btn" href="/invoices/${inv.id}/send">Resend</a>` : '',
    inv.status === 'draft' ? postButton(`/invoices/${inv.id}/delete`, 'Delete', '', `Delete draft ${inv.number}? The number will not be reused.`) : '',
    inv.status === 'sent' && !inv.paid ? postButton(`/invoices/${inv.id}/void`, 'Void', '', `Void ${inv.number}? Reminders stop and it no longer counts as owing.`) : '',
  ].join('');

  const side = `
    ${inv.status === 'sent' ? `<div class="card"><h2>Record payment</h2><form method="post" action="/invoices/${inv.id}/payments">
      ${field('amount', `Amount (${esc(s.currency)})`, (inv.balance / 100).toFixed(2), { type: 'number', step: '0.01', required: true })}
      ${field('received_on', 'Received', t, { type: 'date', required: true })}
      ${field('reference', 'Reference', '', { placeholder: 'Bank reference' })}
      <button class="primary">Record payment</button></form></div>` : ''}
    <div class="card"><h2>Payments</h2>${inv.payments.length ? `<table class="list"><tbody>${inv.payments.map((p) => `<tr><td>${shortDate(p.received_on)}<br><small class="muted">${esc(p.method)}${p.reference ? ` · ${esc(p.reference)}` : ''}</small></td><td class="num">${money(p.amount)}<br>${postButton(`/payments/${p.id}/delete`, 'Undo', 'link', 'Remove this payment?')}</td></tr>`).join('')}</tbody></table>` : '<p class="empty">None yet.</p>'}
      <dl class="kv" style="margin-top:8px"><dt>Total</dt><dd class="num">${money(inv.total)}</dd><dt>Paid</dt><dd class="num">${money(inv.paid)}</dd><dt><strong>Owing</strong></dt><dd class="num"><strong>${money(inv.status === 'void' ? 0 : inv.balance)}</strong></dd></dl></div>
    ${inv.status === 'sent' ? `<div class="card"><h2>Reminders</h2>
      ${inv.reminders_paused ? '<p class="notice err" style="margin-bottom:12px">Paused for this invoice.</p>' : !inv.client.reminders_enabled ? '<p class="muted">Off for this client.</p>' : !s.reminders_enabled ? '<p class="muted">Off in Settings.</p>' : ''}
      <table class="list"><tbody>${plan.map((r) => `<tr><td>${shortDate(r.date)}</td><td>${esc(r.label)}</td><td class="num">${r.rec ? pill(r.rec.status) : r.date < t ? '<span class="muted">—</span>' : '<span class="muted">due</span>'}</td></tr>`).join('')}</tbody></table>
      <div class="actions" style="margin-top:12px">${postButton(`/invoices/${inv.id}/pause`, inv.reminders_paused ? 'Resume reminders' : 'Pause reminders', 'small')}
      ${inv.needs_attention ? postButton(`/invoices/${inv.id}/attention`, 'Clear chase flag', 'small') : ''}</div>
      <p class="muted" style="font-size:13px;margin-bottom:0">Pause if the client has disputed the invoice or promised a payment date.</p></div>` : ''}`;

  const sub = `${esc(inv.client.company)} · ${cur(s, inv.total)} · due ${shortDate(inv.due_on)}${inv.quote ? ` · from quote <a class="mono" href="/quotes/${inv.quote.id}">${esc(inv.quote.number)}</a>` : ''}`;
  const body = `${pageHead(`Invoice <span class="mono">${esc(inv.number)}</span> ${pill(inv.display_status)}${inv.needs_attention ? ' ' + pill('attention') : ''}`, sub, acts)}
  <div class="grid side"><iframe class="docframe" onload="this.style.height = this.contentDocument.documentElement.scrollHeight + 2 + 'px'" src="/invoices/${inv.id}/doc" title="Invoice ${esc(inv.number)}"></iframe><div>${side}</div></div>`;
  return layout({ title: `Invoice ${inv.number}`, active: '/invoices', body, flash: flashFrom(url) });
}

// ---------- emails & settings

function emailsPage(url) {
  const es = D.listEmails(db, 200);
  const body = `${pageHead('Emails', sendMode() === 'smtp' ? 'Everything sent from the app.' : 'Test mode: these were saved here instead of being sent.')}
  <div class="card scroll">${es.length ? `<table class="list"><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Mode</th></tr></thead><tbody>
  ${es.map((e) => `<tr><td>${esc(e.created_at.slice(0, 16))} <span class="muted">UTC</span></td><td>${esc(e.to_address)}</td><td>${e.file ? `<a href="/emails/${e.id}">${esc(e.subject)}</a>` : esc(e.subject)}</td><td>${pill(e.mode === 'smtp' ? 'sent' : 'outbox')}</td></tr>`).join('')}
  </tbody></table>` : '<p class="empty">No emails yet.</p>'}</div>`;
  return layout({ title: 'Emails', active: '/emails', body, flash: flashFrom(url) });
}

function emailPreview(id) {
  const e = db.prepare('SELECT * FROM emails WHERE id = ?').get(id) ?? notFound();
  if (!e.file || !existsSync(e.file)) notFound();
  const raw = readFileSync(e.file, 'utf8');
  return `${pageHead('Email', esc(e.subject), '<a class="btn" href="/emails">Back</a>')}<div class="card"><dl class="kv"><dt>To</dt><dd>${esc(e.to_address)}</dd><dt>Saved</dt><dd>${esc(e.created_at)} UTC</dd><dt>File</dt><dd class="mono" style="font-size:12px">${esc(e.file)}</dd></dl></div>
  <div class="card"><pre style="white-space:pre-wrap;font-size:12px;max-height:600px;overflow:auto">${esc(raw.split(/\n--/)[0])}\n\n${esc(textPart(raw))}</pre></div>`;
}

function textPart(raw) {
  const m = raw.match(/Content-Type: text\/plain[^\n]*\n(?:Content-Transfer-Encoding: ([^\n]+)\n)?\n([\s\S]*?)\n--/);
  if (!m) return '';
  if (/quoted-printable/i.test(m[1] ?? '')) {
    return m[2].replace(/=\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return m[2];
}

function settingsPage(url) {
  const s = settings();
  const rates = D.listRates(db, true);
  const body = `${pageHead('Settings')}
  <form method="post" action="/settings">
  <div class="grid g2">
    <div class="card"><h2>Business</h2>
      ${field('business_name', 'Business name', s.business_name)}
      ${field('sender_name', 'Sign emails as', s.sender_name)}
      ${field('email', 'Accounts email (invoices are sent from this)', s.email, { type: 'email', placeholder: 'accounts@yourdomain.com.au' })}
      ${field('phone', 'Phone', s.phone)}
      ${area('address', 'Address', s.address)}
      ${field('abn', 'ABN', s.abn, { placeholder: '00 000 000 000' })}
      ${field('casa_arn', 'CASA ARN', s.casa_arn, { hint: 'Your Aviation Reference Number. Shown on quotes and invoices.' })}
    </div>
    <div class="card"><h2>Bank transfer</h2>
      ${field('bank_account_name', 'Account name', s.bank_account_name)}
      <div class="row2">${field('bank_bsb', 'BSB', s.bank_bsb, { placeholder: '000-000' })}${field('bank_account_number', 'Account number', s.bank_account_number)}</div>
      <h2 style="margin-top:12px">Tax and terms</h2>
      <div class="row2">${field('currency', 'Currency', s.currency)}${field('timezone', 'Timezone', s.timezone)}</div>
      <div class="row2">${field('tax_label', 'Tax name', s.tax_label)}${field('tax_rate_pct', 'Tax rate %', Math.round(s.tax_rate * 1000) / 10, { type: 'number', step: '0.1' })}</div>
      <div class="row2">${field('payment_terms_days', 'Payment terms (days)', s.payment_terms_days, { type: 'number' })}${field('quote_valid_days', 'Quotes valid (days)', s.quote_valid_days, { type: 'number' })}</div>
      ${checkbox('reminders_enabled', 'Send automatic payment reminders', s.reminders_enabled)}
    </div>
  </div>
  <div class="card"><h2>Wording on documents</h2>
    ${area('invoice_terms', 'Invoice terms', s.invoice_terms, '{days} and {number} are filled in automatically.')}
    ${area('quote_terms', 'Quote terms', s.quote_terms)}
    ${area('quote_included', 'Included on every quote', s.quote_included)}
    <div class="actions"><button class="primary">Save settings</button><span class="muted">Next number: <span class="mono">${D.formatNumber(s.next_number)}</span></span></div>
  </div>
  </form>
  <div class="card scroll"><h2>Rate card</h2>
    <table class="list"><thead><tr><th>Item</th><th>Detail</th><th>Unit</th><th class="num">Rate ex ${esc(s.tax_label)}</th><th>Active</th><th></th></tr></thead><tbody>
    ${rates.map((r) => `<tr>
      <td><input form="rate${r.id}" name="name" value="${esc(r.name)}" required aria-label="Item"></td><td><input form="rate${r.id}" name="detail" value="${esc(r.detail)}" aria-label="Detail"></td>
      <td style="width:100px"><input form="rate${r.id}" name="unit" value="${esc(r.unit)}" aria-label="Unit"></td><td style="width:120px"><input form="rate${r.id}" name="unit_price" type="number" step="0.01" value="${(r.unit_price / 100).toFixed(2)}" aria-label="Rate"></td>
      <td style="width:60px"><input form="rate${r.id}" type="checkbox" name="active" value="1"${r.active ? ' checked' : ''} aria-label="Active"></td><td><button form="rate${r.id}" class="small">Save</button></td></tr>`).join('')}
    <tr>
      <td><input form="ratenew" name="name" placeholder="New item" required aria-label="Item"></td><td><input form="ratenew" name="detail" aria-label="Detail"></td><td><input form="ratenew" name="unit" placeholder="day" aria-label="Unit"></td>
      <td><input form="ratenew" name="unit_price" type="number" step="0.01" required aria-label="Rate"></td><td><input form="ratenew" type="hidden" name="active" value="1"></td><td><button form="ratenew" class="small primary">Add</button></td></tr>
    </tbody></table>
    ${rates.map((r) => `<form id="rate${r.id}" method="post" action="/rates/${r.id}"></form>`).join('')}<form id="ratenew" method="post" action="/rates/new"></form></div>`;
  return layout({ title: 'Settings', active: '/settings', body, flash: flashFrom(url) });
}

// ---------------------------------------------------------------- routing

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>\\d+)')}$`), fn });

route('GET', '/', ({ url }) => dashboard(url));

route('GET', '/clients', ({ url }) => clientsPage(url));
route('GET', '/clients/new', () => layout({ title: 'New client', active: '/clients', body: pageHead('New client') + clientForm() }));
route('GET', '/abr/abn', async ({ res, url }) => json(res, async () => lookupAbn(url.searchParams.get('abn') ?? '')));
route('GET', '/abr/search', async ({ res, url }) => json(res, async () => searchNames(url.searchParams.get('name') ?? '')));
route('POST', '/clients/new', async ({ req, res }) => {
  const id = D.saveClient(db, clientFromForm(await readForm(req)));
  redirect(res, `/clients/${id}`, { msg: 'Client added.' });
});
route('GET', '/clients/:id', ({ p, url }) => clientPage(+p.id, url));
route('GET', '/clients/:id/edit', ({ p }) => {
  const c = D.getClient(db, +p.id) ?? notFound();
  return layout({ title: 'Edit client', active: '/clients', body: pageHead(`Edit ${esc(c.company)}`) + clientForm(c) });
});
route('POST', '/clients/:id/edit', async ({ req, res, p }) => {
  D.getClient(db, +p.id) ?? notFound();
  D.saveClient(db, clientFromForm(await readForm(req)), +p.id);
  redirect(res, `/clients/${p.id}`, { msg: 'Saved.' });
});

// quotes
route('GET', '/quotes', ({ url }) => quotesPage(url));
route('GET', '/quotes/new', ({ url }) => layout({ title: 'New quote', active: '/quotes', body: pageHead('New quote') + docForm('quote', { client_id: url.searchParams.get('client') }, settings()) }));
route('POST', '/quotes/new', async ({ req, res }) => {
  const id = D.saveQuote(db, docFromForm('quote', await readForm(req)));
  redirect(res, `/quotes/${id}`, { msg: 'Quote saved as a draft.' });
});
route('GET', '/quotes/:id', ({ p, url }) => quotePage(+p.id, url));
route('GET', '/quotes/:id/edit', ({ p }) => {
  const q = D.getQuote(db, +p.id) ?? notFound();
  return layout({ title: `Edit ${q.number}`, active: '/quotes', body: pageHead(`Edit quote <span class="mono">${esc(q.number)}</span>`) + docForm('quote', q, settings()) });
});
route('POST', '/quotes/:id/edit', async ({ req, res, p }) => {
  const q = D.getQuote(db, +p.id) ?? notFound();
  if (q.status === 'accepted') throw new HttpError(400, 'Accepted quotes are locked. Edit the invoice instead.');
  D.saveQuote(db, docFromForm('quote', await readForm(req)), q.id);
  redirect(res, `/quotes/${q.id}`, { msg: q.status === 'sent' ? 'Saved. Resend it so the client has the latest version.' : 'Saved.' });
});
route('GET', '/quotes/:id/doc', ({ p, res }) => html(res, renderQuote(D.getQuote(db, +p.id) ?? notFound(), settings())));
route('GET', '/quotes/:id/pdf', async ({ p, res }) => {
  const q = D.getQuote(db, +p.id) ?? notFound();
  const pdf = await htmlToPdf(renderQuote(q, settings()));
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Hover-Guy-Quote-${q.number}.pdf"` }).end(pdf);
});
route('GET', '/quotes/:id/send', ({ p }) => {
  const q = D.getQuote(db, +p.id) ?? notFound();
  const s = settings();
  return sendPreview('quote', q, quoteEmail(q, s), s);
});
route('POST', '/quotes/:id/send', async ({ p, res }) => {
  const r = await sendQuote(db, +p.id);
  redirect(res, `/quotes/${p.id}`, { msg: r.mode === 'smtp' ? 'Quote emailed.' : 'Test mode: quote email saved to the Emails page.' });
});
route('POST', '/quotes/:id/invoice', ({ p, res }) => {
  D.getQuote(db, +p.id) ?? notFound();
  const id = D.invoiceFromQuote(db, +p.id);
  redirect(res, `/invoices/${id}`, { msg: 'Draft invoice created from the quote. Check it, then send.' });
});
route('POST', '/quotes/:id/status', ({ p, res, url }) => {
  const to = url.searchParams.get('to');
  if (!['declined', 'sent', 'draft'].includes(to)) throw new HttpError(400, 'Bad status');
  D.setQuoteStatus(db, +p.id, to);
  redirect(res, `/quotes/${p.id}`, { msg: `Marked ${to}.` });
});
route('POST', '/quotes/:id/delete', ({ p, res }) => {
  const q = D.getQuote(db, +p.id) ?? notFound();
  if (q.status !== 'draft' || q.invoice) throw new HttpError(400, 'Only unsent draft quotes can be deleted.');
  db.prepare('DELETE FROM quotes WHERE id = ?').run(q.id);
  redirect(res, '/quotes', { msg: `Deleted ${q.number}.` });
});

// invoices
route('GET', '/invoices', ({ url }) => invoicesPage(url));
route('GET', '/invoices/new', ({ url }) => layout({ title: 'New invoice', active: '/invoices', body: pageHead('New invoice') + docForm('invoice', { client_id: url.searchParams.get('client') }, settings()) }));
route('POST', '/invoices/new', async ({ req, res }) => {
  const id = D.saveInvoice(db, docFromForm('invoice', await readForm(req)));
  redirect(res, `/invoices/${id}`, { msg: 'Invoice saved as a draft.' });
});
route('GET', '/invoices/:id', ({ p, url }) => invoicePage(+p.id, url));
route('GET', '/invoices/:id/edit', ({ p }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  if (inv.status !== 'draft') throw new HttpError(400, 'Sent invoices are locked. Void it and issue a new one if it needs to change.');
  return layout({ title: `Edit ${inv.number}`, active: '/invoices', body: pageHead(`Edit invoice <span class="mono">${esc(inv.number)}</span>`) + docForm('invoice', inv, settings()) });
});
route('POST', '/invoices/:id/edit', async ({ req, res, p }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  if (inv.status !== 'draft') throw new HttpError(400, 'Sent invoices are locked.');
  D.saveInvoice(db, { ...docFromForm('invoice', await readForm(req)), quote_id: inv.quote_id }, inv.id);
  redirect(res, `/invoices/${inv.id}`, { msg: 'Saved.' });
});
route('GET', '/invoices/:id/doc', ({ p, res }) => html(res, renderInvoice(D.getInvoice(db, +p.id) ?? notFound(), settings())));
route('GET', '/invoices/:id/pdf', async ({ p, res }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  const pdf = await invoicePdf(db, settings(), inv);
  res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${pdf.filename}"` }).end(pdf.content);
});
route('GET', '/invoices/:id/send', ({ p }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  const s = settings();
  return sendPreview('invoice', inv, invoiceEmail(inv, s), s);
});
route('POST', '/invoices/:id/send', async ({ p, res }) => {
  const r = await sendInvoice(db, +p.id);
  redirect(res, `/invoices/${p.id}`, { msg: r.mode === 'smtp' ? 'Invoice emailed. Reminders are now scheduled.' : 'Test mode: invoice email saved to the Emails page. Reminders are now scheduled.' });
});
route('POST', '/invoices/:id/payments', async ({ req, res, p }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  const f = await readForm(req);
  const amount = parseMoney(f.get('amount'));
  if (!(amount > 0)) throw new HttpError(400, 'Enter the amount received.');
  D.recordPayment(db, inv.id, { amount, received_on: str(f, 'received_on') || today(settings().timezone), reference: str(f, 'reference') });
  const after = D.getInvoice(db, inv.id);
  redirect(res, `/invoices/${inv.id}`, { msg: after.status === 'paid' ? 'Paid in full. Reminders stopped.' : `Payment recorded. ${money(after.balance)} still owing.` });
});
route('POST', '/payments/:id/delete', ({ p, res }) => {
  const invId = D.deletePayment(db, +p.id) ?? notFound();
  redirect(res, `/invoices/${invId}`, { msg: 'Payment removed.' });
});
route('POST', '/invoices/:id/pause', ({ p, res }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  D.setInvoiceField(db, inv.id, 'reminders_paused', inv.reminders_paused ? 0 : 1);
  redirect(res, `/invoices/${inv.id}`, { msg: inv.reminders_paused ? 'Reminders resumed.' : 'Reminders paused.' });
});
route('POST', '/invoices/:id/attention', ({ p, res }) => {
  D.setInvoiceField(db, +p.id, 'needs_attention', 0);
  redirect(res, `/invoices/${p.id}`);
});
route('POST', '/invoices/:id/void', ({ p, res }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  D.setInvoiceField(db, inv.id, 'status', 'void');
  redirect(res, `/invoices/${inv.id}`, { msg: `${inv.number} voided.` });
});
route('POST', '/invoices/:id/delete', ({ p, res }) => {
  const inv = D.getInvoice(db, +p.id) ?? notFound();
  if (inv.status !== 'draft') throw new HttpError(400, 'Only drafts can be deleted. Void sent invoices instead.');
  db.prepare('DELETE FROM invoices WHERE id = ?').run(inv.id);
  redirect(res, '/invoices', { msg: `Deleted draft ${inv.number}.` });
});

// emails, settings, reminders
route('GET', '/emails', ({ url }) => emailsPage(url));
route('GET', '/emails/:id', ({ p }) => layout({ title: 'Email', active: '/emails', body: emailPreview(+p.id) }));
route('GET', '/settings', ({ url }) => settingsPage(url));
route('POST', '/settings', async ({ req, res }) => {
  const f = await readForm(req);
  const keys = ['business_name', 'sender_name', 'email', 'phone', 'address', 'abn', 'casa_arn', 'bank_account_name', 'bank_bsb', 'bank_account_number', 'currency', 'tax_label', 'timezone', 'invoice_terms', 'quote_terms', 'quote_included'];
  const v = Object.fromEntries(keys.map((k) => [k, str(f, k)]));
  if (v.abn && !D.validAbn(v.abn)) throw new HttpError(400, `ABN "${v.abn}" doesn't pass the ATO check. Please re-check the 11 digits.`);
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { throw new HttpError(400, `Unknown timezone "${v.timezone}". Try Australia/Melbourne.`); }
  v.tax_rate = (parseFloat(f.get('tax_rate_pct')) || 0) / 100;
  v.payment_terms_days = parseInt(f.get('payment_terms_days'), 10) || 14;
  v.quote_valid_days = parseInt(f.get('quote_valid_days'), 10) || 30;
  v.reminders_enabled = f.get('reminders_enabled') ? 1 : 0;
  D.updateSettings(db, v);
  redirect(res, '/settings', { msg: 'Settings saved.' });
});
const rateFromForm = (f) => ({ name: str(f, 'name'), detail: str(f, 'detail'), unit: str(f, 'unit'), unit_price: parseMoney(f.get('unit_price')) || 0, active: f.get('active') ? 1 : 0 });
route('POST', '/rates/new', async ({ req, res }) => { D.saveRate(db, rateFromForm(await readForm(req))); redirect(res, '/settings', { msg: 'Rate added.' }); });
route('POST', '/rates/:id', async ({ req, res, p }) => { D.saveRate(db, rateFromForm(await readForm(req)), +p.id); redirect(res, '/settings', { msg: 'Rate saved.' }); });
route('POST', '/reminders/run', async ({ res }) => {
  const r = await runReminders(db);
  redirect(res, '/', { msg: `Reminders checked: ${r.sent.length} sent, ${r.skipped.length} skipped${r.failed.length ? `, ${r.failed.length} failed (${r.failed[0].error})` : ''}.`, err: r.failed.length > 0 });
});

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (req.method === 'GET' && /^\/(brand\/[\w.-]+|app\.css)$/.test(url.pathname) && serveStatic(res, url.pathname)) return;
  if (!authorised(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Hover Guy invoicing"' }).end('Sign in required');
    return;
  }
  if (req.method === 'POST') {
    // Forms only come from this app; reject cross-site posts.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
  }
  for (const r of routes) {
    const m = r.method === req.method && url.pathname.match(r.re);
    if (!m) continue;
    const out = await r.fn({ req, res, url, p: m.groups ?? {} });
    if (typeof out === 'string') html(res, out);
    return;
  }
  notFound();
}

function errorPage(e) {
  return layout({ title: 'Problem', body: `${pageHead(e.status === 404 ? 'Not found' : 'Something needs fixing')}<div class="notice err">${esc(e.message)}</div><a class="btn" href="javascript:history.back()">Go back</a>` });
}

// ---------------------------------------------------------------- daily reminders

let lastRun = '';
async function reminderTick() {
  const s = settings();
  const t = today(s.timezone);
  const hour = Number(new Intl.DateTimeFormat('en-AU', { timeZone: s.timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (lastRun === t || hour < REMINDER_HOUR) return;
  lastRun = t;
  try {
    const r = await runReminders(db);
    console.log(`[reminders] ${t}: ${r.sent.length} sent, ${r.skipped.length} skipped, ${r.failed.length} failed`);
  } catch (e) {
    console.error('[reminders] run failed', e);
    lastRun = '';
  }
}

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!(e instanceof HttpError)) console.error(e);
    if (!res.headersSent) html(res, errorPage(e), e.status ?? 500);
  });
}).listen(PORT, HOST, () => {
  console.log(`Hover Guy invoicing on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(sendMode() === 'smtp' ? 'LIVE: emails are sent via SMTP.' : 'Test mode: emails are saved to the outbox, not sent.');
  if (!process.env.ADMIN_PASSWORD) console.log('No ADMIN_PASSWORD set, so the app only listens on this computer.');
  if (process.env.REMINDERS !== 'off') {
    reminderTick();
    setInterval(reminderTick, 15 * 60 * 1000).unref();
  }
});
