import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocation } from '../core/src/goal.ts';
import { parseFixed, SCALE_AMOUNT } from '../core/src/money.ts';

const CATS = [
  { key: 'stock', label: '股票', value: '44000.00', color: '#4c6ef5' },
  { key: 'fund', label: '场外基金', value: '57080.00', color: '#9a6bf2' },
  { key: 'etf', label: 'ETF', value: '25500.00', color: '#ee9d3f' },
];
// 合计 126,580（PRD §13.0 验收示例数字）

test('全量分布：分母为持仓总市值，合计 100%，无灰色扇区', () => {
  const result = allocation({ categories: CATS, goal: null, mode: 'full' });
  assert.equal(result.mode, 'full');
  assert.equal(result.totalMarketValue, '126580');
  const fractionSum = result.segments.reduce((acc, s) => acc + s.fraction, 0);
  assert.ok(Math.abs(fractionSum - 1) < 1e-9);
  assert.ok(result.segments.every((s) => !s.gray));
  assert.equal(result.segments.find((s) => s.key === 'stock')?.fraction ?? 0, 44000 / 126580);
});

test('目标达成（未达成）：分母为目标金额，灰色待达成补足 100%', () => {
  const result = allocation({
    categories: CATS,
    goal: { targetAmount: '1000000.00', enabled: true },
    mode: 'goal',
  });
  assert.equal(result.mode, 'goal');
  assert.equal(result.effectiveGoalAmount, '1000000');
  // PRD 验收：完成率 12.658%，待达成 873,420
  assert.ok(Math.abs((result.progressRatio ?? 0) - 0.12658) < 1e-12);
  assert.equal(result.remainingAmount, '873420');
  assert.equal(result.overAmount, null);
  const stock = result.segments.find((s) => s.key === 'stock');
  assert.equal(stock?.denominator, 'goal');
  assert.ok(Math.abs((stock?.fraction ?? 0) - 0.044) < 1e-12);
  const gray = result.segments.find((s) => s.gray);
  assert.equal(gray?.label, '待达成');
  const sum = result.segments.reduce((acc, s) => acc + s.fraction, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('目标达成（超额）：完成率可超过 100%，无负值灰色扇区', () => {
  const result = allocation({
    categories: [
      { key: 'stock', label: '股票', value: '665800.00' },
      { key: 'fund', label: '场外基金', value: '600000.00' },
    ],
    goal: { targetAmount: '1000000.00', enabled: true },
    mode: 'goal',
  });
  assert.equal(result.mode, 'goal');
  assert.equal(result.overAmount, '265800');
  assert.equal(result.remainingAmount, null);
  assert.ok((result.progressRatio ?? 0) > 1);
  assert.ok(result.segments.every((s) => !s.gray));
  const sum = result.segments.reduce((acc, s) => acc + s.fraction, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9); // 彩色扇区按当前构成绘制
});

test('总市值恰好等于目标：待达成 0，无灰色', () => {
  const result = allocation({
    categories: [{ key: 'stock', label: '股票', value: '1000000.00' }],
    goal: { targetAmount: '1000000.00', enabled: true },
    mode: 'goal',
  });
  assert.equal(result.remainingAmount, null);
  assert.equal(result.overAmount, null);
  assert.ok(Math.abs((result.progressRatio ?? 0) - 1) < 1e-12);
});

test('目标关闭 / 金额非法时回退全量分布', () => {
  const disabled = allocation({
    categories: CATS,
    goal: { targetAmount: '1000000.00', enabled: false },
    mode: 'goal',
  });
  assert.equal(disabled.mode, 'full');
  assert.equal(disabled.effectiveGoalAmount, null);
  const invalid = allocation({
    categories: CATS,
    goal: { targetAmount: '0.00', enabled: true },
    mode: 'goal',
  });
  assert.equal(invalid.mode, 'full');
  assert.match(invalid.note ?? '', /大于 0/);
});

test('分母口径标签明确（current / goal）', () => {
  const full = allocation({ categories: CATS, goal: null, mode: 'full' });
  assert.ok(full.segments.every((s) => s.denominator === 'current'));
  const goal = allocation({
    categories: CATS,
    goal: { targetAmount: '1000000.00', enabled: true },
    mode: 'goal',
  });
  assert.ok(goal.segments.filter((s) => !s.gray).every((s) => s.denominator === 'goal'));
  assert.equal(goal.segments.find((s) => s.gray)?.denominator, 'goal');
});

test('parseFixed 金额解析（scale=2）', () => {
  assert.equal(parseFixed('126580.00', SCALE_AMOUNT), 12658000);
});
