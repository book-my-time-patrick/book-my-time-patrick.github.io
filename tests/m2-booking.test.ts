import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApi } from '../server/app.js';
import type { Environment } from '../server/db.js';
import { encryptSecret, randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const origin = 'https://booking.example.test';
const now = Date.parse('2026-11-06T03:15:00Z');
const startAt = Date.parse('2026-11-06T03:30:00Z');
const calendarRoute = '/api/invite/calendar';
const requestRoute = '/api/invite/requests';
const adminRoute = '/api/admin/requests';
type Calendar = { weekStart: string; week: number; maxWeek: number; canSubmit: boolean; days: { date: string; slots: { startAt: number; state: string }[] }[] };
type Booking = { id: string; startAt: number; endAt: number; updatedAt: number; status: string; mailStatus: string };

async function fixture(t: TestContext) {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const DB = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const filename of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    DB.migrate(filename, await readFile(new URL(filename, migrations), 'utf8'));
  }
  const key = randomToken(), session = randomToken();
  const env: Environment = { DB, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: key };
  await DB.prepare(`INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at)
    VALUES (1,'Synthetic owner','synthetic-id','unused',?)`).bind(now).run();
  await DB.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES ('synthetic-key','unused','Synthetic','[]','singleDevice',?)`).bind(now).run();
  await DB.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES ('synthetic-session',?,'synthetic-key','Synthetic','Test','Test',?,?,?,?)`)
    .bind(await sha256(session), now, now, now + 86_400_000, now).run();
  await DB.prepare("INSERT INTO mailboxes(id,address,verified_at) VALUES('owner-mail','owner@example.test',?)").bind(now).run();
  await DB.prepare(`UPDATE mail_settings SET sender='booking@example.test',api_key_cipher=?,primary_delivery_id='owner-mail',accept_requests=1`)
    .bind(await encryptSecret('re_synthetic', key, 'mail-api-key')).run();

  const sent: { to: string[]; reply_to?: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails');
    sent.push(JSON.parse(String(options?.body)));
    return Response.json({ id: 'synthetic-mail' });
  });
  const app = createApi();
  async function call<T = Record<string, unknown>>(path: string, options: {
    token?: string; admin?: boolean; body?: Record<string, unknown>; database?: Environment['DB'];
  } = {}) {
    const headers = new Headers({ Origin: origin, 'CF-Connecting-IP': '192.0.2.7' });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.admin) headers.set('Cookie', `__Host-admin_session=${session}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      headers, method: options.body ? 'POST' : 'GET', body: options.body ? JSON.stringify(options.body) : undefined,
    }, { ...env, DB: options.database ?? DB });
    return { status: response.status, headers: response.headers, data: await response.json() as T };
  }
  async function invite(kind: 'invite' | 'preview' = 'invite', modules = ['calendar'], modes = ['request']) {
    const id = crypto.randomUUID(), token = randomToken();
    await DB.prepare(`INSERT INTO invites(id,token_hash,label,permissions_json,created_at,expires_at,kind,creator_session_id)
      VALUES (?,?,'Internal synthetic label',?,?,?,?, 'synthetic-session')`)
      .bind(id, await sha256(token), JSON.stringify({ modules, modes }), now, now + 3_600_000, kind).run();
    return { id, token };
  }
  return { DB, call, invite, sent, advance: (time: number) => { clock = time; } };
}

function application(overrides: Record<string, unknown> = {}) {
  return { submissionId: crypto.randomUUID(), name: 'Synthetic guest', email: 'Guest+work@EXAMPLE.TEST',
    startAt, duration: 60, meetingType: 'online', notes: 'Private synthetic note', website: '', ...overrides };
}

test('M2 周历校验权限，屏蔽过去时间，并且预览不计访问、不创建申请', async t => {
  const f = await fixture(t);
  const valid = await f.invite(), preview = await f.invite('preview');
  const readOnly = await f.invite('invite', ['calendar'], []);
  const denied = await f.invite('invite', ['profile'], []);
  assert.equal((await f.call(calendarRoute)).status, 404);
  assert.equal((await f.call(calendarRoute, denied)).status, 404);
  const week = await f.call<Calendar>(calendarRoute, valid);
  assert.equal(week.status, 200);
  assert.equal(week.data.weekStart, '2026-11-02');
  assert.equal(week.data.days.length, 7);
  assert.ok(week.data.days.every(day => day.slots.length === 24));
  assert.ok(week.data.days[0].slots.every(slot => slot.state === 'expired'));
  assert.ok(week.data.days[5].slots.every(slot => slot.state === 'unavailable'));
  assert.deepEqual(week.data.days[4].slots.find(slot => slot.startAt === startAt), { startAt, state: 'request' });
  assert.equal(week.data.canSubmit, true);
  assert.doesNotMatch(JSON.stringify(week.data), /Internal synthetic label|owner@example|Synthetic owner/);
  const end = (await f.call<Calendar>(`${calendarRoute}?week=99`, valid)).data;
  assert.equal(end.week, end.maxWeek);
  assert.equal((await f.call(`${calendarRoute}?week=-1`, valid)).status, 400);
  const restricted = (await f.call<Calendar>(calendarRoute, readOnly)).data;
  assert.equal(restricted.canSubmit, false);
  assert.ok(restricted.days.every(day => day.slots.every(slot => slot.state !== 'request')));
  assert.equal((await f.call<Calendar>(calendarRoute, preview)).data.canSubmit, false);
  for (const { token } of [preview, readOnly]) {
    const deniedPost = await f.call(requestRoute, { token, body: application() });
    assert.equal(deniedPost.status, 403);
    assert.equal(deniedPost.data.error, 'REQUESTS_DISABLED');
  }
  const oldSlot = await f.call(requestRoute, { ...valid, body: application({ startAt: startAt - 1_800_000 }) });
  assert.equal(oldSlot.data.error, 'SLOT_UNAVAILABLE');
  const tooLong = await f.call(requestRoute, { ...valid, body: application({ startAt: Date.parse('2026-11-06T12:30:00Z') }) });
  assert.equal(tooLong.data.error, 'SLOT_UNAVAILABLE');
  assert.equal((await f.call(requestRoute, { ...valid, body: application({ website: 'spam' }) })).status, 400);
  assert.equal((await f.call(requestRoute, { ...valid, body: application({ email: 'a@example.test\r\nBcc: b@example.test' }) })).status, 400);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM booking_requests').first<{ n: number }>())?.n, 0);
  assert.ok((await f.DB.prepare('SELECT open_count FROM invites').all<{ open_count: number }>()).results.every(row => row.open_count === 0));
  assert.equal(f.sent.length, 0);
});

test('M2 申请幂等，写入时重新检查邀请和邮件开关', async t => {
  const f = await fixture(t), valid = await f.invite();
  const body = application();
  const duplicates = await Promise.all([f.call(requestRoute, { ...valid, body }), f.call(requestRoute, { ...valid, body })]);
  assert.deepEqual(duplicates.map(item => item.status).sort(), [200, 201]);
  assert.deepEqual(duplicates.find(item => item.status === 201)?.data, { ok: true, mailStatus: 'sent' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].reply_to, 'Guest+work@example.test');
  assert.equal((await f.call(requestRoute, { ...valid, body: { ...body, name: 'Different' } })).data.error, 'SUBMISSION_CHANGED');

  function beforeInsert(sql: string, values: unknown[]): Environment['DB'] {
    return { ...f.DB, prepare(query) {
      // Node SQLite executes run() synchronously before yielding its result.
      if (query.includes('INSERT INTO booking_requests')) void f.DB.prepare(sql).bind(...values).run();
      return f.DB.prepare(query);
    } };
  }
  const lateDisable = await f.call(requestRoute, { ...valid, body: application(), database: beforeInsert('UPDATE mail_settings SET accept_requests=0', []) });
  assert.equal(lateDisable.data.error, 'REQUESTS_DISABLED');
  await f.DB.prepare('UPDATE mail_settings SET accept_requests=1').run();
  const lateRevoke = await f.call(requestRoute, { ...valid, body: application(), database: beforeInsert('UPDATE invites SET revoked_at=? WHERE id=?', [now, valid.id]) });
  assert.equal(lateRevoke.status, 404);
  assert.equal((await f.DB.prepare('SELECT COUNT(*) AS n FROM booking_requests').first<{ n: number }>())?.n, 1);
  assert.equal(f.sent.length, 1);
});

test('M2 申请限流按邀请与来源分别生效，重试同一申请不消耗额外额度', async t => {
  const f = await fixture(t), first = await f.invite(), second = await f.invite(), third = await f.invite();
  const retry = application();
  assert.equal((await f.call(requestRoute, { ...first, body: retry })).status, 201);
  for (let i = 0; i < 4; i++) assert.equal((await f.call(requestRoute, { ...first, body: application() })).status, 201);
  const throttled = await f.call(requestRoute, { ...first, body: application() });
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('Retry-After')) > 0);
  for (let i = 0; i < 24; i++) assert.equal((await f.call(requestRoute, { ...first, body: application() })).status, 429);
  assert.equal((await f.call(requestRoute, { ...first, body: retry })).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await f.call(requestRoute, { ...second, body: application() })).status, 201);
  for (let i = 0; i < 2; i++) assert.equal((await f.call(requestRoute, { ...third, body: application() })).status, 201);
  assert.equal((await f.call(requestRoute, { ...third, body: application() })).status, 429);
  assert.equal(f.sent.length, 12);
});

test('M2 同一时段可收到多份申请，但并发确认只能有一个成功，过期申请不会重发', async t => {
  const f = await fixture(t), invitation = await f.invite();
  for (const email of ['first@example.test', 'second@example.test']) {
    assert.equal((await f.call(requestRoute, { ...invitation, body: application({ email }) })).status, 201);
  }
  assert.equal((await f.call(adminRoute)).status, 401);
  const pending = (await f.call<{ requests: Booking[] }>(adminRoute, { admin: true })).data.requests;
  assert.equal(pending.length, 2);
  const decide = (request: Booking, action: string, extra: Record<string, unknown> = {}) =>
    f.call<{ request: Booking; error?: string }>(`${adminRoute}/${request.id}/decision`, { admin: true, body: { action, expectedUpdatedAt: request.updatedAt, ...extra } });
  const decisions = await Promise.all(pending.map(item => decide(item, 'confirm')));
  assert.deepEqual(decisions.map(item => item.status).sort(), [200, 409]);
  assert.equal(decisions.find(item => item.status === 409)?.data.error, 'SLOT_CONFLICT');
  const confirmed = decisions.find(item => item.status === 200)!.data.request;
  assert.equal((await decide(confirmed, 'cancel', { expectedUpdatedAt: now })).data.error, 'BOOKING_CHANGED');
  const remaining = pending.find(item => item.id !== confirmed.id)!;
  const suggested = (await decide(remaining, 'suggest', { startAt: confirmed.endAt, duration: 30 })).data.request;
  assert.equal(suggested.status, 'suggested');
  assert.equal((await decide(suggested, 'confirm')).data.request.status, 'confirmed');
  assert.equal((await decide(confirmed, 'cancel')).data.request.status, 'cancelled');
  assert.equal((await f.call(requestRoute, { ...invitation, body: application() })).status, 201);
  const expires = (await f.call<{ requests: Booking[] }>(adminRoute, { admin: true })).data.requests[0];
  f.advance(startAt + 1);
  const history = (await f.call<{ requests: Booking[] }>(`${adminRoute}?status=history`, { admin: true })).data.requests;
  assert.equal(history.find(item => item.id === expires.id)?.status, 'expired');
  const sent = f.sent.length;
  assert.equal((await f.call(`${adminRoute}/${expires.id}/notify`, { admin: true, body: {} })).data.error, 'SLOT_UNAVAILABLE');
  assert.equal(f.sent.length, sent);
});
