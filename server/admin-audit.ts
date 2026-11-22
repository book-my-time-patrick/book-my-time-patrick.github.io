import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import type { Environment } from './db.js';

type Method = 'passkey' | 'password';
type AuditEnv = { Bindings: Environment };
const actors = new WeakMap<Request, Method>();
const writes = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function markAdminActor(c: Context<AuditEnv>, method: Method) {
  if (writes.has(c.req.method)) actors.set(c.req.raw, method);
}

export const auditAdminWrite: MiddlewareHandler<AuditEnv> = async (c, next) => {
  await next();
  const actor = actors.get(c.req.raw);
  if (!actor || c.res.status < 200 || c.res.status >= 300) return;
  const route = matchedRoutes(c).filter(entry => entry.method === c.req.method).at(-1)?.path ?? '';
  if (!route.startsWith('/api/admin/') || route.includes('*')) return;
  // The action is already committed. An audit failure must not cause clients to repeat it.
  try {
    await c.env.DB!.prepare('INSERT INTO admin_audit_log(id,recorded_at,method,route,auth_method) VALUES(?,?,?,?,?)')
      .bind(crypto.randomUUID(), Date.now(), c.req.method, route, actor).run();
  } catch {
    console.warn('Admin audit write failed');
  }
};
