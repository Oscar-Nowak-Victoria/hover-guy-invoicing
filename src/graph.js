// Sends mail through Microsoft 365 (Exchange Online) with the Microsoft Graph API.
// Microsoft has retired password-based SMTP for Microsoft 365, so this uses an Entra ID
// app registration (client credentials) with the Mail.Send application permission.
// Needs MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET.

export const graphConfigured = () =>
  Boolean(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);

let cached = null; // { token, expires }

async function token(fetchImpl) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(process.env.MS_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    throw new Error(`Microsoft sign-in failed: ${d.error_description?.split(/\s*Trace ID:/)[0] || d.error || `HTTP ${res.status}`}`);
  }
  cached = { token: d.access_token, expires: Date.now() + (d.expires_in ?? 3600) * 1000 };
  return cached.token;
}

const recipients = (list) => [].concat(list ?? []).filter(Boolean).map((address) => ({ emailAddress: { address } }));

/**
 * @param from     mailbox to send as (the accounts address)
 * @param mail     { to, subject, html, replyTo, attachments: [{ filename, content(Buffer), contentType?, cid? }] }
 */
export async function graphSend(from, mail, fetchImpl = fetch) {
  const message = {
    subject: mail.subject,
    body: { contentType: 'HTML', content: mail.html },
    toRecipients: recipients(mail.to),
    replyTo: recipients(mail.replyTo),
    attachments: (mail.attachments ?? []).map((a) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.filename,
      contentType: a.contentType || 'application/octet-stream',
      contentBytes: Buffer.from(a.content).toString('base64'),
      ...(a.cid ? { isInline: true, contentId: a.cid } : {}),
    })),
  };
  const res = await fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token(fetchImpl)}`, 'Content-Type': 'application/json' },
    // saveToSentItems keeps a copy in the accounts mailbox's Sent Items.
    body: JSON.stringify({ message, saveToSentItems: true }),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 202) {
    const d = await res.json().catch(() => ({}));
    const msg = d.error?.message || `HTTP ${res.status}`;
    if (res.status === 403 || d.error?.code === 'ErrorAccessDenied') {
      throw new Error(`Microsoft 365 refused to send as ${from}. Check the app has Mail.Send (Application) with admin consent. (${msg})`);
    }
    if (res.status === 404 || d.error?.code === 'ErrorInvalidUser' || d.error?.code === 'MailboxNotEnabledForRESTAPI') {
      throw new Error(`Microsoft 365 couldn't find the mailbox ${from}. Check the accounts email in Settings. (${msg})`);
    }
    throw new Error(`Microsoft 365 send failed: ${msg}`);
  }
}

export const _resetTokenCache = () => { cached = null; };
