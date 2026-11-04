import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from './app.js';

const app = createApi();
app.get('*', serveStatic({ root: './dist' }));

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 无效');

serve({
  port,
  hostname: '0.0.0.0',
  fetch: (request) => app.fetch(request, { FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN }),
}, () => console.log(`同域预览已启动 http://127.0.0.1:${port}`));
