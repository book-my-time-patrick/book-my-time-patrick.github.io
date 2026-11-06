import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inviteStatus } from '../web/src/invite-status.js';

test('邀请列表可在警告时间和到期时间原地更新状态', () => {
  const expires = Date.parse('2026-11-07T17:00:00+08:00');
  const warning = Date.parse('2026-11-04T17:00:00+08:00');
  assert.deepEqual(inviteStatus(expires, false, warning - 1), { state: 'active', nextAt: warning });
  assert.deepEqual(inviteStatus(expires, false, warning), { state: 'expiring', nextAt: expires });
  assert.deepEqual(inviteStatus(expires, false, expires - 1), { state: 'expiring', nextAt: expires });
  assert.deepEqual(inviteStatus(expires, false, expires), { state: 'expired', nextAt: null });
});

test('已撤销优先于到期状态，无法解析的有效期不显示有效', () => {
  const now = Date.parse('2026-11-07T17:00:00+08:00');
  assert.deepEqual(inviteStatus(now - 1, true, now), { state: 'revoked', nextAt: null });
  assert.deepEqual(inviteStatus(NaN, false, now), { state: 'expired', nextAt: null });
});
