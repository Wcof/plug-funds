/**
 * 中证官方估值 → 刷新链路：用 fixture 顶替网络，验证指标真的落库、且不覆盖报价端 pe。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry, type MarketProvider } from '../server/src/market/provider.ts';
import { refreshMarketData } from '../server/src/services/refresh.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { latestValuationMetrics, metricHistory, saveValuationMetric } from '../server/src/repo/market.ts';
import type { Instrument, MarketPoint } from '../core/src/types.ts';
import type { ServiceContext } from '../server/src/context.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixtures', '000300indicator.xls'));
const TODAY = '2026-11-13';

function point(instrumentId: string, value: string): MarketPoint {
  return {
    instrumentId, priceType: 'CLOSE_PRICE', value, currency: 'CNY',
    tradingDate: TODAY, observedAt: `${TODAY}T15:00:00Z`, provider: 'stub', quality: 'FRESH',
  };
}

/** 只报价、只给 PE 的桩 Provider：模拟腾讯在指数上的行为。 */
function stubProvider(): MarketProvider {
  return {
    id: 'stub',
    supports: (instrument: Instrument) => instrument.type === 'INDEX',
    async fetchQuote(instrument) { return point(instrument.id, '3993.3500'); },
    async fetchHistory() { return []; },
    async fetchMetrics(instrument) {
      return [{ metricKey: 'pe', value: '13.45', asOfDate: TODAY, quality: 'FRESH' as const }];
    },
  };
}

function makeCtx(): { ctx: ServiceContext; handle: DbHandle } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-csindex-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  return { ctx: { handle, dirs, registry: createRegistry([stubProvider()]), today: TODAY, hideAmount: false }, handle };
}

test('刷新指数：中证官方 PE / 股息率落库，报价端 pe 不被覆盖', async () => {
  const { ctx, handle } = makeCtx();
  const instrument = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH', secid: '1.000300' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(fixture, { status: 200 })) as typeof globalThis.fetch;
  try {
    const { results } = await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.ok(results[0].providers.includes('csindex'), '中证源应出现在参与源里');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const metrics = new Map(latestValuationMetrics(handle, instrument.id).map((m) => [m.metricKey, m]));
  assert.equal(metrics.get('pe')?.value, '13.45', '报价端口径的 pe 必须保持不变');
  assert.equal(metrics.get('pe')?.provider, 'stub');
  assert.ok(metrics.has('pe_official'), '官方 PE2 应落在独立键');
  assert.ok(metrics.has('pe_official_total_share'), '官方 PE1 应落在独立键');
  assert.ok(metrics.has('dividend_yield_calc_share'), 'XLS 计算用股本股息率必须独立落库');
  assert.equal(metrics.get('dividend_yield_calc_share')?.provider, 'csindex');
  assert.ok(Number(metrics.get('dividend_yield_calc_share')?.value) > 0);
  assert.equal(metrics.has('dividend_yield'), false, 'JSON 覆盖指数不能在 JSON 失败时改用 XLS 主股息率');

  // 20 个交易日的截面全部写入，供分位累积
  assert.equal(metricHistory(handle, instrument.id, 'pe_official').length, 20);
  assert.equal(metricHistory(handle, instrument.id, 'dividend_yield_calc_share').length, 20);
  // 跨度仅 30 天左右 → 分位守卫必须拦住，不许写「近 3 年分位」
  assert.equal(metricHistory(handle, instrument.id, 'pe_official_percentile').length, 0);
  assert.equal(metricHistory(handle, instrument.id, 'pe_percentile').length, 0, '样本跨度 <180 天时不得产生分位');
});

test('刷新指数：中证限流时整条链路不崩，报价与 PE 照常入库', async () => {
  const { ctx, handle } = makeCtx();
  const instrument = saveInstrument(handle, { code: '000905', name: '中证500', type: 'INDEX', market: 'SH', secid: '1.000905' });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('<html>403</html>', { status: 403 })) as typeof globalThis.fetch;
  try {
    const { results } = await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
    assert.equal(results[0].ok, true, '官方源失败不能拖垮整条刷新');
    assert.ok(!results[0].providers.includes('csindex'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const metrics = new Map(latestValuationMetrics(handle, instrument.id).map((m) => [m.metricKey, m]));
  assert.equal(metrics.get('pe')?.value, '13.45');
  assert.equal(metrics.has('dividend_yield'), false, '拿不到就是拿不到，不许编一个股息率');
});

test('刷新指数：官方 JSON 估值落库，报价端 pe 让位（口径差 12%+）', async () => {
  const { ctx, handle } = makeCtx();
  const instrument = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH', secid: '1.000300' });

  // 25 个截面跨 2 年，满足「样本 ≥20 + 跨度 ≥180 天」分位守卫
  const history = Array.from({ length: 25 }, (_, i) => {
    const d = new Date('2024-11-11T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return { tradeDate: d.toISOString().slice(0, 10).replace(/-/g, ''), indexName: '沪深300', indexNameEn: 'CSI 300', peg: 12 + i * 0.1 };
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('data-service/indexValuation')) {
      return new Response(JSON.stringify({
        code: '200', msg: 'Success',
        data: {
          tradeDate: '20261111',
          indexValuations: [{
            tradeDate: '20261111', indexName: '沪深300',
            pe: 13.83, peg: 13.14, pb: 1.29, dp: 3.03,
            peLastYear: 14.5, pegLastYear: 14.1, pbLastYear: 1.4,
          }],
        },
      }), { status: 200 });
    }
    if (href.includes('indexCsiDsPe')) {
      return new Response(JSON.stringify({ code: '200', msg: 'Success', data: history }), { status: 200 });
    }
    return new Response('<html>403</html>', { status: 403 });
  }) as typeof globalThis.fetch;

  try {
    const { results } = await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
    assert.equal(results[0].ok, true);
    assert.ok(results[0].providers.includes('csindex'));
  } finally {
    globalThis.fetch = originalFetch;
  }

  const metrics = new Map(latestValuationMetrics(handle, instrument.id).map((m) => [m.metricKey, m]));
  assert.equal(metrics.get('pe')?.value, '13.14', '指数的 pe 采用中证官方滚动口径');
  assert.equal(metrics.get('pe')?.provider, 'csindex');
  assert.equal(metrics.get('pe_official_static')?.value, '13.83');
  assert.equal(metrics.get('pb')?.value, '1.29', '官方 PB 是指数唯一真实 PB 来源');
  assert.equal(metrics.get('dividend_yield')?.value, '3.03');
  assert.equal(metricHistory(handle, instrument.id, 'pe').length, 25, '官方 PE 历史应沉淀供分位使用');
  assert.equal(metricHistory(handle, instrument.id, 'pe_percentile').length, 1, '跨度够长时应产生分位');
  assert.notEqual(metrics.get('pe')?.value, '13.45', '报价端 pe 不得覆盖官方值');
});

test('刷新指数：库里已有更新的报价端 pe 时，官方历史仍要回填', async () => {
  const { ctx, handle } = makeCtx();
  const instrument = saveInstrument(handle, { code: '000016', name: '上证50', type: 'INDEX', market: 'SH', secid: '1.000016' });
  // 模拟「昨天刷新时官方源失败、报价端先写了今天这一条」
  saveValuationMetric(handle, {
    instrumentId: instrument.id, metricKey: 'pe', value: '11.77',
    asOfDate: TODAY, provider: 'stub', quality: 'FRESH',
  });

  const history = Array.from({ length: 25 }, (_, i) => {
    const d = new Date('2024-11-11T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return { tradeDate: d.toISOString().slice(0, 10).replace(/-/g, ''), indexName: '上证50', indexNameEn: 'SSE 50', peg: 10 + i * 0.1 };
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('dataStructure')) return new Response('', { status: 404 });
    if (href.includes('data-service/indexValuation')) {
      return new Response(JSON.stringify({
        code: '200', msg: 'Success',
        data: { tradeDate: '20261111', indexValuations: [{ tradeDate: '20261111', indexName: '上证50', pe: 11.91, peg: 11.63, pb: 1.14, dp: 3.65 }] },
      }), { status: 200 });
    }
    if (href.includes('indexCsiDsPe')) return new Response(JSON.stringify({ code: '200', msg: 'Success', data: history }), { status: 200 });
    return new Response('<html>403</html>', { status: 403 });
  }) as typeof globalThis.fetch;

  try {
    await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(metricHistory(handle, instrument.id, 'pe').length, 25, '只保留 25 条官方历史，不混入报价口径');
  assert.equal(metricHistory(handle, instrument.id, 'pe_quote').length, 1, '报价端旧值迁移后继续留存报价证据');
  const official = metricHistory(handle, instrument.id, 'pe').filter((p) => p.asOfDate <= '2026-11-11');
  assert.equal(official.length, 25, '官方序列必须真正落库，不能被「报价端更新」挡住');
});

test('分位窗口按基础指标日期锚定，刷新与指数视图保留边界样本且执行来源及跨度守卫', async () => {
  const baseDate = '2026-11-11';
  const monthly = Array.from({ length: 18 }, (_, i) => {
    const date = new Date('2024-01-11T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + i);
    return date.toISOString().slice(0, 10);
  });
  const scenarios = [
    { dates: ['2023-11-11', ...monthly, baseDate], expected: 5, name: '20 个官方样本，含三年前同日边界' },
    { dates: [...monthly, baseDate], expected: null, name: '19 个官方样本，报价不得补足' },
    { dates: [...Array.from({ length: 19 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`), baseDate], expected: null, name: '20 个样本但跨度不足 180 天' },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes('data-service/indexValuation')) return new Response(JSON.stringify({ code: '200', data: {
      tradeDate: '20261111', indexValuations: [{ tradeDate: '20261111', indexName: '沪深300', pe: 13.83, peg: 13.14, pb: 1.29, dp: 3.03 }],
    } }), { status: 200 });
    if (href.includes('indexCsiDsPe')) return new Response(JSON.stringify({ code: '200', data: [] }), { status: 200 });
    return new Response('<html>403</html>', { status: 403 });
  }) as typeof globalThis.fetch;
  try {
    for (const scenario of scenarios) {
      const { ctx, handle } = makeCtx();
      try {
        const instrument = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
        for (const date of scenario.dates) for (const key of ['pe', 'pb']) {
          saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: key,
            value: date === baseDate ? (key === 'pe' ? '13.14' : '1.29') : (key === 'pe' ? '20' : '2'),
            asOfDate: date, provider: 'csindex', quality: 'FRESH' });
        }
        // 截面前三年的前一天不得进入窗口；混入的报价 PE 不能凑足官方样本。
        for (const key of ['pe', 'pb']) saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: key,
          value: '1', asOfDate: '2023-11-10', provider: 'csindex', quality: 'FRESH' });
        saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'pe', value: '1',
          asOfDate: '2025-10-20', provider: 'stub', quality: 'FRESH' });
        await refreshMarketData(ctx, { instrumentIds: [instrument.id] });
        const current = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
        const view = getIndexValuation(ctx, { years: 3 }).rows[0];
        for (const key of ['pe', 'pb'] as const) {
          const metric = current.get(`${key}_percentile`);
          assert.equal(metric?.value ?? null, scenario.expected === null ? null : '5.00', `${scenario.name}：${key} 刷新`);
          assert.equal(view[key].percentile, scenario.expected, `${scenario.name}：${key} 指数视图`);
          if (metric) assert.equal(metric.asOfDate, baseDate);
        }
      } finally { handle.db.close(); }
    }
  } finally { globalThis.fetch = originalFetch; }
});
