/**
 * 组合集中度与风险基线（纯函数，金额入参为定点字符串 scale=2）。
 *
 * 定位：为「个人资产决策」提供描述性风险坐标，不产生买卖建议。
 * 纪律：
 * - 市值缺失（价格缺失）的持仓不按 0 计入占比分母，单独计入 missingCount，
 *   避免「缺数据 = 零权重」导致集中度被低估。
 * - 占比是比率，允许浮点；金额输出仍走定点字符串。
 * - 阈值为产品口径常量，仅用于提示「值得复核」，不是风控合规线。
 */
import { formatFixed, parseFixed, SCALE_AMOUNT } from './money.ts';

export interface RiskHoldingInput {
  id: string;
  name: string;
  /** 类别 key（stock / etf / fund / index / 自定义分类）。 */
  category: string;
  /** 定点字符串 scale=2；null 表示市值缺失。 */
  marketValue: string | null;
}

export type RiskFlagLevel = 'OK' | 'WATCH' | 'HIGH';

export interface ConcentrationFlag {
  code: 'SINGLE_HOLDING' | 'TOP3' | 'SINGLE_CATEGORY' | 'TOO_FEW_HOLDINGS' | 'MISSING_VALUE';
  level: RiskFlagLevel;
  message: string;
}

export interface ConcentrationResult {
  /** 参与计算的市值合计（定点字符串 scale=2）。 */
  coveredValue: string;
  /** 市值缺失、未计入占比的持仓数。 */
  missingCount: number;
  /** 计入占比的持仓数。 */
  countedCount: number;
  top1: { id: string; name: string; weight: number } | null;
  top3Weight: number | null;
  /** 赫芬达尔指数（0–1）：1 表示全部集中在单一标的。 */
  hhi: number | null;
  /** 有效持仓数 = 1 / HHI；2.0 表示分散度约等于 2 只等权标的。 */
  effectiveHoldings: number | null;
  byCategory: { category: string; weight: number }[];
  flags: ConcentrationFlag[];
}

export const CONCENTRATION_THRESHOLDS = {
  top1Watch: 0.25,
  top1High: 0.4,
  top3Watch: 0.55,
  top3High: 0.7,
  categoryWatch: 0.8,
  /** 少于该持仓数时不做前三大集中度评判（小样本下 top3 恒接近 100%，无区分度）。 */
  top3MinHoldings: 5,
  fewHoldings: 5,
} as const;

const EMPTY: ConcentrationResult = {
  coveredValue: '0',
  missingCount: 0,
  countedCount: 0,
  top1: null,
  top3Weight: null,
  hhi: null,
  effectiveHoldings: null,
  byCategory: [],
  flags: [],
};

export function concentration(holdings: RiskHoldingInput[]): ConcentrationResult {
  const missingCount = holdings.filter((h) => h.marketValue === null).length;
  const counted = holdings
    .map((h) => ({ ...h, raw: h.marketValue === null ? 0 : parseFixed(h.marketValue, SCALE_AMOUNT) }))
    .filter((h) => h.raw > 0);

  if (counted.length === 0) {
    return {
      ...EMPTY,
      missingCount,
      flags: missingCount > 0
        ? [{ code: 'MISSING_VALUE', level: 'WATCH', message: `${missingCount} 个持仓缺价格，无法计算集中度。` }]
        : [],
    };
  }

  const totalRaw = counted.reduce((sum, h) => sum + h.raw, 0);
  const weights = counted
    .map((h) => ({ id: h.id, name: h.name, category: h.category, weight: h.raw / totalRaw }))
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, 'zh-CN'));

  const top1 = weights[0] ? { id: weights[0].id, name: weights[0].name, weight: weights[0].weight } : null;
  const top3Weight = weights.slice(0, 3).reduce((sum, w) => sum + w.weight, 0);
  const hhi = weights.reduce((sum, w) => sum + w.weight * w.weight, 0);

  const categoryMap = new Map<string, number>();
  for (const w of weights) categoryMap.set(w.category, (categoryMap.get(w.category) ?? 0) + w.weight);
  const byCategory = [...categoryMap.entries()]
    .map(([category, weight]) => ({ category, weight }))
    .sort((a, b) => b.weight - a.weight);

  const flags: ConcentrationFlag[] = [];
  if (top1) {
    if (top1.weight >= CONCENTRATION_THRESHOLDS.top1High) {
      flags.push({
        code: 'SINGLE_HOLDING', level: 'HIGH',
        message: `单一持仓「${top1.name}」占 ${(top1.weight * 100).toFixed(1)}%，超过 ${(CONCENTRATION_THRESHOLDS.top1High * 100).toFixed(0)}% 高度集中线。`,
      });
    } else if (top1.weight >= CONCENTRATION_THRESHOLDS.top1Watch) {
      flags.push({
        code: 'SINGLE_HOLDING', level: 'WATCH',
        message: `单一持仓「${top1.name}」占 ${(top1.weight * 100).toFixed(1)}%，超过 ${(CONCENTRATION_THRESHOLDS.top1Watch * 100).toFixed(0)}% 观察线。`,
      });
    }
  }
  if (counted.length >= CONCENTRATION_THRESHOLDS.top3MinHoldings) {
    if (top3Weight >= CONCENTRATION_THRESHOLDS.top3High) {
      flags.push({
        code: 'TOP3', level: 'HIGH',
        message: `前三大持仓合计占 ${(top3Weight * 100).toFixed(1)}%，超过 ${(CONCENTRATION_THRESHOLDS.top3High * 100).toFixed(0)}%。`,
      });
    } else if (top3Weight >= CONCENTRATION_THRESHOLDS.top3Watch) {
      flags.push({
        code: 'TOP3', level: 'WATCH',
        message: `前三大持仓合计占 ${(top3Weight * 100).toFixed(1)}%，超过 ${(CONCENTRATION_THRESHOLDS.top3Watch * 100).toFixed(0)}%。`,
      });
    }
  }
  const heaviestCategory = byCategory[0];
  if (heaviestCategory && heaviestCategory.weight >= CONCENTRATION_THRESHOLDS.categoryWatch) {
    flags.push({
      code: 'SINGLE_CATEGORY', level: 'WATCH',
      message: `「${heaviestCategory.category}」类别占 ${(heaviestCategory.weight * 100).toFixed(1)}%，资产类别高度单一。`,
    });
  }
  if (counted.length < CONCENTRATION_THRESHOLDS.fewHoldings) {
    flags.push({
      code: 'TOO_FEW_HOLDINGS', level: 'WATCH',
      message: `仅 ${counted.length} 个持仓计入占比，分散度不足，集中度指标参考意义有限。`,
    });
  }
  if (missingCount > 0) {
    flags.push({
      code: 'MISSING_VALUE', level: 'WATCH',
      message: `${missingCount} 个持仓缺价格，未计入占比；集中度可能被低估。`,
    });
  }

  return {
    coveredValue: formatFixed(totalRaw, SCALE_AMOUNT),
    missingCount,
    countedCount: counted.length,
    top1,
    top3Weight,
    hhi,
    effectiveHoldings: hhi > 0 ? 1 / hhi : null,
    byCategory,
    flags,
  };
}
