import { createCloudflareClient } from './cloudflare-client.mjs';

const { request, dispatcher } = createCloudflareClient();
try {
  const accounts = await request('/accounts?per_page=50');
  if (accounts.length !== 1) throw new Error(`检测到 ${accounts.length} 个账号，需要先选择部署账号`);
  const base = `/accounts/${accounts[0].id}`;
  const report = { loggedIn: true, accountCount: accounts.length };
  try {
    const subdomain = await request(`${base}/workers/subdomain`);
    report.workersSubdomainReady = Boolean(subdomain.subdomain);
  } catch (error) {
    report.workersSubdomainReady = false;
    report.subdomainCheck = error.message;
  }
  try {
    const subscriptions = await request(`${base}/subscriptions`);
    report.workersSubscriptions = subscriptions.filter((item) => /worker/i.test(`${item.rate_plan?.id} ${item.rate_plan?.public_name}`)).map((item) => ({ plan: item.rate_plan?.public_name || item.rate_plan?.id, price: item.price ?? null }));
  } catch (error) {
    report.planCheck = error.message;
  }
  try {
    await request(`${base}/workers/observability/telemetry/query`, {
      method: 'POST',
      body: JSON.stringify({ queryId: 'm0-permission-check', view: 'events', limit: 1, timeframe: { from: Date.now() - 60000, to: Date.now() }, parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$metadata.service', type: 'string', operation: 'eq', value: 'm0-preflight-nonexistent' }] } }),
    });
    report.cpuTelemetryAvailable = true;
  } catch (error) {
    report.cpuTelemetryAvailable = false;
    report.telemetryCheck = error.message;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await dispatcher.close();
}
