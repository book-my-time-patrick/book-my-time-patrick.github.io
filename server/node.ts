import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from './app.js';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openSqlite } from './sqlite.js';

const app = createApi();
app.get('*', serveStatic({ root: './dist' }));
const databasePath = process.env.DATABASE_PATH || './.local/app.sqlite';
await mkdir(dirname(databasePath), { recursive: true });
const DB = openSqlite(databasePath);
for (const file of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
  DB.migrate(file, await readFile(`migrations/${file}`, 'utf8'));
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');
const trustedSite = process.env.SITE_ORIGIN ? new URL(process.env.SITE_ORIGIN) : null;

function externalRequest(request: Request): Request {
  const url = new URL(request.url);
  // Only enable for the isolated Node service behind our HTTPS reverse proxy.
  if (process.env.TRUST_PROXY === '1' && trustedSite?.protocol === 'https:' && url.host === trustedSite.host && request.headers.get('x-forwarded-proto') === 'https') {
    url.protocol = 'https:';
    return new Request(url, request);
  }
  return request;
}

serve({
  port,
  hostname: '0.0.0.0',
  fetch: (request) => app.fetch(externalRequest(request), {
    FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN,
    SITE_ORIGIN: process.env.SITE_ORIGIN,
    DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY,
    SETUP_TOKEN_HASH: process.env.SETUP_TOKEN_HASH,
    SETUP_EXPIRES_AT: process.env.SETUP_EXPIRES_AT,
    DB,
  }),
}, () => console.log(`同域预览已启动 http://127.0.0.1:${port}`));
