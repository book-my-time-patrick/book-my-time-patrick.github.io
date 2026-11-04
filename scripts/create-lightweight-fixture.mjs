import { webcrypto } from 'node:crypto';

// 公开的 RFC 4226 示例密钥，仅用于 M0 探针。
const secret = '12345678901234567890';
const challenge = new TextEncoder().encode('M0-public-synthetic-passkey-benchmark-v1');

export async function createFixture() {
  const { subtle } = webcrypto;
  const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const signature = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, challenge);
  const publicJwk = await subtle.exportKey('jwk', keys.publicKey);

  // 固定在生成时的时间步，后续重复测试不受网络延迟和 30 秒边界影响。
  const step = Math.floor(Date.now() / 30000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmacKey = await subtle.importKey('raw', Buffer.from(secret, 'ascii'),
    { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = Buffer.from(await subtle.sign('HMAC', hmacKey, counter));
  const position = mac[mac.length - 1] & 15;
  const token = String((mac.readUInt32BE(position) & 0x7fffffff) % 1000000).padStart(6, '0');

  return { publicJwk, signature: Buffer.from(signature).toString('base64'), step, secret, token };
}
