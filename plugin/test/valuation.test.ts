import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annualVolatility,
  dailyReturns,
  maxDrawdown,
  mean,
  percentile,
  periodReturn,
  sharpeRatio,
  stdev,
  xirr,
} from '../core/src/valuation.ts';

test('percentile：经验分位（PRD §4.6.6）', () => {
  const series = [10, 20, 30, 40, 50];
  assert.equal(percentile(series, 30), 60); // ≤30 的有 3/5
  assert.equal(percentile(series, 5), 0);
  assert.equal(percentile(series, 100), 100);
  assert.equal(percentile([], 1), null);
  assert.equal(percentile([Number.NaN, 1, 2], 1), 50); // NaN 被剔除：1/2
});

test('dailyReturns / mean / stdev', () => {
  const rets = dailyReturns([100, 101, 99.99, 100.9899]);
  assert.equal(rets.length, 3);
  assert.ok(Math.abs(mean(rets) - 0.0033) < 5e-4);
  assert.equal(stdev([1]), null);
  assert.equal(stdev([1, 1, 1]), 0);
  assert.ok(stdev([1, 2, 3]) !== null);
});

test('sharpeRatio：样本不足 / 零波动 → null，不伪造', () => {
  assert.equal(sharpeRatio([0.001, -0.001], {}), null);
  assert.equal(sharpeRatio(new Array(60).fill(0.001), {}), null); // sd = 0
  const alternating = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const sharpe = sharpeRatio(alternating, { rfAnnual: 0 });
  // 均值为 0、无风险利率 0 → 零超额 → 夏普为 0（可计算，不报样本不足）
  assert.ok(sharpe !== null && sharpe === 0);
  // 已知构造：日均 0.0005、日 sd ≈ 0.01 → 年化夏普 = (0.0005−rf/252)/0.01×√252
  const seq = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 0.0105 : -0.0095));
  const s2 = sharpeRatio(seq, { rfAnnual: 0 });
  const sd = stdev(seq)!;
  const expected = ((0.0005) / sd) * Math.sqrt(252);
  assert.ok(Math.abs((s2 ?? 0) - expected) < 1e-9);
});

test('annualVolatility', () => {
  const seq = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  const vol = annualVolatility(seq, {});
  const sd = stdev(seq)!;
  assert.ok(vol !== null && Math.abs(vol - sd * Math.sqrt(252)) < 1e-12);
});

test('maxDrawdown：峰谷最大跌幅', () => {
  assert.equal(maxDrawdown([100, 120, 90, 110]), 0.25);
  assert.equal(maxDrawdown([100, 110, 120]), 0);
  assert.equal(maxDrawdown([100]), null);
  assert.equal(maxDrawdown([]), null);
});

test('xirr：单笔一年 10% 收益', () => {
  const rate = xirr([
    { date: '2026-01-01', amount: -10000 },
    { date: '2027-01-01', amount: 11000 },
  ]);
  assert.ok(rate !== null && Math.abs(rate - 0.1) < 1e-6);
});

test('xirr：多笔现金流 + 期末市值（组合口径）', () => {
  const rate = xirr([
    { date: '2026-01-01', amount: -100000 },
    { date: '2026-07-01', amount: -50000 },
    { date: '2027-01-01', amount: 162000 },
  ]);
  assert.ok(rate !== null && rate > 0 && rate < 1);
});

test('xirr：现金流同号 / 样本不足 → null', () => {
  assert.equal(
    xirr([
      { date: '2026-01-01', amount: -100 },
      { date: '2026-02-01', amount: -50 },
    ]),
    null,
  );
  assert.equal(xirr([{ date: '2026-01-01', amount: -100 }]), null);
});

test('periodReturn：阶段涨幅', () => {
  assert.ok(Math.abs((periodReturn([100, 105, 110]) ?? 0) - 0.1) < 1e-12);
  assert.equal(periodReturn([0, 0]), null);
});
