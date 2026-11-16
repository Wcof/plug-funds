/**
 * 指数估值一览（复刻参考页 #/6 的数据契约，数据全部来自本机）。
 *
 * 口径与诚实边界：
 * - 只聚合 instruments.type === 'INDEX' 的标的；没有指数标的时返回空数组，由前端显示「— / 样本不足」。
 * - 收盘点位 / 今年收益率来自 effectiveHistoryPoints()（与全局有效价格口径一致，估算净值不参与）。
 * - 估值指标来自 valuation_metrics 当前截面；历史均值 / 最小 / 20% / 50% / 80% / 最大来自 metricHistory()。
 * - 分位点样本 < 20 不产生数值（与 refresh.ts 的 PE/PB 分位规则一致）。
 * - 场内|场外基金数、指数总市值：项目不存这两类数据，恒为 null，绝不填 0。
 * - 参考页的「加权 / 等权 / 算数 / 中位数」是成分股聚合口径，本项目数据源不含成分股，
 *   该选择仅作为口径标注返回，不改变数值；不得据此声称等价实现。
 */
import { percentile } from '../../../core/src/valuation.ts';
import type { ServiceContext } from '../context.ts';
import { effectiveHistoryPoints, latestValuationMetrics, metricHistory } from '../repo/market.ts';
import { listInstruments } from '../repo/instruments.ts';

export interface IndexMetricStats {
  current: number | null;
  percentile: number | null;
  avg: number | null;
  min: number | null;
  p20: number | null;
  p50: number | null;
  p80: number | null;
  max: number | null;
  samples: number;
}

export interface IndexValuationRow {
  id: string;
  code: string;
  name: string;
  tag: string;
  market: string;
  publishDate: string | null;
  close: number | null;
  ytdReturn: number | null;
  /** 场内 | 场外基金数：项目无此数据，恒 null。 */
  fundOn: number | null;
  fundOff: number | null;
  pe: IndexMetricStats;
  pb: IndexMetricStats;
  ps: IndexMetricStats;
  /** 近 3 / 2 / 1 年 ROE（按估值日期年份倒序，缺失为 null）。 */
  roe: [number | null, number | null, number | null];
  dividendYield: number | null;
  marketValue: number | null;
  quality: 'REAL' | 'PARTIAL' | 'INSUFFICIENT';
}

export interface IndexValuationResult {
  rows: IndexValuationRow[];
  count: number;
  note: string;
  caliber: { market: string; category: string; stat: string; years: number };
}

export interface IndexValuationOptions {
  market?: string;
  category?: string;
  stat?: string;
  years?: number;
}

const MIN_PERCENTILE_SAMPLES = 20;

function quantileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildStats(values: number[], current: number | null): IndexMetricStats {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    current,
    percentile: current === null || n < MIN_PERCENTILE_SAMPLES ? null : percentile(sorted, current),
    avg: n === 0 ? null : sorted.reduce((a, b) => a + b, 0) / n,
    min: n === 0 ? null : sorted[0],
    p20: quantileOf(sorted, 0.2),
    p50: quantileOf(sorted, 0.5),
    p80: quantileOf(sorted, 0.8),
    max: n === 0 ? null : sorted[n - 1],
    samples: n,
  };
}

function sinceFor(years: number, today: string): string | undefined {
  if (!Number.isFinite(years) || years <= 0) return undefined;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - Math.round(years));
  return d.toISOString().slice(0, 10);
}

function currentMetric(metrics: { metricKey: string; value: string | null }[], key: string): number | null {
  const row = metrics.find((m) => m.metricKey === key);
  if (!row || row.value === null || row.value === '') return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}

/** 近 3 / 2 / 1 年 ROE：按 as_of_date 年份倒序，每年取最后一个截面。 */
function recentRoe(history: { asOfDate: string; value: number }[]): [number | null, number | null, number | null] {
  const byYear = new Map<string, number>();
  for (const point of history) byYear.set(point.asOfDate.slice(0, 4), point.value);
  const years = [...byYear.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 3);
  return [0, 1, 2].map((i) => (years[i] ? byYear.get(years[i]) ?? null : null)) as [number | null, number | null, number | null];
}

export function getIndexValuation(ctx: ServiceContext, options: IndexValuationOptions = {}): IndexValuationResult {
  const years = Number.isFinite(Number(options.years)) ? Number(options.years) : 10;
  const since = sinceFor(years, ctx.today);
  const instruments = listInstruments(ctx.handle, { type: 'INDEX', active: true });

  const rows: IndexValuationRow[] = instruments.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
    const numbers = points.map((p) => Number(p.value)).filter(Number.isFinite);
    const close = numbers.length > 0 ? numbers[numbers.length - 1] : null;
    const yearStart = `${ctx.today.slice(0, 4)}-01-01`;
    const firstOfYear = points.find((p) => p.tradingDate >= yearStart);
    const firstValue = firstOfYear ? Number(firstOfYear.value) : null;
    const ytdReturn = close !== null && firstValue !== null && firstValue > 0 && points.length >= 2
      ? (close / firstValue - 1) * 100
      : null;

    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const statFor = (key: string): IndexMetricStats => buildStats(
      metricHistory(ctx.handle, instrument.id, key, since).map((p) => p.value),
      currentMetric(metrics, key),
    );

    const pe = statFor('pe');
    const pb = statFor('pb');
    const ps = statFor('ps');
    const roe = recentRoe(metricHistory(ctx.handle, instrument.id, 'roe', since));
    const dividendYield = currentMetric(metrics, 'dividend_yield');

    const filled = [close, pe.current, pb.current, ps.current, dividendYield].filter((v) => v !== null).length;
    const quality: IndexValuationRow['quality'] = filled === 0 ? 'INSUFFICIENT' : filled < 5 ? 'PARTIAL' : 'REAL';

    return {
      id: instrument.id,
      code: instrument.code,
      name: instrument.name,
      tag: instrument.tag,
      market: instrument.market,
      publishDate: instrument.foundedDate ?? null,
      close,
      ytdReturn,
      fundOn: null,
      fundOff: null,
      pe, pb, ps, roe,
      dividendYield,
      marketValue: null,
      quality,
    };
  });

  return {
    rows,
    count: rows.length,
    note: '数值全部取自本机 valuation_metrics / market_points（有效价格口径），缺数据为 null 并显示「—」。'
      + `分位点样本 < ${MIN_PERCENTILE_SAMPLES} 不产生数值；场内|场外基金数与指数总市值项目未存，恒为「—」。`
      + '参考页的加权/等权/算数/中位数为成分股聚合口径，本项目数据源不含成分股，该选择仅作口径标注、不改变数值。',
    caliber: {
      market: String(options.market ?? '全部'),
      category: String(options.category ?? '全部'),
      stat: String(options.stat ?? '加权平均值'),
      years,
    },
  };
}
