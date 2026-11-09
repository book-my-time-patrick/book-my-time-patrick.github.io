import { mkdir, readFile, writeFile } from 'node:fs/promises';

const [frontendInput, apiInput, siteInput, databaseInput] = process.argv.slice(2);

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
  const site = siteInput === undefined ? null : origin(siteInput, '站点地址');
  let existingDatabase;
  try { existingDatabase = JSON.parse(await readFile('.local/wrangler.production.jsonc', 'utf8')).d1_databases?.find((binding) => binding.binding === 'DB'); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('现有生产配置无法读取，已停止以免丢失数据库绑定；请先恢复配置'); }
  const databaseId = databaseInput || existingDatabase?.database_id;
  if (databaseId && !/^[a-f0-9-]{36}$/i.test(databaseId)) throw new Error('D1 数据库 ID 格式无效');
  if ([api, site].some((url) => url && /(^|\.)(workers\.dev|github\.io)$/.test(url.hostname))) {
    throw new Error('API 和站点需要使用你可管理的自有域名');
  }
  const routes = [{ pattern: api.hostname, custom_domain: true }];
  if (site && site.hostname !== api.hostname) {
    routes.push({ pattern: site.hostname, custom_domain: true });
  }
  await mkdir('.local', { recursive: true });
  await writeFile('.local/wrangler.production.jsonc', `${JSON.stringify({
    name: 'invited-booking-api',
    main: '../server/worker.ts',
    compatibility_date: '2026-11-04',
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false },
    triggers: { crons: ['*/5 * * * *'] },
    vars: { FRONTEND_ORIGIN: frontend.origin, SITE_ORIGIN: (site || api).origin },
    routes,
    ...(databaseId ? { d1_databases: [{ binding: 'DB', database_name: 'invited-booking', database_id: databaseId, migrations_dir: '../migrations' }] } : {}),
    ...(site ? {
      assets: {
        directory: './site-dist',
        not_found_handling: 'none',
        run_worker_first: ['/api', '/api/*'],
      },
    } : {}),
  }, null, 2)}\n`);
  console.log('已生成 .local/wrangler.production.jsonc');
  console.log(`GitHub 仓库变量 VITE_API_BASE_URL 填写 ${api.origin}/api`);
  if (site) {
    console.log(`分享入口 ${site.origin}/，可达性自检 ${site.origin}/#/check`);
    console.log('运行 npm run deploy:site，先重新构建静态前端，再发布站点与 API。后续前端修改也使用此命令。');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '配置失败');
  console.error('用法 npm run configure:worker -- https://你的账号.github.io https://api.你的域名 [https://你的站点域名] [D1数据库ID]');
  process.exitCode = 1;
}
