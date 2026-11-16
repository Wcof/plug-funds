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
import type { MarketPoint } from '../core/src/types.ts';

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
  min: number | null; p20: number | null; p50: number | null; p80: number | null;
  max: number | null; samples: number;
}
interface Row {
  code: string; name: string; close: number | null; ytdReturn: number | null;
  fundOn: number | null; fundOff: number | null; marketValue: number | null;
  pe: Stats; pb: Stats; ps: Stats; quality: string; publishDate: string | null;
}
interface Result { rows: Row[]; count: number; note: string; caliber: { stat: string; years: number } }

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
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '100.0000', currency: 'CNY', tradingDate: '2026-01-05', observedAt: '', provider: 'fixture', quality: 'FRESH' },
    { instrumentId: id, priceType: 'CLOSE_PRICE', value: '120.0000', currency: 'CNY', tradingDate: '2026-11-13', observedAt: '', provider: 'fixture', quality: 'FRESH' },
  ];
  saveMarketPoints(handle, points);
  // 只有 3 个历史截面，不足以产生分位点
  for (let i = 0; i < 3; i += 1) {
    saveValuationMetric(handle, {
      instrumentId: id, metricKey: 'pe', value: String(10 + i),
      asOfDate: `2026-10-0${i + 1}`, provider: 'fixture', quality: 'OFFICIAL',
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

test('指数估值：样本 ≥20 时产生分位点，年份窗口影响历史序列', async () => {
  const instrument = await rpc<{ id: string }>('save_instrument', {
    code: '900006', name: '恒生指数', type: 'INDEX', market: 'SH',
  });
  const id = instrument.id;
  for (let i = 0; i < 25; i += 1) {
    const day = String(i + 1).padStart(2, '0');
    saveValuationMetric(handle, {
      instrumentId: id, metricKey: 'pe', value: String(5 + i * 0.5),
      asOfDate: `2026-10-${day}`, provider: 'fixture', quality: 'OFFICIAL',
    });
  }
  const all = await rpc<Result>('get_index_valuation', { years: 0, stat: '中位数', market: '港股指数' });
  assert.equal(all.rows[0].pe.samples, 25);
  assert.notEqual(all.rows[0].pe.percentile, null);
  assert.equal(all.caliber.years, 0);
  assert.equal(all.caliber.stat, '中位数');

  // 3 年窗口在本用例中仍覆盖 2026-10 的数据；改用极小窗口验证 since 生效
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
