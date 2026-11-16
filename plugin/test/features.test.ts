/**
 * v0.2 功能回归：展示掩码与数据出口隔离、资金流 / XIRR、组合 PE/PB、
 * CSV 导入（预览 / 幂等 / 整批回滚）、备份恢复、策略版本化、手工指标、
 * 「我的收益」图表语义、每日快照。
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
import { effectiveHistoryPoints, saveMarketPoints, saveValuationMetric } from '../server/src/repo/market.ts';
import { isTradingHours } from '../server/src/repo/refresh-settings.ts';
import type { ServiceContext } from '../server/src/context.ts';
import type { MarketPoint, Txn } from '../core/src/types.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

async function expectFail(method: string, params: Record<string, unknown>): Promise<void> {
  const result = await dispatch(ctx, method, params);
  assert.notEqual(result.status, 200, `${method} 本应失败`);
  assert.equal(result.envelope.success, false);
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-features-'));
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

function priceHistory(instrumentId: string, days = 30): MarketPoint[] {
  const out: MarketPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    out.push({
      instrumentId, priceType: 'CLOSE_PRICE', value: (10 + i * 0.05).toFixed(4),
      currency: 'CNY', tradingDate: d.toISOString().slice(0, 10),
      observedAt: `${d.toISOString().slice(0, 10)}T15:00:00Z`,
      provider: 'fixture', quality: 'FRESH',
    });
  }
  return out;
}

test('RPC 方法表与实现一致，且含 v0.2 新增方法', () => {
  const methods = listRpcMethods();
  assert.equal(methods.length, RPC_METHODS.length);
  for (const method of RPC_METHODS) assert.ok(methods.includes(method), `HANDLERS 缺少 ${method}`);
  for (const method of ['save_portfolio_cash_flow', 'commit_import_transactions', 'restore_backup', 'save_strategy_template']) {
    assert.ok(methods.includes(method));
  }
});

test('隐藏金额开启时导出 / 备份仍是真实数值（不写 ****）', async () => {
  const { instrumentId } = await seedPosition();
  await rpc('save_portfolio_goal', { name: '目标', targetAmount: '1000000', enabled: true });
  await rpc('set_hide_amount', { enabled: true });
  const hidden = await rpc<Record<string, unknown>>('get_portfolio_goal');
  assert.equal(JSON.stringify(hidden).includes('****'), true, '展示响应应被掩码');
  const backup = await rpc<{ goals: { targetAmount: string }[]; transactions: Txn[] }>('export_backup');
  assert.equal(backup.goals[0].targetAmount, '1000000');
  assert.ok(backup.transactions[0].amount === '1000.00' || backup.transactions[0].amount === '1000');
  assert.equal(JSON.stringify(backup).includes('****'), false);
  const csv = await rpc<{ csv: string }>('export_holdings_csv');
  assert.ok(csv.csv.includes(instrumentId) || csv.csv.includes('招商银行'));
  await rpc('set_hide_amount', { enabled: false });
});

test('组合外部资金流水：录入 / 删除，XIRR 由「不可计算」变为可计算', async () => {
  await seedPosition();
  const before = await rpc<{ xirr: number | null }>('get_portfolio_performance_metrics', { range: '1y' });
  assert.equal(before.xirr, null);
  const flow = await rpc<{ id: string; amount: string }>('save_portfolio_cash_flow', {
    flowType: 'CONTRIBUTION', flowDate: '2026-09-01', amount: '1000.00', note: '本金投入',
  });
  assert.equal(Number(flow.amount), 1000, '定点字符串正规化后可为 1000');
  const after = await rpc<{ xirr: number | null; valuationNote: string | null }>('get_portfolio_performance_metrics', { range: '1y' });
  assert.ok(after.xirr !== null, '录入资金流后应能解出 XIRR');
  await expectFail('save_portfolio_cash_flow', { flowType: 'WITHDRAWAL', flowDate: TODAY, amount: '-5' });
  const removed = await rpc<{ deleted: boolean }>('delete_portfolio_cash_flow', { id: flow.id });
  assert.equal(removed.deleted, true);
});

test('组合 PE / PB 按覆盖市值加权；缺指标不按 0 处理', async () => {
  const { instrumentId } = await seedPosition();
  const empty = await rpc<{ portfolioPe: number | null; valuationNote: string | null }>('get_portfolio_performance_metrics', { range: '1y' });
  assert.equal(empty.portfolioPe, null);
  assert.match(empty.valuationNote ?? '', /估值截面/);
  saveValuationMetric(handle, { instrumentId, metricKey: 'pe', value: '8.00', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });
  saveValuationMetric(handle, { instrumentId, metricKey: 'pb', value: '0.90', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH' });
  const filled = await rpc<{ portfolioPe: number | null; portfolioPb: number | null; valuationCoverage: number | null }>(
    'get_portfolio_performance_metrics', { range: '1y' },
  );
  assert.equal(filled.portfolioPe, 8);
  assert.equal(filled.portfolioPb, 0.9);
  assert.equal(filled.valuationCoverage, 1);
});

test('CSV 导入：预览错误行 → 提交 → 重复提交幂等 → 超卖整批回滚', async () => {
  const csv = [
    '账户,标的代码,标的名称,资产类别,交易类型,交易日,数量,价格,金额,手续费,税费,状态,备注,幂等键',
    'CSV账户,600036,招商银行,股票,期初,2026-10-01,100,,1000.00,0,0,已确认,期初,',
    'CSV账户,600036,招商银行,股票,买入,2026-10-02,50,11.00,,0,0,已确认,加仓,',
    'CSV账户,600036,招商银行,股票,不存在的类型,2026-10-03,10,11.00,,0,0,已确认,坏行,',
  ].join('\n');
  const preview = await rpc<{ summary: { total: number; valid: number; invalid: number }; errors: { line: number }[]; rows: unknown[] }>(
    'preview_import_transactions', { csv },
  );
  assert.equal(preview.summary.total, 3);
  assert.equal(preview.summary.valid, 2);
  assert.equal(preview.summary.invalid, 1);
  assert.equal(preview.errors[0].line, 4);
  assert.equal(preview.rows.length, 2);

  const first = await rpc<{ imported: number; skipped: number }>('commit_import_transactions', { csv });
  assert.equal(first.imported, 2);
  const second = await rpc<{ imported: number; skipped: number }>('commit_import_transactions', { csv });
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 2);
  const positions = await rpc<{ rows: { qty: string }[] }>('list_positions');
  assert.equal(positions.rows.length, 1);
  assert.equal(Number(positions.rows[0].qty), 150);

  const oversell = [
    '账户,标的代码,标的名称,资产类别,交易类型,交易日,数量,价格,金额,手续费,税费,状态,备注,幂等键',
    'CSV账户,000001,平安银行,股票,卖出,2026-10-05,999,11.00,,0,0,已确认,超卖,',
  ].join('\n');
  const before = await rpc<{ rows: unknown[] }>('list_positions');
  await expectFail('commit_import_transactions', { csv: oversell });
  const after = await rpc<{ rows: unknown[] }>('list_positions');
  assert.equal(after.rows.length, before.rows.length, '失败批次不得留下部分写入');
});

test('JSON 备份：导出 → 校验预览 → 恢复到干净库，数据一致', async () => {
  const { instrumentId } = await seedPosition();
  await rpc('save_portfolio_cash_flow', { flowType: 'CONTRIBUTION', flowDate: '2026-09-01', amount: '1000.00' });
  const backup = await rpc<Record<string, unknown>>('export_backup');
  const preview = await rpc<{ ok: boolean; counts: Record<string, number>; errors: string[] }>('preview_restore_backup', { payload: backup });
  assert.equal(preview.ok, true);
  assert.ok(preview.counts.transactions >= 1);
  assert.ok(preview.counts.cashFlows >= 1);
  const bad = await rpc<{ ok: boolean; errors: string[] }>('preview_restore_backup', { payload: { kind: 'other' } });
  assert.equal(bad.ok, false);
  await expectFail('restore_backup', { payload: { kind: 'other', schemaVersion: 2 } });

  // 恢复到另一个干净库（真实场景：换机 / 重装后导入备份）
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-restore-'));
  const dirs2 = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp2 } as NodeJS.ProcessEnv);
  const handle2 = openState(dirs2, { inMemory: true });
  const ctx2: ServiceContext = { handle: handle2, dirs: dirs2, registry: createRegistry([]), today: TODAY, hideAmount: false };
  const emptyResult = await dispatch(ctx2, 'list_positions', {});
  assert.equal((emptyResult.envelope.data as { rows: unknown[] }).rows.length, 0);
  const restoreResult = await dispatch(ctx2, 'restore_backup', { payload: backup });
  assert.equal(restoreResult.status, 200, `恢复失败：${JSON.stringify(restoreResult.envelope.error)}`);
  assert.ok((restoreResult.envelope.data as { restored: Record<string, number> }).restored.transactions >= 1);
  const rowsResult = await dispatch(ctx2, 'list_positions', {});
  assert.equal((rowsResult.envelope.data as { rows: { instrumentId: string }[] }).rows[0].instrumentId, instrumentId);
  const flowsResult = await dispatch(ctx2, 'get_portfolio_goal', {});
  assert.equal((flowsResult.envelope.data as { cashFlows: unknown[] }).cashFlows.length, 1);
  handle2.db.close();
});

test('策略模板：编辑生成版本、权重校验、回滚', async () => {
  const list = await rpc<{ templates: { id: string; name: string; metrics: { key: string; weight: number }[]; version: number }[] }>('list_strategy_templates');
  assert.equal(list.templates.length, 4);
  const base = list.templates[0];
  assert.equal(base.version, 0);
  const rules = base.metrics.map((r) => ({ ...r }));
  const saved = await rpc<{ template: { id: string; version: number } }>('save_strategy_template', {
    id: base.id, name: base.name, scope: '测试', metrics: rules, note: 'v1',
  });
  assert.equal(saved.template.version, 1);
  const second = await rpc<{ template: { version: number } }>('save_strategy_template', {
    id: base.id, name: base.name, scope: '测试',
    metrics: rules.map((r, i) => (i === 0 ? { ...r } : r)), note: 'v2',
  });
  assert.equal(second.template.version, 2);
  const versions = await rpc<{ versions: { version: number; current: boolean }[] }>('list_strategy_versions', { templateId: base.id });
  assert.equal(versions.versions.length, 2);
  assert.equal(versions.versions[0].current, true);
  const rolled = await rpc<{ template: { version: number } }>('restore_strategy_version', { templateId: base.id, version: 1 });
  assert.equal(rolled.template.version, 3);
  const badRules = rules.map((r) => ({ ...r, weight: 1 }));
  await expectFail('save_strategy_template', { id: base.id, name: base.name, metrics: badRules });
});

test('手工补录指标 + 历史价格：估值评分在真实数据下可达，口径标注 MANUAL', async () => {
  const { instrumentId } = await seedPosition();
  saveMarketPoints(handle, priceHistory(instrumentId, 30));
  for (const [key, value] of [
    ['pe', '8'], ['pb', '0.9'], ['roe', '15'], ['dividend_yield', '4.2'],
    ['pe_percentile', '18'], ['pb_percentile', '22'],
  ] as const) {
    await rpc('save_manual_metric', { instrumentId, metricKey: key, value, asOfDate: TODAY });
  }
  const view = await rpc<{ rows: { caliber: string; strategies: { total: number | null; level: string }[] }[] }>('get_holdings_valuation');
  assert.equal(view.rows.length, 1);
  assert.match(view.rows[0].caliber, /手工补录/);
  assert.ok(view.rows[0].strategies.some((s) => s.total !== null), '指标齐备时应能产生评分，而不是恒为数据不足');
});

test('「我的收益」Tab 返回累计收益金额，联动列表为当日变动 / 累计收益', async () => {
  const { instrumentId } = await seedPosition();
  saveMarketPoints(handle, priceHistory(instrumentId, 30));
  const perf = await rpc<{ series: { value: string }[] }>('get_instrument_chart_series', { instrumentId, tab: 'perf', period: '1y' });
  const mine = await rpc<{ series: { value: string }[]; list: { value: string; extra: string | null }[]; costLine: string | null }>(
    'get_instrument_chart_series', { instrumentId, tab: 'mine', period: '1y' },
  );
  assert.ok(mine.series.length > 0);
  assert.notEqual(mine.series[0].value, perf.series[0].value, '收益序列不应等于价格序列');
  assert.equal(mine.costLine, '0');
  assert.ok(mine.list[0].extra !== null);
  assert.ok(Number(mine.series.at(-1)!.value) !== 0);
});

test('行情刷新写入每日快照（同日重复覆盖）', async () => {
  await seedPosition();
  await rpc('refresh_market_data', {});
  const first = handle.db.prepare('SELECT * FROM portfolio_snapshots').all() as { snapshot_date: string }[];
  assert.equal(first.length, 1);
  await rpc('refresh_market_data', {});
  const second = handle.db.prepare('SELECT * FROM portfolio_snapshots').all() as unknown[];
  assert.equal(second.length, 1);
  const holdings = handle.db.prepare('SELECT COUNT(*) AS n FROM holding_snapshots').get() as { n: number };
  assert.equal(holdings.n, 1);
  const runs = handle.db.prepare('SELECT COUNT(*) AS n FROM data_source_runs').get() as { n: number };
  assert.equal(runs.n, 2);
});

test('有效历史价格：MANUAL_PRICE 优先、同日多来源去重、估算净值不参与计价', async () => {
  const { instrumentId } = await seedPosition();
  saveMarketPoints(handle, [
    { instrumentId, priceType: 'CLOSE_PRICE', value: '10.0000', currency: 'CNY', tradingDate: '2026-10-01', observedAt: '', provider: 'fixture', quality: 'OFFICIAL' },
    { instrumentId, priceType: 'REALTIME_PRICE', value: '11.0000', currency: 'CNY', tradingDate: '2026-10-01', observedAt: '', provider: 'fixture', quality: 'REALTIME' },
    { instrumentId, priceType: 'MANUAL_PRICE', value: '12.5000', currency: 'CNY', tradingDate: '2026-10-01', observedAt: '', provider: 'manual', quality: 'MANUAL' },
    { instrumentId, priceType: 'MANUAL_PRICE', value: '13.0000', currency: 'CNY', tradingDate: '2026-10-02', observedAt: '', provider: 'manual', quality: 'MANUAL' },
    { instrumentId, priceType: 'ESTIMATED_NAV', value: '99.0000', currency: 'CNY', tradingDate: '2026-10-03', observedAt: '', provider: 'fixture', quality: 'ESTIMATED' },
  ] as MarketPoint[]);
  const points = effectiveHistoryPoints(handle, instrumentId, 'STOCK');
  const byDate = new Map(points.map((p) => [p.tradingDate, p]));
  assert.equal(byDate.size, points.length, '同日多来源必须去重，不得重复计数');
  assert.ok(!byDate.has('2026-10-03'), 'ESTIMATED_NAV 不得进入计价序列');
  assert.equal(byDate.get('2026-10-01')?.priceType, 'MANUAL_PRICE');
  assert.equal(byDate.get('2026-10-01')?.value, '12.5000', '同日 MANUAL > REALTIME > CLOSE');
  assert.equal(byDate.get('2026-10-02')?.value, '13.0000');
  assert.equal(byDate.get(TODAY)?.value, '12.0000', 'seed 预置的手工价格仍在序列中');
});

test('行情自动刷新配置：默认 60 秒可关闭、间隔校验、交易时段判定', async () => {
  const initial = await rpc<{
    settings: { enabled: boolean; intervalSec: number; tradingHoursOnly: boolean };
    limits: { minSec: number; maxSec: number };
  }>('get_refresh_settings');
  assert.equal(initial.settings.enabled, true);
  assert.equal(initial.settings.intervalSec, 60);
  assert.equal(initial.settings.tradingHoursOnly, true);
  assert.equal(initial.limits.minSec, 15);

  const saved = await rpc<{ settings: { enabled: boolean; intervalSec: number; tradingHoursOnly: boolean } }>(
    'save_refresh_settings', { enabled: false, intervalSec: 120, tradingHoursOnly: false },
  );
  assert.deepEqual(saved.settings, { enabled: false, intervalSec: 120, tradingHoursOnly: false });
  const reread = await rpc<{ settings: { enabled: boolean } }>('get_refresh_settings');
  assert.equal(reread.settings.enabled, false, '设置必须持久化，重启后仍生效');

  const bad = await dispatch(ctx, 'save_refresh_settings', { intervalSec: 1 });
  assert.equal(bad.status, 422);
  assert.equal(bad.envelope.error?.code, 'validation-error');

  // 不依赖具体日历：先找本周周一，再派生周末 / 午休 / 收盘后。
  const anchor = new Date(2026, 10, 11, 10, 0);
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7));
  assert.equal(isTradingHours(monday), true);
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  assert.equal(isTradingHours(saturday), false);
  const lunch = new Date(monday);
  lunch.setHours(12, 0, 0, 0);
  assert.equal(isTradingHours(lunch), false);
  const afterClose = new Date(monday);
  afterClose.setHours(15, 30, 0, 0);
  assert.equal(isTradingHours(afterClose), false);
});

test('输入错误分类：CSV 表头 / 模板权重 → 422，资源不存在 → 404，均非 500', async () => {
  const badCsv = await dispatch(ctx, 'preview_import_transactions', { csv: '日期,方向,数量\n' });
  assert.equal(badCsv.status, 422);
  assert.equal(badCsv.envelope.error?.code, 'validation-error');

  const badRules = await dispatch(ctx, 'save_strategy_template', {
    name: '权重错误', scope: 'ALL', metrics: [{ key: 'pe', label: 'PE', weight: 30, direction: 'lower-better', favorableAt: 10, adverseAt: 30, required: true }],
  });
  assert.equal(badRules.status, 422);
  assert.equal(badRules.envelope.error?.code, 'validation-error');

  const missing = await dispatch(ctx, 'get_position_detail', { positionId: '不存在:不存在' });
  assert.equal(missing.status, 404);
  assert.equal(missing.envelope.error?.code, 'not-found');
});
