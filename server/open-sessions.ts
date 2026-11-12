import type { Context, Hono } from 'hono';
import { BOOKING_DAY, REQUEST_DURATIONS, REQUEST_HORIZON } from '../shared/booking.js';
import { AuthError, requireAdmin } from './auth.js';
import { CALENDAR_FRESH_MS } from './calendar-availability.js';
import type { Environment, SqlDatabase } from './db.js';

type Ctx = Context<{ Bindings: Environment }>;
type Color = 'blue' | 'plum' | 'green' | 'amber';
type ActivityType = {
  id: string; name: string; emoji: string; color: Color; duration: number; location: string; capacity: number | null;
};
export type OpenSessionRow = {
  id: string; type_id: string; title: string; emoji: string; color: Color;
  start_at: number; end_at: number; location: string; description: string; map_url: string;
  capacity: number | null; approval_required: number; email_required: number; invite_ids: string;
  archived: number; confirmed: number; pending: number; conflict: number;
};

const minute = 60_000;
const maxBatch = 12;
const maxInviteIds = 40;
const openColor = new Set<Color>(['blue', 'plum', 'green', 'amber']);
const confirmedCount = "(SELECT COUNT(*) FROM booking_requests WHERE open_session_id=s.id AND status='confirmed')";
const pendingCount = "(SELECT COUNT(*) FROM booking_requests WHERE open_session_id=s.id AND status='pending')";
export const openVisibility = "(s.invite_ids='[]' OR EXISTS (SELECT 1 FROM json_each(s.invite_ids) WHERE value=?))";
export const openHasCapacity = `(s.capacity IS NULL OR ${confirmedCount}<s.capacity)`;

// Only use a source that has synchronized the complete interval recently.
export const openCalendarConflict = `EXISTS (SELECT 1 FROM calendar_sources cs, json_each(cs.busy_json) busy
  WHERE cs.synced_at>? AND cs.synced_at<=? AND cs.last_error IS NULL
    AND cs.covered_from<=s.start_at AND cs.covered_until>=s.end_at
    AND json_extract(busy.value,'$[0]')<s.end_at AND json_extract(busy.value,'$[1]')>s.start_at)`;
export const openOtherBooking = `EXISTS (SELECT 1 FROM booking_requests b
  WHERE b.status='confirmed' AND (b.open_session_id IS NULL OR b.open_session_id<>s.id)
    AND b.start_at<s.end_at AND b.end_at>s.start_at)`;
export const openConflicts = `(${openCalendarConflict} OR ${openOtherBooking})`;
export const openClock = (now: number) => [now - CALENDAR_FRESH_MS, now] as const;

function dbFor(c: Ctx) {
  if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return c.env.DB;
}

function invalid(): never { throw new AuthError(400, 'INVALID_INPUT'); }

async function body(c: Ctx): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') invalid();
  const data: unknown = await c.req.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) invalid();
  return data as Record<string, unknown>;
}

function text(value: unknown, max: number, multiline = false) {
  const control = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || value.length > max || control.test(value)) invalid();
  return value.trim().replace(/\r\n?/g, '\n');
}

function duration(value: unknown) {
  if (typeof value !== 'number' || !REQUEST_DURATIONS.some(length => length === value)) invalid();
  return value;
}

function capacity(value: unknown) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) invalid();
  return value;
}

function mapLink(value: unknown) {
  const input = text(value, 512);
  if (!input) return '';
  const url = URL.canParse(input) ? new URL(input) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password) invalid();
  return url.href;
}

function activity(input: Record<string, unknown>): Omit<ActivityType, 'id'> {
  const name = text(input.name, 36);
  const color = input.color as Color;
  if (!name || !openColor.has(color)) invalid();
  return { name, emoji: text(input.emoji, 32), color, duration: duration(input.duration),
    location: text(input.location, 100), capacity: capacity(input.capacity) };
}

function openTime(value: unknown, length: number, now: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now || value > now + REQUEST_HORIZON
    || value % (30 * minute) !== 0) throw new AuthError(409, 'SLOT_UNAVAILABLE');
  const localMinute = ((value + 8 * 60 * minute) % BOOKING_DAY) / minute;
  if (localMinute < 9 * 60 || localMinute + length > 21 * 60) throw new AuthError(409, 'SLOT_UNAVAILABLE');
  return value;
}

function sessionView(row: OpenSessionRow) {
  return {
    id: row.id, title: row.title, emoji: row.emoji, color: row.color, startAt: row.start_at, endAt: row.end_at,
    location: row.location, description: row.description, mapUrl: row.map_url, capacity: row.capacity,
    remaining: row.capacity === null ? null : Math.max(0, row.capacity - row.confirmed),
    approvalRequired: row.approval_required === 1, emailRequired: row.email_required === 1,
  };
}

export async function weekOpenSessions(db: SqlDatabase, startAt: number, endAt: number, now: number, inviteId: string) {
  const result = await db.prepare(`SELECT s.*, ${confirmedCount} AS confirmed
    FROM open_sessions s WHERE s.archived=0 AND s.start_at>? AND s.start_at>=? AND s.start_at<?
    AND ${openVisibility} AND NOT ${openConflicts} ORDER BY s.start_at`)
    .bind(now, startAt, endAt, inviteId, ...openClock(now)).all<OpenSessionRow>();
  return result.results.map(sessionView);
}

export function mountOpenSessions(app: Hono<{ Bindings: Environment }>) {
  const path = '/api/admin/open-sessions';
  const typesPath = '/api/admin/open-types';
  const adminOnly = async (c: Ctx, next: () => Promise<void>) => {
    if (!await requireAdmin(c)) throw new AuthError(401, 'UNAUTHORIZED');
    await next();
  };

  app.get(path, adminOnly, async c => {
    const db = dbFor(c), now = Date.now();
    const [types, sessions, invites] = await Promise.all([
      db.prepare('SELECT id,name,emoji,color,duration,location,capacity FROM activity_types WHERE archived=0 ORDER BY rowid').all<ActivityType>(),
      db.prepare(`SELECT s.*, ${confirmedCount} AS confirmed, ${pendingCount} AS pending,
          CASE WHEN s.archived=0 AND s.start_at>? THEN ${openConflicts} ELSE 0 END AS conflict
        FROM open_sessions s
        ORDER BY CASE WHEN s.archived=0 AND s.start_at>? THEN 0 ELSE 1 END,
          CASE WHEN s.archived=0 AND s.start_at>? THEN s.start_at ELSE -s.start_at END LIMIT 800`)
        .bind(now, ...openClock(now), now, now).all<OpenSessionRow>(),
      db.prepare(`SELECT id,label FROM invites WHERE kind='invite' AND revoked_at IS NULL AND expires_at>?
        AND EXISTS (SELECT 1 FROM json_each(permissions_json,'$.modes') WHERE value='open')
        ORDER BY created_at DESC`).bind(now).all<{ id: string; label: string }>(),
    ]);
    return c.json({ now, types: types.results, invites: invites.results, sessions: sessions.results.map(row => ({
      ...sessionView(row), typeId: row.type_id, inviteIds: JSON.parse(row.invite_ids) as string[],
      confirmed: row.confirmed, pending: row.pending, archived: row.archived === 1, conflict: row.conflict === 1,
    })) });
  });

  app.post(typesPath, adminOnly, async c => {
    const item = activity(await body(c));
    const saved = await dbFor(c).prepare(`INSERT INTO activity_types(id,name,emoji,color,duration,location,capacity)
      SELECT ?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM activity_types WHERE archived=0)<40 RETURNING id`)
      .bind(crypto.randomUUID(), item.name, item.emoji, item.color, item.duration, item.location, item.capacity).first();
    if (!saved) throw new AuthError(409, 'LIMIT_REACHED');
    return c.json({ ok: true }, 201);
  });
  app.patch(`${typesPath}/:id`, adminOnly, async c => {
    const item = activity(await body(c));
    const saved = await dbFor(c).prepare(`UPDATE activity_types SET name=?,emoji=?,color=?,duration=?,location=?,capacity=?
      WHERE id=? AND archived=0 RETURNING id`)
      .bind(item.name, item.emoji, item.color, item.duration, item.location, item.capacity, c.req.param('id')).first();
    if (!saved) throw new AuthError(404, 'NOT_FOUND');
    return c.json({ ok: true });
  });
  app.delete(`${typesPath}/:id`, adminOnly, async c => {
    await dbFor(c).prepare('UPDATE activity_types SET archived=1 WHERE id=?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  app.post(path, adminOnly, async c => {
    const input = await body(c), db = dbFor(c), now = Date.now();
    const length = duration(input.duration);
    if (!Array.isArray(input.startAts) || !input.startAts.length || input.startAts.length > maxBatch ||
      !Array.isArray(input.inviteIds) || input.inviteIds.length > maxInviteIds ||
      typeof input.approvalRequired !== 'boolean' || typeof input.emailRequired !== 'boolean') invalid();
    const typeId = text(input.typeId, 36);
    const inviteIds = [...new Set(input.inviteIds.map(id => text(id, 36)))];
    const starts = [...new Set(input.startAts.map(time => openTime(time, length, now)))].sort((a, b) => a - b);
    const candidates = starts.map(startAt => ({ id: crypto.randomUUID(), startAt, endAt: startAt + length * minute }));
    if (candidates.some((slot, index) => index > 0 && candidates[index - 1].endAt > slot.startAt)) {
      throw new AuthError(409, 'SLOT_CONFLICT');
    }
    const location = text(input.location, 100), description = text(input.description, 500, true);
    const mapUrl = mapLink(input.mapUrl), seats = capacity(input.capacity), visibility = JSON.stringify(inviteIds);
    const result = await db.prepare(`WITH candidate AS (
        SELECT json_extract(value,'$.id') AS id, json_extract(value,'$.startAt') AS start_at,
          json_extract(value,'$.endAt') AS end_at FROM json_each(?)
      )
      INSERT INTO open_sessions(id,type_id,title,emoji,color,start_at,end_at,location,description,map_url,capacity,approval_required,email_required,invite_ids)
      SELECT s.id,t.id,t.name,t.emoji,t.color,s.start_at,s.end_at,?,?,?,?,?,?,?
      FROM candidate s CROSS JOIN activity_types t WHERE t.id=? AND t.archived=0
        AND NOT EXISTS (SELECT 1 FROM candidate s WHERE ${openConflicts}
          OR EXISTS (SELECT 1 FROM open_sessions o WHERE o.archived=0 AND o.start_at<s.end_at AND o.end_at>s.start_at))
        AND (SELECT COUNT(*) FROM invites i JOIN json_each(?) target ON target.value=i.id
          WHERE i.kind='invite' AND i.revoked_at IS NULL AND i.expires_at>?
          AND EXISTS (SELECT 1 FROM json_each(i.permissions_json,'$.modes') WHERE value='open'))=?
      RETURNING id`).bind(JSON.stringify(candidates), location, description, mapUrl, seats, Number(input.approvalRequired),
      Number(input.emailRequired), visibility, typeId, ...openClock(now), visibility, now, inviteIds.length).all();
    if (result.results.length !== candidates.length) throw new AuthError(409, 'SLOT_CONFLICT');
    return c.json({ ok: true }, 201);
  });

  app.delete(`${path}/:id`, adminOnly, async c => {
    await dbFor(c).prepare('UPDATE open_sessions SET archived=1 WHERE id=?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });
}
