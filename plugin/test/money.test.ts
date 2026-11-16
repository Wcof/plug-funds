import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PrecisionError,
  SCALE_AMOUNT,
  SCALE_QTY,
  divToScale,
  formatFixed,
  mulAmount,
  mulToScale,
  parseFixed,
  truncDiv,
  unitFromAmount,
} from '../core/src/money.ts';

test('parseFixed / formatFixed 往返与正规化', () => {
  assert.equal(parseFixed('123.45', SCALE_AMOUNT), 12345);
  assert.equal(parseFixed('-123.45', SCALE_AMOUNT), -12345);
  assert.equal(parseFixed('0', SCALE_AMOUNT), 0);
  assert.equal(parseFixed('1.2', SCALE_AMOUNT), 120);
  assert.equal(formatFixed(12345, SCALE_AMOUNT), '123.45');
  assert.equal(formatFixed(-7, SCALE_AMOUNT), '-0.07');
  // 去掉纯零尾随小数位
  assert.equal(formatFixed(12000, SCALE_AMOUNT), '120');
  assert.equal(formatFixed(385000, SCALE_QTY), '38.5');
  assert.equal(formatFixed(1, SCALE_QTY), '0.0001');
});

test('parseFixed 拒绝超精度与非零尾数', () => {
  assert.throws(() => parseFixed('0.001', SCALE_AMOUNT), PrecisionError);
  assert.throws(() => parseFixed('1.2345', SCALE_AMOUNT), PrecisionError);
  // 尾数为 0 时允许截断
  assert.equal(parseFixed('1.2300', SCALE_AMOUNT), 123);
  assert.throws(() => parseFixed('abc', SCALE_AMOUNT), PrecisionError);
  assert.throws(() => parseFixed('', SCALE_AMOUNT), PrecisionError);
});

test('truncDiv 向零截断（ROUND_DOWN，含负数）', () => {
  assert.equal(truncDiv(7, 2), 3);
  assert.equal(truncDiv(-7, 2), -3);
  assert.equal(truncDiv(7, -2), -3);
  assert.equal(truncDiv(-7, -2), 3);
  assert.throws(() => truncDiv(1, 0), RangeError);
});

test('mulAmount：价格 × 份额 → 金额（买入总成本口径）', () => {
  const price = parseFixed('41.25', SCALE_QTY);
  const qty = parseFixed('400', SCALE_QTY);
  assert.equal(mulAmount(price, qty), 1650000); // 16,500.00
  // 截断口径：1.2691 × 18517.06 = 23500.0008… → 金额 23500.00
  const p2 = parseFixed('1.2691', SCALE_QTY);
  const q2 = parseFixed('18517.06', SCALE_QTY);
  assert.equal(mulAmount(p2, q2), 2350000);
  // 金额口径固定 2 位（ROUND_DOWN）：1.0001 × 3 = 3.0003 → 3.00
  assert.equal(mulAmount(parseFixed('1.0001', SCALE_QTY), parseFixed('3', SCALE_QTY)), 300);
  // 1.0001 × 3.3333 = 3.333733… → 3.33
  assert.equal(mulAmount(parseFixed('1.0001', SCALE_QTY), parseFixed('3.3333', SCALE_QTY)), 333);
});

test('unitFromAmount：金额 ÷ 份额 → 单位成本', () => {
  const amount = parseFixed('15764.21', SCALE_AMOUNT);
  const qty = parseFixed('400', SCALE_QTY);
  const unit = unitFromAmount(amount, qty); // 39.410525 → 截断 39.4105
  assert.equal(unit, 394105);
  assert.equal(formatFixed(unit, SCALE_QTY), '39.4105');
});

test('divToScale / mulToScale 通用组合', () => {
  assert.equal(mulToScale(parseFixed('1.5', SCALE_QTY), parseFixed('2', SCALE_QTY), SCALE_AMOUNT, SCALE_QTY * 2), 300);
  // 1.00 ÷ 4.0000 = 0.25 → s4 raw = 2500
  assert.equal(divToScale(100, 2, parseFixed('4', SCALE_QTY), SCALE_QTY, SCALE_QTY), 2500);
});
