import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createApi } from '../server/app.js';

const app = createApi();
const environment = { FRONTEND_ORIGIN: 'https://invited.example.com' };

test('连通性接口只返回固定公开信号，禁止缓存与索引', async () => {
  const result = await app.request('https://api.example.com/api/health', {}, environment);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, service: 'invite-api' });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(result.headers.get('X-Robots-Tag')!, /noindex/);
  assert.ok(result.headers.has('Strict-Transport-Security'));
});

test('只允许精确的前端源，不能用相似域名绕过', async () => {
  const valid = await app.request('https://api.example.com/api/health', { headers: { Origin: environment.FRONTEND_ORIGIN } }, environment);
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('Access-Control-Allow-Origin'), environment.FRONTEND_ORIGIN);
  const denied = await app.request('https://api.example.com/api/health', { headers: { Origin: 'https://invited.example.com.evil.invalid' } }, environment);
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
});

test('预检受相同的源限制，独立 API 也可供同域备用服务调用', async () => {
  const preflight = await app.request('https://api.example.com/api/private', { method: 'OPTIONS', headers: { Origin: environment.FRONTEND_ORIGIN } }, environment);
  assert.equal(preflight.status, 204);
  const sameOrigin = await app.request('https://api.example.com/api/health', { headers: { Origin: 'https://api.example.com' } }, {});
  assert.equal(sameOrigin.status, 200);
  const unconfigured = await app.request('https://api.example.com/api/health', { headers: { Origin: environment.FRONTEND_ORIGIN } }, {});
  assert.equal(unconfigured.status, 403);
});

test('M0 所有业务入口与未知邀请统一关闭，不能枚举私人信息', async () => {
  for (const path of ['/api/invites/unknown', '/api/profile', '/api/availability', '/api/assets/a', '/api/admin', '/api/agent/chat']) {
    const result = await app.request(`https://api.example.com${path}`, {}, environment);
    assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: 'NOT_FOUND' });
  }
  const post = await app.request('https://api.example.com/api/bookings', { method: 'POST', body: '{}' }, environment);
  assert.equal(post.status, 404);
});
