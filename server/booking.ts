import type { Context, Hono } from 'hono';
import { BOOKING_DAY, isRequestSlot, parseEmailAddress, requestWeek } from '../shared/booking.js';
import { AuthError, requireAdmin } from './auth.js';
import type { Environment } from './db.js';
import { activeInvitation } from './invites.js';
import { deliverBooking, REQUEST_MAIL_GATE_SQL, requestMailReady } from './mail.js';
import { fromBase64url, hmac, sha256 } from './security.js';

type Ctx = Context<{ Bindings: Environment }>;
type BookingStatus = 'pending' | 'confirmed' | 'declined' | 'suggested' | 'cancelled';
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
  created_at: number;
  updated_at: number;
  message: string;
  sequence: number;
  mail_status: BookingMailStatus;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

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

function invitePermissions(serialized: string) {
  return JSON.parse(serialized) as { modules: string[]; modes: string[] };
}

async function limitRequest(c: Ctx, inviteId: string, now: number) {
  const secret = c.env.DATA_ENCRYPTION_KEY;
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  const db = database(c);
  const window = Math.floor(now / HOUR);
  const day = Math.floor(now / BOOKING_DAY);
  const windowEnd = (window + 1) * HOUR;
  const dayEnd = (day + 1) * BOOKING_DAY;
  const ip = c.req.header('CF-Connecting-IP') ?? 'local';
  const ipKey = await hmac(fromBase64url(secret), `booking-request:ip:${window}:${ip}`);
  const limits = [
    { bucket: `global:${day}`, expiresAt: dayEnd, max: 24 },
    { bucket: `invite:${window}:${inviteId}`, expiresAt: windowEnd, max: 5 },
    { bucket: `ip:${window}:${ipKey}`, expiresAt: windowEnd, max: 12 },
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
  if (status === 'confirmed') readSlot(startAt, (endAt - startAt) / MINUTE, now);
  const message = readText(input.message ?? '', 1000, true);
  const updatedAt = Math.max(now, expected + 1);
  const changed = await database(c).prepare(`
    UPDATE booking_requests
    SET status=?,start_at=?,end_at=?,message=?,updated_at=?,sequence=sequence+1,mail_status='pending'
    WHERE id=? AND updated_at=? AND status=? AND start_at>?
      AND (?<>'confirmed' OR NOT EXISTS (
        SELECT 1 FROM booking_requests other
        WHERE other.status='confirmed' AND other.id<>? AND other.start_at<? AND other.end_at>?
      ))
    RETURNING *
  `).bind(status, startAt, endAt, message, updatedAt, row.id, expected, row.status, now,
    status, row.id, endAt, startAt).first<BookingRow>();
  if (changed) return changed;

  const latest = await findBooking(c, row.id);
  if (!latest || latest.updated_at !== expected || latest.status !== row.status) throw new AuthError(409, 'BOOKING_CHANGED');
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

export function mountBookings(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/invite/calendar', async c => {
    const now = Date.now();
    const invitation = await activeInvitation(c, now);
    const permissions = invitePermissions(invitation.permissions_json);
    const canRequest = permissions.modes.includes('request');
    if (!canRequest && !permissions.modules.includes('calendar')) throw new AuthError(404, 'NOT_FOUND');
    const requestedWeek = c.req.query('week') ?? '0';
    if (!/^\d{1,2}$/.test(requestedWeek)) throw new AuthError(400, 'INVALID_INPUT');
    const canSubmit = invitation.kind === 'invite' && canRequest && await requestMailReady(c);
    return c.json({ ...requestWeek(now, Number(requestedWeek), canRequest), canSubmit });
  });

  app.post('/api/invite/requests', async c => {
    const invitation = await activeInvitation(c);
    if (invitation.kind !== 'invite' || !invitePermissions(invitation.permissions_json).modes.includes('request')) {
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
    function accepted(row: BookingRow) {
      if (row.submission_fingerprint !== fingerprint) throw new AuthError(409, 'SUBMISSION_CHANGED');
      return c.json({ ok: true, mailStatus: row.mail_status });
    }
    const existing = await findSubmission(c, invitation.id, submissionId);
    if (existing) return accepted(existing);
    readSlot(input.startAt, input.duration, Date.now());
    if (!await requestMailReady(c)) throw new AuthError(403, 'REQUESTS_DISABLED');
    await limitRequest(c, invitation.id, Date.now());
    const now = Date.now();
    const { startAt, endAt } = readSlot(input.startAt, input.duration, now);
    const row = await database(c).prepare(`
      INSERT INTO booking_requests(id,invite_id,submission_id,submission_fingerprint,name,email,start_at,end_at,meeting_type,notes,status,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,'pending',?,?
      FROM invites WHERE id=? AND kind='invite' AND revoked_at IS NULL AND expires_at>? AND permissions_json=?
        AND ${REQUEST_MAIL_GATE_SQL}
      ON CONFLICT(invite_id,submission_id) DO NOTHING
      RETURNING *
    `).bind(crypto.randomUUID(), invitation.id, submissionId, fingerprint, name, email, startAt, endAt,
      meetingType, notes, now, now, invitation.id, now, invitation.permissions_json).first<BookingRow>();
    if (!row) {
      const raced = await findSubmission(c, invitation.id, submissionId);
      if (raced) return accepted(raced);
      const current = await activeInvitation(c);
      if (current.id === invitation.id && current.permissions_json === invitation.permissions_json) {
        throw new AuthError(403, 'REQUESTS_DISABLED');
      }
      throw new AuthError(404, 'NOT_FOUND');
    }
    return c.json({ ok: true, mailStatus: await tryDelivery(c, row) }, 201);
  });

  app.get('/api/admin/requests', async c => {
    await requireBookingAdmin(c);
    const now = Date.now();
    const status = c.req.query('status') ?? 'pending';
    const db = database(c);
    let rows;
    if (status === 'history') {
      rows = await db.prepare(`SELECT * FROM booking_requests
        WHERE status IN ('declined','suggested','cancelled') OR start_at<=?
        ORDER BY updated_at DESC,id LIMIT 100`).bind(now).all<BookingRow>();
    } else {
      if (status !== 'pending' && status !== 'confirmed') throw new AuthError(400, 'INVALID_INPUT');
      rows = await db.prepare('SELECT * FROM booking_requests WHERE status=? AND start_at>? ORDER BY start_at,id LIMIT 100')
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
