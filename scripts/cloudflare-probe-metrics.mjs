import { readFile, writeFile } from 'node:fs/promises';
import { createCloudflareClient } from './cloudflare-client.mjs';

const reportPath = '.local/cloud-auth-probe.json';
const report = JSON.parse(await readFile(reportPath, 'utf8'));
if (!/^booking-cpu-probe-[a-f0-9]+$/.test(report.workerName)) throw new Error('本机记录不属于当前性能探针');
const { request, dispatcher } = createCloudflareClient();
try {
  const accounts = await request('/accounts?per_page=50');
  if (accounts.length !== 1) throw new Error('需要唯一的部署账号');
  const start = new Date(Date.parse(report.checkedAt) - 60000).toISOString();
  const end = new Date().toISOString();
  const query = `query { viewer { accounts(filter: {accountTag: ${JSON.stringify(accounts[0].id)}}) { workersInvocationsAdaptive(limit: 1000, filter: {scriptName: ${JSON.stringify(report.workerName)}, datetime_geq: ${JSON.stringify(start)}, datetime_leq: ${JSON.stringify(end)}}) { sum { requests errors } quantiles { cpuTimeP50 cpuTimeP99 } dimensions { datetime status } } } } metricSchema: __type(name: "AccountWorkersInvocationsAdaptiveQuantiles") { fields { name description } } }`;
  const data = await request('/graphql', { method: 'POST', body: JSON.stringify({ query }) });
  report.platformMetrics = data.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
  report.cpuMetricDefinitions = data.metricSchema?.fields?.filter((field) => ['cpuTimeP50', 'cpuTimeP99'].includes(field.name)) || [];
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ metrics: report.platformMetrics, definitions: report.cpuMetricDefinitions }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await dispatcher.close();
}
