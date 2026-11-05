import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionExpiry } from '../server/session-policy.js';

test('记住设备持续六个自然月，月底和闰年不会意外延长到下一月', () => {
  for (const [start, expected] of [
    ['2026-11-05T09:20:30.456Z', '2027-05-05T09:20:30.456Z'],
    ['2026-08-31T23:59:59.000Z', '2027-02-28T23:59:59.000Z'],
    ['2027-08-31T09:20:30.456Z', '2028-02-29T09:20:30.456Z'],
    ['2026-10-31T09:20:30.456Z', '2027-04-30T09:20:30.456Z'],
  ]) assert.equal(new Date(sessionExpiry(Date.parse(start), true)).toISOString(), expected);
});

test('不记住设备仍只提供十二小时会话', () => {
  assert.equal(new Date(sessionExpiry(Date.parse('2026-12-31T23:00:00Z'), false)).toISOString(), '2027-01-01T11:00:00.000Z');
});
