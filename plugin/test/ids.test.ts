import { test } from 'node:test';
import assert from 'node:assert/strict';
import { todayLocal } from '../server/src/ids.ts';

test('todayLocal 按 UTC+8 在北京时间午夜切换日期', () => {
  assert.equal(todayLocal(new Date('2026-11-16T15:59:59.999Z')), '2026-11-16');
  assert.equal(todayLocal(new Date('2026-11-16T16:00:00.000Z')), '2026-11-17');
  assert.equal(todayLocal(new Date('2026-11-16T23:59:59.999Z')), '2026-11-17');
  assert.equal(todayLocal(new Date('2026-11-17T00:00:00.000Z')), '2026-11-17');
});

test('todayLocal 在 UTC+8 跨月、跨年及闰日边界保持正确', () => {
  assert.equal(todayLocal(new Date('2026-11-30T16:00:00.000Z')), '2026-12-01');
  assert.equal(todayLocal(new Date('2026-12-31T16:00:00.000Z')), '2027-01-01');
  assert.equal(todayLocal(new Date('2028-02-28T16:00:00.000Z')), '2028-02-29');
  assert.equal(todayLocal(new Date('2028-02-29T16:00:00.000Z')), '2028-03-01');
});
