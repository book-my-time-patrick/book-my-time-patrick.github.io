import { deriveTestHash, parameters } from './argon2.js';

export default {
  fetch(request: Request, environment: { LOCAL_PROBE?: string }) {
    const url = new URL(request.url);
    if (environment.LOCAL_PROBE !== 'true' || url.hostname !== '127.0.0.1' || url.pathname !== '/probe' || request.method !== 'POST') {
      return new Response('Not found', { status: 404 });
    }
    const hash = deriveTestHash();
    return Response.json({ ok: hash.length === 32, parameters, runtime: 'local-workerd', cloudCpuVerified: false }, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  },
};
