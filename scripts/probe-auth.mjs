import { argon2id } from '@noble/hashes/argon2.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';

const parameters = { m: 19456, t: 2, p: 1, dkLen: 32 };
const samples = [];
for (let index = 0; index < 5; index += 1) {
  const start = process.cpuUsage();
  const wallStart = performance.now();
  const hash = argon2id('M0-public-performance-test', 'M0-public-salt-16bytes', parameters);
  const usage = process.cpuUsage(start);
  if (hash.length !== 32) throw new Error('Argon2id 计算失败');
  samples.push({ cpuMs: (usage.user + usage.system) / 1000, wallMs: performance.now() - wallStart });
}

const median = [...samples].sort((first, second) => first.cpuMs - second.cpuMs)[2].cpuMs;
const report = {
  checkedAt: new Date().toISOString(),
  runtime: process.version,
  implementation: '@noble/hashes (JavaScript)',
  cpu: cpus()[0]?.model,
  parameters,
  samples,
  medianCpuMs: median,
  workersFreeCpuBudgetMs: 10,
  cloudCpuVerified: false,
  decision: median > 10 ? 'LOCAL_IMPLEMENTATION_EXCEEDS_FREE_BUDGET' : 'REQUIRES_CLOUD_VERIFICATION',
  note: '本机 Node CPU 样本不代表 Cloudflare CPU 计费。其他优化实现需单独核验，不能据本结果宣称所有 Argon2id 实现均不可用。',
};
await mkdir('.local', { recursive: true });
await writeFile('.local/auth-probe.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(`Argon2id ${parameters.m / 1024} MiB，${parameters.t} 次迭代，5 次样本`);
console.log(`本机 CPU 中位数 ${median.toFixed(1)} ms，Workers Free 标称预算 10 ms`);
console.log(report.note);
console.log('结果已保存到 .local/auth-probe.json');
