import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { decodeClientDataJSON } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { Environment, SqlDatabase } from './db.js';
import { sessionExpiry } from './session-policy.js';
import { base64url, decryptSecret, encryptSecret, equalText, fromBase64url, hmac, matchingTotpStep, newTotpSecret, randomToken, sha256 } from './security.js';

type C = Context<{ Bindings: Environment }>;
type Purpose = 'setup' | 'login' | 'reauth' | 'register';
const FIVE_MINUTES = 300_000;
const RECENT_WINDOW = 600_000;
const DAY = 86_400_000;
const credentialTransports = new Set(['usb', 'nfc', 'ble', 'hybrid', 'internal']);
export class AuthError extends Error {
  public status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  constructor(status: number, public code: string) { super(code); this.status = ([400,401,403,404,409,429,503].includes(status) ? status : 503) as typeof this.status; }
}
interface Owner { id: number; name: string; webauthn_user_id: string; totp_cipher: string; totp_last_step: number }
interface Passkey { id: string; public_key: string; counter: number; transports: string; revoked_at: number | null }
interface Challenge { id: string; challenge: string; payload: string | null; session_id: string | null }
export interface AdminSession {
  id: string; sessionId: string; ownerId: number; name: string; sessionHash: string; credentialId: string;
  label: string; os: string; browser: string; createdAt: number; lastSeenAt: number; expiresAt: number; recentAuthUntil: number;
}
function settings(c: C) {
  const { DB, SITE_ORIGIN, DATA_ENCRYPTION_KEY, SETUP_TOKEN_HASH } = c.env;
  if (!DB || !SITE_ORIGIN || !DATA_ENCRYPTION_KEY || !/^[A-Za-z0-9_-]{43}$/.test(DATA_ENCRYPTION_KEY)) throw new AuthError(503, 'ADMIN_UNAVAILABLE');
  let site: URL;
  try { site = new URL(SITE_ORIGIN); } catch { throw new AuthError(503, 'ADMIN_UNAVAILABLE'); }
  if (site.origin !== SITE_ORIGIN || (site.protocol !== 'https:' && !(site.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(site.hostname)))) throw new AuthError(503, 'ADMIN_UNAVAILABLE');
  return { db: DB, site, key: DATA_ENCRYPTION_KEY, setupHash: SETUP_TOKEN_HASH };
}
function checkRequestOrigin(c: C) {
  const { site } = settings(c);
  const request = new URL(c.req.url);
  if (site.protocol === 'https:' && request.origin !== site.origin) throw new AuthError(403, 'FORBIDDEN');
  const origin = c.req.header('Origin');
  if ((origin && origin !== site.origin) || (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin !== site.origin)) throw new AuthError(403, 'FORBIDDEN');
  if (c.req.header('Sec-Fetch-Site') === 'cross-site') throw new AuthError(403, 'FORBIDDEN');
}
function text(value: unknown, maximum = 80): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new AuthError(400, 'INVALID_INPUT');
  return value.trim();
}
async function body(c: C): Promise<Record<string, unknown>> {
  if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) throw new AuthError(400, 'INVALID_INPUT');
  try {
    const input: unknown = await c.req.json();
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input as Record<string, unknown>;
  } catch { throw new AuthError(400, 'INVALID_INPUT'); }
}
function responseInput<T>(value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, 'INVALID_INPUT');
  const id = (value as { id?: unknown }).id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(id)) throw new AuthError(400, 'INVALID_INPUT');
  return value as T;
}
function transports(value: string): AuthenticatorTransport[] {
  try { const decoded: unknown = JSON.parse(value); return Array.isArray(decoded) ? decoded.filter(item => typeof item === 'string' && credentialTransports.has(item)) : []; } catch { return []; }
}
function coarseDevice(c: C) {
  const ua = c.req.header('User-Agent') ?? '';
  const os = /Windows NT 10/.test(ua) ? 'Windows 10 / 11' : /iPhone|iPad|iPod/.test(ua) ? 'iOS / iPadOS' : /Macintosh|Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : '其他系统';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '其他浏览器';
  return { os, browser };
}
function cookieName(c: C) { return settings(c).site.protocol === 'https:' ? '__Host-admin_session' : 'admin_session'; }
function issueCookie(c: C, token: string, expiresAt: number) {
  setCookie(c, cookieName(c), token, { httpOnly: true, secure: settings(c).site.protocol === 'https:', sameSite: 'Strict', path: '/', maxAge: Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) });
}
function clearCookie(c: C) { deleteCookie(c, cookieName(c), { path: '/', secure: settings(c).site.protocol === 'https:', sameSite: 'Strict', httpOnly: true }); }
function sessionView(session: AdminSession) {
  return { id: session.id, label: session.label, os: session.os, browser: session.browser, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, current: true, recentAuthUntil: session.recentAuthUntil };
}
export async function requireAdmin(c: C, recent = false): Promise<AdminSession | null> {
  checkRequestOrigin(c);
  const { db } = settings(c);
  const token = getCookie(c, cookieName(c));
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await sha256(token);
  const now = Date.now();
  const row = await db.prepare(`SELECT s.id,s.credential_id,s.label,s.os,s.browser,s.created_at,s.last_seen_at,s.expires_at,s.recent_auth_at,o.name FROM sessions s JOIN passkeys p ON p.id=s.credential_id CROSS JOIN owners o WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND p.revoked_at IS NULL AND o.id=1`).bind(hash, now).first<{id:string;credential_id:string;label:string;os:string;browser:string;created_at:number;last_seen_at:number;expires_at:number;recent_auth_at:number;name:string}>();
  if (!row) return null;
  const session: AdminSession = { id: row.id, sessionId: row.id, ownerId: 1, name: row.name, sessionHash: hash, credentialId: row.credential_id, label: row.label, os: row.os, browser: row.browser, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, recentAuthUntil: row.recent_auth_at + RECENT_WINDOW };
  if (recent && session.recentAuthUntil <= now) throw new AuthError(403, 'REAUTH_REQUIRED');
  if (row.last_seen_at < now - 60_000) await db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=? AND revoked_at IS NULL').bind(now, row.id).run();
  return session;
}
async function admin(c: C, recent = false): Promise<AdminSession> { const result = await requireAdmin(c, recent); if (!result) throw new AuthError(401, 'UNAUTHENTICATED'); return result; }
async function owner(db: SqlDatabase): Promise<Owner> { const result = await db.prepare('SELECT * FROM owners WHERE id=1').first<Owner>(); if (!result) throw new AuthError(401, 'AUTHENTICATION_FAILED'); return result; }
async function rateLimit(c: C) {
  const { db, key } = settings(c);
  const now = Date.now(), window = Math.floor(now / FIVE_MINUTES);
  const peer = await hmac(fromBase64url(key), `auth-rate:${Math.floor(now / DAY)}:${c.req.header('CF-Connecting-IP') ?? 'local'}`);
  const values = await db.batch<{ hits: number }>([
    db.prepare('INSERT INTO auth_rates(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=MIN(hits+1,241) RETURNING hits').bind(`global:${window}`, (window + 2) * FIVE_MINUTES),
    db.prepare('INSERT INTO auth_rates(bucket,hits,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=MIN(hits+1,31) RETURNING hits').bind(`${peer}:${window}`, (window + 2) * FIVE_MINUTES),
  ]);
  if ((values[0].results[0]?.hits ?? 999) > 240 || (values[1].results[0]?.hits ?? 999) > 30) throw new AuthError(429, 'RATE_LIMITED');
}
async function cleanExpired(db: SqlDatabase) {
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM auth_challenges WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM auth_rates WHERE expires_at<=?').bind(now),
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
  ]);
}
async function saveChallenge(c: C, purpose: Purpose, challenge: string, sessionId: string | null = null, payload: unknown = null) {
  const { db } = settings(c);
  await cleanExpired(db);
  const id = randomToken();
  await db.prepare('INSERT INTO auth_challenges(id,purpose,challenge,session_id,payload,expires_at) VALUES(?,?,?,?,?,?)').bind(id,purpose,challenge,sessionId,payload === null ? null : JSON.stringify(payload),Date.now()+FIVE_MINUTES).run();
  return id;
}
async function consumeChallenge(c: C, purpose: Purpose, flowId: unknown, sessionId: string | null = null): Promise<Challenge> {
  const id = text(flowId, 64);
  const result = await settings(c).db.prepare('DELETE FROM auth_challenges WHERE id=? AND purpose=? AND expires_at>? AND session_id IS ? RETURNING id,challenge,payload,session_id').bind(id,purpose,Date.now(),sessionId).first<Challenge>();
  if (!result) throw new AuthError(401, purpose === 'setup' ? 'SETUP_FLOW_EXPIRED' : 'AUTHENTICATION_FAILED');
  return result;
}
async function readSetupChallenge(c: C, flowId: unknown): Promise<Challenge> {
  const id = text(flowId, 64);
  const result = await settings(c).db.prepare("SELECT id,challenge,payload,session_id FROM auth_challenges WHERE id=? AND purpose='setup' AND expires_at>? AND session_id IS NULL").bind(id, Date.now()).first<Challenge>();
  if (!result) throw new AuthError(401, 'SETUP_FLOW_EXPIRED');
  return result;
}
async function registrationOptions(c: C, userID: string, exclude: Array<{id:string;transports:string}> = []) {
  const { site } = settings(c);
  return generateRegistrationOptions({ rpName: '受邀预约后台', rpID: site.hostname, userName: 'owner', userDisplayName: '管理员', userID: fromBase64url(userID), attestationType: 'none', supportedAlgorithmIDs: [-7], timeout: FIVE_MINUTES, authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: exclude.map(item=>({id:item.id,transports:transports(item.transports)})) });
}
async function verifyRegistration(c: C, challenge: Challenge, response: unknown, setupDiagnostics = false) {
  const failure = setupDiagnostics ? 'PASSKEY_VERIFICATION_FAILED' : 'AUTHENTICATION_FAILED';
  const parsed = responseInput<RegistrationResponseJSON>(response);
  let clientData;
  try { clientData = decodeClientDataJSON(parsed.response.clientDataJSON); }
  catch { throw new AuthError(401, failure); }
  if (clientData.crossOrigin || clientData.topOrigin) throw new AuthError(401, setupDiagnostics ? 'PASSKEY_CONTEXT_NOT_SUPPORTED' : 'AUTHENTICATION_FAILED');
  try {
    const result = await verifyRegistrationResponse({ response: parsed, expectedChallenge: challenge.challenge, expectedOrigin: settings(c).site.origin, expectedRPID: settings(c).site.hostname, requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7] });
    if (!result.verified || !result.registrationInfo) throw new Error();
    return result.registrationInfo;
  } catch { throw new AuthError(401, failure); }
}
async function verifyAuthentication(c: C, challenge: Challenge, response: unknown) {
  const parsed = responseInput<AuthenticationResponseJSON>(response);
  try {
    const clientData = decodeClientDataJSON(parsed.response.clientDataJSON);
    if (clientData.crossOrigin || clientData.topOrigin) throw new Error();
  } catch { throw new AuthError(401, 'AUTHENTICATION_FAILED'); }
  const { db, site } = settings(c);
  const key = await db.prepare('SELECT id,public_key,counter,transports,revoked_at FROM passkeys WHERE id=? AND revoked_at IS NULL').bind(parsed.id).first<Passkey>();
  if (!key) throw new AuthError(401, 'AUTHENTICATION_FAILED');
  const account = await owner(db);
  if (parsed.response?.userHandle && parsed.response.userHandle !== account.webauthn_user_id) throw new AuthError(401, 'AUTHENTICATION_FAILED');
  try {
    const result = await verifyAuthenticationResponse({ response: parsed, expectedChallenge: challenge.challenge, expectedOrigin: site.origin, expectedRPID: site.hostname, requireUserVerification: true, credential: { id:key.id, publicKey:fromBase64url(key.public_key), counter:key.counter, transports:transports(key.transports) } });
    if (!result.verified) throw new Error();
    return { account, key, info: result.authenticationInfo };
  } catch { throw new AuthError(401, 'AUTHENTICATION_FAILED'); }
}
function newSession(c: C, credentialId: string, input: Record<string, unknown>) {
  const now = Date.now();
  const device = coarseDevice(c);
  return { id: crypto.randomUUID(), token: randomToken(), credentialId, label: input.deviceName === undefined ? `${device.os} · ${device.browser}` : text(input.deviceName) || `${device.os} · ${device.browser}`, ...device, now, expiresAt: sessionExpiry(now, input.remember === true) };
}
export function mountAuth(app: Hono<{ Bindings: Environment }>) {
  const endpoint = (handler: (c: C) => Promise<Response>) => async (c: C) => {
    try { checkRequestOrigin(c); return await handler(c); }
    catch(error) { if (error instanceof AuthError) return c.json({error:error.code}, error.status); return c.json({error:'ADMIN_UNAVAILABLE'},503); }
  };
  app.get('/api/admin/status', endpoint(async c => c.json({ configured: !!await settings(c).db.prepare('SELECT id FROM owners WHERE id=1').first() })));
  app.post('/api/admin/setup/options', endpoint(async c => {
    await rateLimit(c);
    const input = await body(c), { db, key } = settings(c), activation = setupActivation(c);
    const supplied = text(input.setupToken, 128);
    if (!equalText(await sha256(supplied), activation.hash) || await db.prepare('SELECT id FROM owners WHERE id=1').first()) throw new AuthError(403,'SETUP_UNAVAILABLE');
    const secret = newTotpSecret(), userID = randomToken();
    const options = await registrationOptions(c,userID);
    const flowId = await saveChallenge(c,'setup',options.challenge,null,{ userID, cipher:await encryptSecret(secret,key), activation });
    return c.json({ flowId, options, totpSecret:secret, totpUri:`otpauth://totp/${encodeURIComponent('受邀预约:管理员')}?secret=${secret}&issuer=${encodeURIComponent('受邀预约')}&algorithm=SHA1&digits=6&period=30` });
  }));
  app.post('/api/admin/setup/verify', endpoint(async c => {
    await rateLimit(c);
    const input = await body(c), { db, key } = settings(c), activation = setupActivation(c);
    if (await db.prepare('SELECT id FROM owners WHERE id=1').first()) throw new AuthError(403,'SETUP_UNAVAILABLE');
    const challenge = await readSetupChallenge(c,input.flowId);
    const pending = JSON.parse(challenge.payload ?? '{}') as {userID:string;cipher:string;activation:{hash:string;expiresAt:number}};
    if (!pending.activation || !equalText(pending.activation.hash,activation.hash) || pending.activation.expiresAt !== activation.expiresAt) throw new AuthError(403,'SETUP_UNAVAILABLE');
    let registration;
    try { registration = await verifyRegistration(c,challenge,input.response,true); }
    catch(error) { await consumeChallenge(c,'setup',input.flowId); throw error; }
    const step = await matchingTotpStep(await decryptSecret(pending.cipher,key),text(input.code,6));
    if (step === null) throw new AuthError(401,'TOTP_INVALID');
    // Only a wrong TOTP may be retried within this same, fixed five-minute flow.
    // Successful verification still atomically consumes the challenge once.
    await consumeChallenge(c,'setup',input.flowId);
    const session = newSession(c,registration.credential.id,input);
    try {
      await db.batch([
        db.prepare('INSERT INTO owners(id,name,webauthn_user_id,totp_cipher,totp_last_step,created_at) VALUES(1,?,?,?,?,?)').bind('管理员',pending.userID,pending.cipher,step,session.now),
        db.prepare('INSERT INTO passkeys(id,public_key,counter,transports,name,device_type,backed_up,created_at,last_used_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(registration.credential.id,base64url(registration.credential.publicKey),registration.credential.counter,JSON.stringify(registration.credential.transports ?? []),session.label,registration.credentialDeviceType,registration.credentialBackedUp?1:0,session.now,session.now),
        db.prepare('INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(session.id,await sha256(session.token),session.credentialId,session.label,session.os,session.browser,session.now,session.now,session.expiresAt,session.now),
      ]);
    } catch { throw new AuthError(503,'SETUP_STORAGE_FAILED'); }
    issueCookie(c,session.token,session.expiresAt);
    return c.json({ok:true});
  }));
  app.post('/api/admin/login/options', endpoint(async c => {
    await rateLimit(c);
    await owner(settings(c).db);
    const options = await generateAuthenticationOptions({ rpID:settings(c).site.hostname, userVerification:'required', timeout:FIVE_MINUTES });
    return c.json({flowId:await saveChallenge(c,'login',options.challenge),options});
  }));
  app.post('/api/admin/login/verify', endpoint(async c => {
    await rateLimit(c);
    const input = await body(c), { db } = settings(c);
    const challenge = await consumeChallenge(c,'login',input.flowId);
    const verified = await verifyAuthentication(c,challenge,input.response);
    const session = newSession(c,verified.key.id,input);
    // Each following statement depends on the preceding CAS succeeding. Zero changes never issues a session.
    const result = await db.batch([
      db.prepare('UPDATE passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=? AND revoked_at IS NULL RETURNING id').bind(verified.info.newCounter,verified.info.credentialBackedUp?1:0,session.now,verified.key.id,verified.key.counter),
      db.prepare('INSERT INTO sessions(id,token_hash,credential_id,label,os,browser,created_at,last_seen_at,expires_at,recent_auth_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE changes()=1 RETURNING id').bind(session.id,await sha256(session.token),session.credentialId,session.label,session.os,session.browser,session.now,session.now,session.expiresAt,session.now),
    ]);
    if (!result[1].results.length) throw new AuthError(401,'AUTHENTICATION_FAILED');
    issueCookie(c,session.token,session.expiresAt);
    return c.json({ok:true});
  }));
  app.get('/api/admin/me', endpoint(async c => { const session = await admin(c); return c.json({id:session.ownerId,name:session.name,session:sessionView(session)}); }));
  app.post('/api/admin/logout', endpoint(async c => {
    const session = await requireAdmin(c);
    if (session) await settings(c).db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').bind(Date.now(),session.id).run();
    clearCookie(c);
    return c.json({ok:true});
  }));
  app.post('/api/admin/reauth/options', endpoint(async c => {
    const session = await admin(c); await rateLimit(c);
    const options = await generateAuthenticationOptions({rpID:settings(c).site.hostname,userVerification:'required',timeout:FIVE_MINUTES});
    return c.json({flowId:await saveChallenge(c,'reauth',options.challenge,session.id),options});
  }));
  app.post('/api/admin/reauth/verify', endpoint(async c => {
    const session = await admin(c); await rateLimit(c);
    const input = await body(c), {db} = settings(c);
    const challenge = await consumeChallenge(c,'reauth',input.flowId,session.id);
    const verified = await verifyAuthentication(c,challenge,input.response);
    const now = Date.now();
    const result = await db.batch([
      db.prepare(`UPDATE passkeys SET counter=?,backed_up=?,last_used_at=? WHERE id=? AND counter=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM sessions s JOIN passkeys p ON p.id=s.credential_id WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND p.revoked_at IS NULL) RETURNING id`).bind(verified.info.newCounter,verified.info.credentialBackedUp?1:0,now,verified.key.id,verified.key.counter,session.id,now),
      db.prepare('UPDATE sessions SET recent_auth_at=? WHERE id=? AND revoked_at IS NULL AND expires_at>? AND changes()=1 RETURNING id').bind(now,session.id,now),
    ]);
    if (!result[1].results.length) throw new AuthError(401,'AUTHENTICATION_FAILED');
    return c.json({ok:true,recentAuthUntil:now+RECENT_WINDOW});
  }));
  app.get('/api/admin/devices', endpoint(async c => {
    const session = await admin(c);
    const result = await settings(c).db.prepare(`SELECT s.id,s.label,s.os,s.browser,s.created_at,s.last_seen_at,s.expires_at FROM sessions s JOIN passkeys p ON p.id=s.credential_id WHERE s.revoked_at IS NULL AND s.expires_at>? AND p.revoked_at IS NULL ORDER BY s.last_seen_at DESC LIMIT 100`).bind(Date.now()).all<{id:string;label:string;os:string;browser:string;created_at:number;last_seen_at:number;expires_at:number}>();
    return c.json({devices:result.results.map(row=>({id:row.id,label:row.label,os:row.os,browser:row.browser,createdAt:row.created_at,lastSeenAt:row.last_seen_at,expiresAt:row.expires_at,current:row.id===session.id}))});
  }));
  app.patch('/api/admin/devices/:id', endpoint(async c => {
    await admin(c); const input = await body(c), label = text(input.label);
    if (!label) throw new AuthError(400,'INVALID_INPUT');
    const changed = await settings(c).db.prepare('UPDATE sessions SET label=? WHERE id=? AND revoked_at IS NULL AND expires_at>? RETURNING id').bind(label,text(c.req.param('id')),Date.now()).first();
    if (!changed) throw new AuthError(404,'NOT_FOUND');
    return c.json({ok:true});
  }));
  app.delete('/api/admin/devices/:id', endpoint(async c => {
    const session = await admin(c), id = text(c.req.param('id'));
    if (id !== session.id && session.recentAuthUntil <= Date.now()) throw new AuthError(403,'REAUTH_REQUIRED');
    const changed = await settings(c).db.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL RETURNING id').bind(Date.now(),id).first();
    if (!changed) throw new AuthError(404,'NOT_FOUND');
    if (id===session.id) clearCookie(c);
    return c.json({ok:true,loggedOut:id===session.id});
  }));
  app.post('/api/admin/devices/revoke-others', endpoint(async c => {
    const session = await admin(c,true);
    await settings(c).db.prepare('UPDATE sessions SET revoked_at=? WHERE id<>? AND revoked_at IS NULL').bind(Date.now(),session.id).run();
    return c.json({ok:true});
  }));
  app.get('/api/admin/passkeys', endpoint(async c => {
    await admin(c);
    const result = await settings(c).db.prepare('SELECT id,name,device_type,backed_up,created_at,last_used_at FROM passkeys WHERE revoked_at IS NULL ORDER BY created_at').all<{id:string;name:string;device_type:string;backed_up:number;created_at:number;last_used_at:number|null}>();
    return c.json({passkeys:result.results.map(row=>({id:row.id,name:row.name,deviceType:row.device_type,backedUp:!!row.backed_up,createdAt:row.created_at,lastUsedAt:row.last_used_at}))});
  }));
  app.post('/api/admin/passkeys/options', endpoint(async c => {
    const session = await admin(c,true); await rateLimit(c);
    const { db } = settings(c), account = await owner(db);
    const existing = await db.prepare('SELECT id,transports FROM passkeys WHERE revoked_at IS NULL').all<{id:string;transports:string}>();
    if (existing.results.length>=20) throw new AuthError(409,'PASSKEY_LIMIT');
    const options = await registrationOptions(c,account.webauthn_user_id,existing.results);
    return c.json({flowId:await saveChallenge(c,'register',options.challenge,session.id),options});
  }));
  app.post('/api/admin/passkeys/verify', endpoint(async c => {
    const session = await admin(c,true); await rateLimit(c);
    const input = await body(c), { db } = settings(c);
    const challenge = await consumeChallenge(c,'register',input.flowId,session.id);
    const registration = await verifyRegistration(c,challenge,input.response), now = Date.now();
    const name = input.deviceName === undefined ? '通行密钥' : text(input.deviceName) || '通行密钥';
    const changed = await db.prepare(`INSERT INTO passkeys(id,public_key,counter,transports,name,device_type,backed_up,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM passkeys WHERE revoked_at IS NULL)<20 AND EXISTS(SELECT 1 FROM sessions s JOIN passkeys p ON p.id=s.credential_id WHERE s.id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.recent_auth_at>? AND p.revoked_at IS NULL) RETURNING id`).bind(registration.credential.id,base64url(registration.credential.publicKey),registration.credential.counter,JSON.stringify(registration.credential.transports??[]),name,registration.credentialDeviceType,registration.credentialBackedUp?1:0,now,session.id,now,now-RECENT_WINDOW).first();
    if (!changed) throw new AuthError(403,'REAUTH_REQUIRED');
    return c.json({ok:true});
  }));
  app.patch('/api/admin/passkeys/:id', endpoint(async c => {
    await admin(c,true); const input = await body(c), name = text(input.name);
    if (!name) throw new AuthError(400,'INVALID_INPUT');
    const changed = await settings(c).db.prepare('UPDATE passkeys SET name=? WHERE id=? AND revoked_at IS NULL RETURNING id').bind(name,text(c.req.param('id'),2048)).first();
    if (!changed) throw new AuthError(404,'NOT_FOUND');
    return c.json({ok:true});
  }));
  app.delete('/api/admin/passkeys/:id', endpoint(async c => {
    const session = await admin(c,true), id = text(c.req.param('id'),2048), now = Date.now(), {db} = settings(c);
    const result = await db.batch([
      db.prepare('UPDATE passkeys SET revoked_at=? WHERE id=? AND revoked_at IS NULL AND (SELECT COUNT(*) FROM passkeys WHERE revoked_at IS NULL)>1 RETURNING id').bind(now,id),
      db.prepare('UPDATE sessions SET revoked_at=? WHERE credential_id=? AND revoked_at IS NULL AND changes()=1').bind(now,id),
    ]);
    if (!result[0].results.length) throw new AuthError(409,'LAST_PASSKEY');
    if (session.credentialId===id) clearCookie(c);
    return c.json({ok:true,loggedOut:session.credentialId===id});
  }));
}
function setupActivation(c: C) {
  const {setupHash} = settings(c), expires = c.env.SETUP_EXPIRES_AT;
  const expiresAt = typeof expires==='string' ? (/^\d+$/.test(expires) ? Number(expires) : Date.parse(expires)) : NaN;
  if (!setupHash || !/^[a-f0-9]{64}$/.test(setupHash) || !Number.isFinite(expiresAt) || expiresAt<=Date.now()) throw new AuthError(403,'SETUP_UNAVAILABLE');
  return {hash:setupHash,expiresAt};
}
