/**
 * 标的图表序列（PRD §4.12.3）：关联板块 / 业绩走势 / 我的收益。
 *
 * - 业绩走势：标的自身收盘价 / 正式净值序列 + 成本线（虚线）+ 买卖标记 + 可选对比指数；
 * - 我的收益：(有效价格 − 单位成本) × 数量 的累计收益序列，0 为保本线；
 * - 关联板块：标的关联指数走势（benchmark_index → 指数标的）；未关联 → 空态说明。
 * 序列均受时间周期筛选控制；指数历史经 Provider 拉取并落库缓存。
 */
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, mulToScale, parseFixed } from '../../../core/src/money.ts';
import { replayPositions } from '../../../core/src/ledger.ts';
import { annualVolatility, dailyReturns, maxDrawdown, sharpeRatio } from '../../../core/src/valuation.ts';
import type { Instrument } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { INDEX_SECIDS } from '../market/eastmoney.ts';
import { allTransactions } from '../repo/transactions.ts';
import { getInstrument, listInstruments, saveInstrument } from '../repo/instruments.ts';
import { effectiveHistoryPoints, historyPoints, saveMarketPoints } from '../repo/market.ts';

export type ChartTab = 'sector' | 'perf' | 'mine';
export type ChartPeriod = '1m' | '3m' | '1y' | 'all' | 'custom';

function resolveSpan(ctx: ServiceContext, period: ChartPeriod, custom?: { begin: string; end: string }): { begin: string; end: string } {
  const end = ctx.today;
  const days = period === '1m' ? 30 : period === '3m' ? 91 : period === '1y' ? 365 : null;
  if (period === 'custom' && custom) return { begin: custom.begin, end: custom.end || end };
  if (days === null) return { begin: '1970-01-01', end };
  const begin = new Date(`${end}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - days);
  return { begin: begin.toISOString().slice(0, 10), end };
}

/** 关联指数标的（存在则返回，不存在时按 secid 映射懒创建 INDEX 标的用于缓存历史）。 */
function ensureIndexInstrument(ctx: ServiceContext, name: string): Instrument | null {
  const secid = INDEX_SECIDS[name];
  if (!secid) return null;
  const [marketCode, code] = secid.split('.');
  const existing = listInstruments(ctx.handle).find((i) => i.type === 'INDEX' && i.code === code);
  if (existing) return existing;
  try {
    return saveInstrument(ctx.handle, {
      code,
      name,
      type: 'INDEX',
      market: marketCode === '1' ? 'SH' : 'SZ',
      secid,
      tag: '指数（对照）',
    });
  } catch {
    return null;
  }
}

/** 异步版本：确保对比指数历史已尝试拉取一次（失败静默，使用库内缓存）。 */
export async function ensureIndexHistory(ctx: ServiceContext, indexInstrument: Instrument, span: { begin: string; end: string }): Promise<void> {
  const provider = ctx.registry.resolve(indexInstrument);
  if (!provider) return;
  const cached = historyPoints(ctx.handle, indexInstrument.id, ['CLOSE_PRICE'], span.begin, span.end);
  if (cached.length > 0) return; // 已有缓存（缓存优先，低频拉取）
  try {
    const points = await provider.fetchHistory(indexInstrument, span);
    if (points.length > 0) saveMarketPoints(ctx.handle, points);
  } catch {
    /* 失败显式由上层空态表达 */
  }
}

export interface ChartPoint {
  date: string;
  /** 定点字符串。 */
  value: string;
}

export interface ChartMarker {
  date: string;
  type: 'buy' | 'sell';
  label: string;
}

export interface ChartSeriesResult {
  tab: ChartTab;
  period: ChartPeriod;
  span: { begin: string; end: string };
  instrument: { id: string; code: string; name: string; type: string };
  unitCost: string | null;
  series: ChartPoint[];
  costLine: string | null;
  markers: ChartMarker[];
  compare: { name: string; series: ChartPoint[] } | null;
  list: { date: string; value: string; change: string | null; extra?: string | null }[];
  note: string | null;
}

export async function getInstrumentChartSeries(
  ctx: ServiceContext,
  input: { instrumentId: string; tab: ChartTab; period: ChartPeriod; compare?: string | null; custom?: { begin: string; end: string } },
): Promise<ChartSeriesResult> {
  const instrument = getInstrument(ctx.handle, input.instrumentId);
  if (!instrument) throw new Error(`instrument not found: ${input.instrumentId}`);
  const span = resolveSpan(ctx, input.period, input.custom);
  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const pos = [...positions.values()].find((p) => p.instrumentId === instrument.id && p.qtyRaw > 0) ?? null;
  const unitCostRaw = pos && pos.qtyRaw > 0 ? pos.unitCostRaw : null;
  const qtyRaw = pos && pos.qtyRaw > 0 ? pos.qtyRaw : null;

  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end);
  // 「我的收益」Tab 画的是累计收益金额（0 = 保本线），不是价格 / 净值曲线。
  const minePoints = input.tab === 'mine' && unitCostRaw !== null && qtyRaw !== null
    ? myProfitSeries(ctx, instrument.id, span)
    : [];
  const series: ChartPoint[] = input.tab === 'mine'
    ? minePoints.map((p) => ({ date: p.date, value: p.cumulative }))
    : points.map((p) => ({ date: p.tradingDate, value: p.value }));

  // 买卖标记（不含待确认）
  const markers: ChartMarker[] = txns
    .filter((t) => t.instrumentId === instrument.id && t.status === 'CONFIRMED' && t.tradeDate >= span.begin && t.tradeDate <= span.end)
    .filter((t) => ['BUY', 'OPENING', 'DIVIDEND_REINVEST', 'SELL'].includes(t.type))
    .map((t) => ({
      date: t.tradeDate,
      type: t.type === 'SELL' ? ('sell' as const) : ('buy' as const),
      label: `${t.tradeDate} ${t.type === 'SELL' ? '卖出' : '买入'} ${t.quantity ?? ''} @${t.price ?? ''}`,
    }));

  // 对比 / 板块指数
  let compare: ChartSeriesResult['compare'] = null;
  if (input.tab === 'perf' && input.compare && input.compare !== 'none') {
    const indexInstrument = ensureIndexInstrument(ctx, input.compare);
    if (indexInstrument) {
      await ensureIndexHistory(ctx, indexInstrument, span);
      const idxPoints = historyPoints(ctx.handle, indexInstrument.id, ['CLOSE_PRICE'], span.begin, span.end);
      if (idxPoints.length > 0) {
        compare = {
          name: input.compare,
          series: idxPoints.map((p) => ({ date: p.tradingDate, value: p.value })),
        };
      }
    }
  }
  if (input.tab === 'sector' && instrument.benchmarkIndex) {
    const indexInstrument = ensureIndexInstrument(ctx, instrument.benchmarkIndex);
    if (indexInstrument) {
      await ensureIndexHistory(ctx, indexInstrument, span);
      const idxPoints = historyPoints(ctx.handle, indexInstrument.id, ['CLOSE_PRICE'], span.begin, span.end);
      if (idxPoints.length > 0) {
        compare = {
          name: instrument.benchmarkIndex,
          series: idxPoints.map((p) => ({ date: p.tradingDate, value: p.value })),
        };
      }
    }
  }

  // 联动列表：业绩走势 → 日期/净值/日涨幅；我的收益 → 日期/当日变动/累计收益（金额 scale=2）
  const list: ChartSeriesResult['list'] = [];
  if (input.tab === 'mine') {
    for (const point of minePoints) {
      list.push({ date: point.date, value: point.daily, change: null, extra: point.cumulative });
    }
  } else {
    for (let i = 0; i < series.length; i += 1) {
      const point = series[i];
      const prevRaw = i === 0 ? null : parseFixed(series[i - 1].value, SCALE_QTY);
      const raw = parseFixed(point.value, SCALE_QTY);
      const change = prevRaw === null || prevRaw === 0 ? null : `${raw >= prevRaw ? '+' : ''}${(((raw / prevRaw) - 1) * 100).toFixed(2)}%`;
      list.push({ date: point.date, value: point.value, change, extra: null });
    }
  }

  let note: string | null = null;
  if (input.tab === 'sector' && !compare) {
    note = '该标的未关联指数 / 板块，无法展示板块走势；可在编辑标的时补充关联指数';
  }
  if (input.tab === 'mine' && (unitCostRaw === null || qtyRaw === null)) {
    note = '当前未持有该标的，无法展示我的收益';
  }
  if (series.length === 0) {
    note = note ?? '区间内没有可用历史数据，请先刷新行情';
  }

  return {
    tab: input.tab,
    period: input.period,
    span,
    instrument: { id: instrument.id, code: instrument.code, name: instrument.name, type: instrument.type },
    unitCost: unitCostRaw === null ? null : formatFixed(unitCostRaw, SCALE_QTY),
    series,
    costLine: input.tab === 'mine'
      ? (minePoints.length > 0 ? '0' : null)
      : (unitCostRaw === null ? null : formatFixed(unitCostRaw, SCALE_QTY)),
    markers,
    compare,
    list,
    note,
  };
}

/** 我的收益序列（供持仓详情「我的收益」Tab 直接消费）。 */
export function myProfitSeries(
  ctx: ServiceContext,
  instrumentId: string,
  span: { begin: string; end: string },
): { date: string; daily: string; cumulative: string }[] {
  const instrument = getInstrument(ctx.handle, instrumentId);
  if (!instrument) return [];
  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const pos = [...positions.values()].find((p) => p.instrumentId === instrumentId && p.qtyRaw > 0);
  if (!pos || pos.qtyRaw === 0) return [];
  const points = effectiveHistoryPoints(ctx.handle, instrumentId, instrument.type, span.begin, span.end);
  const out: { date: string; daily: string; cumulative: string }[] = [];
  let prevProfit: number | null = null;
  for (const p of points) {
    const raw = parseFixed(p.value, SCALE_QTY);
    const profit = mulToScale(raw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) - mulToScale(pos.unitCostRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
    out.push({
      date: p.tradingDate,
      daily: formatFixed(prevProfit === null ? 0 : profit - prevProfit, SCALE_AMOUNT),
      cumulative: formatFixed(profit, SCALE_AMOUNT),
    });
    prevProfit = profit;
  }
  return out;
}

/** 供估值视图使用：标的日收益序列的统计摘要。 */
export function seriesStats(series: ChartPoint[]): { sharpe: number | null; vol: number | null; mdd: number | null } {
  const navs = series.map((p) => parseFixed(p.value, SCALE_QTY));
  const rets = dailyReturns(navs);
  return {
    sharpe: sharpeRatio(rets, { minSamples: 20 }),
    vol: annualVolatility(rets, { minSamples: 20 }),
    mdd: maxDrawdown(navs),
  };
}
