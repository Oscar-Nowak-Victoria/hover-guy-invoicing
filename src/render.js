// Branded quote and invoice documents (Flight Deck layout from the brand guide).
// The same HTML is shown in the browser and printed to PDF for email attachments.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { money, quantity } from './money.js';
import { shortDate } from './dates.js';
import { lineAmount } from './db.js';

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = readFileSync(join(pub, 'document.css'), 'utf8');
const logo = `data:image/svg+xml;base64,${readFileSync(join(pub, 'brand', 'hover-guy-logo-horizontal-reverse.svg')).toString('base64')}`;

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = (text) => esc(text).replace(/\n/g, '<br>');
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function partyBlock(label, name, rows) {
  return `<div><span class="label">${label}</span><p><strong>${esc(name)}</strong>${rows.filter(Boolean).map((r) => `<br>${r}`).join('')}</p></div>`;
}

function lineRows(items) {
  return items.map((l) => `
    <tr>
      <td class="desc">${esc(l.description)}${l.detail ? `<small>${esc(l.detail)}</small>` : ''}</td>
      <td class="num">${quantity(l.quantity)}${l.unit ? ` ${esc(l.unit)}` : ''}</td>
      <td class="num">${money(l.unit_price)}</td>
      <td class="num">${money(lineAmount(l))}</td>
    </tr>`).join('');
}

function totalsBlock(doc, s, label) {
  return `
    <table class="totals">
      <tr><td>Subtotal</td><td>${money(doc.subtotal)}</td></tr>
      <tr><td>${esc(s.tax_label)} ${Math.round(s.tax_rate * 1000) / 10}%</td><td>${money(doc.tax)}</td></tr>
      ${doc.paid ? `<tr><td>Total</td><td>${money(doc.total)}</td></tr><tr><td>Paid</td><td>-${money(doc.paid)}</td></tr>` : ''}
      <tr class="grand"><td>${label} ${esc(s.currency)}</td><td>${money(doc.paid ? doc.balance : doc.total)}</td></tr>
    </table>`;
}

function page({ title, docType, number, body, footerRight, s }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head>
<body><div class="page">
  <header class="bar">
    <img src="${logo}" alt="${esc(s.business_name)}">
    <div class="ref"><div class="mono doctype">${docType}</div><div class="mono docnum">${esc(number)}</div></div>
  </header>
  <main>${body}</main>
  <footer><span>Certified pilots for your fleet.</span><span class="mono">${footerRight}</span></footer>
</div></body></html>`;
}

function fromBlock(s, withAbn) {
  return partyBlock('From', s.business_name, [
    s.sender_name && esc(s.sender_name), lines(s.address),
    withAbn && s.abn && `ABN ${esc(s.abn)}`, esc(s.email), esc(s.phone),
  ]);
}

function clientBlock(label, c, invoice) {
  return partyBlock(label, c.company, [
    c.contact_name && `Attn: ${esc(c.contact_name)}`, lines(c.address),
    c.abn && `ABN ${esc(c.abn)}`, invoice && esc(c.accounts_email || c.email),
  ]);
}

const metaRow = (k, v, mono) => (v ? `<tr><td class="label">${k}</td><td${mono ? ' class="mono"' : ''}>${v}</td></tr>` : '');

export function renderInvoice(inv, s) {
  const terms = fill(s.invoice_terms, { days: inv.client.payment_terms_days ?? s.payment_terms_days, number: inv.number });
  const body = `
    <section class="parties">
      ${clientBlock('Bill to', inv.client, true)}
      ${fromBlock(s, true)}
      <div><span class="label">Details</span><table class="meta">
        ${metaRow('Issued', shortDate(inv.issued_on))}
        ${metaRow('Due', `<strong>${shortDate(inv.due_on)}</strong>`)}
        ${metaRow('Quote', inv.quote && esc(inv.quote.number), true)}
        ${metaRow('Client PO', esc(inv.client_po))}
      </table></div>
    </section>
    <h1>${esc(inv.title)}</h1>
    ${inv.summary ? `<p class="summary">${esc(inv.summary)}</p>` : ''}
    <table class="lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${lineRows(inv.lines)}</tbody></table>
    ${totalsBlock(inv, s, inv.status === 'paid' ? 'BALANCE' : 'TOTAL DUE')}
    <section class="panels">
      <div class="panel"><span class="label">Payment</span><table>
        <tr><td>Account name</td><td>${esc(s.bank_account_name)}</td></tr>
        <tr><td>BSB</td><td>${esc(s.bank_bsb) || '—'}</td></tr>
        <tr><td>Account no.</td><td>${esc(s.bank_account_number) || '—'}</td></tr>
        <tr><td>Reference</td><td class="mono">${esc(inv.number)}</td></tr>
      </table></div>
      <div class="panel"><span class="label">Terms</span><p>${lines(terms)}</p></div>
    </section>`;
  return page({
    title: `Invoice ${inv.number}`, docType: inv.status === 'paid' ? 'Tax invoice · Paid' : 'Tax invoice',
    number: inv.number, body, s, footerRight: `${esc(s.business_name)} · Drone pilot services`,
  });
}

export function renderQuote(q, s) {
  const terms = fill(s.quote_terms, { days: s.quote_valid_days, number: q.number });
  const body = `
    <section class="parties">
      ${clientBlock('Prepared for', q.client, false)}
      ${fromBlock(s, false)}
      <div><span class="label">Details</span><table class="meta">
        ${metaRow('Issued', shortDate(q.issued_on))}
        ${metaRow('Valid to', `<strong>${shortDate(q.valid_until)}</strong>`)}
        ${metaRow('Job date', shortDate(q.job_date))}
        ${metaRow('Site', esc(q.site))}
      </table></div>
    </section>
    <h1>${esc(q.title)}</h1>
    ${q.summary ? `<p class="summary">${esc(q.summary)}</p>` : ''}
    <table class="lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>
      <tbody>${lineRows(q.lines)}</tbody></table>
    ${totalsBlock(q, s, 'QUOTE TOTAL')}
    <section class="panels">
      <div class="panel"><span class="label">Included</span><p>${lines(s.quote_included)}</p></div>
      <div class="panel"><span class="label">Terms</span><p>${lines(terms)}</p></div>
    </section>`;
  return page({
    title: `Quote ${q.number}`, docType: 'Quote', number: q.number, body, s,
    footerRight: `Reply to accept, or quote ${esc(q.number)} when booking`,
  });
}
