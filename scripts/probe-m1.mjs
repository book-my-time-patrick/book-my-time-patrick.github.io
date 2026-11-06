import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fetch } from 'undici';
import { createCloudflareClient } from './cloudflare-client.mjs';
import { makeAuthenticator, totp } from '../tests/webauthn-fixture.ts';

// Isolated synthetic owner only. Never use the production Worker or database.
const passwordOnly=process.argv.includes('--password-only');
const bookingOnly=process.argv.includes('--m2');
if (passwordOnly && bookingOnly) throw new Error('Choose only one focused probe');
const client=createCloudflareClient();
const nonce=randomBytes(6).toString('hex'),name=`invited-${bookingOnly?'m2':'m1'}-probe-${nonce}`;
const configPath=`.local/${name}.jsonc`;
const evidence={name,scope:bookingOnly?'m2':passwordOnly?'password':'full',startedAt:new Date().toISOString(),syntheticOnly:true,mockMail:bookingOnly,realDeviceVerified:false,exactCloudCpuVerified:false,checks:[],cleanup:{}};
const mockMail={key:`re_synthetic_probe_${nonce}`,sender:'booking@notify.example.test',owner:'owner@example.test',guest:'visitor@example.test'};
let accountId,databaseId,zoneId,workerAttempted=false;
let phase='account';
function wrangler(args) {
 try { return execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'}}); }
 catch { throw new Error('隔离探针 Wrangler 操作失败（原始输出不打印）'); }
}

function mailStubSource(site) {
 // This is emitted only in the isolated M2 Worker. Every outbound fetch fails closed.
 return `const fixture = ${JSON.stringify({ ...mockMail, site })};
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  if (input !== 'https://api.resend.com/emails' || init?.method !== 'POST') throw new Error('Outbound probe fetch blocked');
  const headers = new Headers(init.headers);
  if (headers.get('Authorization') !== 'Bearer ' + fixture.key || typeof init.body !== 'string') throw new Error('Invalid synthetic mail request');
  const message = JSON.parse(init.body);
  if (message.from !== '受邀预约 <' + fixture.sender + '>' || !Array.isArray(message.to) || message.to.length !== 1
    || ![fixture.owner, fixture.guest].includes(message.to[0]) || !Array.isArray(message.attachments)
    || message.attachments.length !== 1) throw new Error('Only synthetic addresses and one ICS attachment are allowed');
  const attachment = message.attachments[0];
  const calendar = atob(attachment.content).replace(/\\r\\n /g, '');
  const uid = /^UID:([0-9a-f-]{36})@/m.exec(calendar)?.[1];
  const tentative = /\\r\\nSTATUS:TENTATIVE\\r\\n/.test(calendar);
  const idempotency = 'booking/' + uid + '/' + (tentative ? '0' : '1') + '/' + (message.to[0] === fixture.owner ? 'owner' : 'guest');
  if (attachment.filename !== 'appointment.ics' || attachment.content_type !== 'text/calendar'
    || !calendar.startsWith('BEGIN:VCALENDAR\\r\\n') || !calendar.endsWith('END:VCALENDAR\\r\\n')
    || !/\\r\\nDTSTART:\\d{8}T\\d{6}Z\\r\\n/.test(calendar) || !/\\r\\nDTEND:\\d{8}T\\d{6}Z\\r\\n/.test(calendar)
    || !uid || headers.get('Idempotency-Key') !== idempotency) throw new Error('Invalid synthetic calendar attachment');
  if (tentative) {
    const reviewPrefix = fixture.site + '/#/review/' + uid + '.0.';
    const reviewLink = typeof message.text === 'string' && message.text.split('\\n').find((line: string) => line.startsWith(reviewPrefix) && line.endsWith('/confirm'));
    if (message.to[0] !== fixture.owner || message.reply_to !== fixture.guest || !reviewLink
      || !/^\\d{13}\\.[A-Za-z0-9_-]{43}\\/confirm$/.test(reviewLink.slice(reviewPrefix.length))) throw new Error('Invalid synthetic review link');
  } else if (!/\\r\\nSTATUS:CONFIRMED\\r\\nSEQUENCE:1\\r\\n/.test(calendar)) throw new Error('Invalid synthetic confirmation');
  return Response.json({ id: 'synthetic-provider-accepted' });
};
`;
}

async function probeBooking(call, seedMailbox, dataKey) {
 const guest = token => ({ Cookie:'', ...(token ? { Authorization:`Bearer ${token}` } : {}) });
 const weekRoute = '/api/invite/calendar?week=1';
 await call(weekRoute,'GET',undefined,404,guest());
 const expiresAt = Date.now()+86400000;
 const issued = (await call('/api/admin/invites','POST',{
  label:'Synthetic booking invite',expiresAt,permissions:{modules:['calendar'],modes:['request']},
 },201)).data;
 const invite = guest(issued.token);
 const inactive = (await call(weekRoute,'GET',undefined,200,invite)).data;
 assert.equal(inactive.canSubmit,false);
 assert.equal(inactive.week,1);
 assert.equal(inactive.days.length,7);
 const slot = inactive.days.flatMap(day=>day.slots).find(item=>item.state==='request');
 assert.ok(slot,'expected a request slot in next week');
 const form = { submissionId:randomUUID(),name:'Synthetic visitor',email:mockMail.guest,startAt:slot.startAt,duration:30,meetingType:'online',notes:'Synthetic only',website:'' };
 assert.equal((await call('/api/invite/requests','POST',form,403,invite)).data.error,'REQUESTS_DISABLED');

 const mailboxId = await seedMailbox();
 await call('/api/admin/mail','PATCH',{sender:mockMail.sender,apiKey:mockMail.key,primaryDeliveryId:mailboxId,acceptRequests:true});
 const active = (await call(weekRoute,'GET',undefined,200,invite)).data;
 assert.equal(active.canSubmit,true);
 assert.ok(active.days.slice(5).every(day=>day.slots.every(item=>item.state!=='request')));
 const calendarOnly = (await call('/api/admin/invites','POST',{
  label:'Synthetic calendar-only invite',expiresAt,permissions:{modules:['calendar'],modes:[]},
 },201)).data;
 assert.equal((await call('/api/invite/requests','POST',form,403,guest(calendarOnly.token))).data.error,'REQUESTS_DISABLED');
 const preview = (await call('/api/admin/preview','POST',{inviteId:issued.invite.id},201)).data;
 const previewAuth = guest(new URL(preview.url).hash.slice(4));
 assert.equal((await call(weekRoute,'GET',undefined,200,previewAuth)).data.canSubmit,false);
 assert.equal((await call('/api/invite/requests','POST',form,403,previewAuth)).data.error,'REQUESTS_DISABLED');

 const submission = (await call('/api/invite/requests','POST',form,201,invite)).data;
 assert.deepEqual(submission,{ok:true,mailStatus:'sent'});
 assert.deepEqual((await call('/api/invite/requests','POST',form,200,invite)).data,submission);
 const pending = (await call('/api/admin/requests?status=pending')).data.requests;
 assert.equal(pending.length,1);
 assert.equal(pending[0].name,form.name);
 assert.equal(pending[0].email,form.email);
 assert.equal(pending[0].startAt,form.startAt);
 assert.equal(pending[0].mailStatus,'sent');
 const value = `${pending[0].id}.0.${pending[0].startAt}`;
 const signature = createHmac('sha256',Buffer.from(dataKey,'base64url')).update(`booking-review:v1:${value}`).digest('base64url');
 const review = guest(`${value}.${signature}`);
 await call('/api/request-action','GET',undefined,404,guest(`${value}.${randomBytes(32).toString('base64url')}`));
 const detail = (await call('/api/request-action','GET',undefined,200,review)).data;
 assert.deepEqual(detail,{name:form.name,startAt:form.startAt,endAt:form.startAt+1800000,meetingType:form.meetingType});
 // A second GET proves link scanning did not consume the approval or alter the request.
 assert.deepEqual((await call('/api/request-action','GET',undefined,200,review)).data,detail);
 assert.deepEqual((await call('/api/request-action','POST',{action:'confirm'},200,review)).data,{status:'confirmed',mailStatus:'sent'});
 await call('/api/request-action','POST',{action:'confirm'},404,review);
 const confirmed = (await call('/api/admin/requests?status=confirmed')).data.requests;
 assert.equal(confirmed.length,1);
 assert.equal(confirmed[0].id,pending[0].id);
 assert.equal(confirmed[0].status,'confirmed');
 assert.equal(confirmed[0].mailStatus,'sent');
}
try {
 await mkdir('.local',{recursive:true});
 const accounts=await client.request('/accounts?per_page=50'); assert.equal(accounts.length,1); accountId=accounts[0].id;
 const primary=JSON.parse(await readFile('.local/wrangler.production.jsonc','utf8'));
 const zoneName=new URL(primary.vars.SITE_ORIGIN).hostname;
 const apiHost=primary.routes.find(route=>route.pattern!==zoneName)?.pattern;
 if(!apiHost||!apiHost.endsWith(`.${zoneName}`))throw new Error('Existing API domain not configured');
 const site=`https://${apiHost}`, prefix=`/__${bookingOnly?'m2':'m1'}_probe_${nonce}`;
 const [zone]=await client.request(`/zones?name=${zoneName}&per_page=50`);zoneId=zone.id;
 const entryPath=`.local/${name}-entry.ts`;
 await writeFile(entryPath,`import {createApi} from '../server/app.js';\nimport type {Environment} from '../server/db.js';\n${bookingOnly?mailStubSource(site):''}const app=createApi();\nexport default {fetch(request:Request,env:Environment){const url=new URL(request.url);if(!url.pathname.startsWith('${prefix}/'))return new Response(null,{status:404});url.pathname=url.pathname.slice(${prefix.length});return app.fetch(new Request(url,request),env);}};\n`);
 phase='create isolated database';
 const database=await client.request(`/accounts/${accountId}/d1/database`,{method:'POST',body:JSON.stringify({name,primary_location_hint:'apac'})});
 databaseId=database.uuid;
 await writeFile(configPath,JSON.stringify({name,main:`./${name}-entry.ts`,compatibility_date:'2026-11-04',workers_dev:false,preview_urls:false,routes:[{pattern:`${site}${prefix}/*`,zone_name:zoneName}],observability:{enabled:false},vars:{SITE_ORIGIN:site,FRONTEND_ORIGIN:site},d1_databases:[{binding:'DB',database_name:name,database_id:databaseId,migrations_dir:'../migrations'}]},null,2)+'\n');
 wrangler(['d1','migrations','apply','DB','--remote','--config',configPath]);
 phase='deploy isolated worker'; workerAttempted=true; wrangler(['deploy','--config',configPath]);
 phase='configure isolated secrets';
 const setupToken=randomBytes(32).toString('base64url');
 const secrets={DATA_ENCRYPTION_KEY:randomBytes(32).toString('base64url'),SETUP_TOKEN_HASH:createHash('sha256').update(setupToken).digest('hex'),SETUP_EXPIRES_AT:new Date(Date.now()+20*60000).toISOString()};
 for(const [key,text] of Object.entries(secrets)) await client.request(`/accounts/${accountId}/workers/scripts/${name}/secrets`,{method:'PUT',body:JSON.stringify({name:key,text,type:'secret_text'})});
 let cookie='';
 async function call(path,method='GET',data,expected=200,extra={}) {
  phase=path;
  // Retry transport failures for reads and repeatable operations in the isolated M2 fixture.
  const retryable=bookingOnly&&(method==='GET'||['/api/admin/mail','/api/admin/preview','/api/admin/invites','/api/invite/requests'].includes(path));
  let response, raw, retried=false;
  for (;;) {
   try {
    response=await fetch(`${site}${prefix}${path}`,{method,headers:{Origin:site,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)}),dispatcher:client.dispatcher,redirect:'error',signal:AbortSignal.timeout(20000)});
    raw=await response.text();
    break;
   } catch(error) {
    if(!retryable||retried)throw error;
    retried=true;
   }
  }
  let value; try {value=JSON.parse(raw);} catch {throw new Error(`${path}: HTTP ${response.status}, non-JSON (possibly runtime failure)`);}
  const passed=response.status===expected||(retried&&path==='/api/invite/requests'&&expected===201&&response.status===200);
  evidence.checks.push({path,method,status:response.status,passed,...(retried?{transportRetried:true}:{})});
  assert.ok(passed,`${path}: expected ${expected}, received ${response.status} ${value.error??''}`);
  return {data:value,response};
 }
 phase='HTTPS and secret-binding readiness';
 let ready=false;
 // Secret updates deploy new versions; a public health response can precede their propagation.
 for(let attempt=0;attempt<12&&!ready;attempt++){try{const response=await fetch(`${site}${prefix}/api/admin/me`,{headers:{Origin:site},dispatcher:client.dispatcher,signal:AbortSignal.timeout(12000)});const value=await response.json();ready=response.status===401&&value.error==='UNAUTHENTICATED';}catch{} if(!ready)await new Promise(resolve=>setTimeout(resolve,2000));}
 if(!ready)throw new Error('isolated authentication bindings not ready');
 assert.equal((await call('/api/admin/status')).data.configured,false);
 if (!bookingOnly) await call('/api/admin/setup/options','POST',{setupToken:'incorrect'},403);
 const setup=(await call('/api/admin/setup/options','POST',{setupToken})).data;
 const authenticator=makeAuthenticator(new URL(site).hostname,site);
 const initialized=await call('/api/admin/setup/verify','POST',{flowId:setup.flowId,response:authenticator.register(setup.options),code:totp(setup.totpSecret,Date.now()-30000),deviceName:'Synthetic desktop',remember:true});
 cookie=initialized.response.headers.get('set-cookie')?.split(';')[0]??''; assert.match(cookie,/^__Host-admin_session=/);
 if (bookingOnly) {
  await probeBooking(call,async()=>{
   phase='seed verified synthetic mailbox';
   assert.equal(database.name,name);
   const id=randomUUID();
   const [seeded]=await client.request(`/accounts/${accountId}/d1/database/${databaseId}/query`,{
    method:'POST',body:JSON.stringify({sql:'INSERT INTO mailboxes(id,address,verified_at) VALUES(?,?,?) RETURNING id',params:[id,mockMail.owner,String(Date.now())]}),
   });
   assert.equal(seeded.success,true);
   assert.deepEqual(seeded.results,[{id}]);
   return id;
  },secrets.DATA_ENCRYPTION_KEY);
 } else {
 const firstCookie=cookie;
 assert.equal((await call('/api/admin/status')).data.configured,true);
 await call('/api/admin/setup/options','POST',{setupToken},403);
 await call('/api/admin/me');
 if (!passwordOnly) {
  const request={label:'Synthetic private note',expiresAt:new Date(Date.now()+86400000).toISOString(),permissions:{modules:['calendar'],modes:['request']}};
  const issued=(await call('/api/admin/invites','POST',request,201)).data;
  const visited=(await call('/api/invite','GET',undefined,200,{Authorization:`Bearer ${issued.token}`})).data;
  assert.deepEqual(visited.permissions,request.permissions); assert.equal(visited.preview,false); assert.ok(!JSON.stringify(visited).includes(request.label));
  const preview=(await call('/api/admin/preview','POST',{inviteId:issued.invite.id},201)).data;
  const previewToken=new URL(preview.url).hash.slice(4);
  assert.equal((await call('/api/invite','GET',undefined,200,{Authorization:`Bearer ${previewToken}`})).data.preview,true);
  assert.equal((await call('/api/admin/invites')).data.invites[0].openCount,1);
  await call(`/api/admin/invites/${issued.invite.id}`,'DELETE',{});
  await call('/api/invite','GET',undefined,404,{Authorization:`Bearer ${issued.token}`});
 }
 const flow=(await call('/api/admin/login/options','POST',{})).data;
 const loginBody={flowId:flow.flowId,response:authenticator.authenticate(flow.options),deviceName:'Synthetic mobile',remember:true};
 const login=await call('/api/admin/login/verify','POST',loginBody);
 cookie=login.response.headers.get('set-cookie')?.split(';')[0]??''; assert.ok(cookie&&cookie!==firstCookie);
 if (!passwordOnly) {
  await call('/api/admin/login/verify','POST',loginBody,401);
  const reauth=(await call('/api/admin/reauth/options','POST',{})).data;
  await call('/api/admin/reauth/verify','POST',{flowId:reauth.flowId,response:authenticator.authenticate(reauth.options)});
  await call('/api/admin/devices');
  const added=makeAuthenticator(new URL(site).hostname,site);
  const register=(await call('/api/admin/passkeys/options','POST',{})).data;
  await call('/api/admin/passkeys/verify','POST',{flowId:register.flowId,response:added.register(register.options),deviceName:'Synthetic second passkey'});
  assert.equal((await call('/api/admin/passkeys')).data.passkeys.length,2);
 }
 const passkeyCookie=cookie;
 const passwordRoute='/api/admin/password';
 const passwordLogin='/api/admin/login/password';
 assert.equal((await call('/api/admin/status')).data.passwordEnabled,false);
 await call(passwordRoute,'POST',{revision:null},401,{Cookie:''});
 const initialPassword=(await call(passwordRoute,'POST',{revision:null})).data;
 assert.match(initialPassword.password,/^[A-Za-z0-9_-]{32}$/);
 assert.deepEqual((await call(passwordRoute)).data,{enabled:true,revision:initialPassword.revision,updatedAt:initialPassword.updatedAt});
 assert.equal((await call('/api/admin/status')).data.passwordEnabled,true);
 await call(passwordLogin,'POST',{password:randomBytes(24).toString('base64url')},401,{Cookie:''});
 const passwordSession=await call(passwordLogin,'POST',{password:initialPassword.password,remember:true},200,{Cookie:''});
 const passwordCookie=passwordSession.response.headers.get('set-cookie')?.split(';')[0]??'';
 assert.match(passwordCookie,/^__Host-admin_session=/);
 cookie=passwordCookie;
 assert.equal((await call('/api/admin/me')).data.session.method,'password');
 assert.ok((await call('/api/admin/devices')).data.devices.some(device=>device.current&&device.method==='password'));
 assert.equal((await call('/api/admin/passkeys/options','POST',{},403)).data.error,'REAUTH_REQUIRED');
 assert.equal((await call(passwordRoute,'DELETE',{revision:initialPassword.revision},403)).data.error,'PASSKEY_LOGIN_REQUIRED');
 const passwordReauth=(await call('/api/admin/reauth/options','POST',{})).data;
 await call('/api/admin/reauth/verify','POST',{flowId:passwordReauth.flowId,response:authenticator.authenticate(passwordReauth.options)});
 cookie=passkeyCookie;
 const rotatedPassword=(await call(passwordRoute,'POST',{revision:initialPassword.revision})).data;
 await call(passwordRoute,'DELETE',{revision:initialPassword.revision},409);
 await call('/api/admin/me','GET',undefined,401,{Cookie:passwordCookie});
 await call(passwordLogin,'POST',{password:initialPassword.password},401,{Cookie:''});
 const rotatedSession=await call(passwordLogin,'POST',{password:rotatedPassword.password},200,{Cookie:''});
 const rotatedCookie=rotatedSession.response.headers.get('set-cookie')?.split(';')[0]??'';
 assert.match(rotatedCookie,/^__Host-admin_session=/);
 await call(passwordRoute,'DELETE',{revision:rotatedPassword.revision});
 await call('/api/admin/me','GET',undefined,401,{Cookie:rotatedCookie});
 await call(passwordLogin,'POST',{password:rotatedPassword.password},401,{Cookie:''});
 assert.equal((await call('/api/admin/me')).data.session.method,'passkey');
 if (!passwordOnly) {
  await call('/api/admin/devices/revoke-others','POST',{});
  await call('/api/admin/me','GET',undefined,401,{Cookie:firstCookie});
  const bad=(await call('/api/admin/login/options','POST',{})).data;
  await call('/api/admin/login/verify','POST',{flowId:bad.flowId,response:authenticator.authenticate(bad.options,{badSignature:true})},401);
 }
 await call('/api/admin/logout','POST',{});
 await call('/api/admin/me','GET',undefined,401);
 }
 evidence.passed=true;
} catch(error) { evidence.passed=false; evidence.phase=phase; evidence.error=error instanceof Error?error.message:'Unknown error'; }
finally {
 if(accountId&&!databaseId) {
  try { const databases=await client.request(`/accounts/${accountId}/d1/database?per_page=100`); databaseId=databases.find(database=>database.name===name)?.uuid; } catch {}
 }
 if(accountId&&workerAttempted) {
  try {const routes=await client.request(`/zones/${zoneId}/workers/routes`);for(const route of routes.filter(item=>item.script===name))await client.request(`/zones/${zoneId}/workers/routes/${route.id}`,{method:'DELETE'});evidence.cleanup.temporaryRouteDeleted=true;}catch{evidence.cleanup.temporaryRouteDeleted=false;}
  try {await client.request(`/accounts/${accountId}/workers/scripts/${name}?force=true`,{method:'DELETE'});evidence.cleanup.workerDeleted=true;}catch{evidence.cleanup.workerDeleted=false;} }
 if(accountId&&databaseId) { try {await client.request(`/accounts/${accountId}/d1/database/${databaseId}`,{method:'DELETE'});evidence.cleanup.databaseDeleted=true;}catch{evidence.cleanup.databaseDeleted=false;} }
 evidence.completedAt=new Date().toISOString();
 await writeFile(`.local/${name}-result.json`,JSON.stringify(evidence,null,2)+'\n');
 await writeFile(bookingOnly?'.local/m2-cloud-probe.json':'.local/m1-cloud-probe.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks.length,error:evidence.error,phase:evidence.phase,cleanup:evidence.cleanup}));
 await client.dispatcher.close();
 if(!evidence.passed||Object.values(evidence.cleanup).some(value=>!value))process.exitCode=1;
}
