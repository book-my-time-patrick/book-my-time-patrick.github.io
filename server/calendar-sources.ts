import type { Context, Hono } from 'hono';
import { parseEmailAddress } from '../shared/booking.js';
import { AuthError, requireAdmin } from './auth.js';
import { CALENDAR_FRESH_MS, CALENDAR_WINDOW_MS, mergeBusyRanges } from './calendar-availability.js';
import type { BusyRange } from './calendar-availability.js';
import {
  CalendarProviderError, discoverIcloudCalendars, exchangeMicrosoftCode, listMicrosoftCalendars,
  microsoftAuthorizationUrl, readIcloudBusy, readMicrosoftBusy, refreshMicrosoftToken,
} from './calendar-providers.js';
import type { BusyInterval, CalendarReference, IcloudCredentials, MicrosoftConfig } from './calendar-providers.js';
import type { Environment, SqlDatabase } from './db.js';
import { DIRECT_MAIL_GATE_SQL } from './mail.js';
import { base64url, decryptSecret, encryptSecret, randomToken, sha256 } from './security.js';

type Ctx = Context<{ Bindings: Environment }>;
const providers = ['icloud', 'outlook'] as const;
type Provider = typeof providers[number];
type AppleSource = { provider: 'icloud'; credentials: IcloudCredentials; calendarIds: string[] };
type OutlookSource = { provider: 'outlook'; config: MicrosoftConfig; refreshToken: string; calendarId: string };
type Source = AppleSource | OutlookSource;
type OAuthStart = { config: MicrosoftConfig; verifier: string; sourceRevision: string | null };
type OutlookChoice = { config: MicrosoftConfig; refreshToken: string; calendars: CalendarReference[]; sourceRevision: string | null };
type Flow = { token_hash: string; payload_encrypted: string };
type SourceRow = {
  provider: Provider; synced_at: number | null; covered_from: number | null; covered_until: number | null;
  last_error: string | null; sync_started_at: number | null;
};
const flowLifetime = 10 * 60_000;
const syncLock = 2 * 60_000;
const callbackPath = '/api/calendar-oauth/callback';
const adminPath = '/api/admin/calendar-sources';

function connectionSettings(env: Environment) {
  const key = env.DATA_ENCRYPTION_KEY;
  if (!env.DB || !key || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new AuthError(503, 'SERVICE_UNAVAILABLE');
  return { db: env.DB, key };
}

async function adminSession(c: Ctx) {
  const session = await requireAdmin(c);
  if (!session) throw new AuthError(401, 'UNAUTHORIZED');
  return session;
}

async function input(c: Ctx): Promise<Record<string, unknown>> {
  if (c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(400, 'INVALID_INPUT');
  }
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, 'INVALID_INPUT');
  return value as Record<string, unknown>;
}

function text(value: unknown, limit: number) {
  if (typeof value !== 'string' || !value || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AuthError(400, 'INVALID_INPUT');
  }
  return value;
}

function appleCredentials(data: Record<string, unknown>): IcloudCredentials {
  const username = parseEmailAddress(data.username);
  const appPassword = text(data.appPassword, 128).trim();
  if (!username || !appPassword || /\s/.test(appPassword)) throw new AuthError(400, 'INVALID_INPUT');
  return { username, appPassword };
}

function readProvider(value: unknown): Provider {
  if (value !== 'icloud' && value !== 'outlook') throw new AuthError(400, 'INVALID_INPUT');
  return value;
}

function syncCode(error: unknown) {
  return error instanceof CalendarProviderError ? error.code : 'CALENDAR_UNAVAILABLE';
}

function providerFailure(error: unknown): never {
  const code = syncCode(error);
  throw new AuthError(code === 'CALENDAR_CONFIG_INVALID' ? 400 : 409, code);
}

async function sourceRevision(db: SqlDatabase, provider: Provider) {
  return db.prepare('SELECT revision FROM calendar_sources WHERE provider=?').bind(provider).first<string>('revision');
}

function makeWindow(now: number) {
  return { startAt: now, endAt: now + CALENDAR_WINDOW_MS + CALENDAR_FRESH_MS };
}

function summarize(intervals: BusyInterval[], window: ReturnType<typeof makeWindow>) {
  const ranges = intervals.flatMap(({ startAt, endAt }): BusyRange[] => {
    const start = Math.max(window.startAt, startAt);
    const end = Math.min(window.endAt, endAt);
    return start < end ? [[start, end]] : [];
  });
  const merged = mergeBusyRanges(ranges);
  if (merged.length > 1024) throw new CalendarProviderError('CALENDAR_LIMIT_EXCEEDED');
  return JSON.stringify(merged);
}

async function collectBusy(source: Source, window: ReturnType<typeof makeWindow>, rotate: (next: OutlookSource) => Promise<void>) {
  if (source.provider === 'icloud') {
    const intervals = await Promise.all(source.calendarIds.map(id => readIcloudBusy(source.credentials, id, window)));
    return summarize(intervals.flat(), window);
  }
  const tokens = await refreshMicrosoftToken(source.config, source.refreshToken);
  if (tokens.refreshToken !== source.refreshToken) await rotate({ ...source, refreshToken: tokens.refreshToken });
  return summarize(await readMicrosoftBusy(source.config.cloud, tokens.accessToken, source.calendarId, window), window);
}

async function saveSource(db: SqlDatabase, key: string, source: Source, expected: string | null,
  choice?: { sessionId: string; tokenHash: string }) {
  const now = Date.now();
  const window = makeWindow(now);
  let current = source;
  let busy: string;
  try {
    busy = await collectBusy(source, window, async next => { current = next; });
  } catch (error) { providerFailure(error); }
  const cipher = await encryptSecret(JSON.stringify(current), key, `calendar-${source.provider}`);
  const choiceGate = choice ? `AND EXISTS (SELECT 1 FROM calendar_connection_flows
    WHERE session_id=? AND token_hash=? AND step='select' AND expires_at>?)` : '';
  const choiceParameters = choice ? [choice.sessionId, choice.tokenHash, Date.now()] : [];
  const saved = await db.prepare(`INSERT INTO calendar_sources(provider,config_encrypted,revision,synced_at,covered_from,covered_until,busy_json)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT revision FROM calendar_sources WHERE provider=?) IS ? ${choiceGate}
    ON CONFLICT(provider) DO UPDATE SET config_encrypted=excluded.config_encrypted,revision=excluded.revision,
      synced_at=excluded.synced_at,covered_from=excluded.covered_from,covered_until=excluded.covered_until,
      busy_json=excluded.busy_json,last_error=NULL,sync_started_at=NULL
    RETURNING provider`).bind(source.provider, cipher, randomToken(16), now, window.startAt, window.endAt, busy,
    source.provider, expected, ...choiceParameters).first();
  if (!saved) throw new AuthError(409, 'CALENDAR_CHANGED');
}

async function refreshSource(db: SqlDatabase, key: string, provider: Provider) {
  const now = Date.now();
  const row = await db.prepare(`UPDATE calendar_sources SET sync_started_at=? WHERE provider=?
    AND (sync_started_at IS NULL OR sync_started_at<=?) RETURNING config_encrypted,revision`)
    .bind(now, provider, now - syncLock).first<{ config_encrypted: string; revision: string }>();
  if (!row) return;
  const identity = [provider, row.revision, now];
  const window = makeWindow(now);
  const currentAttempt = 'provider=? AND revision=? AND sync_started_at=?';
  try {
    const source = JSON.parse(await decryptSecret(row.config_encrypted, key, `calendar-${provider}`)) as Source;
    if (source.provider !== provider) throw new Error('Invalid stored source');
    const busy = await collectBusy(source, window, async next => {
      const cipher = await encryptSecret(JSON.stringify(next), key, 'calendar-outlook');
      await db.prepare(`UPDATE calendar_sources SET config_encrypted=? WHERE ${currentAttempt}`).bind(cipher, ...identity).run();
    });
    await db.prepare(`UPDATE calendar_sources SET busy_json=?,synced_at=?,covered_from=?,covered_until=?,last_error=NULL,sync_started_at=NULL
      WHERE ${currentAttempt}`).bind(busy, now, window.startAt, window.endAt, ...identity).run();
  } catch (error) {
    await db.prepare(`UPDATE calendar_sources SET last_error=?,busy_json='[]',sync_started_at=NULL WHERE ${currentAttempt}`)
      .bind(syncCode(error), ...identity).run();
  }
}

export async function refreshCalendars(env: Environment) {
  if (!env.DB || !env.DATA_ENCRYPTION_KEY) return;
  const { db, key } = connectionSettings(env);
  await Promise.all([
    db.prepare('DELETE FROM calendar_connection_flows WHERE expires_at<=?').bind(Date.now()).run(),
    ...providers.map(provider => refreshSource(db, key, provider)),
  ]);
}

function isFresh(row: SourceRow | undefined, now: number) {
  return Boolean(row && !row.last_error && row.synced_at !== null && row.synced_at > now - CALENDAR_FRESH_MS && row.synced_at <= now
    && row.covered_from !== null && row.covered_from <= now && row.covered_until !== null && row.covered_until >= now + CALENDAR_WINDOW_MS);
}

async function adminState(db: SqlDatabase, key: string, sessionId: string) {
  const now = Date.now();
  const [rows, toggle, flow] = await Promise.all([
    db.prepare(`SELECT provider,synced_at,covered_from,covered_until,last_error,sync_started_at FROM calendar_sources`).all<SourceRow>(),
    db.prepare('SELECT direct_enabled FROM calendar_settings WHERE id=1').first<number>('direct_enabled'),
    db.prepare("SELECT payload_encrypted FROM calendar_connection_flows WHERE session_id=? AND step='select' AND expires_at>?")
      .bind(sessionId, now).first<string>('payload_encrypted'),
  ]);
  const outlookChoices = flow ? (JSON.parse(await decryptSecret(flow, key, 'calendar-oauth')) as OutlookChoice).calendars : [];
  return {
    directEnabled: toggle === 1,
    sources: providers.map(provider => {
      const row = rows.results.find(item => item.provider === provider);
      return { provider, connected: Boolean(row), ready: isFresh(row, now), syncedAt: row?.synced_at ?? null, error: row?.last_error ?? null,
        syncing: row?.sync_started_at != null && row.sync_started_at > now - syncLock };
    }),
    outlookChoices,
  };
}

export function mountCalendarSources(app: Hono<{ Bindings: Environment }>) {
  app.get(callbackPath, c => {
    const url = new URL(c.req.url);
    if (url.protocol === 'https:' && url.origin !== c.env.SITE_ORIGIN) throw new AuthError(404, 'NOT_FOUND');
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    const fields = /^[A-Za-z0-9_-]{43}$/.test(state) && code.length > 0 && code.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(code)
      ? new URLSearchParams({ state, code }) : new URLSearchParams({ cancelled: '1' });
    return c.redirect(`/#/admin/calendar-return?${fields}`, 303);
  });

  app.get(adminPath, async c => {
    const session = await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    return c.json(await adminState(db, key, session.id));
  });

  app.post(`${adminPath}/icloud/discover`, async c => {
    await adminSession(c);
    const credentials = appleCredentials(await input(c));
    try { return c.json({ calendars: await discoverIcloudCalendars(credentials) }); }
    catch (error) { providerFailure(error); }
  });
  app.post(`${adminPath}/icloud/connect`, async c => {
    await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    const data = await input(c);
    const credentials = appleCredentials(data);
    if (!Array.isArray(data.calendarIds) || data.calendarIds.length < 1 || data.calendarIds.length > 4) throw new AuthError(400, 'INVALID_INPUT');
    const calendarIds = [...new Set(data.calendarIds.map(id => text(id, 2048)))];
    const expected = await sourceRevision(db, 'icloud');
    let calendars: CalendarReference[];
    try { calendars = await discoverIcloudCalendars(credentials); }
    catch (error) { providerFailure(error); }
    if (calendarIds.some(id => !calendars.some(calendar => calendar.id === id))) throw new AuthError(400, 'INVALID_INPUT');
    await saveSource(db, key, { provider: 'icloud', credentials, calendarIds }, expected);
    return c.json({ ok: true });
  });

  app.post(`${adminPath}/outlook/start`, async c => {
    const session = await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    const data = await input(c);
    if (data.cloud !== 'global' && data.cloud !== 'china') throw new AuthError(400, 'INVALID_INPUT');
    const config: MicrosoftConfig = {
      cloud: data.cloud, tenantId: text(data.tenantId, 80).trim(), clientId: text(data.clientId, 80).trim(),
      clientSecret: text(data.clientSecret, 512).trim(), redirectUri: `${c.env.SITE_ORIGIN}${callbackPath}`,
    };
    const state = randomToken();
    const verifier = randomToken();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    let url: string;
    try { url = String(microsoftAuthorizationUrl(config, state, challenge)); }
    catch (error) { providerFailure(error); }
    const payload: OAuthStart = { config, verifier, sourceRevision: await sourceRevision(db, 'outlook') };
    const encrypted = await encryptSecret(JSON.stringify(payload), key, 'calendar-oauth');
    const now = Date.now();
    await db.prepare(`INSERT INTO calendar_connection_flows(session_id,token_hash,step,payload_encrypted,expires_at)
      VALUES(?,?,'authorize',?,?) ON CONFLICT(session_id) DO UPDATE SET token_hash=excluded.token_hash,step='authorize',
      payload_encrypted=excluded.payload_encrypted,expires_at=excluded.expires_at`)
      .bind(session.id, await sha256(state), encrypted, now + flowLifetime).run();
    return c.json({ url });
  });

  app.post(`${adminPath}/outlook/finish`, async c => {
    const session = await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    const data = await input(c);
    const state = text(data.state, 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AuthError(400, 'INVALID_INPUT');
    const code = text(data.code, 4096);
    const flow = await db.prepare(`UPDATE calendar_connection_flows SET step='exchange'
      WHERE session_id=? AND token_hash=? AND step='authorize' AND expires_at>? RETURNING token_hash,payload_encrypted`)
      .bind(session.id, await sha256(state), Date.now()).first<Flow>();
    if (!flow) throw new AuthError(409, 'CALENDAR_FLOW_EXPIRED');
    const started = JSON.parse(await decryptSecret(flow.payload_encrypted, key, 'calendar-oauth')) as OAuthStart;
    let choice: OutlookChoice;
    try {
      const tokens = await exchangeMicrosoftCode(started.config, code, started.verifier);
      const calendars = await listMicrosoftCalendars(started.config.cloud, tokens.accessToken);
      choice = { config: started.config, refreshToken: tokens.refreshToken, calendars, sourceRevision: started.sourceRevision };
    } catch (error) {
      await db.prepare('DELETE FROM calendar_connection_flows WHERE session_id=? AND token_hash=?').bind(session.id, flow.token_hash).run();
      providerFailure(error);
    }
    const encrypted = await encryptSecret(JSON.stringify(choice), key, 'calendar-oauth');
    const saved = await db.prepare(`UPDATE calendar_connection_flows SET payload_encrypted=?,step='select',expires_at=?
      WHERE session_id=? AND token_hash=? AND step='exchange' RETURNING session_id`)
      .bind(encrypted, Date.now() + flowLifetime, session.id, flow.token_hash).first();
    if (!saved) throw new AuthError(409, 'CALENDAR_FLOW_EXPIRED');
    return c.json({ ok: true });
  });

  app.post(`${adminPath}/outlook/select`, async c => {
    const session = await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    const calendarId = text((await input(c)).calendarId, 2048);
    const flow = await db.prepare(`SELECT token_hash,payload_encrypted FROM calendar_connection_flows
      WHERE session_id=? AND step='select' AND expires_at>?`).bind(session.id, Date.now()).first<Flow>();
    if (!flow) throw new AuthError(409, 'CALENDAR_FLOW_EXPIRED');
    const { config, refreshToken, calendars, sourceRevision: expected } = JSON.parse(await decryptSecret(flow.payload_encrypted, key, 'calendar-oauth')) as OutlookChoice;
    if (!calendars.some(calendar => calendar.id === calendarId)) throw new AuthError(400, 'INVALID_INPUT');
    await saveSource(db, key, { provider: 'outlook', config, refreshToken, calendarId }, expected, {
      sessionId: session.id, tokenHash: flow.token_hash,
    });
    await db.prepare('DELETE FROM calendar_connection_flows WHERE session_id=? AND token_hash=?').bind(session.id, flow.token_hash).run();
    return c.json({ ok: true });
  });

  app.post(`${adminPath}/refresh`, async c => {
    await adminSession(c);
    const { db, key } = connectionSettings(c.env);
    const provider = readProvider((await input(c)).provider);
    await refreshSource(db, key, provider);
    return c.json({ ok: true });
  });

  app.post(`${adminPath}/disconnect`, async c => {
    await adminSession(c);
    const { db } = connectionSettings(c.env);
    const provider = readProvider((await input(c)).provider);
    await db.batch([
      db.prepare('DELETE FROM calendar_sources WHERE provider=?').bind(provider),
      db.prepare('UPDATE calendar_settings SET direct_enabled=0 WHERE id=1'),
      ...(provider === 'outlook' ? [db.prepare('DELETE FROM calendar_connection_flows')] : []),
    ]);
    return c.json({ ok: true });
  });

  app.post(`${adminPath}/direct`, async c => {
    await adminSession(c);
    const { db } = connectionSettings(c.env);
    const enabled = (await input(c)).enabled;
    if (typeof enabled !== 'boolean') throw new AuthError(400, 'INVALID_INPUT');
    const now = Date.now();
    const changed = await db.prepare(`UPDATE calendar_settings SET direct_enabled=? WHERE id=1 AND (?=0 OR (
      (SELECT COUNT(*) FROM calendar_sources WHERE synced_at>? AND synced_at<=? AND covered_from<=?
      AND covered_until>=? AND last_error IS NULL)=2 AND ${DIRECT_MAIL_GATE_SQL})) RETURNING id`)
      .bind(Number(enabled), Number(enabled), now - CALENDAR_FRESH_MS, now, now, now + CALENDAR_WINDOW_MS).first();
    if (!changed) throw new AuthError(409, 'CALENDAR_NOT_READY');
    return c.json({ ok: true });
  });
}
