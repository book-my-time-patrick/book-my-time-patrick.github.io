import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createApi } from '../server/app.js';
import { refreshCalendars } from '../server/calendar-sources.js';
import { decryptSecret, randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

test('工作日历授权绑定当前会话、只交换一次，连接与刷新只保存加密凭据和忙碌区间', async t => {
  const origin = 'https://booking.example.test';
  const base = '/api/admin/calendar-sources';
  const now = Date.parse('2026-11-09T00:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const DB = openSqlite(':memory:');
  for (const name of (await readdir('migrations')).filter(file => file.endsWith('.sql')).sort()) {
    DB.migrate(name, await readFile(`migrations/${name}`, 'utf8'));
  }
  await DB.prepare("INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at) VALUES(1,'Test','test','unused',?)").bind(now).run();
  await DB.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES('test-key','unused','Test','[]','singleDevice',?)`).bind(now).run();
  const sessions = [randomToken(), randomToken()];
  for (const [index, session] of sessions.entries()) {
    await DB.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
      VALUES(?,?,'test-key','Test','Test','Test',?,?,?,?)`)
      .bind(String(index), await sha256(session), now, now, now + 86_400_000, now).run();
  }
  const env = { DB, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: randomToken() };
  const app = createApi();
  const call = (path: string, session: string, body?: object) => app.request(origin + path, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: origin, Cookie: `__Host-admin_session=${session}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, env);
  let tokenCalls = 0;
  let unavailable = false;
  const mock = t.mock.method(globalThis, 'fetch', async (address: URL, options?: RequestInit) => {
    if (address.hostname === 'login.microsoftonline.com') {
      const params = new URLSearchParams(String(options?.body));
      assert.equal(params.get('client_secret'), 'synthetic-private-value');
      if (++tokenCalls === 1) {
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.match(params.get('code_verifier') ?? '', /^[\w-]{43}$/);
      } else assert.equal(params.get('refresh_token'), `synthetic-refresh-${tokenCalls - 1}`);
      return Response.json({ token_type: 'Bearer', expires_in: 3600, access_token: 'synthetic-access', refresh_token: `synthetic-refresh-${tokenCalls}` });
    }
    assert.equal(address.hostname, 'graph.microsoft.com');
    if (address.pathname.endsWith('/calendars')) return Response.json({ value: [{ id: 'test-calendar', name: 'Work' }] });
    if (unavailable) return Response.json({}, { status: 503 });
    assert.equal(address.searchParams.get('$select'), 'start,end,isAllDay,showAs,isCancelled');
    return Response.json({ value: [{ start: { dateTime: '2026-11-09T02:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-09T03:00:00', timeZone: 'UTC' }, isAllDay: false, showAs: 'busy', isCancelled: false }] });
  });

  assert.equal((await call(base, '')).status, 401);
  const start = await call(base + '/outlook/start', sessions[0], {
    cloud: 'global', tenantId: 'tenant.example.test', clientId: '11111111-1111-1111-1111-111111111111', clientSecret: 'synthetic-private-value',
  });
  assert.equal(start.status, 200);
  const authorization = new URL((await start.json()).url);
  assert.equal(authorization.hostname, 'login.microsoftonline.com');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!authorization.href.includes('synthetic-private-value'));
  const state = authorization.searchParams.get('state');
  const callback = await app.request(origin + '/api/calendar-oauth/callback?' + new URLSearchParams({ state: state!, code: 'synthetic-code' }), {}, env);
  assert.equal(callback.status, 303);
  assert.match(callback.headers.get('Location') ?? '', /^\/#\/admin\/calendar-return\?state=/);
  const proof = { state, code: 'synthetic-code' };
  assert.equal((await call(base + '/outlook/finish', sessions[1], proof)).status, 409);
  assert.equal(mock.mock.callCount(), 0);
  assert.equal((await call(base + '/outlook/finish', sessions[0], proof)).status, 200);
  assert.equal((await call(base + '/outlook/finish', sessions[0], proof)).status, 409);
  const choices = await (await call(base, sessions[0])).text();
  assert.match(choices, /test-calendar/);
  assert.doesNotMatch(choices, /synthetic-(private|refresh|access)/);
  assert.equal((await call(base + '/outlook/select', sessions[0], { calendarId: 'test-calendar' })).status, 200);
  const stored = await DB.prepare("SELECT config_encrypted,busy_json FROM calendar_sources WHERE provider='outlook'")
    .first<{ config_encrypted: string; busy_json: string }>();
  assert.ok(stored);
  assert.doesNotMatch(stored.config_encrypted, /synthetic-/);
  assert.match(await decryptSecret(stored.config_encrypted, env.DATA_ENCRYPTION_KEY, 'calendar-outlook'), /synthetic-refresh-2/);
  assert.deepEqual(JSON.parse(stored.busy_json), [[now + 2 * 3_600_000, now + 3 * 3_600_000]]);
  assert.equal((await call(base + '/direct', sessions[0], { enabled: true })).status, 409);
  unavailable = true;
  await refreshCalendars(env);
  const status = await (await call(base, sessions[0])).json();
  const outlook = status.sources.find((source: { provider: string }) => source.provider === 'outlook');
  assert.equal(outlook.ready, false);
  assert.equal(outlook.error, 'CALENDAR_UNAVAILABLE');
  assert.equal((await call(base + '/disconnect', sessions[0], { provider: 'outlook' })).status, 200);
  assert.equal(await DB.prepare("SELECT provider FROM calendar_sources WHERE provider='outlook'").first(), null);
});
