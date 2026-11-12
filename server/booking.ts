import type { Context, Hono } from 'hono';
import { BOOKING_DAY, isRequestSlot, parseEmailAddress, REQUEST_DURATIONS, REQUEST_HORIZON, requestWeek } from '../shared/booking.js';
import { AuthError, requireAdmin } from './auth.js';
import { CALENDAR_FRESH_MS, CALENDAR_WINDOW_MS, readAvailability } from './calendar-availability.js';
import type { BusySnapshot } from './calendar-availability.js';
import { withCalendarCities } from './calendar-location.js';
import type { Environment } from './db.js';
import { calendarFile } from './ical.js';
import { activeInvitation, invitationPermissions } from './invites.js';
import { deliverBooking, DIRECT_MAIL_GATE_SQL, directMailReady, REQUEST_MAIL_GATE_SQL, requestMailReady } from './mail.js';
import { openClock, openConflicts, openHasCapacity, openVisibility, weekOpenSessions } from './open-sessions.js';
import type { OpenSessionRow } from './open-sessions.js';
import { fromBase64url, hmac, sha256 } from './security.js';

type Ctx = Context<{ Bindings: Environment }>;
type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'suggested' | 'cancelled';
type BookingSource = 'request' | 'direct';
export type BookingMailStatus = 'pending' | 'sent' | 'failed' | 'unconfigured';
type MeetingType = 'online' | 'in-person';

export interface BookingRow {
  id: string;
  invite_id: string;
  submission_id: string;
  submission_fingerprint: string;
  name: string;
  email: string;
  start_at: number;
  end_at: number;
  meeting_type: MeetingType;
  notes: string;
  status: BookingStatus;
  source: BookingSource;
  open_session_id: string | null;
  open_title?: string | null;
  created_at: number;
  updated_at: number;
  message: string;
  sequence: number;
  mail_status: BookingMailStatus;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const directCalendarGate = `EXISTS (SELECT 1 FROM calendar_settings WHERE id=1 AND direct_enabled=1)
  AND (SELECT COUNT(*) FROM calendar_sources WHERE provider IN ('icloud','outlook')
    AND synced_at>? AND synced_at<=? AND covered_from<=? AND covered_until>=?
    AND last_error IS NULL AND json_type(busy_json)='array')=2`;
const noConfirmedOverlap = `NOT EXISTS (SELECT 1 FROM booking_requests other
  WHERE other.status='confirmed' AND other.start_at<? AND other.end_at>?)`;
const noBusyOverlap = `NOT EXISTS (SELECT 1 FROM calendar_sources source, json_each(source.busy_json) busy
  WHERE source.provider IN ('icloud','outlook')
    AND json_extract(busy.value,'$[0]')<? AND json_extract(busy.value,'$[1]')>?)`;
const noOpenOverlap = 'NOT EXISTS (SELECT 1 FROM open_sessions WHERE archived=0 AND start_at<? AND end_at>?)';
type Reservation = { start_at: number; end_at: number };

function calendarWindow(now: number) {
  return [now - CALENDAR_FRESH_MS, now, now, now + CALENDAR_WINDOW_MS];
}

function database(c: Ctx) {
  if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return c.env.DB;
}

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(400, 'INVALID_INPUT');
  }
  let value: unknown;
  try { value = await c.req.json(); }
  catch { throw new AuthError(400, 'INVALID_INPUT'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, 'INVALID_INPUT');
  return value as Record<string, unknown>;
}

function readText(value: unknown, limit: number, multiline = false): string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || value.length > limit || controls.test(value)) throw new AuthError(400, 'INVALID_INPUT');
  return value.replace(/\r\n?/g, '\n').trim();
}

function readSlot(startAt: unknown, duration: unknown, now: number) {
  if (typeof startAt !== 'number' || typeof duration !== 'number' || !isRequestSlot(startAt, duration, now)) {
    throw new AuthError(409, 'SLOT_UNAVAILABLE');
  }
  return { startAt, endAt: startAt + duration * MINUTE };
}

async function limitRequest(c: Ctx, inviteId: string, now: number, open = false) {
  const secret = c.env.DATA_ENCRYPTION_KEY;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  const db = database(c);
  const window = Math.floor(now / HOUR);
  const day = Math.floor(now / BOOKING_DAY);
  const windowEnd = (window + 1) * HOUR;
  const dayEnd = (day + 1) * BOOKING_DAY;
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const bucket = open ? 'open:' : '';
  const ipKey = await hmac(fromBase64url(secret), `booking-request:${bucket}ip:${window}:${ip}`);
  const limits = [
    { bucket: `${bucket}global:${day}`, expiresAt: dayEnd, max: open ? 300 : 24 },
    { bucket: `${bucket}invite:${window}:${inviteId}`, expiresAt: windowEnd, max: open ? 100 : 5 },
    { bucket: `${bucket}ip:${window}:${ipKey}`, expiresAt: windowEnd, max: 12 },
  ];
  const policy = 'WITH limits(bucket,expires_at,max_hits) AS (VALUES (?,?,?),(?,?,?),(?,?,?))';
  const capped = 'FROM limits p JOIN booking_request_rates r ON r.bucket=p.bucket WHERE r.hits>=p.max_hits';
  const parameters = limits.flatMap(({ bucket, expiresAt, max }) => [bucket, expiresAt, max]);
  const [, result] = await db.batch<{ bucket: string }>([
    db.prepare('DELETE FROM booking_request_rates WHERE expires_at<=?').bind(now),
    db.prepare(`${policy}
      INSERT INTO booking_request_rates(bucket,hits,expires_at)
      SELECT bucket,1,expires_at FROM limits WHERE NOT EXISTS(SELECT 1 ${capped})
      ON CONFLICT(bucket) DO UPDATE SET hits=hits+1 RETURNING bucket
    `).bind(...parameters),
  ]);
  if (result.results.length !== limits.length) {
    const blocked = await db.prepare(`${policy} SELECT MAX(r.expires_at) AS retry_at ${capped}`)
      .bind(...parameters).first<{ retry_at: number | null }>();
    c.header('Retry-After', String(Math.max(1, Math.ceil(((blocked?.retry_at ?? windowEnd) - now) / 1000))));
    throw new AuthError(429, 'RATE_LIMITED');
  }
}

export async function findBooking(c: Ctx, id: string): Promise<BookingRow | null> {
  if (!uuid.test(id) || id.length !== 36) return null;
  return database(c).prepare('SELECT * FROM booking_requests WHERE id=?').bind(id).first<BookingRow>();
}

function findSubmission(c: Ctx, inviteId: string, submissionId: string) {
  return database(c).prepare('SELECT * FROM booking_requests WHERE invite_id=? AND submission_id=?')
    .bind(inviteId, submissionId).first<BookingRow>();
}

export function bookingView(row: BookingRow, mailStatus = row.mail_status, now = Date.now()) {
  const expired = (row.status === 'pending' || row.status === 'suggested') && row.start_at <= now;
  return {
    id: row.id,
    inviteId: row.invite_id,
    name: row.name,
    email: row.email,
    startAt: row.start_at,
    endAt: row.end_at,
    meetingType: row.meeting_type,
    notes: row.notes,
    source: row.open_session_id ? 'open' : row.source,
    ...(row.open_title ? { openTitle: row.open_title } : {}),
    status: expired ? 'expired' as const : row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    message: row.message,
    mailStatus,
  };
}

// Decisions write the state change and check interval overlap in the same SQL statement.
// The caller delivers the resulting message only after the new state is committed.
export async function decideBooking(c: Ctx, row: BookingRow, input: Record<string, unknown>): Promise<BookingRow> {
  const expected = input.expectedUpdatedAt;
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) throw new AuthError(400, 'INVALID_INPUT');
  if (row.updated_at !== expected) throw new AuthError(409, 'BOOKING_CHANGED');
  const now = Date.now();
  const open = row.open_session_id !== null;
  if (open && (input.action === 'suggest' || input.action === 'reschedule')) throw new AuthError(409, 'SLOT_UNAVAILABLE');
  const canDecide = row.status === 'pending' || row.status === 'suggested';
  const canEdit = row.status === 'confirmed';
  let status: BookingStatus;
  let startAt = row.start_at;
  let endAt = row.end_at;
  switch (input.action) {
    case 'confirm':
      if (!canDecide) throw new AuthError(409, 'BOOKING_CHANGED');
      status = 'confirmed';
      break;
    case 'decline':
      if (!canDecide) throw new AuthError(409, 'BOOKING_CHANGED');
      status = 'declined';
      break;
    case 'suggest':
      if (!canDecide) throw new AuthError(409, 'BOOKING_CHANGED');
      status = 'suggested';
      ({ startAt, endAt } = readSlot(input.startAt, input.duration, now));
      break;
    case 'cancel':
      if (!canEdit) throw new AuthError(409, 'BOOKING_CHANGED');
      status = 'cancelled';
      break;
    case 'reschedule':
      if (!canEdit) throw new AuthError(409, 'BOOKING_CHANGED');
      status = 'confirmed';
      ({ startAt, endAt } = readSlot(input.startAt, input.duration, now));
      break;
    default:
      throw new AuthError(400, 'INVALID_INPUT');
  }
  if (row.start_at <= now) throw new AuthError(409, 'SLOT_UNAVAILABLE');
  if (status === 'confirmed' && !open) readSlot(startAt, (endAt - startAt) / MINUTE, now);
  const message = readText(input.message ?? '', 1000, true);
  const updatedAt = Math.max(now, expected + 1);
  const canConfirm = open
    ? `EXISTS (SELECT 1 FROM open_sessions s WHERE s.id=? AND s.archived=0 AND s.start_at>?
      AND ${openHasCapacity} AND NOT ${openConflicts})`
    : `${noOpenOverlap} AND NOT EXISTS (SELECT 1 FROM booking_requests other
      WHERE other.status='confirmed' AND other.id<>? AND other.start_at<? AND other.end_at>?)`;
  const confirmBindings = open ? [row.open_session_id, now, ...openClock(now)] : [endAt, startAt, row.id, endAt, startAt];
  const changed = await database(c).prepare(`
    UPDATE booking_requests
    SET status=?,start_at=?,end_at=?,message=?,updated_at=?,sequence=sequence+1,mail_status='pending'
    WHERE id=? AND updated_at=? AND status=? AND start_at>?
      AND (?<>'confirmed' OR (${canConfirm}))
    RETURNING *
  `).bind(status, startAt, endAt, message, updatedAt, row.id, expected, row.status, now,
    status, ...confirmBindings).first<BookingRow>();
  if (changed) return changed;

  const latest = await findBooking(c, row.id);
  if (!latest || latest.updated_at !== expected || latest.status !== row.status) throw new AuthError(409, 'BOOKING_CHANGED');
  if (open && status === 'confirmed') {
    const session = await database(c).prepare(`SELECT s.archived,s.start_at,NOT ${openHasCapacity} AS full
      FROM open_sessions s WHERE s.id=?`).bind(row.open_session_id).first<{ archived: number; start_at: number; full: number }>();
    if (!session || session.archived || session.start_at <= Date.now()) throw new AuthError(409, 'SLOT_UNAVAILABLE');
    if (session.full) throw new AuthError(409, 'OPEN_FULL');
  }
  throw new AuthError(409, 'SLOT_CONFLICT');
}

async function requireBookingAdmin(c: Ctx) {
  if (!await requireAdmin(c)) throw new AuthError(401, 'UNAUTHORIZED');
}

async function bookingOr404(c: Ctx) {
  const row = await findBooking(c, c.req.param('id') ?? '');
  if (!row) throw new AuthError(404, 'NOT_FOUND');
  return row;
}

// A provider outage must never make a committed request look unsubmitted.
async function tryDelivery(c: Ctx, row: BookingRow): Promise<BookingMailStatus> {
  try { return await deliverBooking(c, row); }
  catch { return row.mail_status; }
}

async function canBookDirect(c: Ctx, now: number) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.env.DATA_ENCRYPTION_KEY ?? '')) return false;
  return Boolean(await database(c).prepare(`SELECT 1 WHERE ${DIRECT_MAIL_GATE_SQL} AND ${directCalendarGate}`)
    .bind(...calendarWindow(now)).first());
}

async function showAvailability(c: Ctx, days: ReturnType<typeof requestWeek>['days'], now: number,
  snapshot: BusySnapshot, hideBusy: boolean, showDurations: boolean, reserved: Reservation[]) {
  const start = days[0].slots[0].startAt;
  const end = days.at(-1)!.slots.at(-1)!.startAt + 30 * MINUTE;
  const booked = await database(c).prepare(`SELECT start_at,end_at FROM booking_requests
    WHERE status='confirmed' AND start_at<? AND end_at>?`).bind(end, start).all<{ start_at: number; end_at: number }>();
  const intervals = snapshot.busy.filter(([from, through]) => from < end && through > start);
  for (const row of [...booked.results, ...reserved]) intervals.push([row.start_at, row.end_at]);
  intervals.sort(([a], [b]) => a - b);
  let interval = 0;
  return days.map(day => ({ ...day, slots: day.slots.map(slot => {
    const startAt = slot.startAt;
    if (startAt <= now || startAt > now + REQUEST_HORIZON) return slot;
    while (interval < intervals.length && intervals[interval][1] <= startAt) interval++;
    const nextBusy = intervals[interval]?.[0] ?? Infinity;
    const free = REQUEST_DURATIONS.filter(duration => isRequestSlot(startAt, duration, now)
      && startAt + duration * MINUTE <= nextBusy);
    const availability = free.length ? 'available' : !hideBusy && nextBusy < startAt + 30 * MINUTE ? 'busy' : 'blocked';
    return { ...slot, availability, ...(showDurations && free.length ? { bookableDurations: free } : {}) };
  }) }));
}

async function submitBooking(c: Ctx, source: BookingSource) {
  const direct = source === 'direct';
  const invitation = await activeInvitation(c);
  const permissions = invitationPermissions(invitation);
  if (invitation.kind !== 'invite' || !permissions.modes.includes(source) || (direct && !permissions.modules.includes('calendar'))) {
    throw new AuthError(403, 'REQUESTS_DISABLED');
  }
  const input = await jsonBody(c);
  if (readText(input.website ?? '', 200)) throw new AuthError(400, 'INVALID_INPUT');
  const name = readText(input.name, 80);
  const email = parseEmailAddress(input.email);
  const meetingType = input.meetingType;
  const notes = readText(input.notes ?? '', 1000, true);
  if (!name || !email || (meetingType !== 'online' && meetingType !== 'in-person')) throw new AuthError(400, 'INVALID_INPUT');
  const submissionId = readText(input.submissionId, 36).toLowerCase();
  if (!uuid.test(submissionId)) throw new AuthError(400, 'INVALID_INPUT');
  const fingerprint = await sha256(JSON.stringify([name, email, input.startAt, input.duration, meetingType, notes]));
  function receipt(row: BookingRow, mailStatus: BookingMailStatus) {
    return { ok: true, mailStatus, ...(direct ? { startAt: row.start_at, endAt: row.end_at } : {}) };
  }
  function accepted(row: BookingRow) {
    if (row.open_session_id || row.source !== source || row.submission_fingerprint !== fingerprint) throw new AuthError(409, 'SUBMISSION_CHANGED');
    if (direct && row.status !== 'confirmed') throw new AuthError(409, 'SLOT_UNAVAILABLE');
    return c.json(receipt(row, row.mail_status));
  }
  const existing = await findSubmission(c, invitation.id, submissionId);
  if (existing) return accepted(existing);
  const ready = (now: number) => direct ? canBookDirect(c, now) : requestMailReady(c);
  const checkedAt = Date.now();
  readSlot(input.startAt, input.duration, checkedAt);
  if (!await ready(checkedAt)) throw new AuthError(403, 'REQUESTS_DISABLED');
  await limitRequest(c, invitation.id, Date.now());
  const now = Date.now();
  const { startAt, endAt } = readSlot(input.startAt, input.duration, now);
  // D1 serializes writes. The conflict and freshness checks must be part of the INSERT.
  const gate = direct ? `direct_enabled=1 AND ${DIRECT_MAIL_GATE_SQL} AND ${directCalendarGate}
      AND ${noConfirmedOverlap} AND ${noBusyOverlap}` : REQUEST_MAIL_GATE_SQL;
  const directBindings = direct ? [...calendarWindow(now), endAt, startAt, endAt, startAt] : [];
  const row = await database(c).prepare(`
    INSERT INTO booking_requests(id,invite_id,submission_id,submission_fingerprint,name,email,start_at,end_at,meeting_type,notes,status,created_at,updated_at,source)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?
    FROM invites WHERE id=? AND kind='invite' AND revoked_at IS NULL AND expires_at>? AND permissions_json=?
      AND ${noOpenOverlap} AND ${gate}
    ON CONFLICT(invite_id,submission_id) DO NOTHING
    RETURNING *
  `).bind(crypto.randomUUID(), invitation.id, submissionId, fingerprint, name, email, startAt, endAt,
    meetingType, notes, direct ? 'confirmed' : 'pending', now, now, source,
    invitation.id, now, invitation.permissions_json, endAt, startAt, ...directBindings).first<BookingRow>();
  if (!row) {
    const raced = await findSubmission(c, invitation.id, submissionId);
    if (raced) return accepted(raced);
    const current = await activeInvitation(c);
    if (current.id !== invitation.id || current.permissions_json !== invitation.permissions_json
      || (direct && current.direct_enabled !== 1)) throw new AuthError(404, 'NOT_FOUND');
    if (await ready(Date.now())) throw new AuthError(409, 'SLOT_CONFLICT');
    throw new AuthError(403, 'REQUESTS_DISABLED');
  }
  return c.json(receipt(row, await tryDelivery(c, row)), 201);
}

async function submitOpenSession(c: Ctx) {
  const invitation = await activeInvitation(c);
  if (invitation.kind !== 'invite' || !invitationPermissions(invitation).modes.includes('open')) {
    throw new AuthError(403, 'REQUESTS_DISABLED');
  }
  const id = c.req.param('id') ?? '';
  if (!uuid.test(id)) throw new AuthError(404, 'NOT_FOUND');
  const input = await jsonBody(c);
  const name = readText(input.name, 80);
  const rawEmail = readText(input.email ?? '', 254);
  const email = rawEmail ? parseEmailAddress(rawEmail) : '';
  const submissionId = readText(input.submissionId, 36).toLowerCase();
  if (!name || email === null || !uuid.test(submissionId) || readText(input.website ?? '', 200)) {
    throw new AuthError(400, 'INVALID_INPUT');
  }
  const db = database(c);
  const session = await db.prepare(`SELECT s.* FROM open_sessions s WHERE id=? AND ${openVisibility}`)
    .bind(id, invitation.id).first<OpenSessionRow>();
  if (!session) throw new AuthError(404, 'NOT_FOUND');
  if (session.email_required && !email) throw new AuthError(400, 'INVALID_INPUT');
  const fingerprint = await sha256(JSON.stringify([id, name, email]));
  function receipt(row: BookingRow, mailStatus = row.mail_status) {
    if (row.open_session_id !== id || row.submission_fingerprint !== fingerprint) throw new AuthError(409, 'SUBMISSION_CHANGED');
    if (row.status !== 'confirmed' && row.status !== 'pending') throw new AuthError(409, 'SLOT_UNAVAILABLE');
    const calendar = row.status === 'confirmed' ? calendarFile({
      uid: `${row.id}@${new URL(c.env.SITE_ORIGIN!).hostname}`, summary: session!.title, location: session!.location,
      startAt: row.start_at, endAt: row.end_at, stamp: row.updated_at, sequence: row.sequence, status: 'CONFIRMED',
    }) : undefined;
    return { ok: true, status: row.status, mailStatus, calendar };
  }
  const existing = await findSubmission(c, invitation.id, submissionId);
  if (existing) return c.json(receipt(existing));
  if (session.archived || session.start_at <= Date.now()) throw new AuthError(409, 'SLOT_UNAVAILABLE');
  await limitRequest(c, invitation.id, Date.now(), true);
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO booking_requests
      (id,invite_id,submission_id,submission_fingerprint,name,email,start_at,end_at,meeting_type,status,created_at,updated_at,open_session_id)
    SELECT ?,?,?,?,?,?,s.start_at,s.end_at,CASE WHEN s.type_id='video' THEN 'online' ELSE 'in-person' END,
      CASE WHEN s.approval_required=1 THEN 'pending' ELSE 'confirmed' END,?,?,s.id
    FROM open_sessions s JOIN invites i ON i.id=? WHERE s.id=? AND s.archived=0 AND s.start_at>?
      AND i.kind='invite' AND i.revoked_at IS NULL AND i.expires_at>? AND i.permissions_json=?
      AND ${openVisibility} AND ${openHasCapacity} AND NOT ${openConflicts}
    ON CONFLICT(invite_id,submission_id) DO NOTHING RETURNING *`)
    .bind(crypto.randomUUID(), invitation.id, submissionId, fingerprint, name, email, now, now,
      invitation.id, id, now, now, invitation.permissions_json, invitation.id, ...openClock(now)).first<BookingRow>();
  if (row) return c.json(receipt(row, await tryDelivery(c, row)), 201);
  const raced = await findSubmission(c, invitation.id, submissionId);
  if (raced) return c.json(receipt(raced));
  const current = await activeInvitation(c);
  if (!invitationPermissions(current).modes.includes('open')) throw new AuthError(403, 'REQUESTS_DISABLED');
  const closed = await db.prepare(`SELECT s.archived,s.start_at,NOT ${openHasCapacity} AS full,${openConflicts} AS conflict
    FROM open_sessions s WHERE s.id=? AND ${openVisibility}`)
    .bind(...openClock(now), id, current.id).first<{ archived: number; start_at: number; full: number; conflict: number }>();
  if (!closed) throw new AuthError(404, 'NOT_FOUND');
  throw new AuthError(409, closed.full && !closed.archived && !closed.conflict && closed.start_at > now ? 'OPEN_FULL' : 'SLOT_UNAVAILABLE');
}

function withoutOpenReservations(days: ReturnType<typeof requestWeek>['days'], reserved: Reservation[], now: number) {
  if (!reserved.length) return days;
  return days.map(day => ({ ...day, slots: day.slots.map(slot => {
    if (slot.state !== 'request') return slot;
    const lengths = REQUEST_DURATIONS.filter(length => isRequestSlot(slot.startAt, length, now));
    const free = lengths.filter(length => !reserved.some(row => row.start_at < slot.startAt + length * MINUTE && row.end_at > slot.startAt));
    if (free.length === lengths.length) return slot;
    return { ...slot, state: free.length ? 'request' as const : 'unavailable' as const, requestDurations: free };
  }) }));
}

export function mountBookings(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/invite/calendar', async c => {
    const now = Date.now();
    const invitation = await activeInvitation(c, now);
    const permissions = invitationPermissions(invitation);
    const canRequest = permissions.modes.includes('request');
    const canOpen = permissions.modes.includes('open');
    const canSeeCalendar = permissions.modules.includes('calendar');
    const allowDirect = canSeeCalendar && permissions.modes.includes('direct');
    if (!canRequest && !canSeeCalendar && !canOpen) throw new AuthError(404, 'NOT_FOUND');
    const requestedWeek = c.req.query('week') ?? '0';
    if (!/^\d{1,2}$/.test(requestedWeek)) throw new AuthError(400, 'INVALID_INPUT');
    const week = requestWeek(now, Number(requestedWeek), canRequest);
    const db = database(c);
    const first = week.days[0].slots[0].startAt;
    const last = first + 7 * BOOKING_DAY;
    const [canSubmit, cities, calendar, directReady, openSessions, reserved] = await Promise.all([
      invitation.kind === 'invite' && canRequest && requestMailReady(c),
      canSeeCalendar && permissions.modules.includes('travel') ? withCalendarCities(c, week.days, now) : week.days,
      canSeeCalendar ? readAvailability(db, now) : undefined,
      allowDirect && invitation.kind === 'invite' && directMailReady(c),
      canOpen ? weekOpenSessions(db, first, last, now, invitation.preview_invite_id ?? invitation.id) : undefined,
      canRequest || canSeeCalendar ? db.prepare(`SELECT start_at,end_at FROM open_sessions
        WHERE archived=0 AND start_at<? AND end_at>? ORDER BY start_at`).bind(last, first).all<Reservation>() : undefined,
    ]);
    const days = withoutOpenReservations(cities, reserved?.results ?? [], now);
    const output = { ...week, days, canSubmit, ...(openSessions ? { openSessions } : {}) };
    if (!calendar) return c.json(output);
    if (!calendar.snapshot) return c.json({ ...output, availability: 'unavailable', canBook: false });
    const canBook = calendar.directEnabled && directReady;
    const markedDays = await showAvailability(c, days, now, calendar.snapshot, permissions.hideBusy === true,
      canBook || (allowDirect && invitation.kind === 'preview'), reserved?.results ?? []);
    return c.json({ ...output, days: markedDays, availability: 'ready', canBook,
      validUntil: calendar.snapshot.validUntil });
  });

  app.post('/api/invite/requests', c => submitBooking(c, 'request'));
  app.post('/api/invite/direct', c => submitBooking(c, 'direct'));
  app.post('/api/invite/open/:id', submitOpenSession);

  app.get('/api/admin/requests', async c => {
    await requireBookingAdmin(c);
    const now = Date.now();
    const status = c.req.query('status') ?? 'pending';
    const db = database(c);
    const bookings = `SELECT booking_requests.*, (SELECT title FROM open_sessions WHERE id=open_session_id) AS open_title
      FROM booking_requests`;
    let rows;
    if (status === 'history') {
      rows = await db.prepare(`${bookings}
        WHERE status IN ('declined','suggested','cancelled') OR start_at<=?
        ORDER BY updated_at DESC,id LIMIT 100`).bind(now).all<BookingRow>();
    } else {
      if (status !== 'pending' && status !== 'confirmed') throw new AuthError(400, 'INVALID_INPUT');
      rows = await db.prepare(`${bookings} WHERE status=? AND start_at>? ORDER BY start_at,id LIMIT 100`)
        .bind(status, now).all<BookingRow>();
    }
    return c.json({ requests: rows.results.map(row => bookingView(row, row.mail_status, now)) });
  });

  app.post('/api/admin/requests/:id/decision', async c => {
    await requireBookingAdmin(c);
    const changed = await decideBooking(c, await bookingOr404(c), await jsonBody(c));
    return c.json({ request: bookingView(changed, await tryDelivery(c, changed)) });
  });

  app.post('/api/admin/requests/:id/notify', async c => {
    await requireBookingAdmin(c);
    const row = await bookingOr404(c);
    if (row.status === 'pending' && row.start_at <= Date.now()) throw new AuthError(409, 'SLOT_UNAVAILABLE');
    return c.json({ request: bookingView(row, await tryDelivery(c, row)) });
  });
}
