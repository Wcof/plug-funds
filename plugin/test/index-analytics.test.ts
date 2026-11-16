/**
 * 指数分析回归：阶段收益 / 波动率 / 回撤 / 新高新低 / RPS / 相关性 / 定投 / 格雷厄姆。
 *
 * 刻意用「能口算的合成日线」做基准，避免测试变成对实现的复述：
 * 100 天线性上涨到 200，则 1 年收益 = 100%，最大回撤 = 0，末点即新高。
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

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-idxan-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

/** 造一段工作日日线：values[i] 对应 dates[i]。 */
function seedSeries(
  instrumentId: string,
  values: number[],
  start = '2025-01-02',
): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < values.length) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  saveMarketPoints(handle, dates.map((date, i) => ({
    instrumentId, priceType: 'CLOSE_PRICE' as const, value: values[i].toFixed(4),
    currency: 'CNY', tradingDate: date, observedAt: `${date}T15:00:00.000Z`,
    provider: 'fixture', quality: 'FRESH' as const,
  })));
  return dates;
}

async function newIndex(code: string, name: string): Promise<string> {
  const created = await rpc<{ id: string }>('save_instrument', { code, name, type: 'INDEX', market: 'SH' });
  return created.id;
}

/* ---------------- 1. 空库 ---------------- */

test('空库：返回空行并在 note 里指路，绝不编造数值', async () => {
  const data = await rpc<{
    rows: unknown[]; dca: unknown[]; graham: unknown[];
    coverage: { indices: number; withHistory: number }; note: string;
  }>('get_index_analytics');
  assert.equal(data.rows.length, 0);
  assert.equal(data.dca.length, 0);
  assert.equal(data.graham.length, 0);
  assert.equal(data.coverage.indices, 0);
  assert.match(data.note, /导入常用指数/);
});

/* ---------------- 2. 阶段收益与新高 ---------------- */

test('单调上涨 60 天：今年收益为正、末点即新高、回撤为 0', async () => {
  const id = await newIndex('000300', '沪深300');
  const values = Array.from({ length: 60 }, (_, i) => 100 + i * 2); // 100 → 218
  // 起始日放在上一年年底附近，这样 YTD 才有「年初基准点」可比较。
  seedSeries(id, values, '2025-12-01');

  const data = await rpc<{
    rows: {
      close: number; returns: { w1: number | null; ytd: number | null };
      maxDrawdown: number | null; high: { isNewHigh: boolean; distance: number | null };
      low: { isNewLow: boolean };
    }[];
  }>('get_index_analytics');

  assert.equal(data.rows.length, 1);
  const row = data.rows[0];
  assert.equal(row.close, 218);
  assert.equal(row.maxDrawdown, 0);
  assert.equal(row.high.isNewHigh, true);
  assert.equal(row.high.distance, 0);
  assert.equal(row.low.isNewLow, false);
  assert.ok(row.returns.ytd !== null && row.returns.ytd > 0, `ytd=${row.returns.ytd}`);
  // 5 个交易日前是 values[-6] = 208 → +4.8%
  assert.ok(Math.abs((row.returns.w1 as number) - (218 / 208 - 1)) < 1e-9);
});

test('先涨后跌：最大回撤为负，末点不是新高', async () => {
  const id = await newIndex('000905', '中证500');
  const values = [100, 120, 140, 160, 200, 180, 160, 140, 120];
  seedSeries(id, values, '2026-10-01');

  const data = await rpc<{ rows: { maxDrawdown: number; high: { isNewHigh: boolean; distance: number } }[] }>('get_index_analytics');
  const row = data.rows[0];
  assert.equal(row.maxDrawdown, 120 / 200 - 1);   // -40%
  assert.equal(row.high.isNewHigh, false);
  assert.equal(row.high.distance, 120 / 200 - 1);
});

/* ---------------- 3. RPS 排名 ---------------- */

test('RPS：同组内 1 年收益最强者的 RPS = 100，最弱者 = 0', async () => {
  const strong = await newIndex('000300', '沪深300');
  const weak = await newIndex('399006', '创业板指');
  // 需要跨越 12 个月，1 年收益才算得出来；两只斜率不同即可分出强弱。
  seedSeries(strong, Array.from({ length: 300 }, (_, i) => 100 + i * 0.6), '2025-01-02');
  seedSeries(weak, Array.from({ length: 300 }, (_, i) => 100 + i * 0.1), '2025-01-02');

  const data = await rpc<{ rows: { code: string; rps: number | null; returns: { y1: number | null } }[] }>('get_index_analytics');
  const byCode = new Map(data.rows.map((r) => [r.code, r]));
  assert.ok((byCode.get('000300')?.returns.y1 ?? 0) > 0, '强势标的 1 年收益应为正');
  assert.equal(byCode.get('000300')?.rps, 100);
  assert.equal(byCode.get('399006')?.rps, 0);
});

test('只有一只指数时 RPS 为 null（单样本排名没有意义）', async () => {
  const id = await newIndex('000300', '沪深300');
  seedSeries(id, Array.from({ length: 30 }, (_, i) => 100 + i));
  const data = await rpc<{ rows: { rps: number | null }[] }>('get_index_analytics');
  assert.equal(data.rows[0].rps, null);
});

/* ---------------- 4. 相关性 ---------------- */

test('同向两只：相关系数接近 1；反向则接近 -1', async () => {
  const a = await newIndex('000300', '沪深300');
  const b = await newIndex('000905', '中证500');
  const c = await newIndex('399001', '深证成指');
  // 用有起伏的日收益率（恒定涨幅是零方差，皮尔逊相关本就无定义）。
  const rets = Array.from({ length: 39 }, (_, i) => (i % 3 === 0 ? 0.02 : i % 3 === 1 ? -0.012 : 0.006));
  const build = (rs: number[]): number[] => {
    let value = 100;
    const out = [value];
    for (const r of rs) { value *= 1 + r; out.push(Number(value.toFixed(4))); }
    return out;
  };
  const zig = build(rets);
  seedSeries(a, zig, '2025-09-01');
  seedSeries(b, zig.map((v) => v * 2), '2025-09-01');
  // 反向：同样的波动，收益率取反
  seedSeries(c, build(rets.map((r) => -r)), '2025-09-01');

  const data = await rpc<{ correlation: { codes: string[]; matrix: (number | null)[][]; samples: number } }>('get_index_analytics');
  const index = new Map(data.correlation.codes.map((code, i) => [code, i]));
  const rho = (x: string, y: string): number | null =>
    data.correlation.matrix[index.get(x) as number][index.get(y) as number];

  assert.ok(Math.abs((rho('000300', '000905') as number) - 1) < 1e-3, `同向 rho=${rho('000300', '000905')}`);
  assert.ok((rho('000300', '399001') as number) < -0.5, `反向 rho=${rho('000300', '399001')}`);
  assert.equal(rho('000300', '000300'), 1);
  assert.ok(data.correlation.samples >= 20);
});

test('共同交易日不足 20 天：矩阵格子保持 null，不用 0 冒充不相关', async () => {
  const a = await newIndex('000300', '沪深300');
  const b = await newIndex('000905', '中证500');
  seedSeries(a, [100, 101, 102, 103, 104], '2026-10-01');
  seedSeries(b, [200, 201, 202, 203, 204], '2026-10-01');

  const data = await rpc<{ correlation: { matrix: (number | null)[][] } }>('get_index_analytics');
  assert.equal(data.correlation.matrix[0][1], null);
});

/* ---------------- 5. 定投 ---------------- */

test('定投：每月首交易日买入，投入 = 月份数 × 1000，期末价值按份额计价', async () => {
  const id = await newIndex('000300', '沪深300');
  // 30 个交易日 ≈ 1.5 个月 → 2 次买入（首月 + 次月），最后一期不买。
  const values = Array.from({ length: 30 }, () => 100);
  seedSeries(id, values, '2026-09-01');

  const data = await rpc<{ dca: { months: number; invested: number; value: number; profit: number; profitRate: number }[] }>('get_index_analytics');
  assert.equal(data.dca.length, 1);
  const dca = data.dca[0];
  assert.equal(dca.invested, dca.months * 1000);
  // 价格恒为 100，价值 = 投入，收益 0
  assert.equal(dca.value, dca.invested);
  assert.equal(dca.profit, 0);
  assert.equal(dca.profitRate, 0);
});

/* ---------------- 6. 格雷厄姆 / ERP ---------------- */

test('格雷厄姆指数 = (1/PE) ÷ 无风险利率；PE 缺失则为 null', async () => {
  const withPe = await newIndex('000300', '沪深300');
  const noPe = await newIndex('000905', '中证500');
  seedSeries(withPe, Array.from({ length: 30 }, () => 100), '2026-09-01');
  seedSeries(noPe, Array.from({ length: 30 }, () => 200), '2026-09-01');
  saveValuationMetric(handle, {
    instrumentId: withPe, metricKey: 'pe', value: '10.00', asOfDate: TODAY, provider: 'fixture', quality: 'FRESH',
  });
  await rpc('save_risk_settings', { riskFreeRate: 0.02 });

  const data = await rpc<{ graham: { code: string; grahamIndex: number | null; erp: number | null; riskFreeRate: number }[] }>('get_index_analytics');
  const byCode = new Map(data.graham.map((g) => [g.code, g]));
  // 1/10 = 0.1；0.1 / 0.02 = 5；0.1 - 0.02 = 0.08
  assert.equal(byCode.get('000300')?.grahamIndex, 5);
  assert.ok(Math.abs((byCode.get('000300')?.erp ?? 0) - 0.08) < 1e-9);
  assert.equal(byCode.get('000905')?.grahamIndex, null);
  assert.equal(byCode.get('000905')?.erp, null);
});

/* ---------------- 7. 契约与边界 ---------------- */

test('换手率恒为 null（数据源不含），不填 0', async () => {
  const id = await newIndex('000300', '沪深300');
  seedSeries(id, Array.from({ length: 25 }, (_, i) => 100 + i));
  const data = await rpc<{ rows: { turnover: number | null }[] }>('get_index_analytics');
  assert.equal(data.rows[0].turnover, null);
});

test('只有 INDEX 标的参与统计，股票持仓不会被算进指数分析', async () => {
  const stock = await rpc<{ id: string }>('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH' });
  seedSeries(stock.id, Array.from({ length: 30 }, () => 40));
  const data = await rpc<{ rows: unknown[]; coverage: { indices: number } }>('get_index_analytics');
  assert.equal(data.coverage.indices, 0);
  assert.equal(data.rows.length, 0);
});
