import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { probe, probeLabel } from '../web/src/connectivity.js';

test('API 未配置时不发送请求，结果明确为待配置且不算通过', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch');
  const result = await probe(null, 'invite-api');
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.unconfigured, true);
  assert.equal(probeLabel(result), '待配置');
});

test('前端占位 HTML、错误服务标识不能冒充 API 连通成功', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch');
  fetchMock.mock.mockImplementation(async () => new Response('<html>登录 Wi-Fi</html>'));
  assert.equal((await probe('https://api.example.com/api/health', 'invite-api')).ok, false);
  fetchMock.mock.mockImplementation(async () => Response.json({ ok: true, service: 'invite-web' }));
  assert.equal((await probe('https://api.example.com/api/health', 'invite-api')).ok, false);
});

test('服务错误与网络失败后允许正常重试，探针不携带凭据或 Referrer', async (context) => {
  const fetchMock = context.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) => {
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    return Response.json({ ok: true, service: 'invite-api' }, { status: 503 });
  });
  assert.equal((await probe('https://api.example.com/api/health', 'invite-api')).ok, false);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await probe('https://api.example.com/api/health', 'invite-api')).ok, false);
  fetchMock.mock.mockImplementation(async () => Response.json({ ok: true, service: 'invite-api' }));
  assert.equal((await probe('https://api.example.com/api/health', 'invite-api')).ok, true);
});
