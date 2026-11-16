import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { archiveIndexQuotePe, effectivePrice, latestValuationMetrics, metricHistory, saveMarketPoints, saveValuationMetric } from '../server/src/repo/market.ts';
import { createRegistry, type MarketProvider } from '../server/src/market/provider.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { getIndexAnalytics } from '../server/src/services/index-analytics.ts';
import { getHoldingsValuation } from '../server/src/services/valuation-view.ts';
import { refreshMarketData } from '../server/src/services/refresh.ts';
import type { ServiceContext } from '../server/src/context.ts';
import type { DataQuality, MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-13';
function setup() {
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: '.tmp/data-correctness-tests' } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  const ctx: ServiceContext = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
  const instrument = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  const metric = (key: string, value: string | null, date = TODAY, provider = 'csindex', quality: DataQuality = 'FRESH') => {
    saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: key, value, asOfDate: date, provider, quality });
  };
  const prices = (rows: Partial<MarketPoint>[]) => saveMarketPoints(handle, rows.map((row) => ({
    instrumentId: instrument.id, priceType: 'CLOSE_PRICE', value: '100', currency: 'CNY', tradingDate: TODAY,
    observedAt: `${TODAY}T07:00:00Z`, provider: 'tencent', quality: 'FRESH', ...row,
  })) as MarketPoint[]);
  return { handle, ctx, instrument, metric, prices };
}

test('官方 PE 不被较新报价遮挡，错日分位及空字符串不进入有效读数', () => {
  const { handle, instrument, metric } = setup();
  try {
    metric('pe', '12', '2026-11-11');
    metric('pe', '90', TODAY, 'tencent');
    metric('pe_percentile', '100', TODAY, 'derived');
    metric('pb', ' ', TODAY);
    metric('pb', '2', '2026-11-14');
    const values = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
    assert.equal(values.get('pe')?.value, '12');
    assert.equal(values.has('pe_percentile'), false);
    assert.equal(values.get('pb')?.value, ' ');
    assert.deepEqual(metricHistory(handle, instrument.id, 'pe', undefined, TODAY).map((row) => row.value), [12]);
    assert.deepEqual(metricHistory(handle, instrument.id, 'pb', undefined, TODAY), []);
  } finally { handle.db.close(); }
});

test('报价迁移保留冲突双方证据，只清理受影响的派生分位并可重复运行', () => {
  const { handle, instrument, metric } = setup();
  try {
    metric('pe_quote', '80', TODAY, 'tencent');
    metric('pe', '90', TODAY, 'eastmoney');
    metric('pe_percentile', '100', TODAY, 'derived');
    metric('pe', '12', '2026-11-11');
    metric('pe_percentile', '50', '2026-11-11', 'derived');
    archiveIndexQuotePe(handle, instrument.id);
    archiveIndexQuotePe(handle, instrument.id);
    assert.deepEqual(metricHistory(handle, instrument.id, 'pe_quote').map((row) => row.value), [80]);
    assert.deepEqual(metricHistory(handle, instrument.id, 'pe_percentile').map((row) => row.value), [50]);
    const logs = handle.db.prepare("SELECT note FROM data_source_runs WHERE note LIKE '%index-quote-pe-archive%'").all() as { note: string }[];
    assert.equal(logs.length, 1);
    const evidence = JSON.parse(logs[0].note);
    assert.equal(evidence.quoteCollisions[0].existing.value, '80');
    assert.equal(evidence.quoteCollisions[0].incoming.value, '90');
    assert.equal(evidence.removedDerivedPercentiles[0].value, '100');
  } finally { handle.db.close(); }
});

test('指数 PE 说明区分官方、报价与手工，按 PE 自身日期标注', async () => {
  for (const [provider, label] of [['csindex', /中证官方滚动口径/], ['tencent', /报价口径（tencent）/], ['manual', /手工补录，口径待核实/]] as const) {
    const { handle, ctx, metric } = setup();
    try {
      metric('dividend_yield', '2', TODAY);
      metric('pe', '12', '2026-11-11', provider);
      const row = (await getHoldingsValuation(ctx, { scope: 'all' })).rows[0];
      assert.match(row.caliber, label);
      assert.match(row.caliber, /2026-11-11/);
      if (provider !== 'csindex') assert.doesNotMatch(row.caliber, /PE 中证官方滚动口径/);
    } finally { handle.db.close(); }
  }
});

test('超过 7 天、错期或冲突的分位不再参与策略评分，7 天边界仍可用', async () => {
  for (const [date, quality, expected] of [
    ['2026-11-05', 'FRESH', null], ['2026-11-06', 'FRESH', 25], [TODAY, 'CONFLICT', null],
  ] as const) {
    const { handle, ctx, metric } = setup();
    try {
      metric('pe', '12', date);
      metric('pe_percentile', '25', date, 'derived', quality);
      const row = (await getHoldingsValuation(ctx, { scope: 'all' })).rows[0];
      assert.equal(row.pePercentile, expected);
      assert.ok(row.strategies.every((strategy) => strategy.metrics.find((entry) => entry.key === 'pe_percentile')?.value === expected));
    } finally { handle.db.close(); }
  }
});

test('指数分位拒绝短窗口，YTD 以年末收盘基准计算，并明确盘中点位类型', () => {
  const { handle, ctx, metric, prices } = setup();
  try {
    prices([
      { tradingDate: '2025-12-31', value: '100' },
      { tradingDate: '2026-01-05', value: '110' },
      { tradingDate: TODAY, priceType: 'REALTIME_PRICE', value: '120' },
    ]);
    for (let i = 1; i <= 25; i++) metric('pe', String(i), `2026-10-${String(i).padStart(2, '0')}`);
    metric('roe', '10', '2023-11-01');
    metric('roe', '30', '2025-11-01');
    metric('roe', '99', '2026-11-01');
    const row = getIndexValuation(ctx).rows[0];
    assert.ok(Math.abs((row.ytdReturn as number) - 20) < 1e-9);
    assert.equal(row.pe.percentile, null);
    assert.equal(row.pe.asOfDate, '2026-10-25');
    assert.deepEqual(row.roe, [10, null, 30], '缺失的 2024 年不应被其他年份挤占');
    assert.equal(row.priceType, 'REALTIME_PRICE');
    assert.equal(row.priceDate, TODAY);
    assert.ok(Math.abs((getIndexAnalytics(ctx).rows[0].returns.ytd as number) - 0.2) < 1e-9);
  } finally { handle.db.close(); }
});

test('YTD 缺少年末基准或只有年末盘中价时两处视图均留空', () => {
  for (const baseline of [
    { tradingDate: '2025-11-30', priceType: 'CLOSE_PRICE' },
    { tradingDate: '2025-12-31', priceType: 'REALTIME_PRICE' },
    { tradingDate: '2026-01-05', priceType: 'CLOSE_PRICE' },
  ] as const) {
    const { handle, ctx, prices } = setup();
    try {
      prices([{ ...baseline, value: '100' }, { value: '120' }]);
      assert.equal(getIndexValuation(ctx).rows[0].ytdReturn, null);
      assert.equal(getIndexAnalytics(ctx).rows[0].returns.ytd, null);
    } finally { handle.db.close(); }
  }
});

test('分析中的 null/空串估值保持缺失，换手率按百分数口径转为比例', () => {
  const { handle, ctx, metric, prices } = setup();
  try {
    prices([{ value: '120' }]);
    metric('pe', null);
    metric('pb', ' ');
    metric('turnover_rate', '0.33', TODAY, 'tencent');
    const row = getIndexAnalytics(ctx).rows[0];
    assert.equal(row.pe, null);
    assert.equal(row.pb, null);
    assert.equal(row.turnover, 0.0033);
  } finally { handle.db.close(); }
});

test('刷新保存发生冲突的双方报价，读取质量不被 FRESH 掩盖', async () => {
  const { handle, ctx } = setup();
  const instrument = saveInstrument(handle, { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH' });
  const provider = (id: string, value: string): MarketProvider => ({
    id, supports: () => true,
    fetchQuote: async () => ({ instrumentId: instrument.id, priceType: 'REALTIME_PRICE', value, currency: 'CNY',
      tradingDate: TODAY, observedAt: `${TODAY}T05:00:00Z`, provider: id, quality: 'FRESH' }),
    fetchHistory: async () => [],
  });
  ctx.registry = createRegistry([provider('tencent', '100'), provider('eastmoney', '110')]);
  try {
    const result = await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
    assert.equal(result.results[0].quotes, 2);
    const saved = handle.db.prepare('SELECT provider, quality FROM market_data WHERE instrument_id = ? ORDER BY provider').all(instrument.id);
    assert.deepEqual(saved.map((row) => [row.provider, row.quality]), [['eastmoney', 'CONFLICT'], ['tencent', 'CONFLICT']]);
    assert.equal(effectivePrice(handle, instrument, TODAY)?.quality, 'CONFLICT');
  } finally { handle.db.close(); }
});
