/**
 * 服务层集成测试：隔离状态目录 + Fixture Provider（无网络）。
 * 覆盖：账户/标的/交易 CRUD、回放与超卖回滚、幂等、双模式分布、
 * 图表序列、估值视图、掩码开关、导出、schema 护栏。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, SchemaError, type DbHandle } from '../server/src/db.ts';
import { resolveStateDirs } from '../server/src/db.ts';
import { createRegistry, type MarketProvider } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import type { ServiceContext } from '../server/src/context.ts';
import { SCALE_QTY, parseFixed } from '../core/src/money.ts';
import { SCHEMA_VERSION, type Instrument, type MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-13';

function tradingDates(count: number, end = TODAY): string[] {
  const dates: string[] = [];
  const d = new Date(`${end}T00:00:00Z`);
  while (dates.length < count) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) dates.unshift(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return dates;
}

/** Fixture Provider：确定性价格序列（今日收盘 41.25，逐日微涨），指标已知。 */
function fixtureProvider(): MarketProvider {
  const dates = tradingDates(260);
  const historyFor = (instrument: Instrument, seed: number): MarketPoint[] => {
    const isFund = instrument.type === 'OPEN_END_FUND';
    const priceType = isFund ? 'OFFICIAL_NAV' : 'CLOSE_PRICE';
    const base = isFund ? 1.2 : 38 + seed * 0.5;
    return dates.map((date, i) => ({
      instrumentId: instrument.id,
      priceType: priceType as MarketPoint['priceType'],
      value: (base * (1 + (i % 7) * 0.002)).toFixed(4),
      currency: 'CNY',
      tradingDate: date,
      observedAt: `${date}T15:32:08Z`,
      provider: 'fixture',
      quality: 'FRESH',
    }));
  };
  return {
    id: 'fixture',
    supports: (instrument) => Boolean(instrument.secid || instrument.fundCode),
    async fetchQuote(instrument) {
      const isFund = instrument.type === 'OPEN_END_FUND';
      const last = historyFor(instrument, instrument.code.charCodeAt(0) % 9).at(-1)!;
      return {
        ...last,
        priceType: (isFund ? 'OFFICIAL_NAV' : 'REALTIME_PRICE') as MarketPoint['priceType'],
        tradingDate: TODAY,
        observedAt: `${TODAY}T15:32:08Z`,
      };
    },
    async fetchHistory(instrument) {
      return historyFor(instrument, instrument.code.charCodeAt(0) % 9);
    },
    async fetchMetrics(instrument) {
      if (instrument.type === 'OPEN_END_FUND') return []; // 主动基金不提供穿透
      return [
        { metricKey: 'pe', value: '7.8', asOfDate: TODAY, quality: 'FRESH' },
        { metricKey: 'pb', value: '0.92', asOfDate: TODAY, quality: 'FRESH' },
        { metricKey: 'dividend_yield', value: '4.2', asOfDate: TODAY, quality: 'FRESH' },
        { metricKey: 'roe', value: '15.9', asOfDate: TODAY, quality: 'FRESH' },
        { metricKey: 'pe_percentile', value: '18.2', asOfDate: TODAY, quality: 'FRESH' },
        { metricKey: 'pb_percentile', value: '22.4', asOfDate: TODAY, quality: 'FRESH' },
      ];
    },
  };
}

let dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: '' } as never);
let handle!: DbHandle;
let ctx!: ServiceContext;

function makeCtx(): ServiceContext {
  return { handle, dirs, registry: createRegistry([fixtureProvider()]), today: TODAY, hideAmount: false };
}

async function rpc(method: string, params: Record<string, unknown> = {}) {
  return dispatch(ctx, method, params);
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-test-'));
  dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs);
  ctx = makeCtx();
});

test('get_app_info：新库初始化与引擎标识', async () => {
  const result = await rpc('get_app_info');
  assert.equal(result.status, 200);
  assert.equal(result.envelope.success, true);
  assert.equal((result.envelope.data as { schemaVersion: number }).schemaVersion, SCHEMA_VERSION);
  assert.equal((result.envelope.data as { engine: string }).engine, 'sqlite');
  assert.equal((result.envelope.data as { isNew: boolean }).isNew, true);
});

test('账本全链路：建仓 → 市值 → 持仓列表 → 清仓后已实现保留', async () => {
  const account = await rpc('save_account', { name: '华宝证券', platform: '券商' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036', tag: '银行红利' });
  const insId = (ins.envelope.data as { id: string }).id;

  const opening = await rpc('record_transaction', {
    accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20',
    quantity: '300', amount: '11550.00',
  });
  assert.equal(opening.status, 200);
  const refresh = await rpc('refresh_market_data', {});
  assert.equal(refresh.status, 200);
  assert.ok((refresh.envelope.data as { results: { ok: boolean }[] }).results.every((r) => r.ok));

  const positions = await rpc('list_positions', {});
  const row = (positions.envelope.data as { rows: { marketValue: string; price: string; weight: number }[] }).rows[0];
  assert.ok(row);
  assert.ok(row.marketValue !== null); // Fixture 提供了价格
  assert.ok(row.weight !== null && row.weight > 0);

  // 全部卖出 → 已实现保留
  await rpc('record_transaction', {
    accountId: accId, instrumentId: insId, type: 'SELL', tradeDate: '2026-11-12',
    quantity: '300', price: '41.25', fee: '5.00',
  });
  const after = await rpc('list_positions', {});
  const afterRow = (after.envelope.data as { rows: { marketValue: string | null; realized: string }[] }).rows[0];
  assert.equal(afterRow.marketValue, '0');
  assert.notEqual(afterRow.realized, '0');
});

test('超卖被拒绝且写入回滚', async () => {
  const account = await rpc('save_account', { name: '测试账户' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600519', name: '贵州茅台', type: 'STOCK', market: 'SH', secid: '1.600519' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-01', quantity: '10', amount: '11800.00' });

  const before = await rpc('list_transactions', { instrumentId: insId });
  const beforeCount = (before.envelope.data as unknown[]).length;

  const oversell = await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'SELL', tradeDate: '2026-11-12', quantity: '20', price: '1200' });
  assert.equal(oversell.status, 422);
  assert.equal((oversell.envelope.error as { code: string }).code, 'oversell');

  const after = await rpc('list_transactions', { instrumentId: insId });
  assert.equal((after.envelope.data as unknown[]).length, beforeCount); // 回滚
});

test('requestId 幂等：同键导入只写一次', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '510300', name: '沪深300ETF', type: 'ETF', market: 'SH', secid: '1.510300' });
  const insId = (ins.envelope.data as { id: string }).id;
  const input = { accountId: accId, instrumentId: insId, type: 'BUY', tradeDate: '2026-11-12', quantity: '2000', price: '1.50', requestId: 'import-row-1' };
  const first = await rpc('record_transaction', input);
  const second = await rpc('record_transaction', input);
  assert.equal((first.envelope.data as { deduplicated: boolean }).deduplicated, false);
  assert.equal((second.envelope.data as { deduplicated: boolean }).deduplicated, true);
  const txns = await rpc('list_transactions', { instrumentId: insId });
  assert.equal((txns.envelope.data as unknown[]).length, 1);
});

test('双模式资产分布：目标未达成出现灰色待达成，分母口径分离', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });
  await rpc('refresh_market_data', {});

  const full = await rpc('get_dashboard_allocation', { mode: 'full' });
  assert.equal(full.status, 200);
  const fullData = full.envelope.data as { mode: string; segments: { gray?: boolean }[] };
  assert.equal(fullData.mode, 'full');
  assert.ok(fullData.segments.every((s) => !s.gray));

  const goal = await rpc('save_portfolio_goal', { name: '目标', targetAmount: '1000000.00', enabled: true });
  assert.equal(goal.status, 200);
  const goalMode = await rpc('get_dashboard_allocation', { mode: 'goal' });
  const goalData = goalMode.envelope.data as { mode: string; remainingAmount: string | null; progressRatio: number | null };
  assert.equal(goalData.mode, 'goal');
  assert.ok(goalData.remainingAmount !== null);
  assert.ok((goalData.progressRatio ?? 0) < 1);
});

test('图表序列：业绩走势带买卖标记与成本线', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'BUY', tradeDate: '2026-11-05', quantity: '100', price: '40' });
  await rpc('refresh_market_data', {});

  const chart = await rpc('get_instrument_chart_series', { instrumentId: insId, tab: 'perf', period: '3m', compare: 'none' });
  const data = chart.envelope.data as { series: unknown[]; markers: { type: string }[]; costLine: string | null };
  assert.ok(data.series.length >= 20);
  assert.equal(data.markers.filter((m) => m.type === 'buy').length, 2);
  assert.ok(data.costLine !== null);
});

test('估值视图：主动基金数据不足；个股可评分', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const stock = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const fund = await rpc('save_instrument', { code: '161005', name: '富国天惠成长混合A', type: 'OPEN_END_FUND', market: 'OTC', fundCode: '161005' });
  const stockId = (stock.envelope.data as { id: string }).id;
  const fundId = (fund.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: stockId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });
  await rpc('record_transaction', { accountId: accId, instrumentId: fundId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '2702.70', amount: '4850.00' });
  await rpc('refresh_market_data', {});

  const valuation = await rpc('get_holdings_valuation', {});
  const rows = (valuation.envelope.data as { rows: { code: string; strategies: { level: string; total: number | null }[]; pe: string | null }[] }).rows;
  const stockRow = rows.find((r) => r.code === '600036')!;
  const fundRow = rows.find((r) => r.code === '161005')!;
  assert.equal(stockRow.pe, '7.8');
  const stockScore = stockRow.strategies[0];
  assert.equal(stockScore.level, '优先研究'); // PE 分位 18.2 / 股息 4.2 / ROE 15.9 全部有利
  assert.ok(stockScore.total !== null && stockScore.total >= 80);
  const fundScore = fundRow.strategies[0];
  assert.equal(fundScore.level, '数据不足'); // 主动基金无穿透指标
});

test('隐藏金额开关：掩码即时生效且可恢复', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });
  await rpc('refresh_market_data', {});

  await rpc('set_hide_amount', { enabled: true });
  const masked = await rpc('list_positions', {});
  const maskedRow = (masked.envelope.data as { rows: { marketValue: string; price: string; qty: string }[] }).rows[0];
  assert.equal(maskedRow.marketValue, '****');
  assert.notEqual(maskedRow.price, '****'); // 价格不受掩码影响
  assert.notEqual(maskedRow.qty, '****');

  await rpc('set_hide_amount', { enabled: false });
  const unmasked = await rpc('list_positions', {});
  const unmaskedRow = (unmasked.envelope.data as { rows: { marketValue: string }[] }).rows[0];
  assert.notEqual(unmaskedRow.marketValue, '****');
});

test('导出：JSON 全量 + CSV 持仓', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });

  const backup = await rpc('export_backup', {});
  const payload = backup.envelope.data as { kind: string; transactions: unknown[] };
  assert.equal(payload.kind, 'plug-funds-backup');
  assert.equal(payload.transactions.length, 1);

  const csv = await rpc('export_holdings_csv', {});
  assert.match((csv.envelope.data as { csv: string }).csv, /招商银行/);
});

test('schema 护栏：高版本数据拒绝打开（先升插件）', () => {
  assert.throws(() => {
    const probeDirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: path.join(dirs.root, 'probe') } as NodeJS.ProcessEnv);
    const probe = openState(probeDirs);
    probe.db.prepare(`UPDATE meta SET value = '999' WHERE key = 'schema_version'`).run();
    probe.db.close();
    openState(probeDirs);
  }, (error: unknown) => error instanceof SchemaError && error.code === 'schema-too-new');
});

test('删除持仓：屏蔽视图、流水保留、重新建仓恢复', async () => {
  const account = await rpc('save_account', { name: 'A' });
  const accId = (account.envelope.data as { id: string }).id;
  const ins = await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  const insId = (ins.envelope.data as { id: string }).id;
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '100', amount: '4000.00' });

  await rpc('delete_position', { positionId: `${accId}:${insId}` });
  const afterDelete = await rpc('list_positions', {});
  assert.equal(((afterDelete.envelope.data as { rows: unknown[] }).rows.length), 0);

  const txns = await rpc('list_transactions', { instrumentId: insId });
  assert.equal((txns.envelope.data as unknown[]).length, 1); // 流水保留

  // 重新建仓 → 恢复持仓视图；流水是事实源，回放 = 旧 100 + 新 50 = 150
  await rpc('record_transaction', { accountId: accId, instrumentId: insId, type: 'OPENING', tradeDate: '2026-11-13', quantity: '50', amount: '2000.00' });
  const restored = await rpc('list_positions', {});
  assert.equal((restored.envelope.data as { rows: { qty: string }[] }).rows.length, 1);
  assert.equal((restored.envelope.data as { rows: { qty: string }[] }).rows[0].qty, '150');
});

test('未支持方法返回 unknown-method', async () => {
  const result = await rpc('no_such_method');
  assert.equal(result.status, 404);
  assert.equal((result.envelope.error as { code: string }).code, 'unknown-method');
});
