/**
 * 指数估值一览（复刻参考页 #/6 的数据契约，数据全部来自本机）。
 *
 * 口径与诚实边界：
 * - 只聚合 instruments.type === 'INDEX' 的标的；没有指数标的时返回空数组，由前端显示「— / 样本不足」。
 * - 最新点位来自 effectiveHistoryPoints() 并保留类型日期；YTD 需要上一年末有效基准，估算净值不参与。
 * - 估值指标来自 valuation_metrics 当前截面；历史均值 / 最小 / 20% / 50% / 80% / 最大来自 metricHistory()。
 * - 当前分位要求基础指标不超过 7 天、同源样本 ≥ 20 且跨度 ≥ 180 天；冲突或无效数据不产生分位。
 * - 场内|场外基金数取官方关联目录，保留统计/观察日和分类状态；总市值从 scale_info 原文读取，缺失不填 0。
 * - 参考页的「加权 / 等权 / 算数 / 中位数」是成分股聚合口径，本项目数据源不含成分股，
 *   该选择仅作为口径标注返回，不改变数值；不得据此声称等价实现。
 */
import { percentile } from '../../../core/src/valuation.ts';
import type { ServiceContext } from '../context.ts';
import { effectiveHistoryPoints, latestValuationMetrics, metricHistory, type ValuationMetricRow } from '../repo/market.ts';
import { listInstruments } from '../repo/instruments.ts';
import { getIndexReference } from '../repo/index-reference.ts';
import type { FundReference, ReferenceStatus } from '../market/index-reference.ts';
import { indexMetricApplicability, type IndexProfile } from '../market/index-profile.ts';

export interface IndexMetricStats {
  current: number | null;
  asOfDate: string | null;
  provider: string | null;
  percentile: number | null;
  percentileStatus: ReferenceStatus;
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
  profile: IndexProfile | null;
  publishDate: string | null;
  close: number | null;
  priceDate: string | null;
  priceType: string | null;
  priceQuality: string | null;
  ytdReturn: number | null;
  /** 官方目录中可分类的场内 | 场外产品代码数；缺失或分类不完整为 null。 */
  fundOn: number | null;
  fundOff: number | null;
  fundReference: FundReference | null;
  fieldStates: Record<string, ReferenceStatus>;
  pe: IndexMetricStats;
  pb: IndexMetricStats;
  ps: IndexMetricStats;
  /** 前 3 / 2 / 1 个日历年的末次 ROE 观测截面，不代表财报年度 ROE。 */
  roe: [number | null, number | null, number | null];
  dividendYield: number | null;
  dividendAsOfDate: string | null;
  dividendProvider: string | null;
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
const MIN_PERCENTILE_SPAN_DAYS = 180;
const MAX_CURRENT_AGE_DAYS = 7;
const METRIC_QUALITIES = new Set(['FRESH', 'DELAYED', 'STALE', 'MISSING', 'ESTIMATED', 'MANUAL', 'CONFLICT']);

interface MetricObservation { asOfDate: string; value: string | null; quality: string }

function validDate(value: string): boolean {
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function numericValue(value: string | null | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantileOf(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function buildStats(series: MetricObservation[], latest: ValuationMetricRow | undefined, today: string): IndexMetricStats {
  const current = numericValue(latest?.value);
  const asOfDate = latest?.asOfDate ?? null;
  const provider = latest?.provider ?? null;
  const values = series.map((point) => ({ ...point, value: numericValue(point.value) }))
    .filter((point): point is Omit<MetricObservation, 'value'> & { value: number } => point.value !== null && point.value > 0 && validDate(point.asOfDate));
  const sorted = values.map((point) => point.value).sort((a, b) => a - b);
  const n = sorted.length;
  const span = n > 0 ? (Date.parse(values[n - 1].asOfDate) - Date.parse(values[0].asOfDate)) / 86_400_000 : 0;
  const age = asOfDate && validDate(asOfDate) ? (Date.parse(today) - Date.parse(asOfDate)) / 86_400_000 : NaN;
  let percentileStatus: IndexMetricStats['percentileStatus'];
  if (!latest || latest.value === null || latest.value.trim() === '' || latest.quality === 'MISSING') {
    percentileStatus = { state: 'MISSING', reason: '当前基础指标缺失或被标记为缺失' };
  } else if (current === null || current <= 0 || !Number.isFinite(age) || age < 0 || !provider?.trim()) {
    percentileStatus = { state: 'SUSPECT', reason: '当前基础指标的数值、日期或来源无效' };
  } else if (latest.quality === 'CONFLICT' || series.some((point) => point.quality === 'CONFLICT')) {
    percentileStatus = { state: 'CONFLICT', reason: '基础指标或同源历史存在未解决的冲突' };
  } else if (age > MAX_CURRENT_AGE_DAYS || ['STALE', 'DELAYED'].includes(latest.quality)) {
    percentileStatus = { state: 'STALE', reason: age > MAX_CURRENT_AGE_DAYS
      ? `基础指标日期 ${asOfDate} 超过 ${MAX_CURRENT_AGE_DAYS} 个自然日，不能视为当前分位`
      : '基础指标被标记为过期或延迟，不能视为当前分位' };
  } else if (latest.quality === 'ESTIMATED' || !METRIC_QUALITIES.has(latest.quality)
    || series.some((point) => ['MISSING', 'ESTIMATED'].includes(point.quality) || !METRIC_QUALITIES.has(point.quality))
    || values.length !== series.length) {
    percentileStatus = { state: 'SUSPECT', reason: '基础指标或同源历史含估算、无效数值、无效日期或异常质量标记' };
  } else if (n < MIN_PERCENTILE_SAMPLES || span < MIN_PERCENTILE_SPAN_DAYS) {
    percentileStatus = { state: 'MISSING', reason: `同源样本 ${n} 个、跨度 ${Math.round(span)} 天，要求至少 ${MIN_PERCENTILE_SAMPLES} 个且 ${MIN_PERCENTILE_SPAN_DAYS} 天` };
  } else {
    percentileStatus = { state: 'VALID', reason: null };
  }
  return {
    current, asOfDate, provider,
    percentile: percentileStatus.state === 'VALID' && current !== null ? percentile(sorted, current) : null,
    percentileStatus,
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

/** 固定前 3 / 2 / 1 个日历年各取末次观测，不把缺失年份前移或宣称财报年度。 */
function recentRoe(history: { asOfDate: string; value: number }[], today: string): [number | null, number | null, number | null] {
  const byYear = new Map<string, number>();
  for (const point of history) byYear.set(point.asOfDate.slice(0, 4), point.value);
  const year = Number(today.slice(0, 4));
  return [3, 2, 1].map((offset) => byYear.get(String(year - offset)) ?? null) as [number | null, number | null, number | null];
}

export function getIndexValuation(ctx: ServiceContext, options: IndexValuationOptions = {}): IndexValuationResult {
  const years = Number.isFinite(Number(options.years)) ? Number(options.years) : 10;
  const since = sinceFor(years, ctx.today);
  const instruments = listInstruments(ctx.handle, { type: 'INDEX', active: true });

  /**
   * 总市值是文本指标（"总市值 507797 亿"），metricHistory 会把值转成数字并过滤掉，
   * 所以单独取一次原文；521 行开销可忽略。
   */
  const scaleTextById = new Map<string, string>();
  {
    const scaleRows = ctx.handle.db
      .prepare("SELECT instrument_id, value, as_of_date FROM valuation_metrics WHERE metric_key = 'scale_info' AND as_of_date <= ? ORDER BY as_of_date")
      .all(ctx.today) as { instrument_id: string; value: string | null; as_of_date: string }[];
    for (const row of scaleRows) if (row.value) scaleTextById.set(row.instrument_id, row.value);
  }

  const rows: IndexValuationRow[] = instruments.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, undefined, undefined, ctx.today);
    const numbers = points.map((p) => Number(p.value)).filter(Number.isFinite);
    const close = numbers.length > 0 ? numbers[numbers.length - 1] : null;
    const yearStart = `${ctx.today.slice(0, 4)}-01-01`;
    const latestPoint = points.at(-1);
    const baseline = points.filter((point) => point.tradingDate < yearStart && point.priceType !== 'REALTIME_PRICE'
      && !['CONFLICT', 'MISSING'].includes(point.quality)).at(-1);
    const yearEnd = `${Number(ctx.today.slice(0, 4)) - 1}-12-31`;
    const baselineAge = baseline ? (Date.parse(yearEnd) - Date.parse(baseline.tradingDate)) / 86_400_000 : Infinity;
    const firstValue = baseline && baselineAge <= 14 ? Number(baseline.value) : null;
    const ytdReturn = close !== null && firstValue !== null && firstValue > 0 && latestPoint && latestPoint.tradingDate >= yearStart
      ? (close / firstValue - 1) * 100
      : null;

    const latestMetrics = latestValuationMetrics(ctx.handle, instrument.id, ctx.today);
    const reference = getIndexReference(ctx.handle, instrument.id);
    const funds = reference?.funds ?? null;
    const seriesFor = (key: string) => metricHistory(ctx.handle, instrument.id, key, since, ctx.today);
    const statFor = (key: string): IndexMetricStats => {
      const applicability = indexMetricApplicability(reference?.profile, key);
      if (applicability) return { ...buildStats([], undefined, ctx.today), percentileStatus: applicability };
      const latest = latestMetrics.find((metric) => metric.metricKey === key);
      const asOfDate = latest?.asOfDate && validDate(latest.asOfDate) ? latest.asOfDate : ctx.today;
      const begin = sinceFor(years, asOfDate);
      // 保留质量元数据，并与最新截面使用同一来源；PB / PS 也不能混合不同来源的历史。
      const series = latest ? ctx.handle.db.prepare(`SELECT as_of_date AS asOfDate, value, quality
        FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND provider = ?
        AND as_of_date <= ?${begin ? ' AND as_of_date >= ?' : ''} ORDER BY as_of_date`)
        .all(instrument.id, key, latest.provider, asOfDate, ...(begin ? [begin] : [])) as MetricObservation[] : [];
      return buildStats(series, latest, ctx.today);
    };

    const pe = statFor('pe');
    const pb = statFor('pb');
    const ps = statFor('ps');
    const metricStatus = (key: 'pe' | 'pb', stats: IndexMetricStats): ReferenceStatus => {
      const applicability = indexMetricApplicability(reference?.profile, key);
      if (applicability) return applicability;
      if (stats.current === null) return { state: 'MISSING', reason: key === 'pb' ? reference?.unavailable.pb ?? '尚未取得 PB' : '尚未取得 PE' };
      if ((key === 'pe' && stats.current > 200) || (key === 'pb' && stats.current > 20)) return { state: 'SUSPECT', reason: `${key.toUpperCase()} 属极端值，保留原值并要求复核` };
      if (key === 'pe' && !['csindex', 'cnindex', 'manual'].includes(stats.provider ?? '')) return { state: 'SUSPECT', reason: '报价端 PE 口径尚未证明与官方滚动 PE 相同' };
      if (['STALE', 'SUSPECT', 'CONFLICT'].includes(stats.percentileStatus.state)) return stats.percentileStatus;
      return { state: 'VALID', reason: null };
    };
    const roe: [number | null, number | null, number | null] = indexMetricApplicability(reference?.profile, 'roe') ? [null, null, null]
      : recentRoe(metricHistory(ctx.handle, instrument.id, 'roe', undefined, ctx.today), ctx.today);
    const dividendSeries = seriesFor('dividend_yield');
    const dividendPoint = dividendSeries.at(-1);
    const dividendYield = dividendPoint?.value ?? null;
    const dividendAsOfDate = dividendPoint?.asOfDate ?? null;
    const dividendSource = dividendPoint ? ctx.handle.db.prepare(`SELECT provider FROM valuation_metrics
      WHERE instrument_id = ? AND metric_key = 'dividend_yield' AND as_of_date = ?`)
      .get(instrument.id, dividendPoint.asOfDate) as { provider: string } | undefined : undefined;
    const dividendProvider = dividendSource?.provider ?? null;
    // 总市值：报价端（腾讯）把「总市值 X 亿」写进 scale_info，这里解析成数值供「市值」列使用。
    // 解析不出来就保持 null（不猜、不填 0）。
    const scaleText = scaleTextById.get(instrument.id) ?? '';
    const scaleMatch = /([\d.]+)\s*亿/.exec(scaleText);
    const marketValue = scaleMatch && Number.isFinite(Number(scaleMatch[1])) ? Number(scaleMatch[1]) : null;

    const filled = [close, pe.current, pb.current, ps.current, dividendYield].filter((v) => v !== null).length;
    const quality: IndexValuationRow['quality'] = filled === 0 ? 'INSUFFICIENT' : filled < 5 ? 'PARTIAL' : 'REAL';

    return {
      id: instrument.id,
      code: instrument.code,
      name: instrument.name,
      tag: instrument.tag,
      market: instrument.market,
      profile: reference?.profile ?? null,
      publishDate: instrument.foundedDate ?? null,
      close,
      priceDate: latestPoint?.tradingDate ?? null,
      priceType: latestPoint?.priceType ?? null,
      priceQuality: latestPoint?.quality ?? null,
      ytdReturn,
      fundOn: funds?.on ?? null,
      fundOff: funds?.off ?? null,
      fundReference: funds,
      fieldStates: {
        assetClass: { state: reference?.profile && reference.profile.assetClass !== 'UNKNOWN' ? 'VALID' : 'MISSING', reason: reference?.profile?.classification.reason ?? '尚无官方资产类别资料' },
        publishDate: reference?.publishStatus ?? { state: instrument.foundedDate ? 'SUSPECT' : 'MISSING', reason: '尚无本轮官方发布日期校验证据' },
        fundOn: funds?.status ?? { state: 'MISSING', reason: reference?.unavailable.funds ?? '尚未取得官方关联产品清单' },
        fundOff: funds?.status ?? { state: 'MISSING', reason: reference?.unavailable.funds ?? '尚未取得官方关联产品清单' },
        pe: metricStatus('pe', pe),
        pb: metricStatus('pb', pb),
        ps: indexMetricApplicability(reference?.profile, 'ps') ?? { state: ps.current === null ? 'MISSING' : 'SUSPECT', reason: reference?.unavailable.ps ?? 'PS 来源与聚合定义尚未核实' },
        roe: indexMetricApplicability(reference?.profile, 'roe') ?? { state: roe.every((v) => v === null) ? 'MISSING' : 'SUSPECT', reason: reference?.unavailable.roe ?? '对应财报年度和指数 ROE 聚合定义尚未核实' },
        indexCurrency: { state: reference?.profile?.currency ? 'VALID' : 'MISSING', reason: reference?.profile?.currencyReason ?? '尚未取得官方计价币资料；点位不使用账本默认 CNY 代替' },
      },
      pe, pb, ps, roe,
      dividendYield,
      dividendAsOfDate,
      dividendProvider,
      marketValue,
      quality,
    };
  });

  return {
    rows,
    count: rows.length,
    note: '数值全部取自本机 valuation_metrics / market_points（有效价格口径），缺数据为 null 并显示「—」。'
      + '最新点位保留日期与价格类型，盘中价不等同收盘价；今年收益以距上一年末不超过 14 天的有效收盘点为基准，缺基准不计算。'
      + 'PE 优先已有中证官方滚动序列，国证自编目录可提供国证官方 PE/PB；不同来源不拼接历史。'
      + '官方资料确认的债券/基金指数不适用直接股票 PE/PB/PS/ROE 口径，旧观测留档但不产生当前估值；指数计价币与人民币账本金额分开。'
      + 'PB 与股息率仅展示当前接入数据源已提供的值，未取得不代表发行方不公开。'
      + 'ROE 按前 3 / 2 / 1 个日历年的末次观测列示，不等同对应财报年度 ROE。'
      + `当前分位仅使用最新截面同来源的历史，基础指标超过 ${MAX_CURRENT_AGE_DAYS} 个自然日、存在冲突或无效数据、样本 < ${MIN_PERCENTILE_SAMPLES} 或跨度 < ${MIN_PERCENTILE_SPAN_DAYS} 天时不产生数值；保留历史描述统计、来源和日期。`
      + '场内|场外计数仅为官方目录所列境内产品代码数；保留统计日期、观察日期与分类存疑状态，不等同全市场基金数。总市值取来源记录「总市值 X 亿」。'
      + '参考页的加权/等权/算数/中位数为成分股聚合口径，本项目数据源不含成分股，该选择仅作口径标注、不改变数值。',
    caliber: {
      market: String(options.market ?? '全部'),
      category: String(options.category ?? '全部'),
      stat: String(options.stat ?? '加权平均值'),
      years,
    },
  };
}
