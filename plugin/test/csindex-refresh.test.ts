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
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { latestValuationMetrics, metricHistory } from '../server/src/repo/market.ts';
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
  assert.ok(metrics.has('dividend_yield'), '股息率只有官方源提供，必须落库');
  assert.equal(metrics.get('dividend_yield')?.provider, 'csindex');
  assert.ok(Number(metrics.get('dividend_yield')?.value) > 0);

  // 20 个交易日的截面全部写入，供分位累积
  assert.equal(metricHistory(handle, instrument.id, 'pe_official').length, 20);
  assert.equal(metricHistory(handle, instrument.id, 'dividend_yield').length, 20);
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
