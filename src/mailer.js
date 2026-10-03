// Sends email. Default is the outbox: messages are saved as .eml files in data/outbox and
// nothing leaves the machine. Real sending only happens with SEND_MODE=smtp plus SMTP settings.
import nodemailer from 'nodemailer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEmail } from './db.js';

const outboxDir = process.env.OUTBOX_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'outbox');

export const sendMode = () => (process.env.SEND_MODE === 'smtp' ? 'smtp' : 'outbox');

let smtp;
function transport() {
  if (sendMode() === 'outbox') return nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  if (!process.env.SMTP_HOST) throw new Error('SEND_MODE=smtp but SMTP_HOST is not set');
  smtp ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return smtp;
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
  const info = await transport().sendMail({
    from: { name: `${s.business_name} Accounts`, address: s.email },
    to: msg.to,
    bcc: s.email, // keeps a copy in the accounts mailbox
    replyTo: s.email,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    attachments: [...(msg.inlineAttachments ?? []), ...(pdf ? [{ ...pdf, contentType: 'application/pdf' }] : [])],
  });
  let file = null;
  if (mode === 'outbox') {
    mkdirSync(outboxDir, { recursive: true });
    const safe = msg.subject.replace(/[^\w-]+/g, '-').slice(0, 60);
    file = join(outboxDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.eml`);
    writeFileSync(file, info.message);
  }
  logEmail(db, { ...msg, mode, file });
  return { mode, file };
}
