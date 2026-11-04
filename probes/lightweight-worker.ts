import { verifySyntheticFixture } from './lightweight.js';

type Environment = { PROBE_TOKEN: string; EXPIRES_AT: string; FIXTURE: string };
let calls = 0;

export default {
  async fetch(request: Request, environment: Environment) {
    const mode = new URL(request.url).pathname.slice(1);
    if (!environment.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${environment.PROBE_TOKEN}` || Date.now() >= Number(environment.EXPIRES_AT) || request.method !== 'POST' || !['totp', 'passkey', 'combined'].includes(mode)) {
      return new Response('Not found', { status: 404 });
    }
    calls += 1;
    if (calls > 40) return new Response('Test quota exhausted', { status: 429 });
    const fixture = JSON.parse(environment.FIXTURE);
    const verified = await verifySyntheticFixture(mode as 'totp' | 'passkey' | 'combined', fixture);
    return Response.json({ verified, implementation: mode, scope: 'cryptographic-core-only' }, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  },
};
