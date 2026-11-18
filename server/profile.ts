import type { Context, Hono } from 'hono';
import { AuthError, requireAdmin } from './auth.js';
import type { Environment, SqlDatabase } from './db.js';

type Ctx = Context<{ Bindings: Environment }>;

// 受邀者可见的文字模块与对应数据库列。顺序即展示顺序。
const sections = ['profile', 'tracks', 'investments', 'contact'] as const;
type Section = typeof sections[number];
const NAME_LIMIT = 40;
const TEXT_LIMIT = 2000;

interface Row { display_name: string; profile: string; tracks: string; investments: string; contact: string; updated_at: number }

function database(c: Ctx) {
  if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return c.env.DB;
}

async function readRow(db: SqlDatabase): Promise<Row> {
  const row = await db.prepare('SELECT display_name,profile,tracks,investments,contact,updated_at FROM profile_content WHERE id=1').first<Row>();
  if (!row) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return row;
}

// 只接受纯文本：统一换行、去除首尾空白，拒绝控制字符与行分隔符。
function readText(value: unknown, limit: number, multiline: boolean) {
  if (typeof value !== 'string') throw new AuthError(400, 'INVALID_PROFILE');
  const text = value.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').normalize('NFC').trim();
  const forbidden = multiline ? /[\p{Cc}\p{Zl}\p{Zp}](?<!\n)/u : /[\p{C}\p{Zl}\p{Zp}]/u;
  if (forbidden.test(text) || [...text].length > limit) throw new AuthError(400, 'INVALID_PROFILE');
  return multiline ? text.replace(/\n{3,}/g, '\n\n') : text.replace(/ +/g, ' ');
}

/** 返回某个邀请有权看到的个人展示内容。个人名称只随「个人介绍」模块下发。 */
export async function publicProfile(db: SqlDatabase, modules: readonly string[]) {
  const row = await readRow(db);
  const content: Partial<Record<Section, string>> = {};
  for (const section of sections) if (modules.includes(section) && row[section]) content[section] = row[section];
  return { displayName: modules.includes('profile') ? row.display_name : '', content };
}

export function mountProfile(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/admin/profile', adminOnly, async c => {
    const row = await readRow(database(c));
    return c.json({
      displayName: row.display_name, profile: row.profile, tracks: row.tracks,
      investments: row.investments, contact: row.contact, updatedAt: row.updated_at,
    });
  });

  app.patch('/api/admin/profile', adminOnly, async c => {
    if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new AuthError(400, 'INVALID_INPUT');
    const input: unknown = await c.req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthError(400, 'INVALID_INPUT');
    const data = input as Record<string, unknown>;
    const allowed = ['displayName', ...sections];
    const keys = Object.keys(data);
    if (!keys.length || keys.some(key => !allowed.includes(key))) throw new AuthError(400, 'INVALID_INPUT');
    const columns: [string, string][] = keys.map(key => key === 'displayName'
      ? ['display_name', readText(data[key], NAME_LIMIT, false)]
      : [key, readText(data[key], TEXT_LIMIT, true)]);
    await database(c).prepare(`UPDATE profile_content SET ${columns.map(([column]) => `${column}=?`).join(',')},updated_at=? WHERE id=1`)
      .bind(...columns.map(([, value]) => value), Date.now()).run();
    return c.json({ ok: true });
  });
}

async function adminOnly(c: Ctx, next: () => Promise<void>) {
  if (!await requireAdmin(c)) throw new AuthError(401, 'UNAUTHENTICATED');
  await next();
}
