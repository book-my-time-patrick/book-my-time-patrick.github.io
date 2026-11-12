import type { Context } from 'hono';
import { parseEmailAddress } from '../shared/booking.js';
import { AuthError } from './auth.js';
import type { BookingMailStatus as MailStatus, BookingRow } from './booking.js';
import type { Environment } from './db.js';
import { calendarAttachment, calendarFile } from './ical.js';
import type { CalendarStatus } from './ical.js';
import { decryptSecret, fromBase64url, hmac } from './security.js';

export type MailContext = Context<{ Bindings: Environment }>;
export interface MailConfig {
  sender: string;
  api_key_cipher: string | null;
  accept_requests: number;
  primary_delivery_id: string | null;
  notification_id: string | null;
  revision: number;
}
interface MailRoute extends MailConfig {
  primary_address: string | null;
  override_address: string | null;
  notification_address: string | null;
}
interface Message {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
  attachments?: ReturnType<typeof calendarAttachment>[];
}
const hour = 3_600_000;
const day = 24 * hour;
const mailGate = `SELECT 1 FROM mail_settings m
  JOIN mailboxes b ON b.id=m.primary_delivery_id WHERE m.id=1
  AND m.sender<>'' AND m.api_key_cipher IS NOT NULL AND b.verified_at IS NOT NULL`;
export const DIRECT_MAIL_GATE_SQL = `EXISTS (${mailGate})`;
export const REQUEST_MAIL_GATE_SQL = `EXISTS (${mailGate} AND m.accept_requests=1)`;
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function mailDb(c: MailContext) {
  if (!c.env.DB) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return c.env.DB;
}
export function mailKey(c: MailContext) {
  const key = c.env.DATA_ENCRYPTION_KEY;
  if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new AuthError(503, 'MAIL_NOT_CONFIGURED');
  return key;
}
export function emailAddress(value: unknown): string {
  const address = parseEmailAddress(value);
  if (!address) throw new AuthError(400, 'INVALID_INPUT');
  return address;
}
export function dateLabel(start: number, end: number) {
  return `${formatter.format(start)}–${formatter.format(end)}（UTC+8）`;
}
export async function readMailConfig(c: MailContext) {
  const config = await mailDb(c).prepare('SELECT * FROM mail_settings WHERE id=1').first<MailConfig>();
  if (!config) throw new AuthError(503, 'MAIL_NOT_CONFIGURED');
  return config;
}
async function readRoute(c: MailContext, inviteId: string) {
  return mailDb(c).prepare(`SELECT s.*,
    (SELECT address FROM mailboxes WHERE id=s.primary_delivery_id AND verified_at IS NOT NULL) AS primary_address,
    (SELECT address FROM mailboxes WHERE id=s.notification_id AND verified_at IS NOT NULL) AS notification_address,
    (SELECT b.address FROM invite_mailboxes i JOIN mailboxes b ON b.id=i.mailbox_id
      WHERE i.invite_id=? AND b.verified_at IS NOT NULL) AS override_address
    FROM mail_settings s WHERE s.id=1`).bind(inviteId).first<MailRoute>();
}
async function bookingMailReady(c: MailContext, gate: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.env.DATA_ENCRYPTION_KEY ?? '')) return false;
  return Boolean(await mailDb(c).prepare(`SELECT 1 WHERE ${gate}`).first());
}
export const requestMailReady = (c: MailContext) => bookingMailReady(c, REQUEST_MAIL_GATE_SQL);
export const directMailReady = (c: MailContext) => bookingMailReady(c, DIRECT_MAIL_GATE_SQL);

export async function sendMail(c: MailContext, config: MailConfig, message: Message, key: string): Promise<boolean> {
  if (!config.sender || !config.api_key_cipher) return false;
  try {
    const apiKey = await decryptSecret(config.api_key_cipher, mailKey(c), 'mail-api-key');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ from: `受邀预约 <${config.sender}>`, ...message }),
    });
    if (!response.ok) { await response.body?.cancel(); return false; }
    const result: unknown = await response.json();
    return Boolean(result && typeof result === 'object' && 'id' in result && typeof result.id === 'string' && result.id.length);
  } catch { return false; }
}

export async function reviewSignature(c: MailContext, value: string) {
  return hmac(fromBase64url(mailKey(c)), `booking-review:v1:${value}`);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

async function messages(c: MailContext, row: BookingRow, route: MailRoute) {
  const delivery = route.override_address ?? route.primary_address;
  if (!delivery) return [];
  const notify = route.notification_address ?? delivery;
  const site = new URL(c.env.SITE_ORIGIN!);
  const time = dateLabel(row.start_at, row.end_at);
  const activity = row.open_session_id
    ? await mailDb(c).prepare('SELECT title,location FROM open_sessions WHERE id=?')
      .bind(row.open_session_id).first<{ title: string; location: string }>()
    : null;
  const meeting = activity ? [activity.title, activity.location].filter(Boolean).join(' · ')
    : row.meeting_type === 'online' ? '线上 / Online' : '线下 / In person';
  const contact = row.email ? { reply_to: row.email } : {};
  const guestName = row.email ? `${row.name} <${row.email}>` : row.name;
  const mail = (to: string, status: CalendarStatus, summary: string) => {
    const request = row.source === 'direct' || Boolean(activity && status !== 'TENTATIVE');
    const content = calendarFile({
      uid: `${row.id}@${site.hostname}`, organizer: route.sender, recipient: to, summary: activity?.title ?? summary,
      location: activity?.location,
      startAt: row.start_at, endAt: row.end_at, stamp: row.updated_at, sequence: row.sequence, status,
      request,
    });
    return calendarAttachment(content, request ? (status === 'CANCELLED' ? 'CANCEL' : 'REQUEST') : undefined);
  };
  type Job = { channel: string; message: Message };
  if (row.status === 'pending') {
    const value = `${row.id}.${row.sequence}.${row.start_at}`;
    const token = `${value}.${await reviewSignature(c, value)}`;
    const actions = [
      { name: '确认 / Confirm', action: 'confirm' }, { name: '拒绝 / Decline', action: 'decline' },
      ...(activity ? [] : [{ name: '建议其他时间 / Suggest another time', action: 'suggest' }]),
    ].map(item => ({ ...item, url: `${site.origin}/#/review/${token}/${item.action}` }));
    const intro = `收到一项预约申请，等待你确认。\nA new request is awaiting your decision.\n${guestName}\n${time}\n${meeting}${row.notes ? `\n${row.notes}` : ''}`;
    const base = {
      subject: '新的预约申请 / New appointment request', ...contact,
      text: `${intro}\n\n${actions.map(item => `${item.name}\n${item.url}`).join('\n\n')}`,
      html: `<div><p>${escapeHtml(intro).replace(/\n/g, '<br>')}</p>${actions.map(item => `<p><a href="${escapeHtml(item.url)}" style="display:inline-block;padding:9px 14px;border:1px solid #003cc1;border-radius:5px;color:#003cc1">${escapeHtml(item.name)}</a></p>`).join('')}</div>`,
    };
    const jobs: Job[] = [{ channel: 'owner', message: { ...base, to: [delivery], attachments: [mail(delivery, 'TENTATIVE', '预约申请 / Appointment request')] } }];
    if (notify.toLowerCase() !== delivery.toLowerCase()) jobs.push({ channel: 'notification', message: { ...base, to: [notify] } });
    return jobs;
  }
  const note = row.message ? `\n${row.message}` : '';
  const guest = (subject: string, body: string): Message => ({ to: [row.email], subject, text: `${body}\n${time}\n${meeting}${note}`, reply_to: notify });
  if (row.status === 'declined') return row.email ? [{ channel: 'guest', message: guest('预约申请未获确认 / Request declined', '这次预约申请未获确认。\nYour appointment request was declined.') }] : [];
  if (row.status === 'suggested') return [{ channel: 'guest', message: guest('建议另一个预约时间 / New time proposed', '以下是建议的时间。请回复本邮件确认是否方便。\nPlease reply to let us know if this time works for you.') }];
  const cancelled = row.status === 'cancelled';
  const status = cancelled ? 'CANCELLED' : 'CONFIRMED';
  const subject = cancelled ? '预约已取消 / Appointment cancelled' : '预约已确认 / Appointment confirmed';
  const jobs: Job[] = [{ channel: 'owner', message: {
    to: [delivery], subject, ...contact, text: `${subject}\n${guestName}\n${time}\n${meeting}${note}`,
    attachments: [mail(delivery, status, '预约 / Appointment')],
  } }];
  if (row.email && row.email.toLowerCase() !== delivery.toLowerCase()) jobs.push({ channel: 'guest', message: {
    ...guest(subject, subject), attachments: [mail(row.email, status, '预约 / Appointment')],
  } });
  return jobs;
}

async function sendBookingOnce(c: MailContext, row: BookingRow, config: MailConfig, channel: string, message: Message): Promise<MailStatus> {
  const db = mailDb(c), now = Date.now(), lease = now + 30_000;
  // Resend retains the idempotency key for 24h. Do not silently retry an ambiguous old send.
  const claim = await db.prepare(`INSERT INTO booking_mail_attempts(booking_id,sequence,channel,first_attempt_at,lease_until)
    SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM booking_requests WHERE id=? AND sequence=?)
    ON CONFLICT(booking_id,sequence,channel) DO UPDATE SET lease_until=excluded.lease_until
    WHERE sent_at IS NULL AND lease_until<=? AND first_attempt_at>? RETURNING channel`)
    .bind(row.id,row.sequence,channel,now,lease,row.id,row.sequence,now,now-day+hour).first();
  if (!claim) {
    const attempt = await db.prepare('SELECT sent_at,lease_until FROM booking_mail_attempts WHERE booking_id=? AND sequence=? AND channel=?')
      .bind(row.id,row.sequence,channel).first<{ sent_at: number | null; lease_until: number }>();
    if (attempt?.sent_at) return 'sent';
    return attempt && attempt.lease_until > now ? 'pending' : 'failed';
  }
  const sent = await sendMail(c, config, message, `booking/${row.id}/${row.sequence}/${channel}`);
  await db.prepare('UPDATE booking_mail_attempts SET sent_at=?,lease_until=0 WHERE booking_id=? AND sequence=? AND channel=? AND lease_until=?')
    .bind(sent ? Date.now() : null,row.id,row.sequence,channel,lease).run();
  return sent ? 'sent' : 'failed';
}

export async function deliverBooking(c: MailContext, row: BookingRow): Promise<MailStatus> {
  if (row.mail_status === 'sent') return 'sent';
  let status: MailStatus;
  try {
    const route = await readRoute(c, row.invite_id);
    if (!route?.sender || !route.api_key_cipher || !route.primary_address) status = 'unconfigured';
    else {
      const jobs = await messages(c, row, route);
      const outcomes = await Promise.all(jobs.map(job => sendBookingOnce(c, row, route, job.channel, job.message)));
      status = outcomes.every(item => item === 'sent') ? 'sent' : outcomes.includes('failed') ? 'failed' : 'pending';
    }
  } catch { status = 'failed'; }
  try {
    await mailDb(c).prepare("UPDATE booking_requests SET mail_status=? WHERE id=? AND sequence=? AND mail_status<>'sent'")
      .bind(status,row.id,row.sequence).run();
  } catch { /* The recorded application can be retried from the inbox. */ }
  return status;
}
