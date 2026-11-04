import { argon2id } from '@noble/hashes/argon2.js';

// OWASP 最低建议参数。仅用于性能核验，不接收或处理真实密码。
export const parameters = { m: 19456, t: 2, p: 1, dkLen: 32 };

export function deriveTestHash() {
  return argon2id('M0-public-performance-test', 'M0-public-salt-16bytes', parameters);
}
