/**
 * 组合风险画像：波动率 / Beta / 与基准相关性 / 跟踪误差 / 股债性价比（ERP）。
 *
 * 数据来源与口径：
 * - 组合收益：getPerformance 的组合单位净值序列（已按外部资金流归一，剔除加减仓扰动）；
 * - 基准：优先 000300（沪深300），否则取第一个有足够历史数据的 INDEX 标的；
 * - 对齐：只保留「组合净值日」与「基准收盘日」的交集，绝不插值补点；
 * - 样本不足（< 20 个共同交易日）一律返回 null，并说明原因；
 * - ERP = 1 / 组合 PE - 无风险利率（盈利收益率口径），PE 缺失时为 null。
 */
import type { ServiceContext } from '../context.ts';
import { getSetting, setSetting } from '../repo/settings.ts';
import { listInstruments } from '../repo/instruments.ts';
import { effectiveHistoryPoints } from '../repo/market.ts';
import { annualizedVolatility, beta, correlation, equityRiskPremium, trackingError } from '../../../core/src/risk.ts';
import { getPerformance, type RangeKey } from './dashboard.ts';
import { listHoldings } from './holdings.ts';
import type { DbHandle } from '../db.ts';
import { ValidationError } from '../errors.ts';

export const DEFAULT_RISK_FREE_RATE = 0.015;
const MIN_COMMON_SAMPLES = 20;

export interface RiskProfile {
  range: { begin: string; end: string };
  samples: number;
  volatility: number | null;
  beta: number | null;
  correlation: number | null;
  trackingError: number | null;
  benchmark: { instrumentId: string | null; code: string | null; name: string | null; samples: number };
  riskFreeRate: number;
  portfolioPe: number | null;
  erp: number | null;
  note: string;
}

export function getRiskFreeRate(handle: DbHandle): number {
  const raw = getSetting(handle, 'risk_free_rate');
  if (raw === null || raw === undefined || raw === '') return DEFAULT_RISK_FREE_RATE;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 0.2 ? value : DEFAULT_RISK_FREE_RATE;
}

export function saveRiskFreeRate(handle: DbHandle, rate: number): number {
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.2) {
    throw new ValidationError('无风险利率必须在 0–20% 之间（小数形式，如 0.015）');
  }
  setSetting(handle, 'risk_free_rate', rate);
  return rate;
}

interface BenchmarkPick {
  instrumentId: string | null;
  code: string | null;
  name: string | null;
  byDate: Map<string, number>;
}

function pickBenchmark(ctx: ServiceContext): BenchmarkPick {
  const indices = listInstruments(ctx.handle, { type: 'INDEX', active: true });
  const candidates = indices
    .map((instrument) => {
      const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, undefined, undefined, ctx.today);
      return { instrument, points };
    })
    .filter((entry) => entry.points.length >= MIN_COMMON_SAMPLES)
    .sort((a, b) => {
      const aPreferred = a.instrument.code === '000300' ? 0 : 1;
      const bPreferred = b.instrument.code === '000300' ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return b.points.length - a.points.length;
    });

  const picked = candidates[0];
  if (!picked) {
    return { instrumentId: null, code: null, name: null, byDate: new Map() };
  }
  const byDate = new Map<string, number>();
  for (const point of picked.points) {
    const value = Number(point.value);
    if (Number.isFinite(value) && value > 0) byDate.set(point.tradingDate, value);
  }
  return {
    instrumentId: picked.instrument.id,
    code: picked.instrument.code,
    name: picked.instrument.name,
    byDate,
  };
}

export function getPortfolioRisk(ctx: ServiceContext, range: RangeKey = '1y'): RiskProfile {
  const performance = getPerformance(ctx, range);
  const riskFreeRate = getRiskFreeRate(ctx.handle);
  const benchmark = pickBenchmark(ctx);

  const navByDate = new Map<string, number>();
  for (const point of performance.series) {
    const nav = point.nav === null ? Number.NaN : Number(point.nav);
    if (Number.isFinite(nav) && nav > 0) navByDate.set(point.date, nav);
  }

  const commonDates = [...navByDate.keys()].filter((d) => benchmark.byDate.has(d)).sort();
  const benchmarkMeta = {
    instrumentId: benchmark.instrumentId, code: benchmark.code, name: benchmark.name, samples: commonDates.length,
  };

  if (commonDates.length < MIN_COMMON_SAMPLES) {
    return {
      range: performance.range,
      samples: commonDates.length,
      volatility: null, beta: null, correlation: null, trackingError: null,
      benchmark: benchmarkMeta,
      riskFreeRate,
      portfolioPe: performance.portfolioPe,
      erp: equityRiskPremium(performance.portfolioPe, riskFreeRate),
      note: benchmark.instrumentId === null
        ? '没有可用的基准指数历史（先在指数页导入常用指数并刷新），Beta / 相关性 / 跟踪误差不可计算。'
        : `组合与基准的共同交易日仅 ${commonDates.length} 个（需 ≥ ${MIN_COMMON_SAMPLES}），风险指标暂不产生。`,
    };
  }

  const navs = commonDates.map((d) => navByDate.get(d)!);
  const benchs = commonDates.map((d) => benchmark.byDate.get(d)!);
  const navReturns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < commonDates.length; i += 1) {
    navReturns.push(navs[i] / navs[i - 1] - 1);
    benchReturns.push(benchs[i] / benchs[i - 1] - 1);
  }

  return {
    range: performance.range,
    samples: commonDates.length,
    volatility: annualizedVolatility(navReturns),
    beta: beta(navReturns, benchReturns),
    correlation: correlation(navReturns, benchReturns),
    trackingError: trackingError(navReturns, benchReturns),
    benchmark: benchmarkMeta,
    riskFreeRate,
    portfolioPe: performance.portfolioPe,
    erp: equityRiskPremium(performance.portfolioPe, riskFreeRate),
    note: `基准 ${benchmark.name ?? '—'}（${benchmark.code ?? '—'}）· 共同交易日 ${commonDates.length} 个 · 无风险利率 ${(riskFreeRate * 100).toFixed(2)}%`,
  };
}

/* ---------------- 持仓相关性矩阵 ---------------- */

export interface CorrelationMatrix {
  codes: string[];
  names: string[];
  /** 方阵；无共同样本的位置为 null。 */
  matrix: (number | null)[][];
  samples: number;
  note: string;
}

/**
 * 持仓两两相关性（按市值取前 12 只，近 1 年日收益）。
 * 只做描述性统计；样本不足的位置返回 null，不用 0 代替「不相关」。
 */
export function getCorrelationMatrix(ctx: ServiceContext, limit = 12): CorrelationMatrix {
  const rows = listHoldings(ctx).rows
    .filter((r) => r.marketValue !== null)
    .sort((a, b) => Number(b.marketValue) - Number(a.marketValue))
    .slice(0, limit);

  const series = rows.map((row) => {
    const points = effectiveHistoryPoints(ctx.handle, row.instrumentId, row.type, undefined, undefined, ctx.today);
    const byDate = new Map<string, number>();
    for (const point of points) {
      const value = Number(point.value);
      if (Number.isFinite(value) && value > 0) byDate.set(point.tradingDate, value);
    }
    return { code: row.code, name: row.name, byDate };
  });

  const codes = series.map((s) => s.code);
  const names = series.map((s) => s.name);
  const matrix: (number | null)[][] = series.map(() => series.map(() => null));
  let samples = 0;

  for (let i = 0; i < series.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < series.length; j += 1) {
      const common = [...series[i].byDate.keys()].filter((d) => series[j].byDate.has(d)).sort();
      if (common.length < MIN_COMMON_SAMPLES) continue;
      const a = common.map((d) => series[i].byDate.get(d)!);
      const b = common.map((d) => series[j].byDate.get(d)!);
      const ra: number[] = [];
      const rb: number[] = [];
      for (let k = 1; k < common.length; k += 1) {
        ra.push(a[k] / a[k - 1] - 1);
        rb.push(b[k] / b[k - 1] - 1);
      }
      const rho = correlation(ra, rb);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      if (rho !== null) samples = Math.max(samples, common.length);
    }
  }

  return {
    codes, names, matrix, samples,
    note: series.length < 2
      ? '持仓少于 2 只，无法计算相关性。'
      : '对角线为 1；空值表示两只标的共同交易日不足 20 个，不能用 0 代替「不相关」。',
  };
}
