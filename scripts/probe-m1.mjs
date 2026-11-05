import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fetch } from 'undici';
import { createCloudflareClient } from './cloudflare-client.mjs';
import { makeAuthenticator, totp } from '../tests/webauthn-fixture.ts';

// Isolated synthetic owner only. Never use the production Worker or database.
const client=createCloudflareClient();
const nonce=randomBytes(6).toString('hex'),name=`invited-m1-probe-${nonce}`;
const configPath=`.local/${name}.jsonc`;
const evidence={name,startedAt:new Date().toISOString(),syntheticOnly:true,realDeviceVerified:false,exactCloudCpuVerified:false,checks:[],cleanup:{}};
let accountId,databaseId,zoneId,workerAttempted=false;
let phase='account';
function wrangler(args) {
 try { return execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'}}); }
 catch { throw new Error('隔离探针 Wrangler 操作失败（原始输出不打印）'); }
}
try {
 await mkdir('.local',{recursive:true});
 const accounts=await client.request('/accounts?per_page=50'); assert.equal(accounts.length,1); accountId=accounts[0].id;
 const primary=JSON.parse(await readFile('.local/wrangler.production.jsonc','utf8'));
 const zoneName=new URL(primary.vars.SITE_ORIGIN).hostname;
 const apiHost=primary.routes.find(route=>route.pattern!==zoneName)?.pattern;
 if(!apiHost||!apiHost.endsWith(`.${zoneName}`))throw new Error('Existing API domain not configured');
 const site=`https://${apiHost}`, prefix=`/__m1_probe_${nonce}`;
 const [zone]=await client.request(`/zones?name=${zoneName}&per_page=50`);zoneId=zone.id;
 const entryPath=`.local/${name}-entry.ts`;
 await writeFile(entryPath,`import {createApi} from '../server/app.js';\nimport type {Environment} from '../server/db.js';\nconst app=createApi();\nexport default {fetch(request:Request,env:Environment){const url=new URL(request.url);if(!url.pathname.startsWith('${prefix}/'))return new Response(null,{status:404});url.pathname=url.pathname.slice(${prefix.length});return app.fetch(new Request(url,request),env);}};\n`);
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
  const response=await fetch(`${site}${prefix}${path}`,{method,headers:{Origin:site,...(cookie?{Cookie:cookie}:{}),...(data===undefined?{}:{'Content-Type':'application/json'}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)}),dispatcher:client.dispatcher,redirect:'error',signal:AbortSignal.timeout(20000)});
  const raw=await response.text(); let value; try {value=JSON.parse(raw);} catch {throw new Error(`${path}: HTTP ${response.status}, non-JSON (possibly runtime failure)`);}
  evidence.checks.push({path,method,status:response.status,passed:response.status===expected});
  assert.equal(response.status,expected,`${path}: ${response.status} ${value.error??''}`);
  return {data:value,response};
 }
 phase='HTTPS and secret-binding readiness';
 let ready=false;
 // Secret updates deploy new versions; a public health response can precede their propagation.
 for(let attempt=0;attempt<12&&!ready;attempt++){try{const response=await fetch(`${site}${prefix}/api/admin/me`,{headers:{Origin:site},dispatcher:client.dispatcher,signal:AbortSignal.timeout(12000)});const value=await response.json();ready=response.status===401&&value.error==='UNAUTHENTICATED';}catch{} if(!ready)await new Promise(resolve=>setTimeout(resolve,2000));}
 if(!ready)throw new Error('isolated authentication bindings not ready');
 assert.equal((await call('/api/admin/status')).data.configured,false);
 await call('/api/admin/setup/options','POST',{setupToken:'incorrect'},403);
 const setup=(await call('/api/admin/setup/options','POST',{setupToken})).data;
 const authenticator=makeAuthenticator(new URL(site).hostname,site);
 const initialized=await call('/api/admin/setup/verify','POST',{flowId:setup.flowId,response:authenticator.register(setup.options),code:totp(setup.totpSecret,Date.now()-30000),deviceName:'Synthetic desktop',remember:true});
 cookie=initialized.response.headers.get('set-cookie')?.split(';')[0]??''; assert.match(cookie,/^__Host-admin_session=/);
 const firstCookie=cookie;
 assert.equal((await call('/api/admin/status')).data.configured,true);
 await call('/api/admin/setup/options','POST',{setupToken},403);
 await call('/api/admin/me');
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
 const flow=(await call('/api/admin/login/options','POST',{})).data;
 const loginBody={flowId:flow.flowId,response:authenticator.authenticate(flow.options),deviceName:'Synthetic mobile',remember:true};
 const login=await call('/api/admin/login/verify','POST',loginBody);
 cookie=login.response.headers.get('set-cookie')?.split(';')[0]??''; assert.ok(cookie&&cookie!==firstCookie);
 await call('/api/admin/login/verify','POST',loginBody,401);
 const reauth=(await call('/api/admin/reauth/options','POST',{})).data;
 await call('/api/admin/reauth/verify','POST',{flowId:reauth.flowId,response:authenticator.authenticate(reauth.options)});
 await call('/api/admin/devices');
 const added=makeAuthenticator(new URL(site).hostname,site);
 const register=(await call('/api/admin/passkeys/options','POST',{})).data;
 await call('/api/admin/passkeys/verify','POST',{flowId:register.flowId,response:added.register(register.options),deviceName:'Synthetic second passkey'});
 assert.equal((await call('/api/admin/passkeys')).data.passkeys.length,2);
 await call('/api/admin/devices/revoke-others','POST',{});
 await call('/api/admin/me','GET',undefined,401,{Cookie:firstCookie});
 const bad=(await call('/api/admin/login/options','POST',{})).data;
 await call('/api/admin/login/verify','POST',{flowId:bad.flowId,response:authenticator.authenticate(bad.options,{badSignature:true})},401);
 await call('/api/admin/logout','POST',{});
 await call('/api/admin/me','GET',undefined,401);
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
 await writeFile('.local/m1-cloud-probe.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks.length,error:evidence.error,phase:evidence.phase,cleanup:evidence.cleanup}));
 await client.dispatcher.close();
 if(!evidence.passed||Object.values(evidence.cleanup).some(value=>!value))process.exitCode=1;
}
