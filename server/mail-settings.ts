import type { Hono } from 'hono';
import { AuthError, requireAdmin } from './auth.js';
import type { Environment } from './db.js';
import { calendarAttachment, calendarFile } from './ical.js';
import { emailAddress, mailDb, mailKey, readMailConfig, sendMail } from './mail.js';
import type { MailContext } from './mail.js';
import { encryptSecret, equalText, fromBase64url, hmac } from './security.js';

interface Mailbox {
  id: string;
  address: string;
  verified_at: number | null;
  code_hash: string | null;
  code_expires_at: number | null;
  code_attempts: number;
  last_code_at: number | null;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const minute = 60_000;
function fail(status: number, code: string): never { throw new AuthError(status, code); }
async function admin(c: MailContext, recent = false) {
  if (!await requireAdmin(c, recent)) fail(401, 'UNAUTHENTICATED');
}
async function body(c: MailContext): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') fail(400, 'INVALID_INPUT');
  let value: unknown;
  try { value = await c.req.json(); } catch { fail(400, 'INVALID_INPUT'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT');
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36 || !uuid.test(value)) fail(400, 'INVALID_INPUT');
  return value;
}
function mailboxView(row: Pick<Mailbox, 'id' | 'address' | 'verified_at'>) {
  return { id: row.id, address: row.address, verifiedAt: row.verified_at };
}
async function mailbox(c: MailContext, mailboxId: string) {
  const row = await mailDb(c).prepare('SELECT * FROM mailboxes WHERE id=?').bind(mailboxId).first<Mailbox>();
  return row ?? fail(404, 'NOT_FOUND');
}
async function verified(c: MailContext, mailboxId: string | null) {
  if (mailboxId && (await mailbox(c, mailboxId)).verified_at === null) fail(409, 'MAILBOX_UNVERIFIED');
}
async function codeHash(c: MailContext, mailboxId: string, now: number, code: string) {
  return hmac(fromBase64url(mailKey(c)), `mailbox-code:v1:${mailboxId}:${now}:${code}`);
}
async function sendingConfig(c: MailContext) {
  const config = await readMailConfig(c);
  if (!config.sender || !config.api_key_cipher) fail(409, 'MAIL_NOT_CONFIGURED');
  return config;
}

export function mountMailSettings(app: Hono<{ Bindings: Environment }>) {
  app.get('/api/admin/mail', async c => {
    await admin(c);
    const db = mailDb(c);
    const [config, boxes, overrides] = await Promise.all([
      readMailConfig(c),
      db.prepare('SELECT id,address,verified_at FROM mailboxes ORDER BY address').all<Mailbox>(),
      db.prepare('SELECT invite_id AS inviteId,mailbox_id AS mailboxId FROM invite_mailboxes').all<{ inviteId: string; mailboxId: string }>(),
    ]);
    return c.json({ sender: config.sender, apiKeyConfigured: Boolean(config.api_key_cipher),
      acceptRequests: Boolean(config.accept_requests), primaryDeliveryId: config.primary_delivery_id,
      notificationId: config.notification_id, mailboxes: boxes.results.map(mailboxView), overrides: overrides.results });
  });

  app.patch('/api/admin/mail', async c => {
    await admin(c, true);
    const input = await body(c), config = await readMailConfig(c);
    const sender = input.sender === undefined ? config.sender : input.sender === '' ? '' : emailAddress(input.sender);
    const key = input.apiKey;
    if (key !== undefined && key !== null && (typeof key !== 'string' || !/^re_[A-Za-z0-9_-]{8,190}$/.test(key))) fail(400, 'INVALID_INPUT');
    const cipher = typeof key === 'string' ? await encryptSecret(key, mailKey(c), 'mail-api-key') : key === null ? null : config.api_key_cipher;
    if (input.acceptRequests !== undefined && typeof input.acceptRequests !== 'boolean') fail(400, 'INVALID_INPUT');
    const accept = input.acceptRequests === undefined ? Boolean(config.accept_requests) : input.acceptRequests;
    const primary = input.primaryDeliveryId === undefined ? config.primary_delivery_id : input.primaryDeliveryId === null ? null : id(input.primaryDeliveryId);
    const notification = input.notificationId === undefined ? config.notification_id : input.notificationId === null ? null : id(input.notificationId);
    if (accept && (!sender || !cipher || !primary)) fail(409, 'MAIL_NOT_CONFIGURED');
    await Promise.all([verified(c, primary), verified(c, notification)]);
    const updated = await mailDb(c).prepare(`UPDATE mail_settings SET sender=?,api_key_cipher=?,accept_requests=?,
      primary_delivery_id=?,notification_id=?,revision=revision+1 WHERE id=1 AND revision=?
      AND (? IS NULL OR EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND verified_at IS NOT NULL))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM mailboxes WHERE id=? AND verified_at IS NOT NULL)) RETURNING id`)
      .bind(sender,cipher,accept ? 1 : 0,primary,notification,config.revision,primary,primary,notification,notification).first();
    if (!updated) fail(409, 'MAIL_SETTINGS_CHANGED');
    return c.json({ ok: true });
  });

  app.post('/api/admin/mailboxes', async c => {
    await admin(c, true);
    const address = emailAddress((await body(c)).address), db = mailDb(c);
    const row = await db.prepare(`INSERT INTO mailboxes(id,address) SELECT ?,?
      WHERE (SELECT COUNT(*) FROM mailboxes)<20 ON CONFLICT(address) DO NOTHING RETURNING id,address,verified_at`)
      .bind(crypto.randomUUID(),address).first<Mailbox>();
    if (!row) {
      if (await db.prepare('SELECT id FROM mailboxes WHERE address=?').bind(address).first()) fail(409, 'MAILBOX_EXISTS');
      fail(409, 'MAILBOX_LIMIT');
    }
    return c.json({ mailbox: mailboxView(row) }, 201);
  });

  app.post('/api/admin/mailboxes/:id/code', async c => {
    await admin(c, true);
    const config = await sendingConfig(c), mailboxId = id(c.req.param('id'));
    const row = await mailbox(c, mailboxId), now = Date.now();
    if (row.verified_at !== null) fail(409, 'MAILBOX_ALREADY_VERIFIED');
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
    const changed = await mailDb(c).prepare(`UPDATE mailboxes SET code_hash=?,code_expires_at=?,code_attempts=0,last_code_at=?
      WHERE id=? AND verified_at IS NULL AND (last_code_at IS NULL OR last_code_at<=?) RETURNING id`)
      .bind(await codeHash(c,mailboxId,now,code),now+10*minute,now,mailboxId,now-minute).first();
    if (!changed) fail(429, 'RATE_LIMITED');
    const sent = await sendMail(c, config, {
      to: [row.address], subject: '邮箱验证 / Verify your email address',
      text: `受邀预约邮箱验证码 / Verification code\n\n${code}\n\n十分钟内有效。Valid for ten minutes.`,
    }, `mailbox-code/${mailboxId}/${now}`);
    if (!sent) fail(503, 'MAIL_SEND_FAILED');
    return c.json({ ok: true });
  });

  app.post('/api/admin/mailboxes/:id/verify', async c => {
    await admin(c, true);
    const mailboxId = id(c.req.param('id')), input = await body(c);
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code) || input.code.length !== 6) fail(400, 'INVALID_INPUT');
    const row = await mailbox(c, mailboxId), now = Date.now();
    if (!row.code_hash || row.last_code_at === null || (row.code_expires_at ?? 0) <= now || row.code_attempts >= 5) fail(400, 'CODE_INVALID');
    const matches = equalText(await codeHash(c,mailboxId,row.last_code_at,input.code), row.code_hash);
    const updated = await mailDb(c).prepare(`UPDATE mailboxes SET code_attempts=code_attempts+1,
      verified_at=CASE WHEN ? THEN ? ELSE verified_at END,
      code_hash=CASE WHEN ? THEN NULL ELSE code_hash END,
      code_expires_at=CASE WHEN ? THEN NULL ELSE code_expires_at END
      WHERE id=? AND verified_at IS NULL AND code_hash=? AND code_expires_at>? AND code_attempts<5 RETURNING verified_at`)
      .bind(matches?1:0,now,matches?1:0,matches?1:0,mailboxId,row.code_hash,Date.now()).first<{ verified_at: number | null }>();
    if (!updated?.verified_at) fail(400, 'CODE_INVALID');
    return c.json({ ok: true });
  });

  app.post('/api/admin/mailboxes/:id/test', async c => {
    await admin(c, true);
    const config = await sendingConfig(c), mailboxId = id(c.req.param('id'));
    const row = await mailbox(c, mailboxId), now = Date.now();
    if (row.verified_at === null) fail(409, 'MAILBOX_UNVERIFIED');
    const changed = await mailDb(c).prepare(`UPDATE mailboxes SET last_test_at=? WHERE id=? AND verified_at IS NOT NULL
      AND (last_test_at IS NULL OR last_test_at<=?) RETURNING id`).bind(now,mailboxId,now-minute).first();
    if (!changed) fail(429, 'RATE_LIMITED');
    const startAt = now + 86_400_000;
    const sent = await sendMail(c, config, {
      to: [row.address], subject: '日历附件测试 / Calendar attachment test',
      text: '请在邮件中打开 .ics 附件，检查日历能否识别。\nOpen the attached .ics file to check your calendar. This is a test.',
      attachments: [calendarAttachment(calendarFile({
        uid: `test-${crypto.randomUUID()}@${new URL(c.env.SITE_ORIGIN!).hostname}`,
        organizer: config.sender, recipient: row.address, summary: '日历附件测试 / Calendar attachment test',
        startAt, endAt: startAt + 30*minute, stamp: now, sequence: 0, status: 'TENTATIVE',
      }))],
    }, `mailbox-test/${mailboxId}/${now}`);
    if (!sent) fail(503, 'MAIL_SEND_FAILED');
    return c.json({ ok: true });
  });

  app.delete('/api/admin/mailboxes/:id', async c => {
    await admin(c, true);
    const mailboxId = id(c.req.param('id')), db = mailDb(c);
    await mailbox(c,mailboxId);
    const removed = await db.prepare(`DELETE FROM mailboxes WHERE id=?
      AND NOT EXISTS(SELECT 1 FROM mail_settings WHERE primary_delivery_id=? OR notification_id=?)
      AND NOT EXISTS(SELECT 1 FROM invite_mailboxes WHERE mailbox_id=?) RETURNING id`)
      .bind(mailboxId,mailboxId,mailboxId,mailboxId).first();
    if (!removed) fail(409, 'MAILBOX_IN_USE');
    return c.json({ ok: true });
  });

  app.patch('/api/admin/mail/overrides/:inviteId', async c => {
    await admin(c, true);
    const inviteId = id(c.req.param('inviteId')), input = await body(c), db = mailDb(c);
    if (!await db.prepare("SELECT id FROM invites WHERE id=? AND kind='invite'").bind(inviteId).first()) fail(404, 'NOT_FOUND');
    if (input.mailboxId === null) {
      await db.prepare('DELETE FROM invite_mailboxes WHERE invite_id=?').bind(inviteId).run();
    } else {
      const mailboxId = id(input.mailboxId);
      const updated = await db.prepare(`INSERT INTO invite_mailboxes(invite_id,mailbox_id) SELECT ?,id FROM mailboxes
        WHERE id=? AND verified_at IS NOT NULL ON CONFLICT(invite_id) DO UPDATE SET mailbox_id=excluded.mailbox_id
        RETURNING invite_id`).bind(inviteId,mailboxId).first();
      if (!updated) fail(409, 'MAILBOX_UNVERIFIED');
    }
    return c.json({ ok: true });
  });
}
