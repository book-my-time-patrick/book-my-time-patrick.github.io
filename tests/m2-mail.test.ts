import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createApi } from '../server/app.js';
import { sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const site = 'https://booking.example.test';
const key = 're_synthetic_test_only_12345';
const sender = 'bookings@notify.example.test';
const owner = 'owner@example.test';
const calendar = 'calendar@example.test';
const guest = 'guest@example.test';
const now = Date.parse('2026-11-06T10:00:00+08:00');

interface Message {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: { filename: string; content: string; content_type: string }[];
}

async function setup() {
  const DB = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const path of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    DB.migrate(path, await readFile(new URL(path, migrations), 'utf8'));
  }
  await DB.prepare('INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at) VALUES(1,?,?,?,?)')
    .bind('Synthetic owner', randomBytes(32).toString('base64url'), 'test-only', now).run();
  await DB.prepare("INSERT INTO passkeys(id,public_key,transports,name,device_type,created_at) VALUES('test-key','test','[]','Test','singleDevice',?)").bind(now).run();
  const token = randomBytes(32).toString('base64url');
  await DB.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES(?,?,'test-key','Test','macOS','Safari',?,?,?,?)`).bind(crypto.randomUUID(),await sha256(token),now,now,now+86_400_000,now).run();
  const app = createApi();
  const environment = { DB, SITE_ORIGIN: site, DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url') };
  async function request(path: string, method = 'GET', data?: unknown, credential: 'admin' | 'public' | string = 'admin') {
    const headers: Record<string,string> = { Origin: site };
    if (credential === 'admin') headers.Cookie = `__Host-admin_session=${token}`;
    else if (credential !== 'public') headers.Authorization = `Bearer ${credential}`;
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.request(`${site}${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, environment);
    return { status: response.status, data: await response.json() };
  }
  return { DB, request };
}

function attachment(message: Message) {
  assert.equal(message.attachments?.[0].filename, 'appointment.ics');
  assert.equal(message.attachments?.[0].content_type, 'text/calendar');
  return Buffer.from(message.attachments![0].content, 'base64').toString('utf8');
}

test('M2 邮箱验证、日历附件、邮件重试和一次性审批形成闭环', async t => {
  t.mock.method(Date, 'now', () => now);
  const { DB, request } = await setup();
  const provider: { idempotency: string; message: Message }[] = [];
  let failOwnerRequest = true;
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    assert.equal(input, 'https://api.resend.com/emails');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('Authorization'), `Bearer ${key}`);
    const message = JSON.parse(String(init.body)) as Message;
    provider.push({ idempotency: headers.get('Idempotency-Key') ?? '', message });
    if (message.to[0] === calendar && message.subject.startsWith('新的预约申请') && failOwnerRequest) {
      failOwnerRequest = false;
      return new Response(null, { status: 503 });
    }
    return Response.json({ id: 'synthetic-provider-accepted' });
  });

  assert.equal((await request('/api/admin/mail', 'GET', undefined, 'public')).status, 401);
  assert.equal((await request('/api/admin/mail', 'PATCH', { acceptRequests: true })).data.error, 'MAIL_NOT_CONFIGURED');
  assert.equal((await request('/api/admin/mail', 'PATCH', { sender, apiKey: key })).status, 200);
  const saved = await DB.prepare('SELECT api_key_cipher FROM mail_settings').first<{ api_key_cipher: string }>();
  assert.ok(saved && !saved.api_key_cipher.includes(key));
  const mailbox = (await request('/api/admin/mailboxes', 'POST', { address: owner })).data.mailbox;
  assert.equal((await request('/api/admin/mail', 'PATCH', { primaryDeliveryId: mailbox.id })).data.error, 'MAILBOX_UNVERIFIED');
  assert.equal((await request(`/api/admin/mailboxes/${mailbox.id}/code`, 'POST', {})).status, 200);
  assert.deepEqual(provider[0].message.to, [owner]);
  const code = provider[0].message.text.match(/^\d{6}$/m)![0];
  assert.equal((await request(`/api/admin/mailboxes/${mailbox.id}/verify`, 'POST', { code: code === '000000' ? '000001' : '000000' })).data.error, 'CODE_INVALID');
  assert.equal((await request(`/api/admin/mailboxes/${mailbox.id}/verify`, 'POST', { code })).status, 200);
  assert.equal((await request(`/api/admin/mailboxes/${mailbox.id}/verify`, 'POST', { code })).data.error, 'CODE_INVALID');
  assert.equal((await request(`/api/admin/mailboxes/${mailbox.id}/test`, 'POST', {})).status, 200);
  assert.match(attachment(provider[1].message), /STATUS:TENTATIVE\r\n/);

  const alt = crypto.randomUUID();
  await DB.prepare('INSERT INTO mailboxes(id,address,verified_at) VALUES(?,?,?)').bind(alt,calendar,now).run();
  const invite = (await request('/api/admin/invites', 'POST', { label: 'Synthetic invite', expiresAt: now+30*86_400_000, permissions: { modules:['calendar'], modes:['request'] } })).data;
  assert.equal((await request('/api/admin/mail', 'PATCH', { primaryDeliveryId: mailbox.id, notificationId: mailbox.id, acceptRequests: true })).status, 200);
  assert.equal((await request(`/api/admin/mail/overrides/${invite.invite.id}`, 'PATCH', { mailboxId: alt })).status, 200);
  const config = (await request('/api/admin/mail')).data;
  assert.equal(config.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(config).includes(key) && !JSON.stringify(config).includes(saved!.api_key_cipher));
  const startAt = Date.parse('2026-11-09T10:00:00+08:00');
  const form = { submissionId: crypto.randomUUID(), name: '<Visitor>', email: guest, startAt, duration: 60,
    meetingType: 'online', notes: '<img src=x>\nI would like to meet.', website: '' };
  const submitted = await request('/api/invite/requests', 'POST', form, invite.token);
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.mailStatus, 'failed');
  assert.equal(provider.length, 4);
  const pending = (await request('/api/admin/requests?status=pending')).data.requests[0];
  assert.equal(pending.status, 'pending');
  assert.equal(pending.mailStatus, 'failed');
  const retry = await request(`/api/admin/requests/${pending.id}/notify`, 'POST', {});
  assert.equal(retry.status, 200);
  assert.equal(retry.data.request.mailStatus, 'sent');
  assert.equal(provider.length, 5);
  const first = provider.find(item => item.message.to[0] === calendar)!;
  const retryMail = provider.at(-1)!;
  assert.equal(retryMail.idempotency, first.idempotency);
  assert.deepEqual(retryMail.message, first.message);
  assert.equal(retryMail.message.reply_to, guest);
  assert.match(retryMail.message.html!, /&lt;img src=x&gt;/);
  assert.doesNotMatch(retryMail.message.html!, /<img/);
  const tentative = attachment(retryMail.message);
  assert.match(tentative, /STATUS:TENTATIVE\r\n/);
  assert.match(tentative, /TRANSP:TRANSPARENT\r\n/);
  assert.match(tentative, /DTSTART:20261109T020000Z\r\n/);
  const review = retryMail.message.text.match(/#\/review\/([^/]+)\/confirm/)![1];
  assert.equal((await request('/api/request-action', 'GET', undefined, review)).status, 200);
  assert.equal((await request('/api/request-action', 'GET', undefined, `${review.slice(0,-1)}!`)).status, 404);
  assert.equal(provider.length, 5);
  const decisions = await Promise.all([1,2].map(() => request('/api/request-action', 'POST', { action:'confirm' }, review)));
  assert.equal(decisions.filter(item => item.status === 200).length, 1);
  assert.ok(decisions.some(item => item.status === 404 || item.status === 409));
  assert.equal((await request('/api/request-action', 'POST', { action:'confirm' }, review)).status, 404);
  assert.equal(provider.length, 7);
  assert.deepEqual(provider.slice(-2).flatMap(item => item.message.to).sort(), [calendar,guest].sort());
  const confirmed = attachment(provider.at(-1)!.message);
  assert.match(confirmed, /STATUS:CONFIRMED\r\n/);
  assert.match(confirmed, /SEQUENCE:1\r\n/);
  assert.equal(confirmed.match(/^UID:.*$/m)![0], tentative.match(/^UID:.*$/m)![0]);
});
