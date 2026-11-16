/**
 * 指数估值一览 RPC：空库诚实返回、真实聚合、分位点样本门槛、不伪造缺失字段。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import { saveMarketPoints, saveValuationMetric } from '../server/src/repo/market.ts';
import type { ServiceContext } from '../server/src/context.ts';
import type { DataQuality, MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-index-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

interface Stats {
  current: number | null; percentile: number | null; avg: number | null;
  asOfDate: string | null; provider: string | null;
  percentileStatus: { state: string; reason: string | null };
  min: number | null; p20: number | null; p50: number | null; p80: number | null;
  max: number | null; samples: number;
}
interface Row {
  code: string; name: string; close: number | null; ytdReturn: number | null;
  fundOn: number | null; fundOff: number | null; marketValue: number | null;
  dividendYield: number | null; dividendAsOfDate: string | null; dividendProvider: string | null;
  pe: Stats; pb: Stats; ps: Stats; quality: string; publishDate: string | null;
}
interface Result { rows: Row[]; count: number; note: string; caliber: { stat: string; years: number } }

function seedMetricSeries(id: string, key = 'pe', end = TODAY, provider = 'csindex', count = 25, step = 10): void {
  for (let i = 0; i < count; i += 1) {
    const date = new Date(`${end}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (count - 1 - i) * step);
    saveValuationMetric(handle, {
      instrumentId: id, metricKey: key, value: String(i + 1),
      asOfDate: date.toISOString().slice(0, 10), provider, quality: 'FRESH',
    });
  }
}

test('指数估值：无 INDEX 标的时返回空数组与口径说明，不伪造行', async () => {
  const result = await rpc<Result>('get_index_valuation');
  assert.equal(result.count, 0);
  assert.deepEqual(result.rows, []);
  assert.match(result.note, /样本|null|本机/);
  assert.equal(result.caliber.years, 10);
  assert.equal(result.caliber.stat, '加权平均值');
});

test('指数估值：只聚合 INDEX 标的，普通股票不出现在列表', async () => {
  await rpc('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH' });
  await rpc('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH', foundedDate: '2005-04-08' });
  const result = await rpc<Result>('get_index_valuation');
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].code, '000300');
  assert.equal(result.rows[0].publishDate, '2005-04-08');
  assert.equal(result.rows[0].quality, 'INSUFFICIENT');
  assert.equal(result.rows[0].close, null);
});

test('指数估值：有效价格与估值指标真实聚合，分位点样本 <20 为 null', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '000300', name: '沪深300', type: 'INDEX', market: 'SH',
  });
  const id = instrument.id;
  const points: MarketPoint[] = [
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '100.0000', currency: 'CNY', tradingDate: '2025-12-31', observedAt: '', provider: 'fixture', quality: 'FRESH' },
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '110.0000', currency: 'CNY', tradingDate: '2026-01-05', observedAt: '', provider: 'fixture', quality: 'FRESH' },
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '120.0000', currency: 'CNY', tradingDate: '2026-11-13', observedAt: '', provider: 'fixture', quality: 'FRESH' },
  ];
  saveMarketPoints(handle, points);
  // 只有 3 个历史截面，不足以产生分位点
  for (let i = 0; i < 3; i += 1) {
    saveValuationMetric(handle, {
      instrumentId: id, metricKey: 'pe', value: String(10 + i),
      asOfDate: `2026-10-0${i + 1}`, provider: 'fixture', quality: 'FRESH',
    });
  }
  const result = await rpc<Result>('get_index_valuation');
  const row = result.rows[0];
  assert.equal(row.close, 120);
  assert.ok(Math.abs((row.ytdReturn ?? 0) - 20) < 1e-9, '今年收益率应为 +20%');
  assert.equal(row.pe.current, 12);
  assert.equal(row.pe.samples, 3);
  assert.equal(row.pe.percentile, null, '样本 <20 不得产生分位点');
  assert.equal(row.pe.min, 10);
  assert.equal(row.pe.max, 12);
  assert.equal(row.fundOn, null);
  assert.equal(row.fundOff, null);
  assert.equal(row.marketValue, null);
});

test('指数估值：样本 ≥20 且跨度 ≥180 天时产生分位点', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '900006', name: '恒生指数', type: 'INDEX', market: 'SH',
  });
  const id = instrument.id;
  for (let i = 0; i < 25; i += 1) {
    const date = new Date(`${TODAY}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (24 - i) * 10);
    saveValuationMetric(handle, {
      instrumentId: id, metricKey: 'pe', value: String(5 + i * 0.5),
      asOfDate: date.toISOString().slice(0, 10), provider: 'fixture', quality: 'FRESH',
    });
  }
  const all = await rpc<Result>('get_index_valuation', { years: 0, stat: '中位数', market: '港股指数' });
  assert.equal(all.rows[0].pe.samples, 25);
  assert.notEqual(all.rows[0].pe.percentile, null);
  assert.deepEqual(all.rows[0].pe.percentileStatus, { state: 'VALID', reason: null });
  assert.equal(all.caliber.years, 0);
  assert.equal(all.caliber.stat, '中位数');

  // 3 年窗口仍覆盖全部 240 天样本。
  const narrow = await rpc<Result>('get_index_valuation', { years: 3 });
  assert.equal(narrow.rows[0].pe.samples, 25);
});

test('指数估值：估算净值不进入收盘点位与今年收益率', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '000905', name: '中证500', type: 'INDEX', market: 'SH',
  });
  const id = instrument.id;
  saveMarketPoints(handle, [
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '100.0000', currency: 'CNY', tradingDate: '2026-01-05', observedAt: '', provider: 'fixture', quality: 'FRESH' },
    { instrumentId: id, priceType: 'ESTIMATED_NAV', value: '999.0000', currency: 'CNY', tradingDate: '2026-11-13', observedAt: '', provider: 'fixture', quality: 'ESTIMATED' },
  ] as MarketPoint[]);
  const result = await rpc<Result>('get_index_valuation');
  assert.equal(result.rows[0].close, 100, 'ESTIMATED_NAV 不得参与计价');
  assert.equal(result.rows[0].ytdReturn, null, '样本不足时收益率为 null，不静默填 0');
});

test('指数估值：基础指标 7 天仍可用，8 天及旧年份仅保留历史统计和日期', async () => {
  for (const [code, end, state] of [
    ['000001', '2026-11-06', 'VALID'], ['000002', '2026-11-05', 'STALE'], ['000003', '2014-06-30', 'STALE'],
  ]) {
    const instrument = await rpc<{ id: string }>('save_instrument', { code, name: code, type: 'INDEX', market: 'SH' });
    seedMetricSeries(instrument.id, 'pe', end);
    const result = await rpc<Result>('get_index_valuation', { years: 0 });
    const stats = result.rows.find((row) => row.code === code)!.pe;
    assert.equal(stats.percentileStatus.state, state);
    assert.equal(stats.asOfDate, end);
    assert.equal(stats.current, 25);
    assert.equal(stats.avg, 13);
    assert.equal(stats.min, 1);
    assert.equal(stats.max, 25);
    assert.equal(stats.samples, 25);
    if (state === 'STALE') {
      assert.equal(stats.percentile, null);
      assert.match(stats.percentileStatus.reason ?? '', /7 个自然日/);
    } else assert.notEqual(stats.percentile, null);
  }
});

test('指数估值：基础指标冲突、缺失、过期、估算及非法数值不产生当前分位', async () => {
  const cases: { value: string | null; quality: DataQuality; state: string }[] = [
    { value: '25', quality: 'CONFLICT', state: 'CONFLICT' },
    { value: '25', quality: 'MISSING', state: 'MISSING' },
    { value: '25', quality: 'STALE', state: 'STALE' },
    { value: '25', quality: 'DELAYED', state: 'STALE' },
    { value: '25', quality: 'ESTIMATED', state: 'SUSPECT' },
    { value: null, quality: 'FRESH', state: 'MISSING' },
    { value: '  ', quality: 'FRESH', state: 'MISSING' },
    { value: 'NaN', quality: 'FRESH', state: 'SUSPECT' },
    { value: 'Infinity', quality: 'FRESH', state: 'SUSPECT' },
    { value: '0', quality: 'FRESH', state: 'SUSPECT' },
    { value: '-1', quality: 'FRESH', state: 'SUSPECT' },
  ];
  for (const [i, item] of cases.entries()) {
    const code = String(100 + i).padStart(6, '0');
    const instrument = await rpc<{ id: string }>('save_instrument', { code, name: code, type: 'INDEX', market: 'SH' });
    seedMetricSeries(instrument.id);
    saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'pe', asOfDate: TODAY, provider: 'csindex', value: item.value, quality: item.quality });
    const stats = (await rpc<Result>('get_index_valuation')).rows.find((row) => row.code === code)!.pe;
    assert.equal(stats.percentile, null, `${item.quality}/${item.value} 不应参与当前分位`);
    assert.equal(stats.percentileStatus.state, item.state);
    assert.ok(stats.percentileStatus.reason);
    assert.equal(stats.asOfDate, TODAY);
    assert.notEqual(stats.avg, null, '历史描述统计继续可见');
  }
});

test('指数估值：同源历史的冲突、缺失或非法记录会阻止分位，历史统计仍保留', async () => {
  const cases = [
    { quality: 'CONFLICT', value: '3', state: 'CONFLICT' },
    { quality: 'MISSING', value: '3', state: 'SUSPECT' },
    { quality: 'ESTIMATED', value: '3', state: 'SUSPECT' },
    { quality: 'UNKNOWN', value: '3', state: 'SUSPECT' },
    { quality: 'FRESH', value: 'NaN', state: 'SUSPECT' },
  ];
  for (const [i, item] of cases.entries()) {
    const code = String(200 + i).padStart(6, '0');
    const instrument = await rpc<{ id: string }>('save_instrument', { code, name: code, type: 'INDEX', market: 'SH' });
    seedMetricSeries(instrument.id);
    // 模拟遗留数据中的质量标记或原文错误，不通过业务输入补造有效数据。
    handle.db.prepare(`UPDATE valuation_metrics SET quality = ?, value = ? WHERE instrument_id = ? AND metric_key = 'pe' AND as_of_date = '2026-10-04'`)
      .run(item.quality, item.value, instrument.id);
    const stats = (await rpc<Result>('get_index_valuation')).rows.find((row) => row.code === code)!.pe;
    assert.equal(stats.percentile, null);
    assert.equal(stats.percentileStatus.state, item.state);
    assert.equal(stats.current, 25);
    assert.notEqual(stats.avg, null);
  }
});

test('指数估值：PB/PS 只采用最新来源样本，其他来源冲突不污染分位或历史统计', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  for (const key of ['pb', 'ps']) {
    seedMetricSeries(instrument.id, key, TODAY, 'primary');
    saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: key, value: '999', asOfDate: '2026-11-12', provider: 'other', quality: 'CONFLICT' });
  }
  const row = (await rpc<Result>('get_index_valuation')).rows[0];
  for (const stats of [row.pb, row.ps]) {
    assert.equal(stats.provider, 'primary');
    assert.equal(stats.samples, 25);
    assert.equal(stats.avg, 13);
    assert.equal(stats.max, 25);
    assert.equal(stats.percentileStatus.state, 'VALID');
    assert.notEqual(stats.percentile, null);
  }
});

test('指数估值：年份选择仍控制历史窗口，缺样本和跨度不足均明确标记', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  seedMetricSeries(instrument.id, 'pb', TODAY, 'fixture', 25, 20);
  seedMetricSeries(instrument.id, 'ps', TODAY, 'fixture', 25, 1);
  const all = await rpc<Result>('get_index_valuation', { years: 0 });
  assert.equal(all.rows[0].pb.samples, 25);
  assert.equal(all.rows[0].pb.percentileStatus.state, 'VALID');
  const oneYear = await rpc<Result>('get_index_valuation', { years: 1 });
  assert.equal(oneYear.caliber.years, 1);
  assert.equal(oneYear.rows[0].pb.samples, 19);
  assert.equal(oneYear.rows[0].pb.percentile, null);
  assert.match(oneYear.rows[0].pb.percentileStatus.reason ?? '', /同源样本 19 个/);
  assert.equal(all.rows[0].ps.percentile, null);
  assert.match(all.rows[0].ps.percentileStatus.reason ?? '', /跨度 24 天/);
});

test('指数估值：20 个同源样本在 180 天边界可用，179 天不产生分位', async () => {
  for (const span of [179, 180]) {
    const code = String(span).padStart(6, '0');
    const instrument = await rpc<{ id: string }>('save_instrument', { code, name: code, type: 'INDEX', market: 'SH' });
    for (let i = 0; i < 20; i += 1) {
      const date = new Date(`${TODAY}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() - Math.round((19 - i) * span / 19));
      saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'pe', value: String(i + 1), asOfDate: date.toISOString().slice(0, 10), provider: 'csindex', quality: 'FRESH' });
    }
    const stats = (await rpc<Result>('get_index_valuation')).rows.find((row) => row.code === code)!.pe;
    assert.equal(stats.samples, 20);
    assert.equal(stats.percentileStatus.state, span === 180 ? 'VALID' : 'MISSING');
    assert.equal(stats.percentile !== null, span === 180);
  }
});

test('指数估值：非法截面日期不抛错，也不产生当前分位', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  seedMetricSeries(instrument.id, 'pe', '2026-02-20');
  saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'pe', value: '30', asOfDate: '2026-02-30', provider: 'csindex', quality: 'FRESH' });
  const stats = (await rpc<Result>('get_index_valuation')).rows[0].pe;
  assert.equal(stats.asOfDate, '2026-02-30');
  assert.equal(stats.percentileStatus.state, 'SUSPECT');
  assert.equal(stats.percentile, null);
  assert.equal(stats.samples, 25);
});

test('指数估值：股息率保留实际数值对应的日期与来源口径', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'dividend_yield', value: '2.5', asOfDate: '2026-11-12', provider: 'csindex-xls-calc-share', quality: 'FRESH' });
  let row = (await rpc<Result>('get_index_valuation')).rows[0];
  assert.equal(row.dividendYield, 2.5);
  assert.equal(row.dividendAsOfDate, '2026-11-12');
  assert.equal(row.dividendProvider, 'csindex-xls-calc-share');
  saveValuationMetric(handle, { instrumentId: instrument.id, metricKey: 'dividend_yield', value: '2.4', asOfDate: TODAY, provider: 'csindex', quality: 'FRESH' });
  row = (await rpc<Result>('get_index_valuation')).rows[0];
  assert.equal(row.dividendYield, 2.4);
  assert.equal(row.dividendAsOfDate, TODAY);
  assert.equal(row.dividendProvider, 'csindex');
});
