import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerError, holdingReturnRate, replayPositions, unrealizedRaw } from '../core/src/ledger.ts';
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, mulToScale, parseFixed } from '../core/src/money.ts';
import type { Txn } from '../core/src/types.ts';

let seq = 0;
function txn(partial: Partial<Txn> & { type: Txn['type'] }): Txn {
  seq += 1;
  return {
    id: `t${seq}`,
    accountId: 'acc1',
    instrumentId: 'ins1',
    type: partial.type,
    status: 'CONFIRMED',
    tradeDate: '2026-10-20',
    seq: partial.seq ?? seq,
    quantity: partial.quantity ?? null,
    price: partial.price ?? null,
    amount: partial.amount ?? null,
    fee: partial.fee ?? null,
    tax: partial.tax ?? null,
    note: '',
    requestId: null,
    createdAt: '2026-11-15T00:00:00Z',
    ...(['tradeDate', 'accountId', 'instrumentId', 'status', 'id'] as const)
      .reduce<Record<string, string>>((acc, k) => {
        if (partial[k] !== undefined) acc[k] = String(partial[k]);
        return acc;
      }, {}),
  } as Txn;
}

const mvRaw = (qtyRaw: number, priceText: string) =>
  mulToScale(parseFixed(priceText, SCALE_QTY), qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);

test('加权平均成本：期初 + 买入 + 卖出 + 分红（PRD §4.4.3）', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '300', amount: '11550.00', tradeDate: '2026-10-20' }),
    txn({ type: 'BUY', quantity: '100', price: '42.10', fee: '4.21', tradeDate: '2026-11-08' }),
    txn({ type: 'SELL', quantity: '100', price: '41.25', fee: '5.00', tradeDate: '2026-11-12' }),
    txn({ type: 'DIVIDEND_CASH', amount: '325.60', tradeDate: '2026-11-13' }),
  ];
  const positions = replayPositions(txns);
  const pos = positions.get('acc1:ins1');
  assert.ok(pos);
  assert.equal(pos.qtyRaw, parseFixed('300', SCALE_QTY));
  // 总成本 = 11550 + (4210 + 4.21) − 结转 3941.05 = 11823.16
  assert.equal(pos.costTotalRaw, 1182316);
  assert.equal(formatFixed(pos.unitCostRaw, SCALE_QTY), '39.4105');
  // 已实现 = 净收入 4120 − 结转 3941.05 = 178.95
  assert.equal(pos.realizedRaw, 17895);
  assert.equal(pos.dividendsRaw, 32560);
  // 未实现（现价 41.25）：市值 12375 − 成本 11823.16 = 551.84
  assert.equal(unrealizedRaw(pos, parseFixed('41.25', SCALE_QTY)), 55184);
  const rate = holdingReturnRate(pos, parseFixed('41.25', SCALE_QTY));
  assert.ok(rate !== null && Math.abs(rate - 551.84 / 11823.16) < 1e-12);
});

test('卖出超过可用持仓被拒绝（超卖）', () => {
  const txns = [txn({ type: 'OPENING', quantity: '300', amount: '11550.00' })];
  const positions = replayPositions(txns);
  assert.throws(
    () => replayPositions([...txns, txn({ type: 'SELL', quantity: '400', price: '41.25' })]),
    (err: LedgerError) => err instanceof LedgerError && err.code === 'oversell',
  );
  assert.equal(positions.get('acc1:ins1')?.qtyRaw, parseFixed('300', SCALE_QTY));
});

test('待确认交易不改变持仓', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '100', amount: '1000.00' }),
    txn({ type: 'BUY', quantity: '200', price: '10', status: 'PENDING_CONFIRMATION' }),
  ];
  const pos = replayPositions(txns).get('acc1:ins1');
  assert.equal(pos?.qtyRaw, parseFixed('100', SCALE_QTY));
  assert.equal(pos?.costTotalRaw, 100000);
});

test('红利再投：份额与成本同步增加', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '14000', amount: '17500.00' }),
    txn({ type: 'DIVIDEND_REINVEST', quantity: '115.24', amount: '148.23' }),
  ];
  const pos = replayPositions(txns).get('acc1:ins1');
  assert.equal(pos?.qtyRaw, parseFixed('14115.24', SCALE_QTY));
  assert.equal(pos?.costTotalRaw, 1764823);
});

test('拆分：总成本不变、数量按系数折算', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '100', amount: '1000.00' }),
    txn({ type: 'SPLIT', quantity: '2' }),
  ];
  const pos = replayPositions(txns).get('acc1:ins1');
  assert.equal(pos?.qtyRaw, parseFixed('200', SCALE_QTY));
  assert.equal(pos?.costTotalRaw, 100000);
  assert.equal(formatFixed(pos!.unitCostRaw, SCALE_QTY), '5');
});

test('修正记录：显式数量与成本增量', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '100', amount: '1000.00' }),
    txn({ type: 'CORRECTION', quantity: '-10', amount: '-95.00', note: '修正录入错误' }),
  ];
  const pos = replayPositions(txns).get('acc1:ins1');
  assert.equal(pos?.qtyRaw, parseFixed('90', SCALE_QTY));
  assert.equal(pos?.costTotalRaw, 90500);
  assert.throws(
    () => replayPositions([txn({ type: 'OPENING', quantity: '10', amount: '100.00' }), txn({ type: 'CORRECTION', quantity: '-20', amount: '0' })]),
    LedgerError,
  );
});

test('同日多笔按 seq 稳定回放（确定性）', () => {
  const a = txn({ type: 'BUY', quantity: '100', price: '10', seq: 2 });
  const b = txn({ type: 'BUY', quantity: '100', price: '20', seq: 1 });
  const p1 = replayPositions([a, b]).get('acc1:ins1');
  const p2 = replayPositions([b, a]).get('acc1:ins1');
  assert.equal(p1?.qtyRaw, p2?.qtyRaw);
  assert.equal(p1?.costTotalRaw, p2?.costTotalRaw);
  assert.equal(p1?.qtyRaw, parseFixed('200', SCALE_QTY));
});

test('独立标的独立投影', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '100', amount: '1000.00' }),
    { ...txn({ type: 'OPENING', quantity: '50', amount: '500.00' }), instrumentId: 'ins2' } as Txn,
  ];
  const positions = replayPositions(txns);
  assert.equal(positions.get('acc1:ins1')?.qtyRaw, parseFixed('100', SCALE_QTY));
  assert.equal(positions.get('acc1:ins2')?.qtyRaw, parseFixed('50', SCALE_QTY));
});

test('全部清仓后成本归零', () => {
  const txns = [
    txn({ type: 'OPENING', quantity: '100', amount: '1000.00' }),
    txn({ type: 'SELL', quantity: '100', price: '11', fee: '0' }),
  ];
  const pos = replayPositions(txns).get('acc1:ins1');
  assert.equal(pos?.qtyRaw, 0);
  assert.equal(pos?.costTotalRaw, 0);
  assert.equal(pos?.unitCostRaw, 0);
  assert.equal(unrealizedRaw(pos!, parseFixed('11', SCALE_QTY)), 0);
  // 已实现保留：1100 − 1000 = 100
  assert.equal(pos?.realizedRaw, 10000);
});

test('市值口径复检（mvRaw 辅助）', () => {
  assert.equal(mvRaw(parseFixed('400', SCALE_QTY), '41.25'), 1650000);
  assert.equal(formatFixed(mvRaw(parseFixed('400', SCALE_QTY), '41.25'), SCALE_AMOUNT), '16500');
});
