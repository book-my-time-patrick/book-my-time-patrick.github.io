import type { Hono } from 'hono';
import { DAY, MINUTE, DEFAULT_RULES, MAX_BOOKING_DAYS, MAX_BUFFER, dayStart, mondayOf, ruleDate, shiftDate, validZone } from '../shared/booking-rules.js';
import type { BookingRules } from '../shared/booking-rules.js';
import { AuthError, requireAdmin } from './auth.js';
import type { Environment, SqlDatabase } from './db.js';

function invalid(): never { throw new AuthError(400, 'INVALID_BOOKING_RULES'); }
function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
const validators: { [K in keyof BookingRules]: (value: unknown) => boolean } = {
  timeZone: validZone,
  weeklyHours: value => Array.isArray(value) && value.length === 7 && value.every(day => Array.isArray(day) && day.length <= 8
    && day.every((range, i) => Array.isArray(range) && range.length === 2 && integer(range[0], 0, 1439)
      && integer(range[1], 1, 1440) && range[0] < range[1] && (i === 0 || day[i - 1][1] <= range[0]))),
  blockedDates: value => Array.isArray(value) && value.length <= 366 && value.every(date => typeof date === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && shiftDate(date, 0) === date),
  leadMinutes: value => integer(value, 0, MAX_BOOKING_DAYS * 1440),
  horizonDays: value => integer(value, 1, MAX_BOOKING_DAYS),
  durations: value => Array.isArray(value) && value.length >= 1 && value.length <= 8
    && value.every(n => integer(n, 15, 120) && n % 15 === 0),
  stepMinutes: value => value === 15 || value === 30,
  bufferBefore: value => integer(value, 0, MAX_BUFFER),
  bufferAfter: value => integer(value, 0, MAX_BUFFER),
  dailyLimit: value => integer(value, 0, 100),
  weeklyLimit: value => integer(value, 0, 100),
};
export function parseRules(input: unknown): Partial<BookingRules> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid();
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(validators, key) || !validators[key as keyof BookingRules](value)) return invalid();
  }
  const rules = { ...input } as Partial<BookingRules>;
  if (rules.durations) rules.durations = [...new Set(rules.durations)].sort((a, b) => a - b);
  if (rules.blockedDates) rules.blockedDates = [...new Set(rules.blockedDates)].sort();
  return rules;
}
export function overrideJson(input: unknown) {
  if (input == null) return null;
  const rules = parseRules(input);
  return Object.keys(rules).length ? JSON.stringify(rules) : null;
}
export async function readRules(db: SqlDatabase, invite?: string) {
  const row = await db.prepare(`SELECT s.rules_json,s.revision,i.booking_rules_json FROM booking_rule_settings s
    LEFT JOIN invites i ON i.id=? WHERE s.id=1`).bind(invite ?? null)
    .first<{ rules_json: string; revision: string; booking_rules_json: string | null }>();
  if (!row) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  const rules: BookingRules = { ...DEFAULT_RULES, ...JSON.parse(row.rules_json), ...JSON.parse(row.booking_rules_json ?? '{}') };
  return { rules, revision: row.revision, override: row.booking_rules_json };
}
export const revisionGate = 'EXISTS (SELECT 1 FROM booking_rule_settings WHERE id=1 AND revision=?)';
export function coverageFor(rules: BookingRules) {
  return { before: rules.bufferBefore * MINUTE, after: rules.horizonDays * DAY + (Math.max(...rules.durations) + rules.bufferAfter) * MINUTE };
}
export async function syncCoverage(db: SqlDatabase, now: number) {
  const { rules } = await readRules(db);
  const row = await db.prepare(`SELECT MAX(COALESCE(json_extract(booking_rules_json,'$.bufferBefore'),?)) AS before_min,
    MAX(COALESCE(json_extract(booking_rules_json,'$.horizonDays'),?)*? +
    (COALESCE(json_extract(booking_rules_json,'$.durations[#-1]'),?) + COALESCE(json_extract(booking_rules_json,'$.bufferAfter'),?))*?) AS after_ms
    FROM invites WHERE booking_rules_json IS NOT NULL AND revoked_at IS NULL AND expires_at>? AND direct_enabled=1`)
    .bind(rules.bufferBefore,rules.horizonDays,DAY,Math.max(...rules.durations),rules.bufferAfter,MINUTE,now)
    .first<{ before_min: number | null; after_ms: number | null }>();
  const base = coverageFor(rules);
  return { before: Math.max(base.before, (row?.before_min ?? 0) * MINUTE),
    after: Math.max(base.after, coverageFor(DEFAULT_RULES).after, row?.after_ms ?? 0) };
}
export function quotaGuard(rules: BookingRules, at: number, except = '') {
  if (!rules.dailyLimit && !rules.weeklyLimit) return { sql: '1', bindings: [] };
  const date = ruleDate(at, rules.timeZone);
  const monday = mondayOf(date);
  const periods = [[date, 1, rules.dailyLimit], [monday, 7, rules.weeklyLimit]] as const;
  const enabled = periods.filter(([, , limit]) => limit > 0);
  const sql = enabled.map(() => `(SELECT COUNT(*) FROM booking_requests q WHERE q.status='confirmed'
    AND q.open_session_id IS NULL AND q.start_at>=? AND q.start_at<? AND q.id<>?)<?`).join(' AND ') || '1';
  const bindings = enabled.flatMap(([start, length, limit]) => [dayStart(start, rules.timeZone),
    dayStart(shiftDate(start, length), rules.timeZone), except, limit]);
  return { sql, bindings };
}
export function mountBookingRules(app: Hono<{ Bindings: Environment }>) {
  const path = '/api/admin/booking-rules';
  app.use(path, async (c, next) => {
    if (!await requireAdmin(c)) throw new AuthError(401, 'UNAUTHORIZED');
    if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
    await next();
  });
  app.get(path, async c => c.json({ rules: (await readRules(c.env.DB!)).rules }));
  app.patch(path, async c => {
    if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid();
    const input = parseRules(await c.req.json().catch(() => null));
    await c.env.DB!.prepare('UPDATE booking_rule_settings SET rules_json=json_patch(rules_json,?),revision=? WHERE id=1')
      .bind(JSON.stringify(input),crypto.randomUUID()).run();
    return c.json({ rules: (await readRules(c.env.DB!)).rules });
  });
}
