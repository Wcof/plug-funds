/**
 * 现金账户（schema v3）与再平衡计划回归。
 *
 * 关注点：
 * - 现金是「时点余额」，要进总资产但不进持仓市值；
 * - 没设置目标权重时绝不能把 currentWeight 当成偏离去建议「全仓卖出」；
 * - 缺价持仓不按 0 计入分母；
 * - 隐藏金额时现金余额与总资产必须一起掩码。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import type { ServiceContext } from '../server/src/context.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

async function failing(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; code: string }> {
  const result = await dispatch(ctx, method, params);
  assert.notEqual(result.status, 200, `${method} 本应失败却成功`);
  return { status: result.status, code: result.envelope.error?.code ?? '' };
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-cash-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

/** 建一只 100 股 @12.0000 的股票持仓 → 市值 1200.00。 */
async function seedStock(price = '12.0000', quantity = '100'): Promise<{ accountId: string; instrumentId: string }> {
  const account = await rpc<{ id: string }>('save_account', { name: '测试账户', platform: '本地' });
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036',
  });
  await rpc('record_transaction', {
    accountId: account.id, instrumentId: instrument.id, type: 'OPENING',
    tradeDate: '2026-10-01', quantity, amount: '1000.00',
  });
  await rpc('save_manual_price', { instrumentId: instrument.id, value: price, tradingDate: TODAY });
  return { accountId: account.id, instrumentId: instrument.id };
}

/* ---------------- 1. 现金账户增删与合计 ---------------- */

test('现金：新增两个账户 → 合计为定点字符串（scale=2）', async () => {
  await rpc('save_cash_account', { name: '华宝证券现金', balance: '5000' });
  await rpc('save_cash_account', { name: '余额宝', balance: '1234.56', note: 'T+0' });

  const listed = await rpc<{ accounts: { name: string; balance: string; currency: string; active: boolean }[] }>('list_cash_accounts');
  assert.equal(listed.accounts.length, 2);
  assert.equal(listed.accounts.find((a) => a.name === '余额宝')?.balance, '1234.56');
  assert.equal(listed.accounts.every((a) => a.currency === 'CNY' && a.active), true);

  const summary = await rpc<{ cashTotal: string; totalAssets: string; cashWeight: number | null }>('get_dashboard_summary');
  assert.equal(summary.cashTotal, '6234.56');
  // 无持仓时总资产就等于现金，占比 100%。
  assert.equal(summary.totalAssets, '6234.56');
  assert.equal(summary.cashWeight, 1);
});

test('现金：名称为空 / 余额为负 → 422 validation-error', async () => {
  assert.deepEqual(await failing('save_cash_account', { name: '  ', balance: '100' }), { status: 422, code: 'validation-error' });
  assert.deepEqual(await failing('save_cash_account', { name: '现金', balance: '-1' }), { status: 422, code: 'validation-error' });
  assert.deepEqual(await failing('save_cash_account', { name: '现金', balance: 'abc' }), { status: 422, code: 'validation-error' });
});

test('现金：修改与删除后合计同步', async () => {
  const created = await rpc<{ id: string }>('save_cash_account', { name: '现金', balance: '1000' });
  await rpc('save_cash_account', { id: created.id, name: '现金', balance: '2500.5', note: '调账' });

  let summary = await rpc<{ cashTotal: string }>('get_dashboard_summary');
  // formatFixed 会去掉纯零尾随小数：2500.50 → '2500.5'
  assert.equal(summary.cashTotal, '2500.5');

  const removed = await rpc<{ deleted: boolean }>('delete_cash_account', { id: created.id });
  assert.equal(removed.deleted, true);
  summary = await rpc<{ cashTotal: string }>('get_dashboard_summary');
  assert.equal(summary.cashTotal, '0');
});

test('现金：停用的账户不计入合计', async () => {
  await rpc('save_cash_account', { name: '在用', balance: '300' });
  const idle = await rpc<{ id: string }>('save_cash_account', { name: '停用', balance: '700' });
  await rpc('save_cash_account', { id: idle.id, name: '停用', balance: '700', active: false });

  const summary = await rpc<{ cashTotal: string }>('get_dashboard_summary');
  assert.equal(summary.cashTotal, '300');
  // 列表仍能看到停用账户，方便重新启用。
  const listed = await rpc<{ accounts: { active: boolean }[] }>('list_cash_accounts');
  assert.equal(listed.accounts.filter((a) => !a.active).length, 1);
});

/* ---------------- 2. 总资产口径 ---------------- */

test('总资产 = 持仓市值 + 现金，现金占比按总资产计算', async () => {
  await seedStock(); // 市值 1200.00
  await rpc('save_cash_account', { name: '现金', balance: '800' });

  const summary = await rpc<{
    totalMarketValue: string; cashTotal: string; totalAssets: string; cashWeight: number | null;
  }>('get_dashboard_summary');
  assert.equal(summary.totalMarketValue, '1200');
  assert.equal(summary.cashTotal, '800');
  assert.equal(summary.totalAssets, '2000');
  assert.equal(summary.cashWeight, 0.4);
});

/* ---------------- 3. 再平衡：未设目标时不得给出假建议 ---------------- */

test('再平衡：未设目标权重时仍返回各类别当前权重，且全部 HOLD', async () => {
  await seedStock();
  await rpc('save_cash_account', { name: '现金', balance: '1200' });

  const plan = await rpc<{
    rows: { category: string; currentWeight: number; targetWeight: number; action: string; amount: string }[];
    targetsSum: number; note: string;
  }>('get_rebalance_plan');

  const stock = plan.rows.find((r) => r.category === 'stock');
  const cash = plan.rows.find((r) => r.category === 'cash');
  assert.equal(stock?.currentWeight, 0.5);
  assert.equal(cash?.currentWeight, 0.5);
  assert.equal(plan.rows.every((r) => r.action === 'HOLD'), true, JSON.stringify(plan.rows));
  assert.equal(plan.rows.every((r) => r.amount === '0'), true);
  assert.equal(plan.targetsSum, 0);
  assert.match(plan.note, /尚未设置目标权重/);
});

/* ---------------- 4. 再平衡：偏离与建议金额方向 ---------------- */

test('再平衡：超配建议卖出、低配建议买入，金额按偏离计算', async () => {
  await seedStock(); // 股票 1200，现金 0 → 总资产 1200
  await rpc('save_rebalance_targets', {
    targets: [{ category: 'stock', targetWeight: 0.5 }, { category: 'cash', targetWeight: 0.5 }],
    threshold: 0.05,
  });

  const plan = await rpc<{
    rows: { category: string; action: string; amount: string; drift: number }[];
    targetsSum: number; threshold: number;
  }>('get_rebalance_plan');

  const stock = plan.rows.find((r) => r.category === 'stock');
  const cash = plan.rows.find((r) => r.category === 'cash');
  assert.equal(plan.targetsSum, 1);
  assert.equal(plan.threshold, 0.05);
  assert.equal(stock?.action, 'SELL');
  assert.equal(stock?.amount, '600');   // (1.0 - 0.5) × 1200
  assert.equal(cash?.action, 'BUY');
  assert.equal(cash?.amount, '600');    // (0.5 - 0.0) × 1200
  assert.equal(stock?.drift, 0.5);
});

test('再平衡：偏离在阈值内 → HOLD 且金额为 0', async () => {
  await seedStock();
  await rpc('save_rebalance_targets', {
    targets: [{ category: 'stock', targetWeight: 0.98 }, { category: 'cash', targetWeight: 0.02 }],
    threshold: 0.05,
  });

  const plan = await rpc<{ rows: { category: string; action: string; amount: string }[]; note: string }>('get_rebalance_plan');
  assert.equal(plan.rows.every((r) => r.action === 'HOLD'), true, JSON.stringify(plan.rows));
  assert.equal(plan.rows.every((r) => r.amount === '0'), true);
  assert.match(plan.note, /阈值内/);
});

test('再平衡：缺价格的持仓不按 0 计入分母，并单独提示', async () => {
  const account = await rpc<{ id: string }>('save_account', { name: '测试账户', platform: '本地' });
  const priced = await rpc<{ id: string }>('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH' });
  const unpriced = await rpc<{ id: string }>('save_instrument', { code: '000002', name: '万科A', type: 'STOCK', market: 'SZ' });
  for (const instrument of [priced, unpriced]) {
    await rpc('record_transaction', {
      accountId: account.id, instrumentId: instrument.id, type: 'OPENING',
      tradeDate: '2026-10-01', quantity: '100', amount: '1000.00',
    });
  }
  await rpc('save_manual_price', { instrumentId: priced.id, value: '10.0000', tradingDate: TODAY });

  const plan = await rpc<{ missingValueCount: number; totalAssets: string; note: string }>('get_rebalance_plan');
  assert.equal(plan.missingValueCount, 1);
  assert.equal(plan.totalAssets, '1000');
  assert.match(plan.note, /缺价格/);
});

test('再平衡：目标合计超 100% / 未知类别 / 权重越界 → 422', async () => {
  assert.deepEqual(
    await failing('save_rebalance_targets', {
      targets: [{ category: 'stock', targetWeight: 0.8 }, { category: 'cash', targetWeight: 0.5 }],
    }),
    { status: 422, code: 'validation-error' },
  );
  assert.deepEqual(
    await failing('save_rebalance_targets', { targets: [{ category: 'bond', targetWeight: 0.3 }] }),
    { status: 422, code: 'validation-error' },
  );
  assert.deepEqual(
    await failing('save_rebalance_targets', { targets: [{ category: 'stock', targetWeight: 1.5 }] }),
    { status: 422, code: 'validation-error' },
  );
  assert.deepEqual(await failing('save_rebalance_targets', { targets: [] }), { status: 422, code: 'validation-error' });
});

/* ---------------- 5. 隐藏金额 ---------------- */

test('隐藏金额：现金余额、现金合计与总资产一并掩码，占比不变', async () => {
  await seedStock();
  await rpc('save_cash_account', { name: '现金', balance: '800' });
  const before = await rpc<{ cashWeight: number | null }>('get_dashboard_summary');

  await rpc('set_hide_amount', { enabled: true });
  const summary = await rpc<{ cashTotal: string; totalAssets: string; cashWeight: number | null }>('get_dashboard_summary');
  assert.equal(summary.cashTotal, '****');
  assert.equal(summary.totalAssets, '****');
  assert.equal(summary.cashWeight, before.cashWeight);

  const listed = await rpc<{ accounts: { balance: string }[] }>('list_cash_accounts');
  assert.equal(listed.accounts[0].balance, '****');

  const plan = await rpc<{ totalAssets: string }>('get_rebalance_plan');
  assert.equal(plan.totalAssets, '****');
});
