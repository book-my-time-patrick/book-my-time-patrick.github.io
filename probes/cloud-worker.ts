import setupWasm from 'argon2id/lib/setup.js';
import simdModule from 'argon2id/dist/simd.wasm';
import scalarModule from 'argon2id/dist/no-simd.wasm';
import { deriveTestHash, parameters } from './argon2.js';

type ProbeEnvironment = { PROBE_TOKEN: string; EXPIRES_AT: string; EXPECTED_HASH: string };
let wasm: ReturnType<typeof setupWasm> | undefined;
let calls = 0;

function initializeWasm() {
  wasm ??= setupWasm(
    async (imports) => ({ module: simdModule, instance: await WebAssembly.instantiate(simdModule, imports) }),
    async (imports) => ({ module: scalarModule, instance: await WebAssembly.instantiate(scalarModule, imports) }),
  );
  return wasm;
}

export default {
  async fetch(request: Request, environment: ProbeEnvironment) {
    const path = new URL(request.url).pathname;
    if (!environment.PROBE_TOKEN || request.headers.get('Authorization') !== `Bearer ${environment.PROBE_TOKEN}` || Date.now() >= Number(environment.EXPIRES_AT) || request.method !== 'POST' || !['/js', '/wasm'].includes(path)) {
      return new Response('Not found', { status: 404 });
    }
    calls += 1;
    if (calls > 40) return new Response('Test quota exhausted', { status: 429 });
    let hash: Uint8Array;
    if (path === '/js') {
      hash = deriveTestHash();
    } else {
      const derive = await initializeWasm();
      hash = derive({
        password: new TextEncoder().encode('M0-public-performance-test'),
        salt: new TextEncoder().encode('M0-public-salt-16bytes'),
        memorySize: parameters.m,
        passes: parameters.t,
        parallelism: parameters.p,
        tagLength: parameters.dkLen,
      });
    }
    const hex = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    return Response.json({ verified: hex === environment.EXPECTED_HASH, implementation: path.slice(1), parameters }, {
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
    });
  },
};
