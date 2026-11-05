import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createCloudflareClient } from './cloudflare-client.mjs';

const local = process.argv.includes('--local');
const refresh = process.argv.includes('--refresh-setup');
const prefix = local ? 'm1-local' : 'm1';
const secretsPath = `.local/${prefix}-secrets.json`;
const safeEnv = {...process.env, WRANGLER_WRITE_LOGS:'false',WRANGLER_SEND_METRICS:'false'};
function wrangler(args) {
  try { return execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{env:safeEnv,encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
  catch { throw new Error('Wrangler 操作失败。请核对官方登录、D1 权限与数据库配置；不会输出工具日志或密钥。'); }
}
async function secureWrite(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary,value,{mode:0o600}); await chmod(temporary,0o600); await rename(temporary,path);
}
async function loadSecrets() { try { return JSON.parse(await readFile(secretsPath,'utf8')); } catch(error) { if(error.code==='ENOENT') return null; throw new Error('本机密钥文件无法读取，禁止自动替换加密密钥'); } }
function newSecrets() { return {DATA_ENCRYPTION_KEY:randomBytes(32).toString('base64url')}; }
function initializeSetup(secrets) {
  const token=randomBytes(32).toString('base64url');
  secrets.SETUP_TOKEN_HASH=createHash('sha256').update(token).digest('hex');
  secrets.SETUP_EXPIRES_AT=new Date(Date.now()+24*3600000).toISOString();
  return token;
}

await mkdir('.local',{recursive:true});
let client;
try {
 let config, accountId, database, existingSecrets=[];
 let secrets=await loadSecrets();
 if (!local) {
  config=JSON.parse(await readFile('.local/wrangler.production.jsonc','utf8'));
  if(!config.vars?.SITE_ORIGIN || !config.assets || !config.routes?.some(r=>r.pattern===new URL(config.vars.SITE_ORIGIN).hostname)) throw new Error('请先生成含主站地址的三参数生产配置');
  client=createCloudflareClient();
  const accounts=await client.request('/accounts?per_page=50');
  if(accounts.length!==1) throw new Error('Cloudflare 账号不唯一，需明确账号后再配置');
  accountId=accounts[0].id;
  existingSecrets=await client.request(`/accounts/${accountId}/workers/scripts/${config.name}/secrets`);
  if(!secrets && existingSecrets.some(s=>s.name==='DATA_ENCRYPTION_KEY')) throw new Error('线上已有加密密钥，请恢复本机备份；禁止自动替换以免无法解密');
  const databases=await client.request(`/accounts/${accountId}/d1/database?per_page=100`);
  database=databases.find(db=>db.name==='invited-booking');
  if(!database) database=await client.request(`/accounts/${accountId}/d1/database`,{method:'POST',body:JSON.stringify({name:'invited-booking',primary_location_hint:'apac'})});
  config.d1_databases=[{binding:'DB',database_name:'invited-booking',database_id:database.uuid,migrations_dir:'../migrations'}];
  await writeFile('.local/wrangler.production.jsonc',JSON.stringify(config,null,2)+'\n');
 }
 secrets ||= newSecrets();
 let setupToken;
 if(!secrets.SETUP_TOKEN_HASH || refresh) setupToken=initializeSetup(secrets);
 await secureWrite(secretsPath,JSON.stringify(secrets,null,2)+'\n');
 if(setupToken) {
  const adminUrl=local?'http://127.0.0.1:5173/#/admin':`${config.vars.SITE_ORIGIN}/#/admin`;
  await secureWrite(`.local/${prefix}-首次初始化.txt`, `后台地址：${adminUrl}\n\n首次初始化码（请在后台页面单独输入）：\n${setupToken}\n\n有效期至：${secrets.SETUP_EXPIRES_AT}\n只用于首次绑定通行密钥与动态验证码，成功后永久失效。不要转发本文件。\n`);
 }
 const envText=Object.entries(secrets).map(([key,value])=>`${key}=${value}`).join('\n')+'\n';
 if(local) {
  await secureWrite('.dev.vars',envText);
  await secureWrite('.local/node-secrets.env',envText);
  wrangler(['d1','migrations','apply','DB','--local','--config','wrangler.local.jsonc','--persist-to','.local/worker-state']);
 } else {
  wrangler(['d1','migrations','apply','DB','--remote','--config','.local/wrangler.production.jsonc']);
  for(const [name,text] of Object.entries(secrets)) {
   if(name==='DATA_ENCRYPTION_KEY' && existingSecrets.some(secret=>secret.name===name)) continue;
   await client.request(`/accounts/${accountId}/workers/scripts/${config.name}/secrets`,{method:'PUT',body:JSON.stringify({name,text,type:'secret_text'})});
  }
 }
 console.log(local?'本机数据库与密钥已准备。':'线上 D1、迁移与服务端密钥已准备，保持 Cloudflare 免费套餐。');
 console.log(setupToken?`首次初始化码仅保存在 .local/${prefix}-首次初始化.txt（当前用户可读），不会打印。`:'已保留现有密钥与初始化码；如需重新签发未启用的初始化码，加 --refresh-setup。');
 if(!local)console.log('接下来运行 npm run deploy:site。首次注册必须由你在浏览器亲自完成，工具不会代建管理员。');
} catch(error) {
 console.error(error instanceof Error?error.message:'初始化准备失败'); process.exitCode=1;
} finally { await client?.dispatcher.close(); }
