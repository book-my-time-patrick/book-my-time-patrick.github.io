import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { createApi } from '../server/app.js';
import { randomToken, sha256 } from '../server/security.js';
import { openSqlite } from '../server/sqlite.js';

const origin = 'https://booking.example.test';
const now = Date.parse('2026-11-18T10:00:00+08:00');

interface InviteView {
  preview: boolean;
  permissions: { modules: string[] };
  profile: { displayName: string };
  content: Record<string, string>;
}

async function fixture(t: TestContext) {
  t.mock.method(Date, 'now', () => now);
  const db = openSqlite(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
    db.migrate(file, await readFile(new URL(file, migrations), 'utf8'));
  }
  const session = randomToken(), key = randomToken();
  await db.prepare("INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,created_at) VALUES(1,'Owner','owner','unused',?)").bind(now).run();
  await db.prepare(`INSERT INTO passkeys(id,public_key,name,transports,device_type,created_at)
    VALUES('fixture-key','unused','Synthetic','[]','singleDevice',?)`).bind(now).run();
  await db.prepare(`INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at)
    VALUES('fixture-session',?,'fixture-key','Synthetic','Test','Test',?,?,?,?)`)
    .bind(await sha256(session), now, now, now + 86_400_000, now).run();
  const app = createApi();
  async function call<T = Record<string, unknown>>(path: string, options: {
    token?: string; admin?: boolean; body?: unknown; method?: string; contentType?: string;
  } = {}) {
    const headers = new Headers({ Origin: origin });
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.admin) headers.set('Cookie', `__Host-admin_session=${session}`);
    if (options.body !== undefined) headers.set('Content-Type', options.contentType ?? 'application/json');
    const response = await app.request(`${origin}${path}`, {
      headers, method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }, { DB: db, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: key });
    return { status: response.status, data: await response.json() as T };
  }
  async function invite(modules: string[], kind: 'invite' | 'preview' = 'invite') {
    const token = randomToken();
    await db.prepare(`INSERT INTO invites(id,token_hash,label,permissions_json,created_at,expires_at,kind,creator_session_id,direct_enabled)
      VALUES(?,?,'fixture',?,?,?,?,'fixture-session',0)`)
      .bind(crypto.randomUUID(), await sha256(token), JSON.stringify({ modules, modes: ['request'] }), now, now + 3_600_000, kind).run();
    return token;
  }
  const save = (body: unknown, extra: { admin?: boolean; contentType?: string } = {}) =>
    call('/api/admin/profile', { admin: true, ...extra, method: 'PATCH', body });
  return { db, call, invite, save };
}

const content = {
  displayName: '  Synthetic   Host ',
  profile: 'Synthetic intro line one.\r\n\r\n\r\n\r\nLine two with <b>markup</b>.',
  tracks: 'Synthetic tracks',
  investments: 'Synthetic investments',
  contact: 'synthetic@example.test',
};

test('M5 个人展示内容需要管理员会话，初始为空', async t => {
  const { call } = await fixture(t);
  assert.equal((await call('/api/admin/profile')).status, 401);
  assert.equal((await call('/api/admin/profile', { method: 'PATCH', body: { profile: 'x' } })).status, 401);
  const initial = await call('/api/admin/profile', { admin: true });
  assert.equal(initial.status, 200);
  assert.deepEqual(initial.data, { displayName: '', profile: '', tracks: '', investments: '', contact: '', updatedAt: 0 });
});

test('M5 保存后规范化换行与空白，并支持只更新部分字段', async t => {
  const { call, save } = await fixture(t);
  assert.equal((await save(content)).status, 200);
  const saved = await call<Record<string, unknown>>('/api/admin/profile', { admin: true });
  assert.equal(saved.data.displayName, 'Synthetic Host');
  assert.equal(saved.data.profile, 'Synthetic intro line one.\n\nLine two with <b>markup</b>.');
  assert.equal(saved.data.updatedAt, now);
  assert.equal((await save({ tracks: '' })).status, 200);
  const next = await call<Record<string, unknown>>('/api/admin/profile', { admin: true });
  assert.equal(next.data.tracks, '');
  assert.equal(next.data.contact, 'synthetic@example.test');
});

test('M5 拒绝超长、控制字符、未知字段、非字符串和非 JSON 请求', async t => {
  const { call, save } = await fixture(t);
  assert.equal((await save(content)).status, 200);
  const bad: unknown[] = [
    {}, [], { unknown: 'x' }, { profile: 1 }, { profile: null }, { displayName: 'x'.repeat(41) },
    { displayName: 'two\nlines' }, { profile: 'x'.repeat(2001) }, { contact: 'bell\u0007' },
    { contact: 'sep arator' }, { tracks: 'ok', investments: 'x'.repeat(2001) },
  ];
  for (const body of bad) assert.equal((await save(body)).status, 400, JSON.stringify(body)?.slice(0, 40));
  assert.equal((await save({ profile: 'x' }, { contentType: 'text/plain' })).status, 400);
  assert.equal((await save({ profile: '汉'.repeat(2000), displayName: '汉'.repeat(40) })).status, 200);
  // 任何一次失败都不会部分写入。
  const stored = await call<Record<string, unknown>>('/api/admin/profile', { admin: true });
  assert.equal(stored.data.contact, 'synthetic@example.test');
  assert.equal(stored.data.investments, 'Synthetic investments');
});

test('M5 受邀者只取得本邀请已授权模块的内容', async t => {
  const { call, invite, save } = await fixture(t);
  await save(content);
  const calendarOnly = await call<InviteView>('/api/invite', { token: await invite(['calendar']) });
  assert.equal(calendarOnly.status, 200);
  assert.deepEqual(calendarOnly.data.content, {});
  assert.equal(calendarOnly.data.profile.displayName, '');

  const partial = await call<InviteView>('/api/invite', { token: await invite(['profile', 'contact']) });
  assert.deepEqual(Object.keys(partial.data.content).sort(), ['contact', 'profile']);
  assert.equal(partial.data.profile.displayName, 'Synthetic Host');
  assert.equal(partial.data.content.contact, 'synthetic@example.test');

  const noProfile = await call<InviteView>('/api/invite', { token: await invite(['tracks', 'investments']) });
  assert.deepEqual(noProfile.data.content, { tracks: 'Synthetic tracks', investments: 'Synthetic investments' });
  assert.equal(noProfile.data.profile.displayName, '', '称呼只随个人介绍模块下发');

  // 未授权的文字不能出现在整个响应里。
  assert.ok(!JSON.stringify(calendarOnly.data).includes('Synthetic'));
  assert.ok(!JSON.stringify(noProfile.data).includes('synthetic@example.test'));
});

test('M5 空字段不下发，预览与正式邀请看到相同内容，失效令牌一无所获', async t => {
  const { call, invite, save } = await fixture(t);
  await save({ profile: 'Only intro', tracks: '', investments: '', contact: '' });
  const all = ['profile', 'tracks', 'investments', 'contact'];
  const real = await call<InviteView>('/api/invite', { token: await invite(all) });
  assert.deepEqual(real.data.content, { profile: 'Only intro' });
  const preview = await call<InviteView>('/api/invite', { token: await invite(all, 'preview') });
  assert.equal(preview.data.preview, true);
  assert.deepEqual(preview.data.content, real.data.content);

  const unknown = await call<Record<string, unknown>>('/api/invite', { token: randomToken() });
  assert.equal(unknown.status, 404);
  assert.ok(!JSON.stringify(unknown.data).includes('Only intro'));
  assert.equal((await call('/api/invite')).status, 404);
});
