import { mkdir, writeFile } from 'node:fs/promises';

const [frontendInput, apiInput] = process.argv.slice(2);

function origin(input, label) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) {
    throw new Error(`${label}请填写纯 HTTPS 源，例如 https://booking.example.com`);
  }
  return url;
}

try {
  const frontend = origin(frontendInput, '前端地址');
  const api = origin(apiInput, 'API 地址');
  if (api.hostname.endsWith('.workers.dev') || api.hostname.endsWith('.github.io')) {
    throw new Error('API 需要使用你可管理的自有域名');
  }
  await mkdir('.local', { recursive: true });
  await writeFile('.local/wrangler.production.jsonc', `${JSON.stringify({
    name: 'invited-booking-api',
    main: '../server/worker.ts',
    compatibility_date: '2026-11-04',
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false },
    vars: { FRONTEND_ORIGIN: frontend.origin },
    routes: [{ pattern: api.hostname, custom_domain: true }],
  }, null, 2)}\n`);
  console.log('已生成 .local/wrangler.production.jsonc');
  console.log(`GitHub 仓库变量 VITE_API_BASE_URL 填写 ${api.origin}/api`);
} catch (error) {
  console.error(error instanceof Error ? error.message : '配置失败');
  console.error('用法 npm run configure:worker -- https://你的账号.github.io https://api.你的域名');
  process.exitCode = 1;
}
