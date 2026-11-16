/**
 * 持仓估值视图（PRD §4.13）：不含收益列，聚焦「贵不贵、稳不稳」。
 * 口径规则：基金 / ETF 用关联指数穿透，主动基金不提供实时穿透（显示 —）；
 * 股票为 PE-TTM / PB（最近披露）；分位样本不足显示「样本不足」。
 */
import { SCALE_QTY, parseFixed } from '../../../core/src/money.ts';
import { scoreWithTemplate, type MetricValue, type StrategyScore } from '../../../core/src/strategy.ts';
import type { ServiceContext } from '../context.ts';
import { listTemplates } from '../repo/strategies.ts';
import { getInstrument, listInstruments } from '../repo/instruments.ts';
import { latestValuationMetrics } from '../repo/market.ts';
import { listHoldings } from './holdings.ts';
import { getInstrumentChartSeries, seriesStats } from './charts.ts';

export interface ValuationRow {
  instrumentId: string;
  code: string;
  name: string;
  type: string;
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

interface MetricLite {
  key: string;
  value: string | null;
  asOfDate: string;
  provider: string;
}

function metricNumber(metrics: MetricLite[], key: string): number | null {
  const row = metrics.find((m) => m.key === key);
  if (!row || row.value === null) return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function getHoldingsValuation(
  ctx: ServiceContext,
  filter: { type?: string } = {},
): Promise<{ rows: ValuationRow[]; note: string }> {
  const holdings = listHoldings(ctx);
  const instruments = new Map(listInstruments(ctx.handle).map((i) => [i.id, i]));
  // 模板来自 DB（内置 + 用户编辑版本 + 自定义），每次评分都读当前生效版本
  const templates = listTemplates(ctx.handle);
  const rows: ValuationRow[] = [];

  for (const holding of holdings.rows) {
    if (filter.type && holding.type !== filter.type) continue;
    const instrument = instruments.get(holding.instrumentId);
    if (!instrument) continue;
    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const lite: MetricLite[] = metrics.map((m) => ({ key: m.metricKey, value: m.value, asOfDate: m.asOfDate, provider: m.provider }));

    // 风险指标来自价格 / 净值历史（近 1 年口径）
    let sharpe: number | null = null;
    let vol: number | null = null;
    let mdd: number | null = null;
    try {
      const chart = await getInstrumentChartSeries(ctx, {
        instrumentId: instrument.id,
        tab: 'perf',
        period: '1y',
        compare: 'none',
      });
      const stats = seriesStats(chart.series);
      sharpe = stats.sharpe;
      vol = stats.vol;
      mdd = stats.mdd;
    } catch {
      /* 历史缺失时保持 null */
    }

    const pe = metricNumber(lite, 'pe');
    const pb = metricNumber(lite, 'pb');
    const pePct = metricNumber(lite, 'pe_percentile');
    const pbPct = metricNumber(lite, 'pb_percentile');
    const dy = metricNumber(lite, 'dividend_yield');
    const roe = metricNumber(lite, 'roe');

    // 口径说明
    const isFund = instrument.type === 'OPEN_END_FUND';
    const isEtf = instrument.type === 'ETF';
    const hasIndexLink = Boolean(instrument.benchmarkIndex);
    let caliber: string;
    if (instrument.type === 'STOCK') {
      caliber = `${metrics.length > 0 ? `个股 PE-TTM / PB · ${metrics[0].asOfDate}` : '个股 PE-TTM / PB'}`;
    } else if (isFund && !hasIndexLink && pe === null) {
      caliber = '主动基金 · 持仓披露滞后（季报），不提供实时穿透估值';
    } else if ((isFund || isEtf) && hasIndexLink) {
      caliber = `跟踪指数穿透（${instrument.benchmarkIndex}）· ${metrics[0]?.asOfDate ?? '—'}`;
    } else {
      caliber = metrics.length > 0 ? `估值截面 ${metrics[0].asOfDate}` : '暂无估值数据';
    }
    const manualCount = lite.filter((m) => m.provider === 'manual').length;
    if (manualCount > 0) caliber += ` · 含 ${manualCount} 项手工补录（MANUAL）`;

    const metricValues: MetricValue[] = [
      { key: 'pe', value: pe },
      { key: 'pb', value: pb },
      { key: 'pe_percentile', value: pePct },
      { key: 'pb_percentile', value: pbPct },
      { key: 'dividend_yield', value: dy },
      { key: 'roe', value: roe },
      { key: 'sharpe', value: sharpe },
      { key: 'max_drawdown_pct', value: mdd === null ? null : mdd * 100 },
      { key: 'annual_volatility_pct', value: vol === null ? null : vol * 100 },
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
      pe: pe === null ? null : String(pe),
      pePercentile: pePct,
      pb: pb === null ? null : String(pb),
      pbPercentile: pbPct,
      dividendYield: dy === null ? null : `${dy}%`,
      roe: roe === null ? null : `${roe}%`,
      sharpe,
      volatilityPct: vol === null ? null : vol * 100,
      maxDrawdownPct: mdd === null ? null : mdd * 100,
      caliber,
      strategies,
    });
  }

  return {
    rows,
    note: '口径：基金 / ETF 用跟踪指数穿透估值并标注日期；主动基金不提供实时穿透；股票为 PE-TTM / 最近披露财报。分位为近 3 年历史分位（样本不足显示「样本不足」）。本视图不含收益。',
  };
}
