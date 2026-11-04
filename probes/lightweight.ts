// M0 密码学探针。固定的虚构消息仅用于测量验签，不实现 WebAuthn 登录、数据库或会话。
const challenge = new TextEncoder().encode('M0-public-synthetic-passkey-benchmark-v1');

type SyntheticFixture = {
  publicJwk: JsonWebKey;
  signature: string;
  step: number;
  secret: string;
  token: string;
};

async function verifyTotp({ step, secret, token }: SyntheticFixture) {
  if (!Number.isSafeInteger(step) || step < 1 || typeof secret !== 'string' || !secret ||
      typeof token !== 'string' || !/^\d{6}$/.test(token)) return false;

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  let matches = false;
  // 三个时间步均执行，测量包含完整的 ±1 容错窗口。
  for (const offset of [-1, 0, 1]) {
    const counter = new DataView(new ArrayBuffer(8));
    counter.setBigUint64(0, BigInt(step) + BigInt(offset));
    const mac = new DataView(await crypto.subtle.sign('HMAC', key, counter));
    const position = mac.getUint8(mac.byteLength - 1) & 15;
    const number = mac.getUint32(position) & 0x7fffffff;
    if (String(number % 1000000).padStart(6, '0') === token) matches = true;
  }
  return matches;
}

async function verifySignature({ publicJwk, signature }: SyntheticFixture) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.d ||
      typeof signature !== 'string') return false;
  const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  if (bytes.length !== 64) return false;
  const key = await crypto.subtle.importKey('jwk', publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, challenge);
}

export async function verifySyntheticFixture(mode: 'totp' | 'passkey' | 'combined', fixture: SyntheticFixture): Promise<boolean> {
  try {
    switch (mode) {
      case 'totp': return await verifyTotp(fixture);
      case 'passkey': return await verifySignature(fixture);
      case 'combined': return await verifySignature(fixture) && await verifyTotp(fixture);
      default: return false;
    }
  } catch {
    return false;
  }
}
