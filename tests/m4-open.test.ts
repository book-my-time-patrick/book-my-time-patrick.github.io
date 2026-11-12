import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApi } from '../server/app.js';
import { CALENDAR_FRESH_MS, CALENDAR_WINDOW_MS } from '../server/calendar-availability.js';
import type { BusyRange } from '../server/calendar-availability.js';
import { encryptSecret, randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const origin = 'https://booking.example.test';
const now = Date.parse('2026-11-09T08:00:00+08:00');
const halfHour = 30 * 60_000;
const startAt = now + 2 * halfHour;
const calendar = '/api/invite/calendar';
const openPath = (id: string) => `/api/invite/open/${id}`;

interface Mail {
  to: string[];
  text: string;
  attachments?: { content: string; content_type: string }[];
}
interface SessionView {
  id: string; title: string; startAt: number; endAt: number;
  remaining: number | null; capacity: number | null;
  approvalRequired: boolean; emailRequired: boolean;
}
interface Week {
  availability?: string; canBook?: boolean; canSubmit: boolean;
  openSessions?: SessionView[];
  days: { city?: string; slots: { startAt: number; state: string; availability?: string; requestDurations?: number[] }[] }[];
}

async function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => now);
  const db = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    db.migrate(file, await readFile(new URL(file, migrations), 'utf8'));
  }
  const key = randomToken(), session = randomToken();
  await db.prepare("INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at) VALUES(1,'Owner','owner','unused',?)").bind(now).run();
  await db.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES('fixture-key','unused','Synthetic','[]','singleDevice',?)`).bind(now).run();
  await db.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES('fixture-session',?,'fixture-key','Synthetic','Test','Test',?,?,?,?)`)
    .bind(await sha256(session), now, now, now + 86_400_000, now).run();
  await db.prepare("INSERT INTO mailboxes(id,address,verified_at) VALUES('delivery','owner@example.test',?)").bind(now).run();
  await db.prepare("UPDATE mail_settings SET sender='booking@example.test',api_key_cipher=?,primary_delivery_id='delivery',accept_requests=1")
    .bind(await encryptSecret('re_synthetic', key, 'mail-api-key')).run();
  await db.prepare('UPDATE calendar_settings SET direct_enabled=1').run();
  const sent: Mail[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    assert.equal(url, 'https://api.resend.com/emails');
    sent.push(JSON.parse(String(options?.body)) as Mail);
    return Response.json({ id: 'synthetic-mail' });
  });
  const app = createApi();
  async function call<T = Record<string, unknown>>(path: string, options: {
    token?: string; admin?: boolean; body?: object; method?: string;
  } = {}) {
    const headers = new Headers({ Origin: origin });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.admin) headers.set('Cookie', `__Host-admin_session=${session}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      headers, method: options.method ?? (options.body ? 'POST' : 'GET'), body: options.body ? JSON.stringify(options.body) : undefined,
    }, { DB: db, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: key });
    return { status: response.status, data: await response.json() as T };
  }
  async function invite({ modules = [] as string[], modes = ['open'] } = {}) {
    const token = randomToken(), id = crypto.randomUUID();
    const permissions = { modules, modes };
    await db.prepare(`INSERT INTO invites(id,token_hash,label,permissions_json,created_at,expires_at,kind,creator_session_id,direct_enabled)
      VALUES(?,?,'fixture',?,?,?,'invite','fixture-session',?)`)
      .bind(id, await sha256(token), JSON.stringify(permissions), now, now + 3_600_000, Number(modes.includes('direct'))).run();
    return { token, id, permissions };
  }
  async function source(provider: 'icloud' | 'outlook', busy: BusyRange[] = []) {
    await db.prepare(`INSERT INTO calendar_sources(provider,config_encrypted,revision,synced_at,covered_from,covered_until,busy_json)
      VALUES(?,'synthetic','revision',?,?,?,?)`)
      .bind(provider, now, now, now + CALENDAR_WINDOW_MS + CALENDAR_FRESH_MS, JSON.stringify(busy)).run();
  }
  async function publish(overrides: Record<string, unknown> = {}) {
    const body = { typeId: 'coffee', startAts: [startAt], duration: 60, inviteIds: [], approvalRequired: false,
      emailRequired: false, location: 'Synthetic cafe', description: 'Synthetic public activity', mapUrl: '', capacity: 1, ...overrides };
    const result = await call('/api/admin/open-sessions', { admin: true, body });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const row = await db.prepare('SELECT id FROM open_sessions WHERE start_at=? AND archived=0')
      .bind((body.startAts as number[])[0]).first<{ id: string }>();
    assert.ok(row);
    return row.id;
  }
  async function bookingRow(submissionId: unknown) {
    const row = await db.prepare('SELECT id,updated_at,status,email FROM booking_requests WHERE submission_id=?')
      .bind(submissionId).first<{ id: string; updated_at: number; status: string; email: string }>();
    assert.ok(row);
    return row;
  }
  async function decide(submissionId: unknown, action: string) {
    const row = await bookingRow(submissionId);
    return call(`/api/admin/requests/${row.id}/decision`, { admin: true, body: { action, expectedUpdatedAt: row.updated_at } });
  }
  return { db, call, invite, source, publish, sent, bookingRow, decide };
}

function booking(overrides: Record<string, unknown> = {}) {
  return { name: 'Synthetic Guest', submissionId: crypto.randomUUID(), ...overrides };
}

test('M4 开放局按链接过滤，开放局独享链接不透露私人忙闲，关联预览只读', async t => {
  const f = await fixture(t);
  const allowed = await f.invite(), other = await f.invite();
  const publicId = await f.publish();
  const privateId = await f.publish({ startAts: [startAt + 4 * halfHour], inviteIds: [allowed.id] });
  const archived = await f.publish({ startAts: [startAt + 8 * halfHour] });
  await f.call(`/api/admin/open-sessions/${archived}`, { admin: true, method: 'DELETE' });
  await f.source('icloud', [[startAt + 12 * halfHour, startAt + 13 * halfHour]]);
  await f.source('outlook');
  const visible = await f.call<Week>(calendar, allowed);
  assert.equal(visible.status, 200);
  assert.deepEqual(visible.data.openSessions?.map(row => row.id), [publicId, privateId]);
  assert.equal(visible.data.availability, undefined);
  assert.equal(visible.data.canBook, undefined);
  assert.equal(visible.data.canSubmit, false);
  assert.ok(visible.data.days.every(day => !day.city && day.slots.every(slot => !slot.availability && slot.state !== 'request')));
  assert.doesNotMatch(JSON.stringify(visible.data), /invite_ids|inviteIds|confirmed|pending|owner@example|busy_json|icloud|outlook/);
  assert.deepEqual((await f.call<Week>(calendar, other)).data.openSessions?.map(row => row.id), [publicId]);
  assert.equal((await f.call(openPath(privateId), { ...other, body: booking() })).status, 404);
  const preview = await f.call<{ url: string }>('/api/admin/preview', { admin: true, body: { inviteId: allowed.id } });
  assert.equal(preview.status, 201);
  const token = preview.data.url.split('/').at(-1)!;
  assert.deepEqual((await f.call<Week>(calendar, { token })).data.openSessions?.map(row => row.id), [publicId, privateId]);
  assert.equal((await f.call(openPath(publicId), { token, body: booking() })).data.error, 'REQUESTS_DISABLED');
});

test('M4 单名额并发只确认一人，无邮箱仍交付日历且重试不重复发信', async t => {
  const f = await fixture(t), first = await f.invite(), second = await f.invite();
  const id = await f.publish();
  const drafts = [booking(), booking({ name: 'Second Guest' })];
  const links = [first, second];
  const result = await Promise.all(links.map((link, index) => f.call(openPath(id), { ...link, body: drafts[index] })));
  assert.deepEqual(result.map(row => row.status).sort(), [201, 409]);
  const winner = result.findIndex(row => row.status === 201);
  assert.equal(result[1 - winner].data.error, 'OPEN_FULL');
  assert.equal(result[winner].data.status, 'confirmed');
  const ics = String(result[winner].data.calendar);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /STATUS:CONFIRMED/);
  assert.match(ics, /LOCATION:Synthetic cafe/);
  assert.doesNotMatch(ics, /owner@example|ATTENDEE|Synthetic Guest|Second Guest/);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].to, ['owner@example.test']);
  assert.match(Buffer.from(f.sent[0].attachments![0].content, 'base64').toString(), /METHOD:REQUEST/);
  const retry = await f.call(openPath(id), { ...links[winner], body: drafts[winner] });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.calendar, ics);
  assert.equal(f.sent.length, 1);
  assert.equal((await f.call<Week>(calendar, first)).data.openSessions?.[0].remaining, 0);
  const changed = await f.call(openPath(id), { ...links[winner], body: { ...drafts[winner], name: 'Changed' } });
  assert.equal(changed.data.error, 'SUBMISSION_CHANGED');
});

test('M4 多人和无限名额保留同场次共存，确认邮件包含请求日历附件', async t => {
  const f = await fixture(t), link = await f.invite();
  const id = await f.publish({ capacity: 2, emailRequired: true });
  const result = await Promise.all(Array.from({ length: 3 }, (_, index) => f.call(openPath(id), {
    ...link, body: booking({ email: `guest${index}@example.test` }),
  })));
  assert.deepEqual(result.map(row => row.status).sort(), [201, 201, 409]);
  assert.equal(result.find(row => row.status === 409)?.data.error, 'OPEN_FULL');
  assert.equal(f.sent.length, 4);
  for (const message of f.sent) {
    assert.match(message.attachments![0].content_type, /method=REQUEST/i);
    assert.match(Buffer.from(message.attachments![0].content, 'base64').toString(), /STATUS:CONFIRMED/);
  }
  const unlimited = await f.publish({ startAts: [startAt + 4 * halfHour], capacity: null });
  const many = await Promise.all(Array.from({ length: 3 }, () => f.call(openPath(unlimited), { ...link, body: booking() })));
  assert.ok(many.every(row => row.status === 201));
  assert.equal((await f.call<Week>(calendar, link)).data.openSessions?.find(row => row.id === unlimited)?.remaining, null);
});

test('M4 周末可待确认，确认竞争名额，取消后释放且不强求邮箱', async t => {
  const f = await fixture(t), link = await f.invite();
  const saturday = Date.parse('2026-11-14T10:00:00+08:00');
  const id = await f.publish({ startAts: [saturday], approvalRequired: true });
  const a = booking(), b = booking({ name: 'Another Guest' });
  for (const draft of [a, b]) {
    const submitted = await f.call(openPath(id), { ...link, body: draft });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.data.status, 'pending');
    assert.equal(submitted.data.calendar, undefined);
  }
  assert.equal((await f.call<Week>(calendar, link)).data.openSessions?.[0].remaining, 1);
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(mail => mail.to.length === 1 && mail.to[0] === 'owner@example.test'));
  assert.equal((await f.decide(a.submissionId, 'suggest')).data.error, 'SLOT_UNAVAILABLE');
  const confirmed = await Promise.all([a, b].map(draft => f.decide(draft.submissionId, 'confirm')));
  assert.deepEqual(confirmed.map(row => row.status).sort(), [200, 409]);
  const winner = confirmed[0].status === 200 ? a : b, waiting = winner === a ? b : a;
  assert.equal((await f.decide(winner.submissionId, 'reschedule')).data.error, 'SLOT_UNAVAILABLE');
  assert.equal((await f.decide(winner.submissionId, 'cancel')).status, 200);
  assert.equal((await f.call<Week>(calendar, link)).data.openSessions?.[0].remaining, 1);
  assert.equal((await f.decide(waiting.submissionId, 'confirm')).status, 200);
  assert.equal((await f.bookingRow(waiting.submissionId)).email, '');
  const cancellation = f.sent.find(mail => mail.attachments?.some(item => Buffer.from(item.content, 'base64').toString().includes('STATUS:CANCELLED')));
  assert.ok(cancellation);
  assert.match(Buffer.from(cancellation.attachments![0].content, 'base64').toString(), /METHOD:CANCEL/);
});

test('M4 请求与直接预约不能穿过已发布场次，可申请时长逐项裁剪', async t => {
  const f = await fixture(t), link = await f.invite({ modules: ['calendar'], modes: ['open', 'request', 'direct'] });
  const id = await f.publish({ startAts: [startAt + halfHour] });
  await f.source('icloud');
  await f.source('outlook');
  const visible = (await f.call<Week>(calendar, link)).data;
  const before = visible.days[0].slots.find(slot => slot.startAt === startAt)!;
  assert.deepEqual(before.requestDurations, [30]);
  const during = visible.days[0].slots.find(slot => slot.startAt === startAt + halfHour)!;
  assert.equal(during.state, 'unavailable');
  const draft = { ...booking({ email: 'guest@example.test' }), startAt, duration: 60, meetingType: 'online' };
  for (const endpoint of ['/api/invite/requests', '/api/invite/direct']) {
    const denied = await f.call(endpoint, { ...link, body: draft });
    assert.equal(denied.status, 409);
    assert.equal(denied.data.error, 'SLOT_CONFLICT');
  }
  assert.equal((await f.call('/api/invite/requests', { ...link, body: { ...draft, duration: 30 } })).status, 201);
  const ordinary = await f.invite({ modules: ['calendar'], modes: ['request', 'direct'] });
  assert.equal((await f.call<Week>(calendar, ordinary)).data.openSessions, undefined);
  assert.equal((await f.call(openPath(id), { ...ordinary, body: booking() })).data.error, 'REQUESTS_DISABLED');
});

test('M4 必填邮箱和链接权限不能绕过，新忙碌记录与归档阻止提交', async t => {
  const f = await fixture(t), link = await f.invite();
  const id = await f.publish({ emailRequired: true });
  for (const bad of [booking(), booking({ email: 'invalid' }), booking({ email: 'ok@example.test', name: '' }),
    booking({ email: 'ok@example.test', website: 'spam' })]) {
    assert.equal((await f.call(openPath(id), { ...link, body: bad })).data.error, 'INVALID_INPUT');
  }
  await f.source('icloud', [[startAt, startAt + 2 * halfHour]]);
  assert.deepEqual((await f.call<Week>(calendar, link)).data.openSessions, []);
  assert.equal((await f.call(openPath(id), { ...link, body: booking({ email: 'ok@example.test' }) })).data.error, 'SLOT_UNAVAILABLE');
  await f.db.prepare('DELETE FROM calendar_sources').run();
  await f.call(`/api/admin/open-sessions/${id}`, { admin: true, method: 'DELETE' });
  assert.deepEqual((await f.call<Week>(calendar, link)).data.openSessions, []);
  assert.equal((await f.call(openPath(id), { ...link, body: booking({ email: 'ok@example.test' }) })).data.error, 'SLOT_UNAVAILABLE');
  assert.equal((await f.call(openPath(id), { body: booking({ email: 'ok@example.test' }) })).status, 404);
  assert.equal(f.sent.length, 0);
});

test('M4 批量发布遇到重叠整体拒绝，类型变更不修改已发布场次', async t => {
  const f = await fixture(t), link = await f.invite();
  await f.publish();
  const result = await f.call('/api/admin/open-sessions', { admin: true, body: {
    typeId: 'coffee', startAts: [startAt, startAt + 4 * halfHour], duration: 60,
    inviteIds: [], approvalRequired: false, emailRequired: false, location: '', description: '', mapUrl: '', capacity: 1,
  } });
  assert.equal(result.data.error, 'SLOT_CONFLICT');
  assert.equal((await f.db.prepare('SELECT COUNT(*) AS n FROM open_sessions').first<{ n: number }>())?.n, 1);
  const before = (await f.call<Week>(calendar, link)).data.openSessions![0];
  assert.equal((await f.call('/api/admin/open-types/coffee', { admin: true, method: 'PATCH', body: {
    name: 'Changed type', emoji: '☕', color: 'blue', duration: 30, location: 'New location', capacity: 2,
  } })).status, 200);
  assert.deepEqual((await f.call<Week>(calendar, link)).data.openSessions![0], before);
});
