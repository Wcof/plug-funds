/**
 * 标的估值视图（PRD §4.13）：不含收益列，聚焦「贵不贵、稳不稳」。
 * 口径规则：基金 / ETF 用关联指数穿透，主动基金不提供实时穿透（显示 —）；
 * 股票为 PE-TTM / PB（最近披露）；分位样本不足显示「样本不足」。
 *
 * 两个口径（scope）：
 * - holdings（默认）：只出持仓标的，用于总览 / 持仓页的「我的持仓估值」；
 * - all：出全部在库标的（含指数、观察标的中无持仓的），估值页用它，
 *   这样没有任何持仓也能看到全部标的；缺数据就显示「数据不足」，绝不从列表里消失。
 */
import { SCALE_QTY, parseFixed } from '../../../core/src/money.ts';
import { scoreWithTemplate, type MetricValue, type StrategyScore } from '../../../core/src/strategy.ts';
import type { Instrument } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { listTemplates } from '../repo/strategies.ts';
import { getInstrument, listInstruments } from '../repo/instruments.ts';
import { effectiveHistoryPoints, latestValuationMetrics } from '../repo/market.ts';
import { listHoldings } from './holdings.ts';
import { seriesStats, type ChartPoint } from './charts.ts';

export type ValuationScope = 'holdings' | 'all';

export interface ValuationFilter {
  /** 按资产类型过滤（STOCK / ETF / OPEN_END_FUND / INDEX）。 */
  type?: string;
  /** 默认 holdings：保持总览 / 持仓页原有口径。 */
  scope?: ValuationScope;
}

export interface ValuationRow {
  instrumentId: string;
  code: string;
  name: string;
  type: string;
  /** 是否在当前持仓中（估值页据此排序与标记，非筛选依据）。 */
  held: boolean;
  pe: string | null;
  pePercentile: number | null;
  pb: string | null;
  pbPercentile: number | null;
  dividendYield: string | null;
  roe: string | null;
  sharpe: number | null;
  volatilityPct: number | null;
  maxDrawdownPct: number | null;
  /** 估值口径说明（日期 + 来源 + 适用性）。 */
  caliber: string;
  strategies: StrategyScore[];
}

export interface ValuationView {
  rows: ValuationRow[];
  /** 本次视图口径：holdings=仅持仓，all=全部标的。 */
  scope: ValuationScope;
  /** 在库标的数（scope=all 时与 rows 长度一致，用于前端提示「N 只标的中 M 只有估值数据」）。 */
  total: number;
  note: string;
}

interface MetricLite {
  key: string;
  value: string | null;
  asOfDate: string;
  provider: string;
  quality: string;
}

function metricNumber(metrics: MetricLite[], key: string): number | null {
  const row = metrics.find((m) => m.key === key);
  if (!row || row.value === null || row.value.trim() === '') return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 近 1 年窗口（与图表 perf Tab 同口径），只读库内已有价格 / 净值，不触发任何外部拉取。 */
function oneYearSpan(today: string): { begin: string; end: string } {
  const begin = new Date(`${today}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - 365);
  return { begin: begin.toISOString().slice(0, 10), end: today };
}

/** 风险指标：直接读有效价格序列（MANUAL > REALTIME > CLOSE / OFFICIAL_NAV），不走图表服务。 */
function riskStats(ctx: ServiceContext, instrument: Instrument): { sharpe: number | null; vol: number | null; mdd: number | null } {
  try {
    const span = oneYearSpan(ctx.today);
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end, ctx.today);
    if (points.length < 20 || points.some((point) => ['CONFLICT', 'MISSING'].includes(point.quality))) return { sharpe: null, vol: null, mdd: null };
    const series: ChartPoint[] = points.map((p) => ({ date: p.tradingDate, value: p.value }));
    return seriesStats(series);
  } catch {
    return { sharpe: null, vol: null, mdd: null };
  }
}

function caliberFor(instrument: Instrument, metrics: MetricLite[], pe: number | null): string {
  const asOf = metrics[0]?.asOfDate;
  const isFund = instrument.type === 'OPEN_END_FUND';
  const isEtf = instrument.type === 'ETF';
  const hasIndexLink = Boolean(instrument.benchmarkIndex);
  let caliber: string;
  if (instrument.type === 'STOCK') {
    caliber = `个股 PE-TTM / PB · ${asOf ?? '暂无披露'}`;
  } else if (instrument.type === 'INDEX') {
    const official = metrics.find((m) => m.key === 'pe_official');
    const staticPe = metrics.find((m) => m.key === 'pe_official_static');
    const dividend = metrics.find((m) => m.key === 'dividend_yield');
    const peMetric = metrics.find((metric) => metric.key === 'pe');
    const source = peMetric?.provider === 'csindex' ? '中证官方滚动口径'
      : peMetric?.provider === 'manual' ? '手工补录，口径待核实' : `报价口径（${peMetric?.provider ?? '来源未知'}），不可与官方滚动口径直接比较`;
    const parts = [`指数 PE ${pe === null ? '未获取' : `${source} · ${peMetric?.asOfDate ?? '日期未知'}`}`];
    if (staticPe) parts.push(`静态 PE ${staticPe.value}`);
    if (official) parts.push(`官方 PE2 ${official.value}（${official.asOfDate}）`);
    if (dividend) parts.push(`股息率 ${dividend.value}%`);
    caliber = parts.join(' · ');
  } else if (isFund && !hasIndexLink && pe === null) {
    caliber = '主动基金 · 持仓披露滞后（季报），不提供实时穿透估值';
  } else if ((isFund || isEtf) && hasIndexLink) {
    caliber = `跟踪指数穿透（${instrument.benchmarkIndex}）· ${asOf ?? '—'}`;
  } else {
    caliber = asOf ? `估值截面 ${asOf}` : '暂无估值数据';
  }
  const manualCount = metrics.filter((m) => m.provider === 'manual').length;
  if (manualCount > 0) caliber += ` · 含 ${manualCount} 项手工补录（MANUAL）`;
  return caliber;
}

export async function getHoldingsValuation(
  ctx: ServiceContext,
  filter: ValuationFilter = {},
): Promise<ValuationView> {
  const scope: ValuationScope = filter.scope === 'all' ? 'all' : 'holdings';
  const holdings = listHoldings(ctx);
  const heldIds = new Set(holdings.rows.map((row) => row.instrumentId));
  const everyInstrument = listInstruments(ctx.handle);
  const byId = new Map(everyInstrument.map((instrument) => [instrument.id, instrument]));
  // 模板来自 DB（内置 + 用户编辑版本 + 自定义），每次评分都读当前生效版本
  const templates = listTemplates(ctx.handle);

  const targets: { instrument: Instrument; held: boolean }[] = [];
  if (scope === 'all') {
    for (const instrument of everyInstrument) {
      if (!instrument.active) continue;
      targets.push({ instrument, held: heldIds.has(instrument.id) });
    }
    // 持仓优先，其余保持 listInstruments 的代码序（稳定、可预期）
    targets.sort((a, b) => (a.held === b.held ? 0 : a.held ? -1 : 1));
  } else {
    for (const row of holdings.rows) {
      const instrument = byId.get(row.instrumentId) ?? getInstrument(ctx.handle, row.instrumentId);
      if (instrument) targets.push({ instrument, held: true });
    }
  }

  const rows: ValuationRow[] = [];
  for (const { instrument, held } of targets) {
    if (filter.type && instrument.type !== filter.type) continue;
    const metrics = latestValuationMetrics(ctx.handle, instrument.id, ctx.today);
    const lite: MetricLite[] = metrics.map((m) => ({ key: m.metricKey, value: m.value, asOfDate: m.asOfDate, provider: m.provider, quality: m.quality }));
    // 派生分位只在基础指标同日且仍新鲜时参与评分；旧值可追溯，但不能当当前判断。
    const usablePercentile = (key: string): number | null => {
      const metric = lite.find((row) => row.key === `${key}_percentile`);
      const base = lite.find((row) => row.key === key);
      const value = metricNumber(lite, `${key}_percentile`);
      if (!metric || !base || metric.asOfDate !== base.asOfDate || value === null || value < 0 || value > 100) return null;
      const age = (Date.parse(ctx.today) - Date.parse(metric.asOfDate)) / 86_400_000;
      return age >= 0 && age <= 7 && !['STALE', 'CONFLICT', 'MISSING'].includes(metric.quality)
        && !['STALE', 'CONFLICT', 'MISSING'].includes(base.quality) ? value : null;
    };

    const stats = riskStats(ctx, instrument);
    const pe = metricNumber(lite, 'pe');
    const pb = metricNumber(lite, 'pb');
    const pePct = usablePercentile('pe');
    const pbPct = usablePercentile('pb');
    const dy = metricNumber(lite, 'dividend_yield');
    const roe = metricNumber(lite, 'roe');

    const metricValues: MetricValue[] = [
      { key: 'pe', value: pe },
      { key: 'pb', value: pb },
      { key: 'pe_percentile', value: pePct },
      { key: 'pb_percentile', value: pbPct },
      { key: 'dividend_yield', value: dy },
      { key: 'roe', value: roe },
      { key: 'sharpe', value: stats.sharpe },
      { key: 'max_drawdown_pct', value: stats.mdd === null ? null : stats.mdd * 100 },
      { key: 'annual_volatility_pct', value: stats.vol === null ? null : stats.vol * 100 },
    ];
    // 内置模板按标的类型挑；用户自定义模板对所有标的生效
    const applicable = templates.filter((template) => template.origin === 'custom'
      || (instrument.type === 'STOCK' ? template.id === 'stock-value' : template.id !== 'stock-value'));
    const strategies = applicable.map((template) => scoreWithTemplate(template, metricValues));

    rows.push({
      instrumentId: instrument.id,
      code: instrument.code,
      name: instrument.name,
      type: instrument.type,
      held,
      pe: pe === null ? null : String(pe),
      pePercentile: pePct,
      pb: pb === null ? null : String(pb),
      pbPercentile: pbPct,
      dividendYield: dy === null ? null : `${dy}%`,
      roe: roe === null ? null : `${roe}%`,
      sharpe: stats.sharpe,
      volatilityPct: stats.vol === null ? null : stats.vol * 100,
      maxDrawdownPct: stats.mdd === null ? null : stats.mdd * 100,
      caliber: caliberFor(instrument, lite, pe) + (lite.some((metric) => metric.key.endsWith('_percentile') && (metric.key === 'pe_percentile' ? pePct : pbPct) === null)
        ? ' · 分位过期、不同日或质量存疑，不参与评分' : ''),
      strategies,
    });
  }

  return {
    rows,
    scope,
    total: scope === 'all' ? everyInstrument.filter((instrument) => instrument.active).length : rows.length,
    note: '口径：基金 / ETF 用跟踪指数穿透估值并标注日期；主动基金不提供实时穿透；股票为 PE-TTM / 最近披露财报；指数为指数估值截面。分位为近 3 年历史分位（样本不足显示「样本不足」）。分位超过 7 个自然日不参与评分，这是保守新鲜度规则，不证明原值错误。本视图不含收益；缺失指标显示「数据不足」，不填 0。',
  };
}
