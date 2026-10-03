// Shared layout and small components for the admin screens.
import { esc } from './render.js';
import { money } from './money.js';
import { isLive } from './mailer.js';

export { esc };

const NAV = [['/', 'Dashboard'], ['/quotes', 'Quotes'], ['/invoices', 'Invoices'], ['/clients', 'Clients'], ['/emails', 'Emails'], ['/settings', 'Settings']];

export function layout({ title, active = '', body, flash }) {
  const live = isLive();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Hover Guy</title>
<link rel="icon" href="/brand/hover-guy-app-icon.svg">
<link rel="stylesheet" href="/app.css"></head><body>
<header class="topbar"><div class="inner">
  <a href="/"><img src="/brand/hover-guy-logo-horizontal-reverse.svg" alt="Hover Guy"></a>
  <nav>${NAV.map(([href, label]) => `<a href="${href}"${active === href ? ' class="on"' : ''}>${label}</a>`).join('')}</nav>
</div></header>
<div class="banner${live ? ' live' : ''}"><div class="inner">${live
    ? 'Live: emails are sent to clients from your accounts address.'
    : '<strong>Test mode.</strong> Emails are saved to the Emails page, not sent. Nothing reaches clients until live sending is switched on.'}</div></div>
<main class="wrap">
${flash ? `<div class="notice${flash.err ? ' err' : ''}">${esc(flash.msg)}</div>` : ''}
${body}
</main></body></html>`;
}

export const pill = (status) => `<span class="pill ${esc(status.replace(/\s+/g, '-'))}">${esc(status)}</span>`;
export const cur = (s, cents) => `<span class="muted">${esc(s.currency)}</span> ${money(cents)}`;

export function pageHead(title, sub, actions = '') {
  return `<div class="pagehead"><div><h1>${title}</h1>${sub ? `<div class="sub muted">${sub}</div>` : ''}</div><div class="actions">${actions}</div></div>`;
}

export const postButton = (action, label, cls = '', confirm) =>
  `<form class="inline" method="post" action="${action}"${confirm ? ` onsubmit="return confirm('${esc(confirm)}')"` : ''}><button class="${cls}">${label}</button></form>`;

export const field = (name, label, value = '', { type = 'text', required, step, placeholder, hint } = {}) =>
  `<label class="f"><span class="label">${label}</span><input type="${type}" name="${name}" value="${esc(value)}"${required ? ' required' : ''}${step ? ` step="${step}"` : ''}${placeholder ? ` placeholder="${esc(placeholder)}"` : ''}>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;

export const area = (name, label, value = '', hint) =>
  `<label class="f"><span class="label">${label}</span><textarea name="${name}">${esc(value)}</textarea>${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;

export const checkbox = (name, label, on) =>
  `<label class="check"><input type="checkbox" name="${name}" value="1"${on ? ' checked' : ''}> <span>${label}</span></label>`;

export function select(name, label, options, value, required) {
  return `<label class="f"><span class="label">${label}</span><select name="${name}"${required ? ' required' : ''}>
    ${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}
  </select></label>`;
}

// Line-item editor shared by quotes and invoices. Prices are entered excluding tax.
export function itemsEditor(lines, rates, s) {
  const row = (l = {}) => `<tr>
    <td><input name="li_description" value="${esc(l.description)}" placeholder="Description" aria-label="Description">
      <small><input name="li_detail" value="${esc(l.detail)}" placeholder="Detail (optional)" aria-label="Detail"></small></td>
    <td class="q"><input name="li_quantity" type="number" step="any" min="0" value="${l.quantity ?? 1}" aria-label="Quantity"></td>
    <td class="u"><input name="li_unit" value="${esc(l.unit)}" placeholder="day" aria-label="Unit"></td>
    <td class="p"><input name="li_price" type="number" step="0.01" value="${l.unit_price != null ? (l.unit_price / 100).toFixed(2) : ''}" aria-label="Rate"></td>
    <td class="t"><select name="li_taxable" aria-label="${esc(s.tax_label)}"><option value="1"${l.taxable === 0 ? '' : ' selected'}>Yes</option><option value="0"${l.taxable === 0 ? ' selected' : ''}>No</option></select></td>
    <td class="a">0.00</td>
    <td><button type="button" class="small" data-remove aria-label="Remove line">✕</button></td>
  </tr>`;
  return `
  <div class="scroll"><table class="items">
    <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate ex ${esc(s.tax_label)}</th><th>${esc(s.tax_label)}</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody id="items">${(lines.length ? lines : [{}]).map(row).join('')}</tbody>
  </table></div>
  <div class="actions" style="margin-top:8px">
    <select id="ratepick" style="max-width:340px"><option value="">Add from rate card…</option>
      ${rates.map((r) => `<option value="${r.id}" data-r='${esc(JSON.stringify(r))}'>${esc(r.name)} (${money(r.unit_price)}/${esc(r.unit)})</option>`).join('')}
    </select>
    <button type="button" class="small" id="addline">+ Blank line</button>
  </div>
  <div class="formtotals">
    <div><span>Subtotal</span><span id="t_sub">0.00</span></div>
    <div><span>${esc(s.tax_label)} ${Math.round(s.tax_rate * 1000) / 10}%</span><span id="t_tax">0.00</span></div>
    <div class="grand"><span>${esc(s.currency)}</span><span id="t_total">0.00</span></div>
  </div>
  <template id="rowtpl">${row()}</template>
  <script>
  (() => {
    const rate = ${Number(s.tax_rate)};
    const body = document.getElementById('items');
    const fmt = (c) => (c / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    function recalc() {
      let sub = 0, taxable = 0;
      for (const tr of body.rows) {
        const q = parseFloat(tr.querySelector('[name=li_quantity]').value) || 0;
        const p = Math.round((parseFloat(tr.querySelector('[name=li_price]').value) || 0) * 100);
        const amt = Math.round(q * p);
        tr.querySelector('.a').textContent = fmt(amt);
        sub += amt;
        if (tr.querySelector('[name=li_taxable]').value === '1') taxable += amt;
      }
      const tax = Math.round(taxable * rate);
      document.getElementById('t_sub').textContent = fmt(sub);
      document.getElementById('t_tax').textContent = fmt(tax);
      document.getElementById('t_total').textContent = fmt(sub + tax);
    }
    function addRow(r) {
      body.insertAdjacentHTML('beforeend', document.getElementById('rowtpl').innerHTML);
      const tr = body.rows[body.rows.length - 1];
      if (r) {
        tr.querySelector('[name=li_description]').value = r.name;
        tr.querySelector('[name=li_detail]').value = r.detail || '';
        tr.querySelector('[name=li_unit]').value = r.unit || '';
        tr.querySelector('[name=li_price]').value = (r.unit_price / 100).toFixed(2);
        tr.querySelector('[name=li_taxable]').value = r.taxable ? '1' : '0';
      }
      recalc();
      return tr;
    }
    body.addEventListener('input', recalc);
    body.addEventListener('change', recalc);
    body.addEventListener('click', (e) => {
      if (!e.target.matches('[data-remove]')) return;
      e.target.closest('tr').remove();
      if (!body.rows.length) addRow();
      recalc();
    });
    document.getElementById('addline').onclick = () => addRow().querySelector('input').focus();
    document.getElementById('ratepick').onchange = (e) => {
      const opt = e.target.selectedOptions[0];
      if (!opt.value) return;
      const r = JSON.parse(opt.dataset.r);
      const first = body.rows[0];
      const blank = body.rows.length === 1 && !first.querySelector('[name=li_description]').value;
      if (blank) first.remove();
      addRow(r);
      e.target.value = '';
    };
    recalc();
  })();
  </script>`;
}
