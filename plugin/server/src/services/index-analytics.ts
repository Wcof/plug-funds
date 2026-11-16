/**
 * 指数分析：把「二级菜单」里能靠本机数据算出来的指标一次算完，前端只做展示。
 *
 * 覆盖（全部基于 market_points 日线 + valuation_metrics 截面，不含任何第三方数值）：
 * - 阶段收益：1 周 / 1 月 / 3 月 / 6 月 / 1 年 / 3 年 / 5 年 / 今年（YTD）
 * - 年化波动率、区间最大回撤
 * - 新高 / 新低（近 60 个交易日窗口内是否创新高/新低 + 距高/低点距离）
 * - RPS 相对强度排名（按 1 年收益在同组内的百分位）
 * - 相关性矩阵（共同交易日 ≥ 20 才算）
 * - 定投回测（每月首个交易日定额买入，用 XIRR 表达年化）
 * - 格雷厄姆指数 / 股债性价比（1/PE ÷ 或 − 无风险利率）
 *
 * 两融余额、互联互通、成分股新高新低家数缺数据时显式留空；换手率取已落库指标。
 */
import type { ServiceContext } from '../context.ts';
import { effectiveHistoryPoints, analysisValuationMetrics } from '../repo/market.ts';
import { listInstruments } from '../repo/instruments.ts';
import { correlation } from '../../../core/src/risk.ts';
import { xirr } from '../../../core/src/valuation.ts';
import { getRiskFreeRate } from './risk.ts';

const MIN_COMMON_SAMPLES = 20;
const VOL_WINDOW = 252;
const HIGH_LOW_WINDOW = 60;
const MAX_INDICES = 30;

export interface ReturnSet {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  ytd: number | null;
}

export interface IndexAnalyticsRow {
  id: string;
  code: string;
  name: string;
  tag: string;
  close: number | null;
  lastDate: string | null;
  samples: number;
  returns: ReturnSet;
  volatility: number | null;
  maxDrawdown: number | null;
  high: { window: number; isNewHigh: boolean; distance: number | null };
  low: { window: number; isNewLow: boolean; distance: number | null };
  /** 相对强度排名 0–100（100 = 同组最强）；只有 1 只时为 null。 */
  rps: number | null;
  /** 换手率小数比例（来源的百分数值除以 100），缺失为 null。 */
  turnover: number | null;
  pe: number | null;
  pb: number | null;
  dividendYield: number | null;
}

export interface DcaRow {
  code: string;
  name: string;
  months: number;
  invested: number;
  value: number;
  profit: number;
  profitRate: number | null;
  xirr: number | null;
}

export interface GrahamRow {
  code: string;
  name: string;
  pe: number | null;
  earningsYield: number | null;
  riskFreeRate: number;
  /** 1/PE ÷ 无风险利率；无风险利率为 0 时 null。 */
  grahamIndex: number | null;
  /** 1/PE − 无风险利率（同为 ERP 口径）。 */
  erp: number | null;
}

export interface EtfRow {
  id: string;
  code: string;
  name: string;
  close: number | null;
  lastDate: string | null;
  samples: number;
  y1: number | null;
  ytd: number | null;
  pe: number | null;
}

export interface IndexAnalyticsResult {
  window: { begin: string | null; end: string | null; tradingDays: number };
  rows: IndexAnalyticsRow[];
  etf: EtfRow[];
  correlation: { codes: string[]; names: string[]; matrix: (number | null)[][]; samples: number };
  dca: DcaRow[];
  graham: GrahamRow[];
  coverage: { indices: number; withHistory: number; withValuation: number; etf: number };
  note: string;
}

/* ---------------- 日期与序列助手 ---------------- */

function finiteOrNull(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

function shiftMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** 取 <= date 的最后一个点（不插值）。 */
function pointAtOrBefore(dates: string[], values: number[], date: string): number | null {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? null : values[found];
}

function periodReturn(dates: string[], values: number[], months: number): number | null {
  const end = values[values.length - 1];
  const begin = pointAtOrBefore(dates, values, shiftMonths(dates[dates.length - 1], -months));
  if (begin === null || begin <= 0) return null;
  return end / begin - 1;
}

function ytdReturn(dates: string[], values: number[], today: string, eligibleBaselines: Set<string>): number | null {
  const year = today.slice(0, 4);
  if (!dates.length || dates[dates.length - 1] < `${year}-01-01`) return null;
  const yearEnd = `${Number(year) - 1}-12-31`;
  const baselineIndex = dates.findLastIndex((date) => date <= yearEnd && eligibleBaselines.has(date));
  if (baselineIndex < 0 || values[baselineIndex] <= 0
    || (Date.parse(yearEnd) - Date.parse(dates[baselineIndex])) / 86_400_000 > 14) return null;
  return values[values.length - 1] / values[baselineIndex] - 1;
}

function numericMetrics(ctx: ServiceContext, id: string): Map<string, number> {
  return new Map(analysisValuationMetrics(ctx.handle, id, ctx.today)
    .filter((metric) => metric.value !== null && metric.value.trim() !== '' && Number.isFinite(Number(metric.value)))
    .map((metric) => [metric.metricKey, Number(metric.value)]));
}

function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] > 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}

function annualizedVolatility(values: number[]): number | null {
  const returns = dailyReturns(values.slice(-(VOL_WINDOW + 1)));
  if (returns.length < MIN_COMMON_SAMPLES) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

function maxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}

/* ---------------- 定投 ---------------- */

function dcaBacktest(dates: string[], values: number[], monthlyAmount = 1000): Omit<DcaRow, 'code' | 'name'> | null {
  if (dates.length < MIN_COMMON_SAMPLES) return null;
  // 每月第一个交易日买入，最后一期不买（否则刚买就算收益，结果失真）。
  const buys: { date: string; index: number }[] = [];
  let lastMonth = '';
  for (let i = 0; i < dates.length - 1; i += 1) {
    const month = dates[i].slice(0, 7);
    if (month !== lastMonth) { buys.push({ date: dates[i], index: i }); lastMonth = month; }
  }
  if (buys.length === 0) return null;

  let units = 0;
  for (const buy of buys) {
    if (values[buy.index] > 0) units += monthlyAmount / values[buy.index];
  }
  const invested = buys.length * monthlyAmount;
  const finalValue = units * values[values.length - 1];
  // xirr 需要「外部现金流 + 期末价值」：把期末价值作为最后一笔正现金流。
  const rate = xirr([
    ...buys.map((buy) => ({ date: buy.date, amount: -monthlyAmount })),
    { date: dates[dates.length - 1], amount: Number(finalValue.toFixed(2)) },
  ]);

  return {
    months: buys.length,
    invested,
    value: Number(finalValue.toFixed(2)),
    profit: Number((finalValue - invested).toFixed(2)),
    profitRate: invested > 0 ? finalValue / invested - 1 : null,
    xirr: rate,
  };
}

/* ---------------- 主流程 ---------------- */

export function getIndexAnalytics(ctx: ServiceContext, options: { limit?: number } = {}): IndexAnalyticsResult {
  const indices = listInstruments(ctx.handle)
    .filter((i) => i.type === 'INDEX' && i.active !== false)
    .slice(0, Math.max(1, Math.min(options.limit ?? MAX_INDICES, MAX_INDICES)));

  const riskFreeRate = getRiskFreeRate(ctx.handle);
  const series = indices.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, undefined, undefined, ctx.today);
    const byDate = new Map<string, number>();
    for (const point of points) {
      const value = Number(point.value);
      if (Number.isFinite(value) && value > 0) byDate.set(point.tradingDate, value);
    }
    const dates = [...byDate.keys()].sort();
    return {
      instrument,
      dates,
      values: dates.map((d) => byDate.get(d) as number),
      byDate,
      eligibleBaselines: new Set(points.filter((point) => point.priceType !== 'REALTIME_PRICE'
        && !['CONFLICT', 'MISSING'].includes(point.quality)).map((point) => point.tradingDate)),
      metrics: numericMetrics(ctx, instrument.id),
    };
  });

  const withHistory = series.filter((s) => s.dates.length > 0);
  const rows: IndexAnalyticsRow[] = withHistory.map((entry) => {
    const { dates, values } = entry;
    const close = values[values.length - 1];
    const windowValues = values.slice(-HIGH_LOW_WINDOW);
    const highValue = Math.max(...windowValues);
    const lowValue = Math.min(...windowValues);
    const pe = finiteOrNull(entry.metrics.get('pe'));
    return {
      id: entry.instrument.id,
      code: entry.instrument.code,
      name: entry.instrument.name,
      tag: entry.instrument.tag,
      close,
      lastDate: dates[dates.length - 1],
      samples: dates.length,
      returns: {
        // 1 周按 5 个交易日前取点，比「减 7 个自然日」更贴近 A 股习惯。
        w1: values.length >= 6 && values[values.length - 6] > 0 ? close / values[values.length - 6] - 1 : null,
        m1: periodReturn(dates, values, 1),
        m3: periodReturn(dates, values, 3),
        m6: periodReturn(dates, values, 6),
        y1: periodReturn(dates, values, 12),
        y3: periodReturn(dates, values, 36),
        y5: periodReturn(dates, values, 60),
        ytd: ytdReturn(dates, values, ctx.today, entry.eligibleBaselines),
      },
      volatility: annualizedVolatility(values),
      maxDrawdown: maxDrawdown(values.slice(-VOL_WINDOW)),
      high: {
        window: Math.min(HIGH_LOW_WINDOW, values.length),
        isNewHigh: close >= highValue,
        distance: highValue > 0 ? close / highValue - 1 : null,
      },
      low: {
        window: Math.min(HIGH_LOW_WINDOW, values.length),
        isNewLow: close <= lowValue,
        distance: lowValue > 0 ? close / lowValue - 1 : null,
      },
      rps: null, // 下面统一按 1 年收益排名回填
      turnover: finiteOrNull(entry.metrics.get('turnover_rate')) === null ? null : (entry.metrics.get('turnover_rate') as number) / 100,
      pe,
      pb: finiteOrNull(entry.metrics.get('pb')),
      dividendYield: finiteOrNull(entry.metrics.get('dividend_yield')),
    };
  });

  // RPS：按 1 年收益在同组内的百分位（100 = 最强）；样本 < 2 不给数值。
  if (rows.length >= 2) {
    const ranked = rows.filter((row) => row.returns.y1 !== null)
      .sort((a, b) => (b.returns.y1 as number) - (a.returns.y1 as number));
    ranked.forEach((row) => {
      if (ranked.length < 2) return;
      const tiedBefore = ranked.findIndex((other) => other.returns.y1 === row.returns.y1);
      const tiedAfter = ranked.findLastIndex((other) => other.returns.y1 === row.returns.y1);
      row.rps = Number((100 * (1 - ((tiedBefore + tiedAfter) / 2) / (ranked.length - 1))).toFixed(1));
    });
  }

  // 相关性矩阵（共同交易日 ≥ 20；不足的格子保持 null）
  const matrix: (number | null)[][] = withHistory.map(() => withHistory.map(() => null));
  let samples = 0;
  for (let i = 0; i < withHistory.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < withHistory.length; j += 1) {
      const common = withHistory[i].dates.filter((d) => withHistory[j].byDate.has(d));
      if (common.length < MIN_COMMON_SAMPLES) continue;
      const ra: number[] = [];
      const rb: number[] = [];
      for (let k = 1; k < common.length; k += 1) {
        const a0 = withHistory[i].byDate.get(common[k - 1]) as number;
        const a1 = withHistory[i].byDate.get(common[k]) as number;
        const b0 = withHistory[j].byDate.get(common[k - 1]) as number;
        const b1 = withHistory[j].byDate.get(common[k]) as number;
        if (a0 > 0 && b0 > 0) { ra.push(a1 / a0 - 1); rb.push(b1 / b0 - 1); }
      }
      const rho = correlation(ra, rb);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      if (rho !== null) samples = Math.max(samples, common.length);
    }
  }

  const dca: DcaRow[] = withHistory
    .map((entry) => {
      const result = dcaBacktest(entry.dates, entry.values);
      return result ? { code: entry.instrument.code, name: entry.instrument.name, ...result } : null;
    })
    .filter((row): row is DcaRow => row !== null);

  const graham: GrahamRow[] = rows.map((row) => {
    const earningsYield = row.pe !== null && row.pe > 0 ? 1 / row.pe : null;
    return {
      code: row.code,
      name: row.name,
      pe: row.pe,
      earningsYield,
      riskFreeRate,
      grahamIndex: earningsYield !== null && riskFreeRate > 0 ? earningsYield / riskFreeRate : null,
      erp: earningsYield !== null ? earningsYield - riskFreeRate : null,
    };
  });

  const beginDates = withHistory.map((s) => s.dates[0]).sort();
  const endDates = withHistory.map((s) => s.dates[s.dates.length - 1]).sort();

  // ETF 列表：与指数同源（都是场内标的），但用途不同——看的是可交易工具本身。
  const etf: EtfRow[] = listInstruments(ctx.handle)
    .filter((i) => i.type === 'ETF' && i.active !== false)
    .slice(0, 50)
    .map((instrument) => {
      const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, undefined, undefined, ctx.today);
      const byDate = new Map<string, number>();
      for (const point of points) {
        const value = Number(point.value);
        if (Number.isFinite(value) && value > 0) byDate.set(point.tradingDate, value);
      }
      const dates = [...byDate.keys()].sort();
      const values = dates.map((d) => byDate.get(d) as number);
      const metrics = numericMetrics(ctx, instrument.id);
      return {
        id: instrument.id,
        code: instrument.code,
        name: instrument.name,
        close: values.length > 0 ? values[values.length - 1] : null,
        lastDate: dates.length > 0 ? dates[dates.length - 1] : null,
        samples: dates.length,
        y1: values.length > 0 ? periodReturn(dates, values, 12) : null,
        ytd: values.length > 0 ? ytdReturn(dates, values, ctx.today, new Set(points.filter((point) => point.priceType !== 'REALTIME_PRICE'
          && !['CONFLICT', 'MISSING'].includes(point.quality)).map((point) => point.tradingDate))) : null,
        pe: finiteOrNull(metrics.get('pe')),
      };
    });

  return {
    window: {
      begin: beginDates[0] ?? null,
      end: endDates[endDates.length - 1] ?? null,
      tradingDays: withHistory.reduce((max, s) => Math.max(max, s.dates.length), 0),
    },
    rows,
    etf,
    correlation: {
      codes: withHistory.map((s) => s.instrument.code),
      names: withHistory.map((s) => s.instrument.name),
      matrix,
      samples,
    },
    dca,
    graham,
    coverage: {
      indices: indices.length,
      withHistory: withHistory.length,
      withValuation: rows.filter((r) => r.pe !== null).length,
      etf: etf.length,
    },
    note: withHistory.length === 0
      ? '尚无指数日线数据。先在「指数」页导入常用指数并刷新行情，这里的阶段收益、波动率、新高新低才有数值。'
      : `基于本机指数日线计算：阶段收益按自然月回退取最近交易日，不插值；今年收益需距上一年末不超过 14 天的基准；波动率取近 ${VOL_WINDOW} 个交易日 × √252；新高新低窗口 ${HIGH_LOW_WINDOW} 个交易日；换手率取来源指标，无值为空；两融 / 互联互通缺数据。分析上限 ${MAX_INDICES} 只指数。`,
  };
}
