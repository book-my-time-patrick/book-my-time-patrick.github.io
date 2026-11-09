import type { Context, Hono } from 'hono';
import type { Environment } from './db.js';
import { AuthError, requireAdmin } from './auth.js';

type Ctx = Context<{ Bindings: Environment }>;
const modules = ['profile','calendar','travel','tracks','investments','contact'];
const modes = ['request','direct','open'];
type Permissions = { modules: string[]; modes: string[]; hideBusy?: true };
type InviteRow = { id:string; token_hash:string; label:string; permissions_json:string; created_at:number; expires_at:number; revoked_at:number|null; last_opened_at:number|null; open_count:number; kind:'invite'|'preview'; creator_session_id:string; direct_enabled:number };
const defaults: Permissions = {modules:[...modules],modes:['request','open']};

function random() { const bytes = crypto.getRandomValues(new Uint8Array(32)); return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
async function digest(value: string) { const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join(''); }
function fail(status: number, code: string): never { throw new AuthError(status,code); }
function database(c: Ctx) { if (!c.env.DB || !c.env.SITE_ORIGIN) return fail(503,'SERVICE_UNAVAILABLE'); return c.env.DB; }
export async function activeInvitation(c: Ctx, now = Date.now()) {
 const header=c.req.header('Authorization')??'';
 if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) return fail(404,'NOT_FOUND');
 const row=await database(c).prepare('SELECT * FROM invites WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(await digest(header.slice(7)),now).first<InviteRow>();
 if(!row) return fail(404,'NOT_FOUND');
 return row;
}
function permissions(input: unknown): Permissions {
  if (input === undefined) return structuredClone(defaults);
  if (!input || typeof input !== 'object') return fail(400,'INVALID_INPUT');
  const data = input as Record<string,unknown>;
  if (data.hideBusy !== undefined && typeof data.hideBusy !== 'boolean') return fail(400,'INVALID_INPUT');
  function allowed(key: string, values: string[]) {
    const list = data[key];
    if (!Array.isArray(list) || list.length > values.length || list.some(x=>typeof x !== 'string'||!values.includes(x))) return fail(400,'INVALID_INPUT');
    return [...new Set(list)] as string[];
  }
  return {modules:allowed('modules',modules),modes:allowed('modes',modes),...(data.hideBusy === true ? {hideBusy:true as const} : {})};
}
export function invitationPermissions(row: InviteRow): Permissions {
  const stored = JSON.parse(row.permissions_json) as Permissions;
  if (row.direct_enabled !== 1) stored.modes = stored.modes.filter(mode => mode !== 'direct');
  return stored;
}
function label(input: unknown) { if(typeof input !== 'string'||!input.trim()||input.trim().length>80) return fail(400,'INVALID_INPUT'); return input.trim(); }
function expiry(input: unknown) { const date = typeof input==='number'?input:typeof input==='string'?Date.parse(input):NaN; if(!Number.isSafeInteger(date)||date<=Date.now()||date>Date.now()+3650*86400000) return fail(400,'INVALID_INPUT'); return date; }
function view(row: InviteRow) { return {id:row.id,label:row.label,createdAt:row.created_at,expiresAt:row.expires_at,revokedAt:row.revoked_at,lastOpenedAt:row.last_opened_at,openCount:row.open_count,permissions:invitationPermissions(row)}; }
async function owner(c:Ctx) { const session=await requireAdmin(c); if(!session) return fail(401,'UNAUTHORIZED'); return session; }
async function body(c:Ctx):Promise<Record<string,unknown>> { try { const data=await c.req.json(); if(!data||Array.isArray(data)||typeof data!=='object') return fail(400,'INVALID_INPUT'); return data; } catch { return fail(400,'INVALID_INPUT'); } }
async function find(c:Ctx,id:string) { const row=await database(c).prepare("SELECT * FROM invites WHERE id=? AND kind='invite'").bind(id).first<InviteRow>(); if(!row)return fail(404,'NOT_FOUND'); return row; }
async function issue(c:Ctx,creator:string,input:{label:string;expiresAt:number;permissions:Permissions},preview=false) {
 const db=database(c), token=random(), id=crypto.randomUUID(), now=Date.now();
 await db.prepare("DELETE FROM invites WHERE kind='preview' AND expires_at<=?").bind(now).run();
 const count=await db.prepare('SELECT COUNT(*) AS n FROM invites').first<{n:number}>();
 if((count?.n??0)>=5000) return fail(409,'LIMIT_REACHED');
 const directEnabled = Number(input.permissions.modes.includes('direct'));
 const row:InviteRow={id,token_hash:await digest(token),label:input.label,permissions_json:JSON.stringify(input.permissions),created_at:now,expires_at:input.expiresAt,revoked_at:null,last_opened_at:null,open_count:0,kind:preview?'preview':'invite',creator_session_id:creator,direct_enabled:directEnabled};
 await db.prepare('INSERT INTO invites(id,token_hash,label,permissions_json,created_at,expires_at,kind,creator_session_id,direct_enabled) VALUES(?,?,?,?,?,?,?,?,?)').bind(row.id,row.token_hash,row.label,row.permissions_json,now,row.expires_at,row.kind,creator,directEnabled).run();
 return {invite:view(row),token,url:`${c.env.SITE_ORIGIN}/#/i/${token}`,expiresAt:row.expires_at};
}

export function mountInvites(app:Hono<{Bindings:Environment}>) {
 app.get('/api/admin/invites',async c=>{
  await owner(c); const rows=await database(c).prepare("SELECT * FROM invites WHERE kind='invite' ORDER BY created_at DESC LIMIT 5000").all<InviteRow>();
  return c.json({invites:rows.results.map(view),now:Date.now()});
 });
 app.post('/api/admin/invites',async c=>{
  const session=await owner(c), data=await body(c);
  return c.json(await issue(c,session.id,{label:label(data.label),expiresAt:expiry(data.expiresAt),permissions:permissions(data.permissions)}),201);
 });
 app.patch('/api/admin/invites/:id',async c=>{
  await owner(c); const row=await find(c,c.req.param('id')),data=await body(c);
  if(row.revoked_at!==null) return fail(409,'INVITE_REVOKED');
  const nextPermissions=data.permissions===undefined ? undefined : permissions(data.permissions);
  const next={label:data.label===undefined?row.label:label(data.label),expiry:data.expiresAt===undefined?row.expires_at:expiry(data.expiresAt)};
  const updated=await database(c).prepare(`UPDATE invites SET label=?,expires_at=?,permissions_json=COALESCE(?,permissions_json),
    direct_enabled=COALESCE(?,direct_enabled) WHERE id=? AND revoked_at IS NULL RETURNING *`)
    .bind(next.label,next.expiry,nextPermissions ? JSON.stringify(nextPermissions) : null,
      nextPermissions ? Number(nextPermissions.modes.includes('direct')) : null,row.id).first<InviteRow>();
  if(!updated) return fail(409,'INVITE_REVOKED');
  return c.json({invite:view(updated)});
 });
 app.delete('/api/admin/invites/:id',async c=>{
  await owner(c); const row=await find(c,c.req.param('id'));
  await database(c).prepare('UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').bind(Date.now(),row.id).run();
  return c.json({ok:true});
 });
 app.post('/api/admin/invites/:id/clone',async c=>{
  const session=await owner(c),row=await find(c,c.req.param('id'));
  return c.json(await issue(c,session.id,{label:row.label,expiresAt:Math.max(row.expires_at,Date.now()+30*86400000),permissions:invitationPermissions(row)}),201);
 });
 app.post('/api/admin/preview',async c=>{
  const session=await owner(c),data=await body(c);
  const config=typeof data.inviteId==='string'?invitationPermissions(await find(c,data.inviteId)):permissions(data.permissions);
  const issued=await issue(c,session.id,{label:'预览',expiresAt:Date.now()+3600000,permissions:config},true);
  return c.json({url:issued.url,expiresAt:issued.expiresAt},201);
 });
 app.get('/api/invite',async c=>{
  const now=Date.now(), row=await activeInvitation(c,now);
  if(row.kind==='invite') {
   const accepted=await database(c).prepare("UPDATE invites SET last_opened_at=?,open_count=open_count+1 WHERE id=? AND revoked_at IS NULL AND expires_at>? RETURNING id").bind(now,row.id,now).first();
   if(!accepted) return fail(404,'NOT_FOUND');
  }
  return c.json({preview:row.kind==='preview',expiresAt:row.expires_at,permissions:invitationPermissions(row),profile:{displayName:''}});
 });
}
