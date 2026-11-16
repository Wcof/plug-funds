import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { latestValuationMetrics, metricHistory, saveValuationMetric } from '../server/src/repo/market.ts';
import { parseCsindexIndicator, readOleWorkbook } from '../server/src/market/csindex.ts';
import { refreshMarketData } from '../server/src/services/refresh.ts';
import type { ServiceContext } from '../server/src/context.ts';

const fixture = fs.readFileSync(new URL('./fixtures/000300indicator.xls', import.meta.url));
const raw = parseCsindexIndicator(readOleWorkbook(fixture))[0];
const TODAY = '2026-11-13';

function setup(code = '000300', name = '沪深300') {
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: '.tmp/csindex-dividend-tests' } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  const instrument = saveInstrument(handle, { code, name, type: 'INDEX', market: 'SH' });
  const registry = createRegistry([{ id: 'stub', supports: () => true, fetchQuote: async () => null, fetchHistory: async () => [] }]);
  const ctx: ServiceContext = { handle, dirs, registry, today: TODAY, hideAmount: false };
  const metric = (key: string, value: string, provider = 'csindex') => saveValuationMetric(handle, {
    instrumentId: instrument.id, metricKey: key, value, asOfDate: raw.tradeDate, provider, quality: 'FRESH',
  });
  return { handle, ctx, instrument, metric };
}

async function withSource(mode: 'json' | 'failed' | 'absent', run: () => Promise<void>, xls = fixture) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.endsWith('indicator.xls')) return new Response(xls, { status: 200 });
    if (href.includes('data-service/indexValuation')) {
      if (mode === 'failed') return new Response('service unavailable', { status: 503 });
      return new Response(JSON.stringify({ code: '200', data: { tradeDate: '20261111', indexValuations: mode === 'absent' ? [] : [
        { tradeDate: '20261111', indexName: '沪深300', pe: 13.83, peg: 13.14, pb: 1.29, dp: 3.03 },
      ] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: '200', data: [] }), { status: 200 });
  }) as typeof globalThis.fetch;
  try { await run(); } finally { globalThis.fetch = originalFetch; }
}

test('XLS 先成功也不占主股息率：JSON 主值与两种股本原值分别保存', async () => {
  const { handle, ctx, instrument } = setup();
  try {
    await withSource('json', async () => { await refreshMarketData(ctx, { instrumentIds: [instrument.id] }); });
    const metrics = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
    assert.equal(metrics.get('dividend_yield')?.value, '3.03');
    assert.equal(metrics.get('dividend_yield')?.provider, 'csindex');
    assert.equal(metrics.get('dividend_yield_calc_share')?.value, '2.67');
    assert.equal(metrics.get('dividend_yield_total_share')?.value, '3.03');
    assert.equal(metricHistory(handle, instrument.id, 'dividend_yield').length, 1, '主键不能混入 XLS 的历史口径');
    assert.equal(metricHistory(handle, instrument.id, 'dividend_yield_calc_share').length, 20);
  } finally { handle.db.close(); }
});

test('JSON 失败或返回缺行时，已有快照主股息率不被 XLS 静默覆盖', async () => {
  for (const mode of ['failed', 'absent'] as const) {
    const { handle, ctx, instrument, metric } = setup();
    try {
      metric('dividend_yield', '3.03');
      await withSource(mode, async () => { await refreshMarketData(ctx, { instrumentIds: [instrument.id] }); });
      const metrics = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
      assert.equal(metrics.get('dividend_yield')?.value, '3.03', mode);
      assert.equal(metrics.get('dividend_yield')?.provider, 'csindex');
      assert.equal(metrics.get('dividend_yield_calc_share')?.value, String(raw.dividendCalcShare));
    } finally { handle.db.close(); }
  }
});

// 仅改测试原件中等长的身份文本，保留真实数值、列名和 OLE2/BIFF8 结构。
const nonSnapshotFixture = Buffer.from(fixture);
for (const [from, to, encoding] of [['000300', '000852', 'ascii'], ['沪深300', '中证千指A', 'utf16le']] as const) {
  const needle = Buffer.from(from, encoding);
  const replacement = Buffer.from(to, encoding);
  for (let offset = nonSnapshotFixture.indexOf(needle); offset >= 0; offset = nonSnapshotFixture.indexOf(needle, offset + replacement.length)) {
    replacement.copy(nonSnapshotFixture, offset);
  }
}

test('非 JSON 覆盖指数以 XLS 兜底时明确计算用股本来源，原始键继续留存', async () => {
  const { handle, ctx, instrument, metric } = setup('000852', '中证千指A');
  try {
    assert.equal(parseCsindexIndicator(readOleWorkbook(nonSnapshotFixture))[0].code, instrument.code);
    metric('dividend_yield', '2.60'); // 旧版没有细分来源的 XLS 主值。
    await withSource('absent', async () => { await refreshMarketData(ctx, { instrumentIds: [instrument.id] }); }, nonSnapshotFixture);
    const metrics = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
    assert.equal(metrics.get('dividend_yield')?.value, '2.67');
    assert.equal(metrics.get('dividend_yield')?.provider, 'csindex-xls-calc-share');
    assert.equal(metrics.get('dividend_yield_calc_share')?.value, '2.67');
    assert.equal(metrics.get('dividend_yield_total_share')?.value, '3.03');
  } finally { handle.db.close(); }
});

test('未来扩展覆盖指数已有 JSON 静态 PE 证据时，失败也不切换股息率口径', async () => {
  const { handle, ctx, instrument, metric } = setup('000852', '中证千指A');
  try {
    metric('pe_official_static', '12');
    metric('dividend_yield', '3.10');
    await withSource('failed', async () => { await refreshMarketData(ctx, { instrumentIds: [instrument.id] }); }, nonSnapshotFixture);
    const metrics = new Map(latestValuationMetrics(handle, instrument.id, TODAY).map((row) => [row.metricKey, row]));
    assert.equal(metrics.get('dividend_yield')?.value, '3.10');
    assert.equal(metrics.get('dividend_yield_calc_share')?.value, '2.67');
  } finally { handle.db.close(); }
});
