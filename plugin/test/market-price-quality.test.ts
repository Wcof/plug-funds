import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { effectiveHistoryPoints, effectivePrice, latestPoint, saveMarketPoints } from '../server/src/repo/market.ts';
import type { MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-16';

function setup(type: 'INDEX' | 'OPEN_END_FUND' = 'INDEX') {
  const handle = openState(resolveStateDirs({ PLUG_FUNDS_STATE_DIR: '.tmp/price-quality-tests' } as NodeJS.ProcessEnv), { inMemory: true });
  const instrument = saveInstrument(handle, { code: '000300', name: '价格质量测试', type, market: type === 'INDEX' ? 'SH' : 'OTC' });
  const put = (overrides: Partial<MarketPoint>[]) => saveMarketPoints(handle, overrides.map((row) => ({
    instrumentId: instrument.id, value: '100', priceType: 'REALTIME_PRICE', tradingDate: TODAY,
    observedAt: `${TODAY}T03:00:00Z`, provider: 'tencent', quality: 'FRESH', currency: 'CNY', ...row,
  })) as MarketPoint[]);
  return { handle, instrument, put };
}

test('有效价保留实时价、收盘价和正式净值的 CONFLICT', () => {
  for (const [type, priceType, date] of [
    ['INDEX', 'REALTIME_PRICE', TODAY],
    ['INDEX', 'CLOSE_PRICE', '2026-11-13'],
    ['OPEN_END_FUND', 'OFFICIAL_NAV', '2026-11-13'],
  ] as const) {
    const { handle, instrument, put } = setup(type);
    try {
      put([{ priceType, tradingDate: date, quality: 'CONFLICT' }]);
      assert.equal(effectivePrice(handle, instrument, TODAY)?.quality, 'CONFLICT');
    } finally { handle.db.close(); }
  }
});

test('历史盘中价不覆盖后续收盘价；仅当日实时价优先', () => {
  const { handle, instrument, put } = setup();
  try {
    put([
      { tradingDate: '2026-11-13', priceType: 'REALTIME_PRICE', value: '90' },
      { tradingDate: '2026-11-13', priceType: 'CLOSE_PRICE', value: '100' },
      { tradingDate: TODAY, priceType: 'REALTIME_PRICE', value: '110' },
      { tradingDate: TODAY, priceType: 'CLOSE_PRICE', value: '109' },
    ]);
    const points = effectiveHistoryPoints(handle, instrument.id, instrument.type, undefined, undefined, TODAY);
    assert.deepEqual(points.map((p) => [p.tradingDate, p.priceType, p.value]), [
      ['2026-11-13', 'CLOSE_PRICE', '100'], [TODAY, 'REALTIME_PRICE', '110'],
    ]);
  } finally { handle.db.close(); }
});

test('只有历史实时价时保留并标记 STALE，冲突不会被 STALE 掩盖', () => {
  const { handle, instrument, put } = setup();
  try {
    put([
      { tradingDate: '2026-11-12', value: '90' },
      { tradingDate: '2026-11-13', value: '100', quality: 'CONFLICT' },
    ]);
    const points = effectiveHistoryPoints(handle, instrument.id, instrument.type, undefined, undefined, TODAY);
    assert.deepEqual(points.map((p) => p.quality), ['STALE', 'CONFLICT']);
    assert.equal(effectivePrice(handle, instrument, TODAY)?.quality, 'CONFLICT');
  } finally { handle.db.close(); }
});

test('同日多来源使用稳定主源并传递冲突，不由抓取时间决定', () => {
  const { handle, instrument, put } = setup();
  try {
    put([
      { provider: 'tencent', value: '100', observedAt: `${TODAY}T03:00:00Z` },
      { provider: 'eastmoney', value: '115', quality: 'CONFLICT', observedAt: `${TODAY}T03:01:00Z` },
    ]);
    const current = latestPoint(handle, instrument.id, ['REALTIME_PRICE']);
    assert.equal(current?.provider, 'tencent');
    assert.equal(current?.quality, 'CONFLICT');
    const history = effectiveHistoryPoints(handle, instrument.id, instrument.type, undefined, undefined, TODAY);
    assert.equal(history[0].provider, 'tencent');
    assert.equal(history[0].quality, 'CONFLICT');
  } finally { handle.db.close(); }
});

test('有效价和历史序列排除未来记录，手工价格仍在同日优先', () => {
  const { handle, instrument, put } = setup();
  try {
    put([
      { priceType: 'MANUAL_PRICE', value: '101', provider: 'manual', quality: 'MANUAL' },
      { priceType: 'REALTIME_PRICE', value: '100' },
      { priceType: 'MANUAL_PRICE', tradingDate: '2026-11-17', value: '999', provider: 'manual', quality: 'MANUAL' },
    ]);
    assert.equal(effectivePrice(handle, instrument, TODAY)?.value, '101');
    const history = effectiveHistoryPoints(handle, instrument.id, instrument.type, undefined, '2026-11-18', TODAY);
    assert.equal(history.length, 1);
    assert.equal(history[0].value, '101');
  } finally { handle.db.close(); }
});
