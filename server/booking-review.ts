import type { Hono } from 'hono';
import { AuthError } from './auth.js';
import { decideBooking, findBooking } from './booking.js';
import type { Environment } from './db.js';
import { deliverBooking, reviewSignature } from './mail.js';
import type { MailContext } from './mail.js';
import { equalText } from './security.js';

function unavailable(): never { throw new AuthError(404, 'NOT_FOUND'); }

async function pendingRequest(c: MailContext) {
  const header = c.req.header('Authorization') ?? '';
  const match = /^Bearer ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:0|[1-9]\d{0,8})\.\d{13})\.([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match) return unavailable();
  const [, value, signature] = match;
  const [id, sequence, deadline] = value.split('.');
  if (Number(deadline) <= Date.now() || !equalText(await reviewSignature(c, value), signature)) return unavailable();
  const row = await findBooking(c, id);
  if (!row || row.status !== 'pending' || row.sequence !== Number(sequence) || row.start_at !== Number(deadline)) return unavailable();
  return row;
}

export function mountBookingReview(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/request-action', async c => {
    const row = await pendingRequest(c);
    return c.json({ name: row.name, startAt: row.start_at, endAt: row.end_at, meetingType: row.meeting_type });
  });
  app.post('/api/request-action', async c => {
    const row = await pendingRequest(c);
    if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AuthError(400, 'INVALID_INPUT');
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new AuthError(400, 'INVALID_INPUT'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AuthError(400, 'INVALID_INPUT');
    const input = body as Record<string, unknown>;
    if (input.action !== 'confirm' && input.action !== 'decline' && input.action !== 'suggest') throw new AuthError(400, 'INVALID_INPUT');
    const updated = await decideBooking(c, row, { ...input, expectedUpdatedAt: row.updated_at });
    return c.json({ status: updated.status, mailStatus: await deliverBooking(c, updated) });
  });
}
