/**
 * 收盘价写入时机回归：盘中（含午休）不得把当日未收盘 bar 当 CLOSE_PRICE 落库。
 *
 * 背景：K 线接口盘中会把当天那根未完成 bar 一起返回，收盘价字段此时等于最新价。
 * 原实现直接入库，导致同一天既有 REALTIME_PRICE 又有一条"假收盘"，
 * 且午休 / 早盘的快照会被当成当日收盘参与历史序列。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropUnsettledClose } from '../server/src/services/refresh.ts';
import type { MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-16';

function point(tradingDate: string, priceType: MarketPoint['priceType'], value: string): MarketPoint {
  return {
    instrumentId: 'ins', priceType, value, currency: 'CNY',
    tradingDate, observedAt: `${tradingDate}T03:00:00Z`, provider: 'stub', quality: 'FRESH',
  };
}

test('盘中：当日 CLOSE 被丢弃，历史收盘与实时价保留', () => {
  const points = [
    point('2026-11-13', 'CLOSE_PRICE', '4016.29'),
    point(TODAY, 'CLOSE_PRICE', '3993.51'),
    point(TODAY, 'REALTIME_PRICE', '3993.51'),
  ];
  const kept = dropUnsettledClose(points, TODAY, false);
  assert.deepEqual(kept.map((p) => `${p.tradingDate}:${p.priceType}`), [
    '2026-11-13:CLOSE_PRICE',
    `${TODAY}:REALTIME_PRICE`,
  ], '当日未收盘 bar 不能当收盘价，实时价照常保留');
});

test('收盘后：原样返回，不误删当日真实收盘价', () => {
  const points = [
    point('2026-11-13', 'CLOSE_PRICE', '4016.29'),
    point(TODAY, 'CLOSE_PRICE', '3993.51'),
  ];
  assert.equal(dropUnsettledClose(points, TODAY, true).length, 2);
});

test('非当日的历史收盘价不受影响（跨日刷新）', () => {
  const points = [point('2026-11-14', 'CLOSE_PRICE', '4001.00')];
  assert.equal(dropUnsettledClose(points, TODAY, false).length, 1, '过滤只针对当日');
});
