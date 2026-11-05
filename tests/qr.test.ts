import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setupQrSvg } from '../web/src/qr.js';

test('绑定二维码本地输出SVG，不含脚本、外链或密钥文本节点', async () => {
  const seed = 'JBSWY3DPEHPK3PXP'; // Public synthetic fixture, never a real account.
  const uri = `otpauth://totp/${encodeURIComponent('受邀预约:管理员')}?secret=${seed}&issuer=${encodeURIComponent('受邀预约')}&algorithm=SHA1&digits=6&period=30`;
  const svg = await setupQrSvg(uri);
  assert.match(svg, /^<svg\b/);
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path\b/);
  assert.doesNotMatch(svg, /<(script|image|use|foreignObject)\b|(?:href|style)=|otpauth:|JBSWY3DPEHPK3PXP/i);
});

test('二维码拒绝网页地址、非TOTP和畸形设置密钥', async () => {
  for (const uri of [
    'https://example.com/?secret=JBSWY3DPEHPK3PXP',
    'otpauth://hotp/account?secret=JBSWY3DPEHPK3PXP',
    'otpauth://totp/account?secret=short',
    'otpauth://user@totp/account?secret=JBSWY3DPEHPK3PXP',
    'otpauth://totp/account?secret=JBSWY3DPEHPK3PXP#unexpected',
  ]) await assert.rejects(setupQrSvg(uri));
});
