import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { argon2id } from '@noble/hashes/argon2.js';
import { fetch } from 'undici';
import { createCloudflareClient } from './cloudflare-client.mjs';
import { createFixture } from './create-lightweight-fixture.mjs';

const dryRun = process.argv.includes('--dry-run');
const local = process.argv.includes('--local');
const lightweight = process.argv.includes('--lightweight');
const implementations = lightweight ? ['totp', 'passkey', 'combined'] : ['js', 'wasm'];
const workerName = `booking-cpu-probe-${randomBytes(5).toString('hex')}`;
const directory = `.local/cloud-probes/${workerName}`;
const configPath = `${directory}/wrangler.jsonc`;
const secretPath = `${directory}/secrets.json`;
const parameters = { m: 19456, t: 2, p: 1, dkLen: 32 };
const expected = Buffer.from(argon2id('M0-public-performance-test', 'M0-public-salt-16bytes', parameters)).toString('hex');
const fixture = lightweight ? await createFixture() : undefined;
const probeToken = randomBytes(32).toString('hex');
const childEnvironment = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false' };
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
const report = { checkedAt: new Date().toISOString(), workerName, parameters, requests: [], cloudCpuVerified: false, workerDeleted: false };
report.scope = lightweight ? 'cryptographic-core-only' : 'argon2id-derivation';
const reportPath = lightweight ? '.local/cloud-lightweight-probe.json' : '.local/cloud-auth-probe.json';
let cloud;
let accountBase;
let uploaded = false;

function runWrangler(args) {
  try {
    return execFileSync(process.execPath, [wrangler, ...args], {
      env: childEnvironment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    });
  } catch (error) {
    // 子进程输出可能带绑定配置，不直接打印。
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    const codes = [...output.matchAll(/\[code:\s*(\d+)\]/g)].map((match) => match[1]);
    throw new Error(`Wrangler ${args[0]} 失败${codes.length ? ` (${codes.join(',')})` : ''}，请核实账号初始化与部署权限`);
  }
}

try {
  let subdomain;
  if (!dryRun && !local) {
    cloud = createCloudflareClient();
    const accounts = await cloud.request('/accounts?per_page=50');
    if (accounts.length !== 1) throw new Error('需要先指定唯一 Cloudflare 部署账号');
    accountBase = `/accounts/${accounts[0].id}`;
    try {
      subdomain = (await cloud.request(`${accountBase}/workers/subdomain`)).subdomain;
    } catch {
      throw new Error('账号尚未启用 Workers 或尚未设置 workers.dev 默认子域名，请先在控制台完成免费服务初始化');
    }
  }

  await mkdir(directory, { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    name: workerName,
    main: lightweight ? '../../../probes/lightweight-worker.ts' : '../../../probes/cloud-worker.ts',
    compatibility_date: '2026-11-04',
    workers_dev: !dryRun && !local,
    preview_urls: false,
    observability: { enabled: !dryRun && !local, head_sampling_rate: 1, logs: { enabled: !dryRun && !local, invocation_logs: true } },
    vars: { EXPIRES_AT: String(Date.now() + 20 * 60 * 1000), ...(lightweight ? { FIXTURE: JSON.stringify(fixture) } : { EXPECTED_HASH: expected }) },
  }, null, 2)}\n`);
  await writeFile(secretPath, JSON.stringify({ PROBE_TOKEN: probeToken }), { mode: 0o600 });

  if (dryRun) {
    runWrangler(['deploy', '--config', configPath, '--dry-run', '--outdir', `${directory}/build`]);
    console.log('云端探针的本机构建已通过。未部署。');
  } else if (local) {
    // .dev.vars 与生成配置放在同一目录，Wrangler 仅用于本机验证。
    const localVariables = `${directory}/.dev.vars`;
    await writeFile(localVariables, `PROBE_TOKEN=${probeToken}\n`, { mode: 0o600 });
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [wrangler, 'dev', '--config', configPath, '--local', '--ip', '127.0.0.1', '--port', '8789'], { env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
    let startupLog = '';
    child.stdout.on('data', (data) => { startupLog = (startupLog + data.toString()).slice(-6000); });
    child.stderr.on('data', (data) => { startupLog = (startupLog + data.toString()).slice(-6000); });
    try {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          await fetch('http://127.0.0.1:8789/', { signal: AbortSignal.timeout(1000) });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      for (const implementation of implementations) {
        const response = await fetch(`http://127.0.0.1:8789/${implementation}`, { method: 'POST', headers: { Authorization: `Bearer ${probeToken}` } });
        const result = await response.json();
        if (!response.ok || result.verified !== true) throw new Error(`${implementation} 的本机 Worker 哈希结果校对失败`);
        console.log(`${implementation} 已在本地 workerd 与合成结果校对通过`);
      }
    } catch (error) {
      console.error(startupLog.replaceAll(probeToken, '[REDACTED]'));
      throw error;
    } finally {
      child.kill('SIGTERM');
      await unlink(localVariables).catch(() => {});
    }
  } else {
    console.log(`开始部署限时探针，调用 ${implementations.length * 12} 次固定虚构输入，然后删除本次探针。`);
    // 先标记，部署部分失败时也尝试清理此次唯一命名的 Worker。
    uploaded = true;
    await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    runWrangler(['deploy', '--config', configPath, '--secrets-file', secretPath, '--message', 'Temporary M0 Argon2id CPU verification']);
    const baseUrl = `https://${workerName}.${subdomain}.workers.dev`;
    report.probeUrl = baseUrl;
    // 新账号首次部署后，默认子域名的 DNS / TLS 可能尚未就绪。
    let ready = false;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const response = await fetch(baseUrl, { dispatcher: cloud.dispatcher, redirect: 'error', signal: AbortSignal.timeout(12000) });
        await response.body?.cancel();
        if (response.status === 404) {
          ready = true;
          break;
        }
      } catch (error) {
        report.connectionError = error.cause?.code || error.code || 'FETCH_FAILED';
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    if (!ready) throw new Error('临时 workers.dev 探针地址尚不可达，未开始算法测试');
    const startedAt = Date.now();
    for (const implementation of implementations) {
      for (let index = 0; index < 12; index += 1) {
        const response = await fetch(`${baseUrl}/${implementation}`, {
          method: 'POST', dispatcher: cloud.dispatcher, redirect: 'error',
          headers: { Authorization: `Bearer ${probeToken}` }, signal: AbortSignal.timeout(20000),
        });
        const body = await response.text();
        let verified = false;
        try { verified = JSON.parse(body).verified === true; } catch { /* 平台超限可能返回文本。 */ }
        const errorCode = body.match(/\b(110[0-9])\b/)?.[1];
        report.requests.push({ implementation, status: response.status, verified, platformErrorCode: errorCode, exceededCpu: errorCode === '1102' || /exceeded.*cpu|CPU time limit/i.test(body), ray: response.headers.get('cf-ray') });
        console.log(`${implementation} ${index + 1}/12 · HTTP ${response.status} · 校验${verified ? '通过' : '未通过'}`);
      }
    }

    try {
      const result = await cloud.request(`${accountBase}/workers/observability/telemetry/query`, {
        method: 'POST',
        body: JSON.stringify({ queryId: 'm0-argon-cpu', view: 'events', limit: 100, timeframe: { from: startedAt - 1000, to: Date.now() }, parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$metadata.service', type: 'string', operation: 'eq', value: workerName }] } }),
      });
      const events = result.events?.events || [];
      report.cpuSamples = [];
      for (const event of events) {
        const source = event.source || event;
        const requestId = source.$workers?.requestId || source.$metadata?.requestId;
        const matched = report.requests.find((request) => request.ray?.split('-')[0] === requestId);
        if (!matched || !Number.isFinite(source.$workers?.cpuTimeMs)) continue;
        report.cpuSamples.push({ implementation: matched.implementation, requestId, cpuTimeMs: source.$workers.cpuTimeMs, outcome: source.$workers.outcome });
      }
      const measured = new Set(report.cpuSamples.map((sample) => sample.requestId));
      report.cloudCpuVerified = report.requests.every((request) => request.ray && measured.has(request.ray.split('-')[0]));
    } catch (error) {
      report.telemetryStatus = error.message;
    }
  }
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
} finally {
  if (uploaded && cloud && accountBase) {
    try {
      await cloud.request(`${accountBase}/workers/scripts/${workerName}`, { method: 'DELETE' });
      report.workerDeleted = true;
    } catch (error) {
      report.cleanupError = error.message;
      process.exitCode = 1;
    }
  }
  await unlink(secretPath).catch(() => {});
  await unlink(configPath).catch(() => {});
  if (cloud) await cloud.dispatcher.close();
  if (!dryRun && !local) {
    await mkdir(directory, { recursive: true });
    report.cpuLimitObserved = report.requests.some((request) => request.exceededCpu);
    report.checks = implementations.map((implementation) => ({
      implementation,
      passed: report.requests.filter((request) => request.implementation === implementation && request.verified).length,
      attempted: report.requests.filter((request) => request.implementation === implementation).length,
      cpuLimitErrors: report.requests.filter((request) => request.implementation === implementation && request.exceededCpu).length,
    }));
    report.coreChecksPassed = !report.error && report.requests.length === implementations.length * 12 && report.requests.every((request) => request.verified);
    if (!report.coreChecksPassed) process.exitCode = process.exitCode || 2;
    await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ workerName, scope: report.scope, checks: report.checks, coreChecksPassed: report.coreChecksPassed, cpuDurationMeasured: report.cloudCpuVerified, workerDeleted: report.workerDeleted, error: report.error, cleanupError: report.cleanupError }, null, 2));
  } else if (report.error) {
    console.error(report.error);
  }
}
