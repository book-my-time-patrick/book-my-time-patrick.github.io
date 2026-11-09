import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApi } from '../server/app.js';
import { CALENDAR_FRESH_MS, CALENDAR_WINDOW_MS } from '../server/calendar-availability.js';
import type { BusyRange } from '../server/calendar-availability.js';
import type { SqlDatabase } from '../server/db.js';
import { encryptSecret, randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const origin = 'https://booking.example.test';
const now = Date.parse('2026-11-09T08:00:00+08:00');
const halfHour = 30 * 60_000;
const startAt = now + 2 * halfHour;
const direct = '/api/invite/direct';
const request = '/api/invite/requests';
const calendar = '/api/invite/calendar';

interface Mail {
  to: string[];
  attachments: { content: string; content_type: string }[];
}
interface Calendar {
  availability?: string;
  validUntil?: number;
  canBook?: boolean;
  canSubmit: boolean;
  days: { slots: { startAt: number; availability?: string; bookableDurations?: number[] }[] }[];
}

async function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => now);
  const db = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    db.migrate(file, await readFile(new URL(file, migrations), 'utf8'));
  }
  const key = randomToken();
  const session = randomToken();
  await db.prepare("INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at) VALUES(1,'Owner','owner','unused',?)").bind(now).run();
  await db.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES('fixture-key','unused','Synthetic','[]','singleDevice',?)`).bind(now).run();
  await db.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES('fixture-session',?,'fixture-key','Synthetic','Test','Test',?,?,?,?)`)
    .bind(await sha256(session), now, now, now + 86_400_000, now).run();
  await db.prepare("INSERT INTO mailboxes(id,address,verified_at) VALUES('delivery','owner@example.test',?)").bind(now).run();
  await db.prepare(`UPDATE mail_settings SET sender='booking@example.test',api_key_cipher=?,primary_delivery_id='delivery',accept_requests=1`)
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
    token?: string; admin?: boolean; body?: object; method?: string; database?: SqlDatabase;
  } = {}) {
    const headers = new Headers({ Origin: origin });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.admin) headers.set('Cookie', `__Host-admin_session=${session}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await app.request(`${origin}${path}`, {
      headers, method: options.method ?? (options.body ? 'POST' : 'GET'), body: options.body ? JSON.stringify(options.body) : undefined,
    }, { DB: options.database ?? db, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: key });
    return { status: response.status, data: await response.json() as T };
  }
  async function invite({ kind = 'invite', directEnabled = 1, modules = ['calendar'], modes = ['request', 'direct'], hideBusy = false } = {}) {
    const token = randomToken();
    const id = crypto.randomUUID();
    const permissions = { modules, modes, ...(hideBusy ? { hideBusy } : {}) };
    await db.prepare(`INSERT INTO invites(id,token_hash,label,permissions_json,created_at,expires_at,kind,creator_session_id,direct_enabled)
      VALUES(?,?,'fixture',?,?,?,?,'fixture-session',?)`)
      .bind(id, await sha256(token), JSON.stringify(permissions), now, now + 3_600_000, kind, directEnabled).run();
    return { token, id, permissions };
  }
  async function source(provider: 'icloud' | 'outlook', busy: BusyRange[] = []) {
    await db.prepare(`INSERT INTO calendar_sources(provider,config_encrypted,revision,synced_at,covered_from,covered_until,busy_json)
      VALUES(?,'synthetic','revision',?,?,?,?)`)
      .bind(provider, now, now, now + CALENDAR_WINDOW_MS + CALENDAR_FRESH_MS, JSON.stringify(busy)).run();
  }
  return { db, call, invite, source, sent };
}

function booking(overrides: Record<string, unknown> = {}) {
  return { name: 'Guest', email: 'guest@example.test', startAt, duration: 60, meetingType: 'online', submissionId: crypto.randomUUID(), ...overrides };
}

test('M3 仅在双来源同步后显示忙闲，隐藏占用标签且对时长逐一判断冲突', async t => {
  const f = await fixture(t);
  const visible = await f.invite();
  await f.source('icloud', [[startAt + halfHour, startAt + 2 * halfHour]]);
  const partial = (await f.call<Calendar>(calendar, visible)).data;
  assert.equal(partial.availability, 'unavailable');
  assert.equal(partial.canBook, false);
  assert.equal(partial.canSubmit, true);
  assert.equal((await f.call(direct, { ...visible, body: booking() })).data.error, 'REQUESTS_DISABLED');

  await f.source('outlook');
  const ready = (await f.call<Calendar>(calendar, visible)).data;
  assert.equal(ready.availability, 'ready');
  assert.equal(ready.canBook, true);
  assert.equal(ready.validUntil, now + CALENDAR_FRESH_MS);
  assert.deepEqual(ready.days[0].slots[0].bookableDurations, [30]);
  assert.equal(ready.days[0].slots[1].availability, 'busy');
  assert.equal((await f.call(direct, { ...visible, body: booking() })).data.error, 'SLOT_CONFLICT');

  const hidden = await f.invite({ hideBusy: true });
  const hiddenCalendar = (await f.call<Calendar>(calendar, hidden)).data;
  assert.equal(hiddenCalendar.days[0].slots[1].availability, 'blocked');
  assert.doesNotMatch(JSON.stringify(hiddenCalendar), /busy_json|coveredFrom|coveredUntil|icloud|outlook|"busy"/i);
  const manual = await f.invite({ modes: ['request'] });
  const manualCalendar = (await f.call<Calendar>(calendar, manual)).data;
  assert.equal(manualCalendar.canBook, false);
  assert.equal(manualCalendar.days[0].slots[1].availability, 'busy');
  assert.equal(manualCalendar.days[0].slots[0].bookableDurations, undefined);
  const requestOnly = await f.invite({ modules: [], modes: ['request'] });
  assert.equal((await f.call<Calendar>(calendar, requestOnly)).data.availability, undefined);
});

test('M3 旧链接需重新启用直接预约，预览可看忙闲而不能发邮件或预约', async t => {
  const f = await fixture(t);
  await f.source('icloud');
  await f.source('outlook');
  const legacy = await f.invite({ directEnabled: 0 });
  const view = await f.call<{ permissions: { modes: string[] } }>('/api/invite', legacy);
  assert.deepEqual(view.data.permissions.modes, ['request']);
  const blocked = await f.call(direct, { ...legacy, body: booking() });
  assert.equal(blocked.status, 403);
  const edit = `/api/admin/invites/${legacy.id}`;
  assert.equal((await f.call(edit, { admin: true, method: 'PATCH', body: { label: 'Changed' } })).status, 200);
  assert.equal((await f.call<Calendar>(calendar, legacy)).data.canBook, false);
  assert.equal((await f.call(edit, { admin: true, method: 'PATCH', body: { permissions: legacy.permissions } })).status, 200);
  assert.equal((await f.call<Calendar>(calendar, legacy)).data.canBook, true);

  const preview = await f.invite({ kind: 'preview' });
  const previewWeek = (await f.call<Calendar>(calendar, preview)).data;
  assert.equal(previewWeek.canBook, false);
  assert.deepEqual(previewWeek.days[0].slots[0].bookableDurations, [30, 60, 90, 120]);
  assert.equal((await f.call(direct, { ...preview, body: booking() })).status, 403);
  await f.db.prepare('UPDATE mail_settings SET accept_requests=0').run();
  const directOnly = (await f.call<Calendar>(calendar, legacy)).data;
  assert.equal(directOnly.canSubmit, false);
  assert.equal(directOnly.canBook, true);
  await f.db.prepare('UPDATE calendar_settings SET direct_enabled=0').run();
  assert.equal((await f.call<Calendar>(calendar, legacy)).data.canBook, false);
  assert.equal(f.sent.length, 0);
});

test('M3 重叠直接预约只有一笔生效，重试幂等且向双方送达确认附件', async t => {
  const f = await fixture(t);
  await f.source('icloud');
  await f.source('outlook');
  const first = { ...await f.invite(), body: booking() };
  const second = { ...await f.invite(), body: booking({ startAt: startAt + halfHour }) };
  const results = await Promise.all([f.call(direct, first), f.call(direct, second)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  assert.equal(results.find(result => result.status === 409)?.data.error, 'SLOT_CONFLICT');
  const winner = results[0].status === 201 ? first : second;
  assert.equal(f.sent.length, 2);
  for (const message of f.sent) {
    const attachment = message.attachments[0];
    const content = Buffer.from(attachment.content, 'base64').toString('utf8');
    assert.equal(attachment.content_type, 'text/calendar; method=REQUEST; charset=UTF-8');
    assert.match(content, /METHOD:REQUEST\r\n/);
    assert.match(content, /STATUS:CONFIRMED\r\n/);
    assert.ok(content.includes(`ATTENDEE:mailto:${message.to[0]}\r\n`));
  }
  assert.deepEqual(f.sent.map(message => message.to[0]).sort(), ['guest@example.test', 'owner@example.test']);
  assert.equal((await f.call(direct, winner)).status, 200);
  assert.equal((await f.call(request, winner)).data.error, 'SUBMISSION_CHANGED');
  assert.equal(f.sent.length, 2);

  const occupied = (await f.call<Calendar>(calendar, { token: winner.token })).data.days[0].slots
    .find(slot => slot.startAt === winner.body.startAt);
  assert.equal(occupied?.availability, 'busy');
  const requested = booking({ startAt: winner.body.startAt });
  assert.equal((await f.call(request, { ...winner, body: requested })).status, 201);
  const pending = await f.db.prepare('SELECT id,updated_at FROM booking_requests WHERE submission_id=?').bind(requested.submissionId)
    .first<{ id: string; updated_at: number }>();
  const decision = await f.call(`/api/admin/requests/${pending!.id}/decision`, {
    admin: true, body: { action: 'confirm', expectedUpdatedAt: pending!.updated_at },
  });
  assert.equal(decision.data.error, 'SLOT_CONFLICT');
  const adjacent = booking({ startAt: winner.body.startAt + 2 * halfHour, duration: 30 });
  assert.equal((await f.call(direct, { ...winner, body: adjacent })).status, 201);
});

test('M3 提交时重新校验同步和邀请状态，失效后仍可人工申请', async t => {
  const f = await fixture(t);
  const invitation = await f.invite();
  await f.source('icloud');
  await f.source('outlook');
  function beforeInsert(sql: string, values: unknown[]) {
    return { ...f.db, prepare(query: string) {
      // The local SQLite adapter completes the write before returning the promise.
      if (query.includes('INSERT INTO booking_requests')) void f.db.prepare(sql).bind(...values).run();
      return f.db.prepare(query);
    } };
  }
  const stale = await f.call(direct, { ...invitation, body: booking(), database: beforeInsert(
    "UPDATE calendar_sources SET synced_at=? WHERE provider='icloud'", [now - CALENDAR_FRESH_MS],
  ) });
  assert.equal(stale.data.error, 'REQUESTS_DISABLED');
  assert.equal((await f.call<Calendar>(calendar, invitation)).data.availability, 'unavailable');
  assert.equal((await f.call(request, { ...invitation, body: booking() })).status, 201);
  await f.db.prepare('UPDATE calendar_sources SET synced_at=?').bind(now).run();
  const revoked = await f.call(direct, { ...invitation, body: booking(), database: beforeInsert(
    'UPDATE invites SET revoked_at=? WHERE id=?', [now, invitation.id],
  ) });
  assert.equal(revoked.status, 404);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM booking_requests WHERE source='direct'").first<{ n: number }>())?.n, 0);
  assert.equal(f.sent.length, 1);
});
