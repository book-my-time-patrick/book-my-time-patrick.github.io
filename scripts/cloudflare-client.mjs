import { execFileSync } from 'node:child_process';
import { EnvHttpProxyAgent, fetch } from 'undici';

// 凭据只在进程内流转，禁用 Wrangler 的 token 日志。
export function createCloudflareClient() {
  let credential;
  try {
    const output = execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'auth', 'token', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' },
    });
    credential = JSON.parse(output);
  } catch {
    throw new Error('无法读取官方 Wrangler 登录，请先运行 npx wrangler login');
  }
  if (typeof credential.token !== 'string' || !credential.token) throw new Error('Wrangler 登录凭据不可用');
  const dispatcher = new EnvHttpProxyAgent();

  async function request(path, options = {}) {
    if (!path.startsWith('/accounts') && path !== '/graphql' && !path.startsWith('/zones?')) throw new Error('仅允许账号、域名列表或指标查询');
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...options,
      dispatcher,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || data.success === false || data.errors?.length) {
      // 不输出完整响应、凭据、请求头或个人信息。
      const codes = Array.isArray(data.errors) ? data.errors.map((error) => error.code).filter(Number.isFinite) : [];
      throw new Error(`Cloudflare API ${response.status} (${codes.join(',') || 'UNKNOWN'})`);
    }
    return path === '/graphql' ? data.data : data.result;
  }

  return { request, dispatcher };
}
