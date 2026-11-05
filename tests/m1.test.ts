import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import { createApi } from '../server/app.js';
import type { Environment } from '../server/db.js';
import { openSqlite } from '../server/sqlite.js';
import { makeAuthenticator, totp } from './webauthn-fixture.js';

const origin = 'https://booking.example.test';
const rpID = 'booking.example.test';
type SetupFlow = { flowId: string; options: PublicKeyCredentialCreationOptionsJSON; totpSecret: string; totpUri: string };
type LoginFlow = { flowId: string; options: PublicKeyCredentialRequestOptionsJSON };
type RegisterFlow = { flowId: string; options: PublicKeyCredentialCreationOptionsJSON };
type SessionView = { id: string; label: string; os: string; browser: string; createdAt: number; lastSeenAt: number; expiresAt: number; recentAuthUntil: number; current: boolean };
type Invite = { id: string; label: string; expiresAt: number; revokedAt: number | null; openCount: number; permissions: { modules: string[]; modes: string[] } };
type Issued = { invite: Invite; token: string; url: string };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
function cookie(response: Response): string {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'A successful two-factor login must issue a session cookie');
  return value.split(';', 1)[0];
}
async function harness() {
  const DB = openSqlite(':memory:');
  const migrationDir = new URL('../migrations/', import.meta.url);
  for (const path of (await readdir(migrationDir)).filter(path => path.endsWith('.sql')).sort()) await DB.exec(await readFile(new URL(path, migrationDir), 'utf8'));
  const setupToken = randomBytes(32).toString('base64url');
  const environment: Environment = { DB, SITE_ORIGIN: origin, DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), SETUP_TOKEN_HASH: sha256(setupToken), SETUP_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString() };
  const app = createApi();
  const state = { cookie: '' };
  async function request<T = Record<string, unknown>>(path: string, method = 'GET', data?: unknown, options: { cookie?: string; origin?: string | null; headers?: Record<string, string>; environment?: Environment } = {}) {
    const headers: Record<string, string> = { ...(options.origin === null ? {} : { Origin: options.origin ?? origin }), ...(options.cookie ?? state.cookie ? { Cookie: options.cookie ?? state.cookie } : {}), ...options.headers };
    if (data !== undefined) headers['Content-Type'] = 'application/json';
    const response = await app.request(`${origin}${path}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, options.environment ?? environment);
    return { response, data: await response.json() as T };
  }
  return { DB, environment, setupToken, app, state, request };
}
async function configured(options: { remember?: boolean; zeroCounter?: boolean } = {}) {
  const h = await harness();
  const authenticator = makeAuthenticator(rpID, origin);
  const pending = await h.request<SetupFlow>('/api/admin/setup/options', 'POST', { setupToken: h.setupToken });
  assert.equal(pending.response.status, 200);
  const response = authenticator.register(pending.data.options, options.zeroCounter ? { counter: 0 } : {});
  const code = totp(pending.data.totpSecret, Date.now() - 30_000);
  const result = await h.request('/api/admin/setup/verify', 'POST', { flowId: pending.data.flowId, response, code, remember: options.remember ?? true, deviceName: '测试电脑' });
  assert.equal(result.response.status, 200);
  h.state.cookie = cookie(result.response);
  return { ...h, authenticator, secret: pending.data.totpSecret, setupResponse: result.response };
}
async function login(h: Awaited<ReturnType<typeof configured>>, options: { authenticator?: ReturnType<typeof makeAuthenticator>; time?: number; counter?: number } = {}) {
  const pending = await h.request<LoginFlow>('/api/admin/login/options', 'POST', {});
  assert.equal(pending.response.status, 200);
  const response = (options.authenticator ?? h.authenticator).authenticate(pending.data.options, options.counter === undefined ? {} : { counter: options.counter });
  const result = await h.request('/api/admin/login/verify', 'POST', { flowId: pending.data.flowId, response, code: totp(h.secret, options.time ?? Date.now()), remember: true, deviceName: '测试手机' });
  return { ...result, pending: pending.data, assertion: response, cookie: result.response.status === 200 ? cookie(result.response) : '' };
}
async function sessionCount(h: Awaited<ReturnType<typeof harness>>) { return (await h.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n; }
async function invite(h: Awaited<ReturnType<typeof configured>>) {
  const result = await h.request<Issued>('/api/admin/invites', 'POST', { label: '不应向访客展示的内部备注', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), permissions: { modules: ['calendar', 'contact'], modes: ['request'] } });
  assert.equal(result.response.status, 201); return result.data;
}

test('M1 缺少数据库或密钥时后台安全关闭', async () => {
  const h = await harness();
  for (const environment of [{}, { ...h.environment, DB: undefined }, { ...h.environment, DATA_ENCRYPTION_KEY: undefined }, { ...h.environment, SITE_ORIGIN: undefined }]) {
    const result = await h.request('/api/admin/status', 'GET', undefined, { environment });
    assert.equal(result.response.status, 503); assert.equal(result.data.error, 'ADMIN_UNAVAILABLE');
  }
  assert.equal(await sessionCount(h), 0);
});

test('M1 初始化只接受有效的专属凭据，过期、轮换与已完成初始化均拒绝', async () => {
  const h = await harness();
  assert.deepEqual((await h.request('/api/admin/status')).data, { configured: false });
  assert.equal((await h.request('/api/admin/setup/options', 'POST', { setupToken: 'unknown' })).response.status, 403);
  const expired = { ...h.environment, SETUP_EXPIRES_AT: new Date(Date.now() - 1).toISOString() };
  assert.equal((await h.request('/api/admin/setup/options', 'POST', { setupToken: h.setupToken }, { environment: expired })).response.status, 403);
  const pending = await h.request<SetupFlow>('/api/admin/setup/options', 'POST', { setupToken: h.setupToken });
  const authenticator = makeAuthenticator(rpID, origin);
  const request = { flowId: pending.data.flowId, response: authenticator.register(pending.data.options), code: totp(pending.data.totpSecret) };
  const rotated = { ...h.environment, SETUP_TOKEN_HASH: sha256(randomBytes(32).toString('base64url')) };
  assert.equal((await h.request('/api/admin/setup/verify', 'POST', request, { environment: rotated })).response.status, 403);
  assert.equal((await h.DB.prepare('SELECT COUNT(*) AS n FROM owners').first<{ n: number }>())!.n, 0);
  const active = await configured();
  assert.equal((await active.request('/api/admin/setup/options', 'POST', { setupToken: active.setupToken })).response.status, 403);
});

test('M1 完整初始化加密保存 TOTP，Cookie 与记住设备期限正确', async () => {
  const h = await configured();
  const value = h.setupResponse.headers.get('set-cookie')!;
  for (const expression of [/^__Host-admin_session=/, /HttpOnly/i, /Secure/i, /SameSite=Strict/i, /Path=\//]) assert.match(value, expression);
  const maxAge = Number(value.match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(maxAge >= 2_591_995 && maxAge <= 2_592_000);
  assert.doesNotMatch(value, /Domain=/i);
  const row = await h.DB.prepare('SELECT token_hash FROM sessions').first<{ token_hash: string }>();
  assert.equal(row!.token_hash, sha256(h.state.cookie.split('=')[1]));
  const owner = await h.DB.prepare('SELECT totp_cipher FROM owners').first<{ totp_cipher: string }>();
  assert.match(owner!.totp_cipher, /^v1\./); assert.ok(!owner!.totp_cipher.includes(h.secret));
  const me = await h.request<{ session: SessionView }>('/api/admin/me');
  assert.equal(me.response.status, 200); assert.equal(me.data.session.label, '测试电脑');
  assert.ok(me.data.session.expiresAt - me.data.session.createdAt <= 30 * 86_400_000);
  assert.deepEqual((await h.request('/api/admin/status')).data, { configured: true });
  const brief = await configured({ remember: false });
  const briefMe = await brief.request<{ session: SessionView }>('/api/admin/me');
  assert.equal(briefMe.data.session.expiresAt - briefMe.data.session.createdAt, 12 * 3_600_000);
});

test('M1 注册拒绝伪造的 Origin、RP、挑战、缺失 UV 及跨源上下文', async () => {
  for (const override of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { challenge: randomBytes(32).toString('base64url') }, { userVerified: false }, { crossOrigin: true, topOrigin: 'https://evil.example' }]) {
    const h = await harness();
    const pending = await h.request<SetupFlow>('/api/admin/setup/options', 'POST', { setupToken: h.setupToken });
    const authenticator = makeAuthenticator(rpID, origin);
    const result = await h.request('/api/admin/setup/verify', 'POST', { flowId: pending.data.flowId, response: authenticator.register(pending.data.options, override), code: totp(pending.data.totpSecret) });
    assert.equal(result.response.status, 401); assert.equal(result.data.error, 'AUTHENTICATION_FAILED'); assert.equal(result.response.headers.get('set-cookie'), null);
    assert.equal(await sessionCount(h), 0);
  }
});

test('M1 登录拒绝 Origin、RP、挑战、UV、UP、签名及跨源篡改', async () => {
  const h = await configured();
  for (const override of [{ origin: 'https://evil.example' }, { rpID: 'evil.example' }, { challenge: randomBytes(32).toString('base64url') }, { userVerified: false }, { userPresent: false }, { badSignature: true }, { crossOrigin: true, topOrigin: 'https://evil.example' }]) {
    const pending = await h.request<LoginFlow>('/api/admin/login/options', 'POST', {});
    assert.equal(pending.response.status, 200);
    const result = await h.request('/api/admin/login/verify', 'POST', { flowId: pending.data.flowId, response: h.authenticator.authenticate(pending.data.options, override), code: totp(h.secret) });
    assert.equal(result.response.status, 401); assert.equal(result.data.error, 'AUTHENTICATION_FAILED'); assert.equal(result.response.headers.get('set-cookie'), null);
  }
  assert.equal(await sessionCount(h), 1);
});

test('M1 登录挑战原子单次消费，错误 TOTP、过期挑战均不能换取会话', async () => {
  const h = await configured();
  const pending = await h.request<LoginFlow>('/api/admin/login/options', 'POST', {});
  const assertion = h.authenticator.authenticate(pending.data.options);
  const valid = totp(h.secret);
  const validWindow = new Set([-1, 0, 1].map(offset => totp(h.secret, Date.now() + offset * 30_000)));
  let invalid = '000000';
  while (validWindow.has(invalid)) invalid = String(Number(invalid) + 1).padStart(6, '0');
  const request = { flowId: pending.data.flowId, response: assertion, code: invalid };
  assert.equal((await h.request('/api/admin/login/verify', 'POST', request)).response.status, 401);
  assert.equal((await h.request('/api/admin/login/verify', 'POST', { ...request, code: valid })).response.status, 401);
  const expired = await h.request<LoginFlow>('/api/admin/login/options', 'POST', {});
  await h.DB.prepare('UPDATE auth_challenges SET expires_at=? WHERE id=?').bind(Date.now() - 1, expired.data.flowId).run();
  assert.equal((await h.request('/api/admin/login/verify', 'POST', { flowId: expired.data.flowId, response: h.authenticator.authenticate(expired.data.options), code: valid })).response.status, 401);
  const good = await login(h); assert.equal(good.response.status, 200);
  const repeated = await h.request('/api/admin/login/verify', 'POST', { flowId: good.pending.flowId, response: good.assertion, code: valid });
  assert.equal(repeated.response.status, 401); assert.equal(await sessionCount(h), 2);
});

test('M1 同一步 TOTP 并发仅一次成功，计数器为零的通行密钥仍可登录', async () => {
  const h = await configured({ zeroCounter: true });
  const flows = await Promise.all([h.request<LoginFlow>('/api/admin/login/options', 'POST', {}), h.request<LoginFlow>('/api/admin/login/options', 'POST', {})]);
  const code = totp(h.secret);
  const results = await Promise.all(flows.map(flow => h.request('/api/admin/login/verify', 'POST', { flowId: flow.data.flowId, response: h.authenticator.authenticate(flow.data.options, { counter: 0 }), code })));
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 401]);
  assert.equal(await sessionCount(h), 2);
  assert.equal((await h.DB.prepare('SELECT counter FROM passkeys').first<{ counter: number }>())!.counter, 0);
});

test('M1 可查看和改名登录设备，撤销与退出立即使指定会话失效', async () => {
  const h = await configured();
  const firstCookie = h.state.cookie;
  const second = await login(h); assert.equal(second.response.status, 200);
  const first = await h.request<{ session: SessionView }>('/api/admin/me');
  const devices = await h.request<{ devices: SessionView[] }>('/api/admin/devices', 'GET', undefined, { cookie: second.cookie });
  assert.equal(devices.data.devices.length, 2); assert.equal(devices.data.devices.filter(device => device.current).length, 1);
  assert.ok(devices.data.devices.every(device => !('userAgent' in device) && !('ip' in device)));
  assert.equal((await h.request(`/api/admin/devices/${first.data.session.id}`, 'PATCH', { label: '我的电脑' }, { cookie: second.cookie })).response.status, 200);
  assert.equal((await h.request<{ session: SessionView }>('/api/admin/me')).data.session.label, '我的电脑');
  assert.equal((await h.request(`/api/admin/devices/${first.data.session.id}`, 'DELETE', undefined, { cookie: second.cookie })).response.status, 200);
  assert.equal((await h.request('/api/admin/me', 'GET', undefined, { cookie: firstCookie })).response.status, 401);
  assert.equal((await h.request('/api/admin/me', 'GET', undefined, { cookie: second.cookie })).response.status, 200);
  const logout = await h.request('/api/admin/logout', 'POST', {}, { cookie: second.cookie });
  assert.equal(logout.response.status, 200); assert.match(logout.response.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await h.request('/api/admin/me', 'GET', undefined, { cookie: second.cookie })).response.status, 401);
});

test('M1 敏感操作要求近期两因素验证，重新验证挑战绑定原登录会话', async () => {
  const h = await configured();
  const second = await login(h); assert.equal(second.response.status, 200);
  const me = await h.request<{ session: SessionView }>('/api/admin/me');
  await h.DB.prepare('UPDATE sessions SET recent_auth_at=? WHERE id=?').bind(Date.now() - 11 * 60_000, me.data.session.id).run();
  const denied = await h.request('/api/admin/passkeys/options', 'POST', {});
  assert.equal(denied.response.status, 403); assert.equal(denied.data.error, 'REAUTH_REQUIRED');
  const pending = await h.request<LoginFlow>('/api/admin/reauth/options', 'POST', {});
  const request = { flowId: pending.data.flowId, response: h.authenticator.authenticate(pending.data.options), code: totp(h.secret, Date.now() + 30_000) };
  assert.equal((await h.request('/api/admin/reauth/verify', 'POST', request, { cookie: second.cookie })).response.status, 401);
  assert.equal((await h.request('/api/admin/reauth/verify', 'POST', request)).response.status, 200);
  assert.equal((await h.request('/api/admin/passkeys/options', 'POST', {})).response.status, 200);
});

test('M1 保留最后一个通行密钥，撤销其他凭据立即使其会话失效', async () => {
  const h = await configured();
  const denied = await h.request(`/api/admin/passkeys/${h.authenticator.id}`, 'DELETE');
  assert.equal(denied.response.status, 409); assert.equal(denied.data.error, 'LAST_PASSKEY');
  const pending = await h.request<RegisterFlow>('/api/admin/passkeys/options', 'POST', {});
  const secondKey = makeAuthenticator(rpID, origin);
  assert.equal((await h.request('/api/admin/passkeys/verify', 'POST', { flowId: pending.data.flowId, response: secondKey.register(pending.data.options), deviceName: '另一把密钥' })).response.status, 200);
  const second = await login(h, { authenticator: secondKey }); assert.equal(second.response.status, 200);
  assert.equal((await h.request(`/api/admin/passkeys/${secondKey.id}`, 'DELETE')).response.status, 200);
  assert.equal((await h.request('/api/admin/me', 'GET', undefined, { cookie: second.cookie })).response.status, 401);
  assert.equal((await h.request('/api/admin/me')).response.status, 200);
  assert.equal((await h.request(`/api/admin/passkeys/${h.authenticator.id}`, 'DELETE')).response.status, 409);
});

test('M1 邀请只保存哈希，创建复制与权限生效，预览不增加真实访问次数', async () => {
  const h = await configured();
  const issued = await invite(h);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(issued.url, `${origin}/#/i/${issued.token}`);
  const stored = await h.DB.prepare('SELECT token_hash FROM invites WHERE id=?').bind(issued.invite.id).first<{ token_hash: string }>();
  assert.equal(stored!.token_hash, sha256(issued.token));
  const opened = await h.request<{ preview: boolean; permissions: Invite['permissions'] }>('/api/invite', 'GET', undefined, { headers: { Authorization: `Bearer ${issued.token}` } });
  assert.equal(opened.response.status, 200); assert.equal(opened.data.preview, false); assert.deepEqual(opened.data.permissions, issued.invite.permissions);
  assert.ok(!JSON.stringify(opened.data).includes(issued.invite.label));
  const listed = await h.request<{ invites: Invite[] }>('/api/admin/invites');
  assert.equal(listed.data.invites[0].openCount, 1); assert.ok(!JSON.stringify(listed.data).includes(issued.token));
  const clone = await h.request<Issued>(`/api/admin/invites/${issued.invite.id}/clone`, 'POST', {});
  assert.equal(clone.response.status, 201); assert.notEqual(clone.data.token, issued.token); assert.deepEqual(clone.data.invite.permissions, issued.invite.permissions);
  const preview = await h.request<{ url: string; expiresAt: number }>('/api/admin/preview', 'POST', { inviteId: issued.invite.id });
  assert.equal(preview.response.status, 201); assert.ok(preview.data.expiresAt <= Date.now() + 3_600_000);
  const token = preview.data.url.split('/#/i/')[1];
  for (let i = 0; i < 2; i++) {
    const checked = await h.request<{ preview: boolean }>('/api/invite', 'GET', undefined, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(checked.response.status, 200); assert.equal(checked.data.preview, true);
  }
  const counts = await h.DB.prepare('SELECT kind,open_count FROM invites').all<{ kind: string; open_count: number }>();
  assert.equal(counts.results.find(row => row.kind === 'preview')!.open_count, 0);
  assert.equal((await h.request<{ invites: Invite[] }>('/api/admin/invites')).data.invites.length, 2);
  assert.equal((await h.request('/api/admin/invites', 'POST', { label: 'x', expiresAt: new Date(Date.now() + 60_000).toISOString(), permissions: { modules: ['private-calendar-details'], modes: [] } })).response.status, 400);
});

test('M1 无效、过期、撤销邀请统一拒绝，私人接口和跨源后台不能绕过门禁', async () => {
  const h = await configured();
  const expired = await invite(h), revoked = await invite(h);
  await h.DB.prepare('UPDATE invites SET expires_at=? WHERE id=?').bind(Date.now() - 1, expired.invite.id).run();
  assert.equal((await h.request(`/api/admin/invites/${revoked.invite.id}`, 'DELETE')).response.status, 200);
  for (const token of [expired.token, revoked.token, randomBytes(32).toString('base64url')]) {
    const result = await h.request('/api/invite', 'GET', undefined, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(result.response.status, 404); assert.deepEqual(result.data, { error: 'NOT_FOUND' });
  }
  assert.equal((await h.request(`/api/invite?token=${revoked.token}`)).response.status, 404);
  assert.equal((await h.request('/api/admin/invites', 'GET', undefined, { cookie: '' })).response.status, 401);
  assert.equal((await h.request('/api/admin/devices/revoke-others', 'POST', {}, { origin: null })).response.status, 403);
  assert.equal((await h.request('/api/admin/devices/revoke-others', 'POST', {}, { origin: 'https://evil.example' })).response.status, 403);
  for (const path of ['/api/profile', '/api/availability', '/api/assets/private', '/api/bookings']) assert.equal((await h.request(path)).response.status, 404);
});
