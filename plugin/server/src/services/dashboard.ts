/**
 * 总览服务（PRD §4.1）：摘要、双模式资产分布、表现指标。
 * 表现指标基于组合单位净值序列（资金投入归一），样本不足显式返回 null。
 */
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, mulToScale, parseFixed, divToScale } from '../../../core/src/money.ts';
import { replayPositions } from '../../../core/src/ledger.ts';
import { allocation, type AllocationMode } from '../../../core/src/goal.ts';
import { maxDrawdown, dailyReturns, sharpeRatio, xirr } from '../../../core/src/valuation.ts';
import type { Instrument, Txn } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { allTransactions, listDeletedPositions } from '../repo/transactions.ts';
import { listInstruments } from '../repo/instruments.ts';
import { getEnabledGoal, listCashFlows } from '../repo/goal.ts';
import { effectiveHistoryPoints, latestValuationMetrics } from '../repo/market.ts';
import { listHoldings } from './holdings.ts';
import { cashTotal } from '../repo/cash.ts';

const CATEGORY_BY_TYPE: Record<Instrument['type'], string> = {
  STOCK: 'stock',
  ETF: 'etf',
  OPEN_END_FUND: 'fund',
  INDEX: 'index',
};

const CATEGORY_LABELS: Record<string, string> = {
  stock: '股票',
  etf: 'ETF',
  fund: '场外基金',
  index: '指数（对照）',
};

const CATEGORY_COLORS: Record<string, string> = {
  stock: '#4c6ef5',
  etf: '#ee9d3f',
  fund: '#9a6bf2',
};

export interface DashboardSummary {
  totalMarketValue: string;
  /** 现金 / 货币基金等流动性资产合计（schema v3）。 */
  cashTotal: string;
  /** 持仓市值 + 现金。 */
  totalAssets: string;
  /** 现金占总资产比例；总资产为 0 时为 null。 */
  cashWeight: number | null;
  byCategory: { key: string; label: string; value: string; weight: number }[];
  dayPnl: string | null;
  dayPnlNote: string | null;
  unrealized: string;
  realized: string;
  dividends: string;
  cumulative: string;
  incomplete: string[];
  updatedAt: string | null;
  dataDate: string | null;
}

function prevTradingPrice(
  ctx: ServiceContext,
  instrument: Instrument,
  currentDate: string,
): { date: string; valueRaw: number } | null {
  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, undefined, undefined, ctx.today);
  const earlier = points.filter((p) => p.tradingDate < currentDate);
  const prev = earlier[earlier.length - 1];
  return prev ? { date: prev.tradingDate, valueRaw: parseFixed(prev.value, SCALE_QTY) } : null;
}

export function getDashboardSummary(ctx: ServiceContext): DashboardSummary {
  const holdings = listHoldings(ctx);
  const byCategoryMap = new Map<string, number>();
  let dayPnlRaw = 0;
  let dayPnlKnown = true;
  let updatedAt: string | null = null;
  let dataDate: string | null = null;

  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const instruments = new Map(listInstruments(ctx.handle).map((i) => [i.id, i]));

  for (const row of holdings.rows) {
    const value = row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0;
    const key = CATEGORY_BY_TYPE[row.type];
    byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + value);
    if (row.priceDate && (!dataDate || row.priceDate > dataDate)) dataDate = row.priceDate;
    if (row.observedAt && (!updatedAt || row.observedAt > updatedAt)) updatedAt = row.observedAt;
    if (row.price === null) continue;
    const instrument = instruments.get(row.instrumentId);
    if (!instrument) continue;
    const prev = prevTradingPrice(ctx, instrument, row.priceDate ?? ctx.today);
    if (!prev) {
      dayPnlKnown = false;
      continue;
    }
    const qtyRaw = parseFixed(row.qty, SCALE_QTY);
    const priceRaw = parseFixed(row.price, SCALE_QTY);
    dayPnlRaw += mulToScale(priceRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) - mulToScale(prev.valueRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
  }

  // 已实现 / 分红：包含已删除视图的持仓（钱已经落袋）。
  let realizedRaw = 0;
  let dividendsRaw = 0;
  const deletedKeys = new Set(listDeletedPositions(ctx.handle).map((d) => `${d.accountId}:${d.instrumentId}`));
  for (const [key, pos] of positions) {
    realizedRaw += pos.realizedRaw;
    dividendsRaw += pos.dividendsRaw;
    if (deletedKeys.has(key) && pos.qtyRaw === 0) continue;
    // 未实现只统计可见持仓（删除视图且已清仓的没有未实现）。
  }
  const unrealizedRawTotal = holdings.rows.reduce((acc, row) => {
    if (row.marketValue === null || row.pnl === null) return acc;
    return acc + parseFixed(row.pnl, SCALE_AMOUNT);
  }, 0);

  const totalRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const byCategory = [...byCategoryMap.entries()]
    .filter(([key]) => key !== 'index')
    .map(([key, value]) => ({
      key,
      label: CATEGORY_LABELS[key] ?? key,
      value: formatFixed(value, SCALE_AMOUNT),
      weight: totalRaw > 0 ? value / totalRaw : 0,
    }))
    .sort((a, b) => b.weight - a.weight);

  const cash = cashTotal(ctx.handle);
  const holdingsRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const cashRaw = parseFixed(cash, SCALE_AMOUNT);
  const assetsRaw = holdingsRaw + cashRaw;
  return {
    totalMarketValue: holdings.totalMarketValue,
    cashTotal: cash,
    totalAssets: formatFixed(assetsRaw, SCALE_AMOUNT),
    cashWeight: assetsRaw > 0 ? cashRaw / assetsRaw : null,
    byCategory,
    dayPnl: dayPnlKnown ? formatFixed(dayPnlRaw, SCALE_AMOUNT) : null,
    dayPnlNote: dayPnlKnown ? null : '部分持仓缺少上一交易日可比价格，暂无可比日收益',
    unrealized: formatFixed(unrealizedRawTotal, SCALE_AMOUNT),
    realized: formatFixed(realizedRaw, SCALE_AMOUNT),
    dividends: formatFixed(dividendsRaw, SCALE_AMOUNT),
    cumulative: formatFixed(unrealizedRawTotal + realizedRaw + dividendsRaw, SCALE_AMOUNT),
    incomplete: holdings.incomplete,
    updatedAt,
    dataDate,
  };
}

export function getDashboardAllocation(
  ctx: ServiceContext,
  mode: AllocationMode,
): ReturnType<typeof allocation> & { incomplete: string[] } {
  const holdings = listHoldings(ctx);
  const byCategoryMap = new Map<string, number>();
  for (const row of holdings.rows) {
    const key = CATEGORY_BY_TYPE[row.type];
    if (key === 'index') continue;
    byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + (row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0));
  }
  const goal = getEnabledGoal(ctx.handle);
  const result = allocation({
    categories: [...byCategoryMap.entries()].map(([key, value]) => ({
      key,
      label: CATEGORY_LABELS[key] ?? key,
      value: formatFixed(value, SCALE_AMOUNT),
      color: CATEGORY_COLORS[key],
    })),
    goal: goal ? { targetAmount: goal.targetAmount, enabled: goal.enabled } : null,
    mode,
  });
  return { ...result, incomplete: holdings.incomplete };
}

/* ---------------- 表现指标（XIRR / 回撤 / 夏普，PRD §4.1.5） ---------------- */

export type RangeKey = '1m' | '3m' | '1y' | 'all' | 'custom';

function resolveRange(range: RangeKey, custom?: { begin: string; end: string }, today?: string): { begin: string; end: string } {
  const end = today ?? new Date().toISOString().slice(0, 10);
  const days = range === '1m' ? 30 : range === '3m' ? 91 : range === '1y' ? 365 : null;
  if (range === 'custom' && custom) return { begin: custom.begin, end: custom.end || end };
  if (days === null) {
    return { begin: '1970-01-01', end };
  }
  const beginDate = new Date(`${end}T00:00:00Z`);
  beginDate.setUTCDate(beginDate.getUTCDate() - days);
  return { begin: beginDate.toISOString().slice(0, 10), end };
}

/** 截至某日的持仓数量（回放该日之前的已确认交易）。 */
function qtyAt(txns: Txn[], accountId: string, instrumentId: string, date: string): number {
  const positions = replayPositions(txns.filter((t) => t.tradeDate <= date));
  const pos = positions.get(`${accountId}:${instrumentId}`);
  return pos?.qtyRaw ?? 0;
}

export interface PerformanceMetrics {
  range: { begin: string; end: string };
  xirr: number | null;
  xirrNote: string | null;
  maxDrawdown: number | null;
  sharpe: number | null;
  seriesPoints: number;
  coverage: number;
  note: string | null;
  series: { date: string; value: string; nav: string | null }[];
  /** 组合 PE / PB：按持仓市值加权；缺失成分不按 0 处理，覆盖 <80% 不产生数值。 */
  portfolioPe: number | null;
  portfolioPb: number | null;
  valuationCoverage: number | null;
  valuationNote: string | null;
}

function metricValue(rows: { metricKey: string; value: string | null }[], key: string): number | null {
  const row = rows.find((r) => r.metricKey === key);
  if (!row || row.value === null) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function portfolioValuation(ctx: ServiceContext, rows: { instrumentId: string; marketValue: string | null }[]): {
  portfolioPe: number | null; portfolioPb: number | null; valuationCoverage: number; valuationNote: string | null;
} {
  let totalMv = 0;
  let coveredMv = 0;
  let peWeighted = 0;
  let pbWeighted = 0;
  for (const row of rows) {
    const mv = row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0;
    if (mv <= 0) continue;
    totalMv += mv;
    const metrics = latestValuationMetrics(ctx.handle, row.instrumentId);
    const pe = metricValue(metrics, 'pe');
    const pb = metricValue(metrics, 'pb');
    if (pe !== null && pb !== null) {
      peWeighted += pe * mv;
      pbWeighted += pb * mv;
      coveredMv += mv;
    }
  }
  const coverage = totalMv > 0 ? coveredMv / totalMv : 0;
  if (coveredMv === 0) {
    return { portfolioPe: null, portfolioPb: null, valuationCoverage: coverage, valuationNote: '暂无可用的 PE / PB 估值截面（刷新行情或手工补录后显示）' };
  }
  if (coverage < 0.8) {
    return { portfolioPe: null, portfolioPb: null, valuationCoverage: coverage, valuationNote: `估值截面覆盖 ${(coverage * 100).toFixed(0)}%，低于 80% 不产生组合估值` };
  }
  return {
    portfolioPe: Math.round((peWeighted / coveredMv) * 100) / 100,
    portfolioPb: Math.round((pbWeighted / coveredMv) * 100) / 100,
    valuationCoverage: coverage,
    valuationNote: `按 ${(coverage * 100).toFixed(0)}% 覆盖市值加权 · 缺失成分不按 0 处理`,
  };
}

export function getPerformance(ctx: ServiceContext, range: RangeKey, custom?: { begin: string; end: string }): PerformanceMetrics {
  const span = resolveRange(range, custom, ctx.today);
  const holdings = listHoldings(ctx);
  const instruments = new Map(listInstruments(ctx.handle).map((i) => [i.id, i]));
  const txns = allTransactions(ctx.handle);

  // 每个持仓标的的历史（收盘价 / 正式净值）
  const histories = new Map<string, { date: string; raw: number }[]>();
  const dateSet = new Set<string>();
  for (const row of holdings.rows) {
    const instrument = instruments.get(row.instrumentId);
    if (!instrument) continue;
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end, ctx.today);
    const series = points.map((p) => ({ date: p.tradingDate, raw: parseFixed(p.value, SCALE_QTY) }));
    histories.set(row.instrumentId, series);
    for (const p of points) dateSet.add(p.tradingDate);
  }
  const dates = [...dateSet].sort();
  if (dates.length === 0) {
    return {
      range: span, xirr: null, xirrNote: '区间内没有可用历史价格', maxDrawdown: null, sharpe: null,
      seriesPoints: 0, coverage: 0, note: '开始记录并刷新行情后可查看', series: [],
      ...portfolioValuation(ctx, holdings.rows),
    };
  }

  // 组合市值序列 + 资金占用（用于单位净值归一）
  const flows = listCashFlows(ctx.handle, { begin: span.begin, end: span.end });
  const series: PerformanceMetrics['series'] = [];
  let prevMvRaw: number | null = null;
  const returns: number[] = [];
  let missingDays = 0;
  for (const date of dates) {
    let mvRaw = 0;
    let complete = true;
    for (const row of holdings.rows) {
      const instrument = instruments.get(row.instrumentId);
      if (!instrument) continue;
      const qtyRaw = qtyAt(txns, row.accountId, row.instrumentId, date);
      if (qtyRaw === 0) continue;
      const history = histories.get(row.instrumentId) ?? [];
      let priceRaw: number | null = null;
      for (const p of history) {
        if (p.date <= date) priceRaw = p.raw;
        else break;
      }
      if (priceRaw === null) {
        complete = false;
        continue;
      }
      mvRaw += mulToScale(priceRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
    }
    if (!complete) missingDays += 1;
    series.push({
      date,
      value: formatFixed(mvRaw, SCALE_AMOUNT),
      nav: null,
    });
    if (prevMvRaw !== null && prevMvRaw > 0) {
      returns.push(mvRaw / prevMvRaw - 1);
    }
    prevMvRaw = mvRaw;
  }

  // 单位净值序列：市值 ÷ 累计净投入（PRD §4.1.5 防止追加资金造成虚假回撤）
  const flowsSorted = [...flows].sort((a, b) => (a.flowDate < b.flowDate ? -1 : 1));
  let capitalRaw = 0;
  let flowIndex = 0;
  let unitNavBroken = false;
  for (const point of series) {
    while (flowIndex < flowsSorted.length && flowsSorted[flowIndex].flowDate <= point.date) {
      const flow = flowsSorted[flowIndex];
      const raw = parseFixed(flow.amount, SCALE_AMOUNT);
      capitalRaw += flow.flowType === 'CONTRIBUTION' ? raw : -raw;
      flowIndex += 1;
    }
    if (capitalRaw > 0) {
      const mvRaw = parseFixed(point.value, SCALE_AMOUNT);
      point.nav = formatFixed(divToScale(mvRaw, SCALE_AMOUNT, capitalRaw, SCALE_AMOUNT, SCALE_QTY), SCALE_QTY);
    } else if (flowsSorted.length > 0 && capitalRaw <= 0) {
      unitNavBroken = true;
    }
  }

  const navSeries = series.filter((p) => p.nav !== null).map((p) => parseFixed(p.nav!, SCALE_QTY));
  const useNav = navSeries.length >= 2 && !unitNavBroken;
  const mdd = useNav ? maxDrawdown(navSeries) : maxDrawdown(series.map((p) => parseFixed(p.value, SCALE_AMOUNT)));
  const rets = useNav ? dailyReturns(navSeries) : returns;
  const sharpe = sharpeRatio(rets, {});
  const coverage = dates.length > 0 ? 1 - missingDays / dates.length : 0;

  // XIRR：外部投入（负）+ 取出（正）+ 期末市值（正）
  const endMv = parseFixed(series[series.length - 1]?.value ?? '0', SCALE_AMOUNT);
  const xirrFlows = [
    ...flows.map((f) => ({
      date: f.flowDate,
      amount: f.flowType === 'CONTRIBUTION' ? -parseFixed(f.amount, SCALE_AMOUNT) : parseFixed(f.amount, SCALE_AMOUNT),
    })),
    ...(endMv > 0 ? [{ date: span.end, amount: endMv }] : []),
  ];
  const xirrValue = xirr(xirrFlows);
  const hasFlows = flows.length > 0;

  return {
    range: span,
    xirr: xirrValue,
    xirrNote: xirrValue === null
      ? (hasFlows ? '现金流与期末价值无法求解 XIRR' : '缺少组合外部投入 / 取出记录，无法计算 XIRR')
      : null,
    maxDrawdown: mdd,
    sharpe,
    seriesPoints: series.length,
    coverage,
    note: missingDays > 0 ? `${missingDays} 个交易日缺少部分持仓价格，已按可得数据计算` : null,
    series,
    ...portfolioValuation(ctx, holdings.rows),
  };
}
