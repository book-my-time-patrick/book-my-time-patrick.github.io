import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApi } from '../server/app.js';
import { randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const now = Date.parse('2026-11-06T16:30:00Z'); // 2026-11-07 in UTC+8.
const origin = 'https://booking.example.test';
const settings = '/api/admin/calendar-location';
const calendar = '/api/invite/calendar';
type Locations = { defaultCity: string; dates: { date: string; city: string }[] };
type Calendar = { days: { date: string; city?: string }[] };

async function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => now);
  const DB = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    DB.migrate(file, await readFile(new URL(file, migrations), 'utf8'));
  }
  const session = randomToken();
  await DB.prepare(`INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at)
    VALUES(1,'Synthetic owner','synthetic-id','unused',?)`).bind(now).run();
  await DB.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES('synthetic-key','unused','Synthetic','[]','singleDevice',?)`).bind(now).run();
  await DB.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES('synthetic-session',?,'synthetic-key','Synthetic','Test','Test',?,?,?,?)`)
    .bind(await sha256(session), now, now, now + 86_400_000, now).run();
  const app = createApi(), env = { DB, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: randomToken() };

  async function call<T = Record<string, unknown>>(path: string, options: {
    method?: string; admin?: boolean; token?: string; body?: Record<string, unknown>;
  } = {}) {
    const headers = new Headers({ Origin: origin });
    if (options.admin) headers.set('Cookie', `__Host-admin_session=${session}`);
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await app.request(`${origin}${path}`, { headers, method: options.method ?? 'GET',
      body: options.body ? JSON.stringify(options.body) : undefined }, env);
    return { status: response.status, data: await response.json() as T };
  }
  async function invite(modules: string[], modes = ['request']) {
    const result = await call<{ token: string; invite: { id: string } }>('/api/admin/invites', {
      method: 'POST', admin: true, body: { label: 'Private synthetic label', expiresAt: now + 3_600_000, permissions: { modules, modes } },
    });
    assert.equal(result.status, 201);
    return result.data;
  }
  return { DB, call, invite };
}

test('地点设置受管理登录保护，支持整个 UTC+8 预约窗口的日期覆盖', async t => {
  const { call } = await fixture(t);
  const patch = (defaultCity: unknown) => call(settings, { method: 'PATCH', admin: true, body: { defaultCity } });
  const override = (startDate: string, endDate: string, city = '示例城市') =>
    call(`${settings}/dates`, { method: 'POST', admin: true, body: { startDate, endDate, city } });
  const list = () => call<Locations>(settings, { admin: true });
  assert.equal((await call(settings)).status, 401);
  assert.equal((await call(settings, { method: 'PATCH', body: { defaultCity: '示例城市' } })).status, 401);
  assert.equal((await call(`${settings}/dates`, { method: 'POST', body: {} })).status, 401);
  assert.equal((await call(`${settings}/dates/2026-11-07`, { method: 'DELETE' })).status, 401);
  assert.deepEqual((await list()).data, { defaultCity: '', dates: [] });
  assert.equal((await patch('  Example  City ')).status, 200);
  for (const invalid of ['示例市,某某街', '示例市/某某区', '示例路12号', '示例市\n', '城'.repeat(25), null]) {
    assert.deepEqual((await patch(invalid)).data, { error: 'INVALID_CITY' });
  }
  assert.equal((await list()).data.defaultCity, 'Example City');
  assert.equal((await override('2026-11-07', '2026-12-07', 'Example-City')).status, 200);
  const full = (await list()).data.dates;
  assert.equal(full.length, 31);
  assert.deepEqual(full[0], { date: '2026-11-07', city: 'Example-City' });
  assert.deepEqual(full.at(-1), { date: '2026-12-07', city: 'Example-City' });
  for (const [from, through] of [
    ['2026-11-06', '2026-11-07'], ['2026-11-07', '2026-12-08'], ['2026-11-08', '2026-11-07'],
    ['2026-11-07', '2026-11-31'], ['2026-11-7', '2026-11-08'],
  ]) assert.deepEqual((await override(from, through)).data, { error: 'INVALID_DATE_RANGE' });
  assert.deepEqual((await override('2026-11-07', '2026-11-07', '')).data, { error: 'INVALID_CITY' });
  assert.deepEqual((await list()).data.dates, full);
  assert.equal((await override('2026-11-07', '2026-11-07', '另一城市')).status, 200);
  assert.deepEqual((await list()).data.dates[0], { date: '2026-11-07', city: '另一城市' });
  for (let i = 0; i < 2; i++) assert.equal((await call(`${settings}/dates/2026-11-07`, { admin: true, method: 'DELETE' })).status, 200);
  assert.equal((await list()).data.dates.length, 30);
  assert.equal((await patch('')).status, 200);
  assert.equal((await list()).data.defaultCity, '');
});

test('受邀周历只向同时有日历及行程权限的链接显示范围内的城市', async t => {
  const { DB, call, invite } = await fixture(t);
  const allowed = await invite(['calendar', 'travel']);
  const calendarOnly = await invite(['calendar']);
  const requestOnly = await invite(['travel']);
  const travelOnly = await invite(['travel'], []);
  const date = (week: Calendar, key: string) => week.days.find(day => day.date === key);
  assert.ok((await call<Calendar>(calendar, allowed)).data.days.every(day => !('city' in day)));
  assert.equal((await call(settings, { admin: true, method: 'PATCH', body: { defaultCity: '默认示例城' } })).status, 200);
  assert.equal((await call(`${settings}/dates`, { admin: true, method: 'POST', body: {
    startDate: '2026-11-07', endDate: '2026-11-07', city: '指定示例城',
  } })).status, 200);
  await DB.prepare(`INSERT INTO calendar_location_dates(date_key,city)
    VALUES('2026-11-06','过去示例城'),('2026-12-08','范围外示例城')`).run();
  const week = (await call<Calendar>(calendar, allowed)).data;
  assert.equal(date(week, '2026-11-07')?.city, '指定示例城');
  assert.equal(date(week, '2026-11-08')?.city, '默认示例城');
  assert.equal(date(week, '2026-11-06')?.city, undefined);
  const last = (await call<Calendar>(`${calendar}?week=5`, allowed)).data;
  assert.equal(date(last, '2026-12-07')?.city, '默认示例城');
  assert.equal(date(last, '2026-12-08')?.city, undefined);
  const privateSettings = (await call<Locations>(settings, { admin: true })).data;
  assert.deepEqual(privateSettings.dates, [{ date: '2026-11-07', city: '指定示例城' }]);
  for (const restricted of [calendarOnly, requestOnly]) {
    const result = await call<Calendar>(calendar, restricted);
    assert.equal(result.status, 200);
    assert.ok(result.data.days.every(day => !('city' in day)));
  }
  const preview = await call<{ url: string }>('/api/admin/preview', { admin: true, method: 'POST', body: {
    permissions: { modules: ['calendar', 'travel'], modes: ['request'] },
  } });
  assert.equal(preview.status, 201);
  const token = new URL(preview.data.url).hash.slice(4);
  assert.equal(date((await call<Calendar>(calendar, { token })).data, '2026-11-07')?.city, '指定示例城');
  assert.deepEqual((await call(calendar, travelOnly)).data, { error: 'NOT_FOUND' });
  assert.deepEqual((await call(calendar)).data, { error: 'NOT_FOUND' });
  assert.doesNotMatch(JSON.stringify((await call('/api/invite', allowed)).data), /示例城/);
  assert.equal((await call(`/api/admin/invites/${allowed.invite.id}`, { admin: true, method: 'DELETE' })).status, 200);
  assert.deepEqual((await call(calendar, allowed)).data, { error: 'NOT_FOUND' });
});
