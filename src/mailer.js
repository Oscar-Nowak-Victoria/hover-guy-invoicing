// Sends email. Default is the outbox: messages are saved as .eml files in data/outbox and
// nothing leaves the machine. Real sending only happens with SEND_MODE=microsoft (Microsoft 365
// via Graph, see graph.js) or SEND_MODE=smtp, plus that method's settings.
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEmail } from './db.js';
import { graphConfigured, graphSend } from './graph.js';

const outboxDir = process.env.OUTBOX_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'outbox');

export function sendMode() {
  const m = process.env.SEND_MODE;
  return m === 'smtp' || m === 'microsoft' ? m : 'outbox';
}
export const isLive = () => sendMode() !== 'outbox';

// The real delivery method that is set up, whether or not SEND_MODE has switched it on.
export function liveMethod() {
  if (graphConfigured()) return 'microsoft';
  if (process.env.SMTP_HOST) return 'smtp';
  return null;
}

let smtp;
function smtpTransport() {
  if (!process.env.SMTP_HOST) throw new Error('SMTP_HOST is not set');
  smtp ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return smtp;
}

function build(s, msg, pdf) {
  return {
    from: { name: `${s.business_name} Accounts`, address: s.email },
    to: msg.to,
    replyTo: s.email,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: [...(msg.inlineAttachments ?? []), ...(pdf ? [{ ...pdf, contentType: 'application/pdf' }] : [])],
  };
}

async function deliver(method, s, mail) {
  if (method === 'microsoft') {
    if (!graphConfigured()) throw new Error('SEND_MODE=microsoft but MS_TENANT_ID, MS_CLIENT_ID or MS_CLIENT_SECRET is missing');
    await graphSend(s.email, mail); // Graph saves a copy in Sent Items
    return null;
  }
  if (method === 'smtp') {
    await smtpTransport().sendMail({ ...mail, bcc: s.email }); // bcc keeps a copy in the accounts mailbox
    return null;
  }
  const info = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
    .sendMail({ ...mail, bcc: s.email });
  mkdirSync(outboxDir, { recursive: true });
  const safe = mail.subject.replace(/[^\w-]+/g, '-').slice(0, 60);
  const file = join(outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.eml`);
  writeFileSync(file, info.message);
  return file;
}

/**
 * @param db  database handle (for the email log)
 * @param s   settings row
 * @param msg { kind, to, subject, text, html, inlineAttachments, quote_id?, invoice_id? }
 * @param pdf optional { filename, content } attachment
 */
export async function send(db, s, msg, pdf) {
  if (!s.email) throw new Error('Add the accounts email address in Settings before sending.');
  if (!msg.to) throw new Error('This client has no email address.');
  const mode = sendMode();
  const file = await deliver(mode, s, build(s, msg, pdf));
  logEmail(db, { ...msg, mode, file });
  return { mode, file };
}

// Sends one email to the accounts address only, through the real delivery method, even
// while SEND_MODE is still outbox. Lets Oscar prove the connection without emailing clients.
export async function sendTestToSelf(db, s, msg) {
  if (!s.email) throw new Error('Add the accounts email address in Settings first.');
  const method = liveMethod();
  if (!method) throw new Error('No email connection is set up yet. Add the Microsoft 365 variables in Railway.');
  await deliver(method, s, build(s, { ...msg, to: s.email }));
  logEmail(db, { ...msg, kind: 'test', to: s.email, mode: method });
  return { mode: method };
}
