/**
 * 决策就绪度（Decision Readiness）。
 *
 * 回答一个具体问题：**当前数据是否足以支撑个人资产决策**。
 * 做法：把决策链拆成 8 个维度，逐项判定 OK / PARTIAL / MISSING，
 * 给出加权分数、阻塞项与可执行的补齐动作；不做买卖建议。
 *
 * 纪律：
 * - 缺数据一律记 MISSING / PARTIAL，绝不用 0 或估算值冒充。
 * - 覆盖率阈值与集中度阈值同源（估值覆盖 80%、集中度见 portfolio-risk）。
 * - 分数只描述「信息完备度」，不代表标的好坏或收益预期。
 */
import type { ServiceContext } from '../context.ts';
import { getEnabledGoal, listCashFlows } from '../repo/goal.ts';
import { analysisValuationMetrics } from '../repo/market.ts';
import { listInstruments } from '../repo/instruments.ts';
import { SCALE_AMOUNT, parseFixed } from '../../../core/src/money.ts';
import { concentration, type ConcentrationResult } from '../../../core/src/portfolio-risk.ts';
import { getPerformance } from './dashboard.ts';
import { cashTotal } from '../repo/cash.ts';
import { listHoldings } from './holdings.ts';

export type ReadinessStatus = 'OK' | 'PARTIAL' | 'MISSING';
export type ReadinessVerdict = 'READY' | 'PARTIAL' | 'INSUFFICIENT';

export interface ReadinessItem {
  key: string;
  /** 该维度服务的决策问题，例如「我现在到底有多少钱？」 */
  question: string;
  label: string;
  status: ReadinessStatus;
  /** 现状事实（含具体数字）。 */
  detail: string;
  /** 用户可执行的补齐动作。 */
  action: string;
  weight: number;
}

export interface DecisionReadiness {
  score: number;
  verdict: ReadinessVerdict;
  verdictText: string;
  items: ReadinessItem[];
  /** 阻塞决策的关键缺口（仅 MISSING 项）。 */
  blockers: string[];
  concentration: ConcentrationResult;
  metrics: {
    holdingCount: number;
    pricedCount: number;
    priceCoverage: number;
    totalMarketValue: string;
    valuationCoverage: number;
    cashFlowCount: number;
    goalEnabled: boolean;
    xirr: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
    portfolioPe: number | null;
    indexCount: number;
    indexWithMetrics: number;
    dataDate: string | null;
  };
  note: string;
}

const WEIGHTS = {
  holdings: 14,
  pricing: 18,
  valuation: 11,
  cashflow: 9,
  performance: 13,
  goal: 7,
  concentration: 10,
  index: 7,
  cash: 11,
} as const;

const VALUATION_COVERAGE_FLOOR = 0.8;

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

export function getDecisionReadiness(ctx: ServiceContext): DecisionReadiness {
  const holdings = listHoldings(ctx);
  const rows = holdings.rows;
  const holdingCount = rows.length;

  const priced = rows.filter((r) => r.marketValue !== null && r.price !== null);
  const pricedCount = priced.length;
  const totalRaw = rows.reduce(
    (sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)),
    0,
  );
  const pricedRaw = priced.reduce(
    (sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)),
    0,
  );
  const priceCoverage = totalRaw > 0 ? pricedRaw / totalRaw : 0;
  const dataDate = rows.reduce<string | null>((latest, r) => {
    if (!r.priceDate) return latest;
    return !latest || r.priceDate > latest ? r.priceDate : latest;
  }, null);

  const performance = getPerformance(ctx, '1y');
  const cashFlows = listCashFlows(ctx.handle);
  const goal = getEnabledGoal(ctx.handle);

  const indexInstruments = listInstruments(ctx.handle, { type: 'INDEX', active: true });
  const indexWithMetrics = indexInstruments.filter((inst) => {
    const metrics = analysisValuationMetrics(ctx.handle, inst.id);
    return metrics.some((m) => m.metricKey === 'pe' && m.value !== null);
  }).length;

  const concentrationResult = concentration(rows.map((r) => ({
    id: r.instrumentId,
    name: r.name,
    category: r.type,
    marketValue: r.marketValue,
  })));

  const items: ReadinessItem[] = [];

  // 1. 持仓与成本
  items.push({
    key: 'holdings',
    question: '我现在持有什么、成本多少？',
    label: '持仓与成本',
    status: holdingCount > 0 ? 'OK' : 'MISSING',
    detail: holdingCount > 0
      ? `${holdingCount} 个持仓，成本与数量来自交易流水回放。`
      : '没有任何持仓。',
    action: holdingCount > 0 ? '—' : '在「持仓 → 记一笔」录入买入交易，或从 CSV 导入流水。',
    weight: WEIGHTS.holdings,
  });

  // 2. 价格覆盖（市值是否可信）
  if (holdingCount === 0) {
    items.push({
      key: 'pricing', question: '我的资产现在值多少钱？', label: '价格与市值',
      status: 'MISSING', detail: '无持仓，无可估值资产。',
      action: '先录入持仓。', weight: WEIGHTS.pricing,
    });
  } else if (priceCoverage >= 0.999) {
    items.push({
      key: 'pricing', question: '我的资产现在值多少钱？', label: '价格与市值',
      status: 'OK', detail: `${pricedCount}/${holdingCount} 个持仓有有效价格，市值完整；最新价格日期 ${dataDate ?? '—'}。`,
      action: '—', weight: WEIGHTS.pricing,
    });
  } else if (priceCoverage > 0) {
    items.push({
      key: 'pricing', question: '我的资产现在值多少钱？', label: '价格与市值',
      status: 'PARTIAL', detail: `仅 ${pricedCount}/${holdingCount} 个持仓有价格（按市值覆盖 ${pct(priceCoverage)}），总市值与收益被低估。`,
      action: '在「设置 → 刷新行情」拉取，或对缺价标的用「手工价格」补录。', weight: WEIGHTS.pricing,
    });
  } else {
    items.push({
      key: 'pricing', question: '我的资产现在值多少钱？', label: '价格与市值',
      status: 'MISSING', detail: '所有持仓都缺有效价格，总市值不可用。',
      action: '刷新行情或手工补录价格。', weight: WEIGHTS.pricing,
    });
  }

  // 3. 估值截面（贵不贵）
  const valuationCoverage = performance.valuationCoverage ?? 0;
  if (holdingCount === 0) {
    items.push({
      key: 'valuation', question: '我持有的东西现在贵不贵？', label: '组合估值',
      status: 'MISSING', detail: '无持仓，无组合估值。',
      action: '先录入持仓与估值指标。', weight: WEIGHTS.valuation,
    });
  } else if (valuationCoverage >= VALUATION_COVERAGE_FLOOR && performance.portfolioPe !== null) {
    items.push({
      key: 'valuation', question: '我持有的东西现在贵不贵？', label: '组合估值',
      status: 'OK',
      detail: `组合 PE ${performance.portfolioPe} · PB ${performance.portfolioPb ?? '—'}，按 ${pct(valuationCoverage)} 覆盖市值加权。`,
      action: '—', weight: WEIGHTS.valuation,
    });
  } else if (valuationCoverage > 0) {
    items.push({
      key: 'valuation', question: '我持有的东西现在贵不贵？', label: '组合估值',
      status: 'PARTIAL',
      detail: `估值截面覆盖 ${pct(valuationCoverage)}，低于 ${pct(VALUATION_COVERAGE_FLOOR)} 不产生组合 PE/PB。`,
      action: '刷新行情补齐 PE/PB，或在持仓详情「补录估值指标」。', weight: WEIGHTS.valuation,
    });
  } else {
    items.push({
      key: 'valuation', question: '我持有的东西现在贵不贵？', label: '组合估值',
      status: 'MISSING', detail: '没有任何 PE / PB 估值截面。',
      action: '刷新行情，或手工补录 PE / PB。', weight: WEIGHTS.valuation,
    });
  }

  // 4. 外部资金流（真实收益率的分母）
  items.push({
    key: 'cashflow',
    question: '我的真实收益率是多少？',
    label: '外部资金流',
    status: cashFlows.length > 0 ? 'OK' : 'MISSING',
    detail: cashFlows.length > 0
      ? `${cashFlows.length} 笔外部资金流，可计算 XIRR。`
      : '未录入外部资金流，XIRR 无法计算（只能看账面涨跌）。',
    action: cashFlows.length > 0 ? '—' : '在「总览 → 资金流」录入入金 / 出金记录。',
    weight: WEIGHTS.cashflow,
  });

  // 5. 表现指标（承担了多少风险）
  const hasXirr = performance.xirr !== null;
  const hasDrawdown = performance.maxDrawdown !== null;
  const hasSharpe = performance.sharpe !== null;
  if (hasXirr && hasDrawdown) {
    items.push({
      key: 'performance', question: '我承担了多少风险、性价比如何？', label: '收益与风险',
      status: hasSharpe ? 'OK' : 'PARTIAL',
      detail: `XIRR ${(performance.xirr! * 100).toFixed(2)}% · 最大回撤 ${(performance.maxDrawdown! * 100).toFixed(2)}% · 夏普 ${hasSharpe ? performance.sharpe!.toFixed(2) : '样本不足'}，区间 ${performance.range.begin} → ${performance.range.end}（${performance.seriesPoints} 个净值点）。`,
      action: hasSharpe ? '—' : '补齐无风险利率与更多历史净值点后夏普才可用。',
      weight: WEIGHTS.performance,
    });
  } else if (hasXirr || hasDrawdown) {
    items.push({
      key: 'performance', question: '我承担了多少风险、性价比如何？', label: '收益与风险',
      status: 'PARTIAL',
      detail: `仅有部分指标（XIRR ${hasXirr ? '可用' : '不可用'} / 最大回撤 ${hasDrawdown ? '可用' : '不可用'}）。`,
      action: '补齐外部资金流与历史价格，使净值序列完整。', weight: WEIGHTS.performance,
    });
  } else {
    items.push({
      key: 'performance', question: '我承担了多少风险、性价比如何？', label: '收益与风险',
      status: 'MISSING', detail: 'XIRR 与最大回撤均不可用（样本不足或资金流缺失）。',
      action: '录入外部资金流 + 回补历史价格。', weight: WEIGHTS.performance,
    });
  }

  // 6. 目标
  items.push({
    key: 'goal',
    question: '我要去哪里、还差多少？',
    label: '投资目标',
    status: goal ? 'OK' : 'MISSING',
    detail: goal
      ? `已设置目标金额（${goal.enabled ? '目标模式启用中' : '目标模式未启用'}），可在「总览 → 目标达成」查看进度。`
      : '未设置目标金额，无法判断进度与所需收益率。',
    action: goal ? '—' : '在「总览 → 目标达成」设置目标金额与期限。',
    weight: WEIGHTS.goal,
  });

  // 7. 集中度
  const highFlags = concentrationResult.flags.filter((f) => f.level === 'HIGH');
  if (concentrationResult.top1 === null) {
    items.push({
      key: 'concentration', question: '我的风险是否过度集中？', label: '集中度',
      status: 'MISSING', detail: '无可用市值，无法计算集中度。',
      action: '先补齐持仓价格。', weight: WEIGHTS.concentration,
    });
  } else if (highFlags.length > 0) {
    items.push({
      key: 'concentration', question: '我的风险是否过度集中？', label: '集中度',
      status: 'PARTIAL',
      detail: `单一持仓 ${pct(concentrationResult.top1.weight)} · 前三大 ${pct(concentrationResult.top3Weight ?? 0)} · 有效持仓数 ${concentrationResult.effectiveHoldings?.toFixed(1) ?? '—'}；${highFlags.length} 项超高度集中线。`,
      action: '检查是否要降低单一标的权重（本工具只提示，不自动下单）。', weight: WEIGHTS.concentration,
    });
  } else {
    items.push({
      key: 'concentration', question: '我的风险是否过度集中？', label: '集中度',
      status: 'OK',
      detail: `单一持仓 ${pct(concentrationResult.top1.weight)} · 前三大 ${pct(concentrationResult.top3Weight ?? 0)} · 有效持仓数 ${concentrationResult.effectiveHoldings?.toFixed(1) ?? '—'}。`,
      action: '—', weight: WEIGHTS.concentration,
    });
  }

  // 8. 现金与流动性（决定真实仓位与应急能力）
  const cash = cashTotal(ctx.handle);
  const cashRaw = parseFixed(cash, SCALE_AMOUNT);
  const holdingsRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const assetsRaw = holdingsRaw + cashRaw;
  const cashShare = assetsRaw > 0 ? cashRaw / assetsRaw : null;
  if (assetsRaw <= 0) {
    items.push({
      key: 'cash', question: '我留了多少现金、应急能力如何？', label: '现金与流动性',
      status: 'MISSING', detail: '没有持仓也没有现金余额，无法评估流动性。',
      action: '在「总览 → 现金」录入现金 / 货币基金余额。', weight: WEIGHTS.cash,
    });
  } else if (cashRaw > 0) {
    items.push({
      key: 'cash', question: '我留了多少现金、应急能力如何？', label: '现金与流动性',
      status: 'OK',
      detail: `现金 ${cash} 元，占总资产 ${pct(cashShare ?? 0)}；总资产 = 持仓市值 + 现金。`,
      action: '—', weight: WEIGHTS.cash,
    });
  } else {
    items.push({
      key: 'cash', question: '我留了多少现金、应急能力如何？', label: '现金与流动性',
      status: 'PARTIAL', detail: '未录入现金余额，总资产只等于持仓市值，仓位比例会偏高。',
      action: '在「总览 → 现金」补录现金 / 货币基金余额。', weight: WEIGHTS.cash,
    });
  }

  // 9. 市场估值坐标
  if (indexWithMetrics > 0) {
    items.push({
      key: 'index', question: '整个市场现在处在什么估值位置？', label: '市场估值坐标',
      status: 'OK', detail: `${indexWithMetrics}/${indexInstruments.length} 个指数有 PE 截面。`,
      action: '—', weight: WEIGHTS.index,
    });
  } else if (indexInstruments.length > 0) {
    items.push({
      key: 'index', question: '整个市场现在处在什么估值位置？', label: '市场估值坐标',
      status: 'PARTIAL', detail: `${indexInstruments.length} 个指数标的已录入，但都没有 PE/PB 截面，指数页显示「—」。`,
      action: '为指数补录估值指标，或刷新行情（需数据源支持指数估值）。', weight: WEIGHTS.index,
    });
  } else {
    items.push({
      key: 'index', question: '整个市场现在处在什么估值位置？', label: '市场估值坐标',
      status: 'MISSING', detail: '没有任何 INDEX 标的，指数页为「结构预览」，数值列全为「—」。',
      action: '在「标的」中新增 type=INDEX 的指数（如沪深300 / 中证500），并补录估值指标。', weight: WEIGHTS.index,
    });
  }

  const earned = items.reduce((sum, item) => {
    const factor = item.status === 'OK' ? 1 : item.status === 'PARTIAL' ? 0.5 : 0;
    return sum + item.weight * factor;
  }, 0);
  const score = Math.round(earned);
  const blockers = items.filter((i) => i.status === 'MISSING').map((i) => i.label);

  const verdict: ReadinessVerdict = score >= 80 && blockers.length === 0
    ? 'READY'
    : score >= 40
      ? 'PARTIAL'
      : 'INSUFFICIENT';

  const verdictText = verdict === 'READY'
    ? '数据完备度足以支撑常规资产决策（配置、加减仓、再平衡复核）。'
    : verdict === 'PARTIAL'
      ? `仅部分支撑：${blockers.length > 0 ? `缺 ${blockers.join(' / ')}` : '部分维度覆盖率不足'}，结论需打折使用。`
      : `不足以支撑资产决策：缺少 ${blockers.join(' / ') || '基础数据'}。`;

  return {
    score,
    verdict,
    verdictText,
    items,
    blockers,
    concentration: concentrationResult,
    metrics: {
      holdingCount,
      pricedCount,
      priceCoverage,
      totalMarketValue: rows.reduce((sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)), 0)
        .toFixed(2),
      valuationCoverage,
      cashFlowCount: cashFlows.length,
      goalEnabled: goal !== null && goal.enabled,
      xirr: performance.xirr,
      maxDrawdown: performance.maxDrawdown,
      sharpe: performance.sharpe,
      portfolioPe: performance.portfolioPe,
      indexCount: indexInstruments.length,
      indexWithMetrics,
      dataDate,
    },
    note: '分数只表示「信息完备度」，不代表标的优劣或收益预期；所有指标均为描述性统计，不构成投资建议。',
  };
}
