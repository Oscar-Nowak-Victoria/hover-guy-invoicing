import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.MS_TENANT_ID = 'tenant-1';
process.env.MS_CLIENT_ID = 'client-1';
process.env.MS_CLIENT_SECRET = 'secret-1';

const { graphSend, _resetTokenCache } = await import('../src/graph.js');
const { openDb, updateSettings, listEmails } = await import('../src/db.js');
const mailer = await import('../src/mailer.js');

let calls;
function fakeFetch({ sendStatus = 202, sendBody = {}, tokenStatus = 200 } = {}) {
  calls = [];
  return async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('login.microsoftonline.com')) {
      return { ok: tokenStatus === 200, status: tokenStatus, json: async () => (tokenStatus === 200 ? { access_token: 'tok', expires_in: 3600 } : { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided. Trace ID: x' }) };
    }
    return { ok: sendStatus < 300, status: sendStatus, json: async () => sendBody };
  };
}

beforeEach(() => _resetTokenCache());

test('sends through Graph as the accounts mailbox with attachments', async () => {
  const f = fakeFetch();
  await graphSend('accounts@hoverguy.com.au', {
    to: 'client@example.com', replyTo: 'accounts@hoverguy.com.au', subject: 'Invoice HG-0002', html: '<p>Hi</p>',
    attachments: [
      { filename: 'logo.png', content: Buffer.from('png'), contentType: 'image/png', cid: 'logo@hg' },
      { filename: 'Invoice.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
    ],
  }, f);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /login\.microsoftonline\.com\/tenant-1\/oauth2\/v2\.0\/token/);
  assert.match(String(calls[0].opts.body), /grant_type=client_credentials/);
  assert.equal(calls[1].url, 'https://graph.microsoft.com/v1.0/users/accounts%40hoverguy.com.au/sendMail');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok');
  const body = JSON.parse(calls[1].opts.body);
  assert.equal(body.saveToSentItems, true);
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'client@example.com' } }]);
  assert.equal(body.message.attachments[0].isInline, true);
  assert.equal(body.message.attachments[0].contentId, 'logo@hg');
  assert.equal(body.message.attachments[1].contentBytes, Buffer.from('%PDF').toString('base64'));
  assert.equal(body.message.attachments[1].isInline, undefined);
});

test('reuses the access token', async () => {
  const f = fakeFetch();
  await graphSend('a@b.c', { to: 'x@y.z', subject: 's', html: 'h' }, f);
  await graphSend('a@b.c', { to: 'x@y.z', subject: 's', html: 'h' }, f);
  assert.equal(calls.filter((c) => c.url.includes('login.')).length, 1);
});

test('explains common Microsoft errors', async () => {
  await assert.rejects(graphSend('a@b.c', { to: 'x', subject: 's', html: 'h' }, fakeFetch({ tokenStatus: 401 })), /Microsoft sign-in failed: AADSTS7000215: Invalid client secret provided\.$/);
  _resetTokenCache();
  await assert.rejects(graphSend('a@b.c', { to: 'x', subject: 's', html: 'h' }, fakeFetch({ sendStatus: 403, sendBody: { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } } })), /Mail\.Send \(Application\) with admin consent/);
  _resetTokenCache();
  await assert.rejects(graphSend('a@b.c', { to: 'x', subject: 's', html: 'h' }, fakeFetch({ sendStatus: 404, sendBody: { error: { code: 'ErrorInvalidUser', message: 'nope' } } })), /couldn't find the mailbox a@b\.c/);
});

test('modes: outbox by default, microsoft only when SEND_MODE says so', () => {
  delete process.env.SEND_MODE;
  assert.equal(mailer.sendMode(), 'outbox');
  assert.equal(mailer.isLive(), false);
  assert.equal(mailer.liveMethod(), 'microsoft');
  process.env.SEND_MODE = 'microsoft';
  assert.equal(mailer.isLive(), true);
  process.env.SEND_MODE = 'anything-else';
  assert.equal(mailer.sendMode(), 'outbox');
  delete process.env.SEND_MODE;
});

test('test email goes only to the accounts address, even in outbox mode', async () => {
  delete process.env.SEND_MODE;
  const db = openDb(':memory:');
  updateSettings(db, { email: 'accounts@hoverguy.com.au' });
  const s = db.prepare('SELECT * FROM settings').get();
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  try {
    const r = await mailer.sendTestToSelf(db, s, { kind: 'test', to: 'client@example.com', subject: 'Test', text: 't', html: '<p>t</p>' });
    assert.equal(r.mode, 'microsoft');
  } finally { globalThis.fetch = real; }
  const body = JSON.parse(calls.at(-1).opts.body);
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'accounts@hoverguy.com.au' } }]);
  assert.deepEqual(listEmails(db).map((e) => [e.kind, e.to_address, e.mode]), [['test', 'accounts@hoverguy.com.au', 'microsoft']]);
});

test('client emails go through Microsoft 365 when SEND_MODE=microsoft', async () => {
  process.env.SEND_MODE = 'microsoft';
  const db = openDb(':memory:');
  updateSettings(db, { email: 'accounts@hoverguy.com.au' });
  const s = db.prepare('SELECT * FROM settings').get();
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch();
  try {
    const r = await mailer.send(db, s, { kind: 'invoice', to: 'client@example.com', subject: 'Invoice', text: 't', html: '<p>t</p>' }, { filename: 'a.pdf', content: Buffer.from('%PDF') });
    assert.equal(r.mode, 'microsoft');
    assert.equal(r.file, null);
  } finally { globalThis.fetch = real; delete process.env.SEND_MODE; }
  const body = JSON.parse(calls.at(-1).opts.body);
  assert.deepEqual(body.message.toRecipients, [{ emailAddress: { address: 'client@example.com' } }]);
  assert.equal(body.message.attachments.at(-1).name, 'a.pdf');
});
