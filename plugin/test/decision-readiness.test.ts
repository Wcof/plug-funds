/**
 * 决策就绪度回归：集中度纯函数 + 8 维度就绪度 + RPC 一致性 + 掩码边界。
 *
 * 关注点：缺数据必须落到 MISSING / PARTIAL，绝不能被算成 0 后「看起来正常」。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch, listRpcMethods } from '../server/src/api.ts';
import { RPC_METHODS } from '../core/src/rpc.ts';
import { concentration } from '../core/src/portfolio-risk.ts';
import { saveValuationMetric } from '../server/src/repo/market.ts';
import type { ServiceContext } from '../server/src/context.ts';

const TODAY = '2026-11-13';
const THIS_YEAR = '2026';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-readiness-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

async function seedPosition(): Promise<{ accountId: string; instrumentId: string }> {
  const account = await rpc<{ id: string }>('save_account', { name: '测试账户', platform: '本地' });
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036',
  });
  await rpc('record_transaction', {
    accountId: account.id, instrumentId: instrument.id, type: 'OPENING',
    tradeDate: '2026-10-01', quantity: '100', amount: '1000.00',
  });
  await rpc('save_manual_price', { instrumentId: instrument.id, value: '12.0000', tradingDate: TODAY });
  return { accountId: account.id, instrumentId: instrument.id };
}

/* ---------------- 1. 集中度纯函数 ---------------- */

test('集中度：单一持仓 → top1=1 / HHI=1 / 触发 HIGH', () => {
  const result = concentration([
    { id: 'a', name: '招商银行', category: 'STOCK', marketValue: '1000.00' },
  ]);
  assert.equal(result.countedCount, 1);
  assert.equal(result.coveredValue, '1000');
  assert.equal(result.top1?.weight, 1);
  assert.equal(result.top3Weight, 1);
  assert.equal(result.hhi, 1);
  assert.equal(result.effectiveHoldings, 1);
  assert.ok(result.flags.some((f) => f.code === 'SINGLE_HOLDING' && f.level === 'HIGH'));
});

test('集中度：四只等权 → HHI=0.25 / 有效持仓数=4 / 无 HIGH', () => {
  const result = concentration([
    { id: 'a', name: 'A', category: 'STOCK', marketValue: '250.00' },
    { id: 'b', name: 'B', category: 'STOCK', marketValue: '250.00' },
    { id: 'c', name: 'C', category: 'ETF', marketValue: '250.00' },
    { id: 'd', name: 'D', category: 'ETF', marketValue: '250.00' },
  ]);
  assert.equal(result.countedCount, 4);
  assert.equal(result.hhi, 0.25);
  assert.equal(result.effectiveHoldings, 4);
  assert.equal(result.top1?.weight, 0.25);
  assert.equal(result.top3Weight, 0.75);
  assert.ok(!result.flags.some((f) => f.level === 'HIGH'));
  // 单一类别 50%：未触发 80% 类别集中提示
  assert.ok(!result.flags.some((f) => f.code === 'SINGLE_CATEGORY'));
});

test('集中度：缺价格的持仓不按 0 计入分母，但单独计数', () => {
  const result = concentration([
    { id: 'a', name: 'A', category: 'STOCK', marketValue: '1000.00' },
    { id: 'b', name: 'B', category: 'STOCK', marketValue: null },
  ]);
  assert.equal(result.countedCount, 1);
  assert.equal(result.missingCount, 1);
  assert.equal(result.coveredValue, '1000');
  assert.equal(result.top1?.weight, 1);
  assert.ok(result.flags.some((f) => f.code === 'MISSING_VALUE'));
});

/* ---------------- 2. 就绪度：空库 ---------------- */

test('就绪度：空库 → INSUFFICIENT，阻塞项含持仓与成本', async () => {
  const data = await rpc<{
    score: number; verdict: string; blockers: string[]; items: { key: string; status: string }[];
  }>('get_decision_readiness');
  assert.equal(data.verdict, 'INSUFFICIENT');
  assert.ok(data.score < 40, `score=${data.score}`);
  assert.ok(data.blockers.includes('持仓与成本'), JSON.stringify(data.blockers));
  const holdingsItem = data.items.find((i) => i.key === 'holdings');
  assert.equal(holdingsItem?.status, 'MISSING');
});

/* ---------------- 3. 就绪度：有持仓 + 价格 + 估值 ---------------- */

test('就绪度：有持仓与价格后 pricing / valuation 转 OK，仍缺市场估值坐标', async () => {
  const { instrumentId } = await seedPosition();
  saveValuationMetric(handle, { instrumentId, metricKey: 'pe', value: '8.00', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });
  saveValuationMetric(handle, { instrumentId, metricKey: 'pb', value: '0.90', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });

  const data = await rpc<{
    score: number; verdict: string; blockers: string[];
    items: { key: string; status: string; detail: string }[];
  }>('get_decision_readiness');

  const byKey = new Map(data.items.map((i) => [i.key, i]));
  assert.equal(byKey.get('holdings')?.status, 'OK');
  assert.equal(byKey.get('pricing')?.status, 'OK');
  assert.equal(byKey.get('valuation')?.status, 'OK');
  assert.equal(byKey.get('index')?.status, 'MISSING');
  assert.ok(data.blockers.includes('市场估值坐标'));
  assert.ok(data.score >= 45, `score=${data.score}`);
});

/* ---------------- 4. 就绪度：补齐指数后 index 转 OK ---------------- */

test('就绪度：录入 INDEX 标的与 PE 截面后，市场估值坐标转 OK', async () => {
  const { instrumentId } = await seedPosition();
  saveValuationMetric(handle, { instrumentId, metricKey: 'pe', value: '8.00', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });
  saveValuationMetric(handle, { instrumentId, metricKey: 'pb', value: '0.90', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });

  const index = await rpc<{ id: string }>('save_instrument', {
    code: '000300', name: '沪深300', type: 'INDEX', market: 'SH',
  });
  saveValuationMetric(handle, { instrumentId: index.id, metricKey: 'pe', value: '12.50', asOfDate: TODAY, provider: 'manual', quality: 'FRESH' });

  const data = await rpc<{ items: { key: string; status: string }[] }>('get_decision_readiness');
  const indexItem = data.items.find((i) => i.key === 'index');
  assert.equal(indexItem?.status, 'OK');
});

/* ---------------- 5. 就绪度：资金流与目标 ---------------- */

test('就绪度：资金流与目标补齐后，对应维度转 OK', async () => {
  await seedPosition();
  await rpc('save_portfolio_cash_flow', {
    flowType: 'CONTRIBUTION', flowDate: `${THIS_YEAR}-09-01`, amount: '1000.00', note: '本金',
  });
  await rpc('save_portfolio_goal', { name: '目标', targetAmount: '200000.00', enabled: true });

  const data = await rpc<{ items: { key: string; status: string }[] }>('get_decision_readiness');
  const byKey = new Map(data.items.map((i) => [i.key, i]));
  assert.equal(byKey.get('cashflow')?.status, 'OK');
  assert.equal(byKey.get('goal')?.status, 'OK');
});

/* ---------------- 6. RPC 契约一致性 ---------------- */

test('get_decision_readiness 在方法表与实现中一致', () => {
  assert.ok((RPC_METHODS as readonly string[]).includes('get_decision_readiness'));
  assert.ok(listRpcMethods().includes('get_decision_readiness'));
});

/* ---------------- 7. 隐藏金额：展示掩码但不影响就绪度判定 ---------------- */

test('隐藏金额：totalMarketValue 被掩码，score / verdict 不变', async () => {
  await seedPosition();
  const before = await rpc<{ score: number; verdict: string }>('get_decision_readiness');

  // 掩码开关读的是持久化设置，不是 ctx.hideAmount，必须走 RPC 打开。
  await rpc('set_hide_amount', { enabled: true });
  const masked = await rpc<{
    score: number; verdict: string;
    metrics: { totalMarketValue: string };
    concentration: { coveredValue: string };
  }>('get_decision_readiness');
  assert.equal(masked.metrics.totalMarketValue, '****');
  assert.equal(masked.concentration.coveredValue, '****');
  assert.equal(masked.score, before.score);
  assert.equal(masked.verdict, before.verdict);
});
