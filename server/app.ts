import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AuthError, mountAuth } from './auth.js';
import { mountBookings } from './booking.js';
import { mountBookingReview } from './booking-review.js';
import { mountCalendarLocation } from './calendar-location.js';
import { mountCalendarSources } from './calendar-sources.js';
import { mountInvites } from './invites.js';
import { mountMailSettings } from './mail-settings.js';
import type { Environment } from './db.js';

export type { Environment } from './db.js';

// M0 只暴露无个人信息的连通性探针。未实现的业务接口统一关闭。
export function createApi() {
  const app = new Hono<{ Bindings: Environment }>();

  app.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    context.header('Referrer-Policy', 'no-referrer');
    context.header('X-Content-Type-Options', 'nosniff');
    context.header('X-Frame-Options', 'DENY');
    context.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    context.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (new URL(context.req.url).protocol === 'https:') {
      context.header('Strict-Transport-Security', 'max-age=31536000');
    }
    await next();
  });

  app.use('/api/*', async (context, next) => {
    context.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    context.header('Vary', 'Origin');
    const origin = context.req.header('Origin');
    const sameOrigin = new URL(context.req.url).origin;
    if (origin && origin !== sameOrigin && origin !== context.env.FRONTEND_ORIGIN) {
      return context.json({ error: 'FORBIDDEN' }, 403);
    }
    if (origin) context.header('Access-Control-Allow-Origin', origin);
    if (context.req.method === 'OPTIONS') {
      context.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      context.header('Access-Control-Max-Age', '600');
      return context.body(null, 204);
    }
    await next();
  });

  app.use('/api/*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: 'INVALID_INPUT' }, 413) }));

  app.get('/api/health', (context) => context.json({ ok: true, service: 'invite-api' }));
  mountAuth(app);
  mountInvites(app);
  mountBookings(app);
  mountMailSettings(app);
  mountBookingReview(app);
  mountCalendarLocation(app);
  mountCalendarSources(app);
  app.all('/api/*', (context) => context.json({ error: 'NOT_FOUND' }, 404));
  app.all('/api', (context) => context.json({ error: 'NOT_FOUND' }, 404));
  app.get('/robots.txt', (context) => context.text('User-agent: *\nDisallow: /\n'));
  app.notFound((context) => context.json({ error: 'NOT_FOUND' }, 404));
  app.onError((error, context) => error instanceof AuthError
    ? context.json({ error: error.code }, error.status as 400 | 401 | 403 | 404 | 409 | 429 | 503)
    : context.json({ error: 'SERVICE_UNAVAILABLE' }, 503));
  return app;
}
