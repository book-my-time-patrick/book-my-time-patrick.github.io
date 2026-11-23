import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rangeRows, resolveDrag, rowAtY } from '../web/src/booking-drag.js';
import type { DragRow } from '../web/src/booking-drag.js';

const all = [30, 60, 90, 120];
const step = 30;
function column(count: number, options: { blocked?: number[]; durations?: Record<number, number[]> } = {}) {
  return Array.from({ length: count }, (_, index): DragRow => ({
    startAt: 1_000_000 + index * step * 60_000,
    selectable: !options.blocked?.includes(index),
    durations: options.durations?.[index] ?? all,
  }));
}

test('向下拖动按经过的行数得到时长', () => {
  const rows = column(12);
  assert.deepEqual(resolveDrag(rows, 2, 2, step, 60, false), { index: 2, duration: 60 }, '尚未移动时等同单击，沿用当前时长');
  assert.deepEqual(resolveDrag(rows, 2, 2, step, 60, true), { index: 2, duration: 30 }, '移动后回到起点行则是精确的一行');
  assert.deepEqual(resolveDrag(rows, 2, 3, step, 60, true), { index: 2, duration: 60 });
  assert.deepEqual(resolveDrag(rows, 2, 4, step, 60, true), { index: 2, duration: 90 });
  assert.deepEqual(resolveDrag(rows, 2, 5, step, 60, true), { index: 2, duration: 120 });
});

test('向上拖动以起点为锚，开始时间上移', () => {
  const rows = column(12);
  assert.deepEqual(resolveDrag(rows, 6, 4, step, 60, true), { index: 4, duration: 90 });
  assert.deepEqual(resolveDrag(rows, 6, 3, step, 60, true), { index: 3, duration: 120 });
});

test('超过最长时长时回缩到允许的最长范围', () => {
  const rows = column(12);
  assert.deepEqual(resolveDrag(rows, 1, 9, step, 60, true), { index: 1, duration: 120 });
  assert.deepEqual(resolveDrag(rows, 9, 0, step, 60, true), { index: 6, duration: 120 });
});

test('遇到不可选的行就在它之前停下', () => {
  const rows = column(12, { blocked: [4] });
  assert.deepEqual(resolveDrag(rows, 2, 6, step, 60, true), { index: 2, duration: 60 });
  assert.deepEqual(resolveDrag(rows, 6, 2, step, 60, true), { index: 5, duration: 60 });
  assert.equal(resolveDrag(rows, 4, 5, step, 60, true), undefined, '锚点本身不可选就不能开始');
});

test('起点自己允许的时长为准，不允许的长度会缩短', () => {
  const rows = column(12, { durations: { 2: [30, 60, 120] } });
  assert.deepEqual(resolveDrag(rows, 2, 4, step, 60, true), { index: 2, duration: 60 }, '三行 90 分钟不被允许，缩到 60');
  assert.deepEqual(resolveDrag(rows, 2, 5, step, 60, true), { index: 2, duration: 120 });
});

test('15 分钟网格下最短时长大于一行时，单行落回首选或最短时长', () => {
  const rows = Array.from({ length: 16 }, (_, index): DragRow => ({ startAt: index * 900_000, selectable: true, durations: [30, 60] }));
  assert.deepEqual(resolveDrag(rows, 3, 3, 15, 60, true), { index: 3, duration: 60 });
  assert.deepEqual(resolveDrag(rows, 3, 3, 15, 90, true), { index: 3, duration: 30 }, '首选不被允许时用最短');
  assert.deepEqual(resolveDrag(rows, 3, 4, 15, 60, true), { index: 3, duration: 30 });
  assert.deepEqual(resolveDrag(rows, 3, 6, 15, 60, true), { index: 3, duration: 60 });
});

test('没有任何允许时长时不产生范围', () => {
  assert.equal(resolveDrag(column(4, { durations: { 1: [] } }), 1, 3, step, 60, true), undefined);
});

test('rangeRows 与 rowAtY', () => {
  assert.deepEqual(rangeRows({ index: 3, duration: 90 }, 30), [3, 4, 5]);
  assert.deepEqual(rangeRows({ index: 3, duration: 15 }, 30), [3]);
  const tops = [0, 20, 40, 60], bottoms = [20, 40, 60, 80];
  assert.equal(rowAtY(tops, bottoms, -10), 0);
  assert.equal(rowAtY(tops, bottoms, 25), 1);
  assert.equal(rowAtY(tops, bottoms, 79), 3);
  assert.equal(rowAtY(tops, bottoms, 500), 3);
  assert.equal(rowAtY([0, 22], [20, 42], 21), 1, '行间空隙取更近的行');
  assert.equal(rowAtY([], [], 5), -1);
});
