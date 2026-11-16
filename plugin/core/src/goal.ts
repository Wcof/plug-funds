/**
 * 资产分布双模式与投资目标口径（PRD §4.1.2 / §6.1.1）。
 *
 * 三个分母绝不混用：
 * - 全量分布：类别市值 ÷ 当前持仓总市值，合计 100%，无灰色扇区；
 * - 目标达成（未达成）：类别市值 ÷ 目标金额，灰色「待达成」补足 100%；
 * - 目标达成（超额）：完成率可 >100%，环形图按当前组合构成绘制，无负值扇区。
 */
import { SCALE_AMOUNT, formatFixed, parseFixed } from './money.ts';

export type AllocationMode = 'full' | 'goal';

export interface AllocationCategoryInput {
  key: string;
  label: string;
  /** 定点字符串（scale=2）。 */
  value: string;
  color?: string;
}

export interface AllocationSegment {
  key: string;
  label: string;
  /** 定点字符串（scale=2）。 */
  value: string;
  /** 显示占比（0–1；超额模式下彩色扇区按当前构成比例绘制）。 */
  fraction: number;
  /** 展示口径：占当前持仓 / 占目标金额。 */
  denominator: 'current' | 'goal';
  /** 待达成灰色扇区（仅为金额差额，非亏损或应投入金额）。 */
  gray?: boolean;
  color?: string;
}

export interface AllocationResult {
  mode: AllocationMode;
  /** 定点字符串：纳入统计的持仓总市值。 */
  totalMarketValue: string;
  /** 定点字符串：生效目标金额（未启用目标时为 null）。 */
  effectiveGoalAmount: string | null;
  segments: AllocationSegment[];
  /** 目标完成率（市值 ÷ 目标金额；未启用目标时 null），可 >1。 */
  progressRatio: number | null;
  /** 待达成金额（未达成时 >0；未启用目标 / 已超额时为 null）。 */
  remainingAmount: string | null;
  /** 超出目标金额（超额时 >0）。 */
  overAmount: string | null;
  note: string | null;
}

function toSegments(
  categories: AllocationCategoryInput[],
  denominatorValueRaw: number,
  denominator: 'current' | 'goal',
): AllocationSegment[] {
  return categories.map((c) => {
    const raw = parseFixed(c.value, SCALE_AMOUNT);
    if (denominatorValueRaw <= 0) {
      throw new RangeError('分母必须为正数');
    }
    return {
      key: c.key,
      label: c.label,
      value: formatFixed(raw, SCALE_AMOUNT),
      fraction: raw / denominatorValueRaw,
      denominator,
      color: c.color,
    };
  });
}

export function allocation(input: {
  categories: AllocationCategoryInput[];
  goal: { targetAmount: string; enabled: boolean } | null;
  mode: AllocationMode;
}): AllocationResult {
  const values = input.categories.map((c) => parseFixed(c.value, SCALE_AMOUNT));
  const totalRaw = values.reduce((a, b) => a + b, 0);
  const goalEnabled = input.mode === 'goal' && input.goal !== null && input.goal.enabled;
  const goalRaw = goalEnabled && input.goal ? parseFixed(input.goal.targetAmount, SCALE_AMOUNT) : null;
  const total = formatFixed(totalRaw, SCALE_AMOUNT);

  if (!goalEnabled || goalRaw === null || goalRaw <= 0) {
    if (input.mode === 'goal') {
      // 目标被要求但不可用：按 PRD 回退全量分布并给出说明。
      return {
        mode: 'full',
        totalMarketValue: total,
        effectiveGoalAmount: null,
        segments: toSegments(input.categories, totalRaw, 'current'),
        progressRatio: null,
        remainingAmount: null,
        overAmount: null,
        note: goalRaw !== null && goalRaw <= 0 ? '目标金额必须大于 0，已回退全量分布' : null,
      };
    }
    return {
      mode: 'full',
      totalMarketValue: total,
      effectiveGoalAmount: null,
      segments: toSegments(input.categories, totalRaw, 'current'),
      progressRatio: null,
      remainingAmount: null,
      overAmount: null,
      note: null,
    };
  }

  if (goalRaw !== null && input.goal) {
    const progressRatio = totalRaw / goalRaw;
    if (totalRaw < goalRaw) {
      // 未达成：彩色（÷目标）+ 灰色待达成，合计 100%。
      const segments = toSegments(input.categories, goalRaw, 'goal');
      const remainingRaw = goalRaw - totalRaw;
      segments.push({
        key: '__remaining',
        label: '待达成',
        value: formatFixed(remainingRaw, SCALE_AMOUNT),
        fraction: remainingRaw / goalRaw,
        denominator: 'goal',
        gray: true,
      });
      return {
        mode: 'goal',
        totalMarketValue: total,
        effectiveGoalAmount: formatFixed(goalRaw, SCALE_AMOUNT),
        segments,
        progressRatio,
        remainingAmount: formatFixed(remainingRaw, SCALE_AMOUNT),
        overAmount: null,
        note: null,
      };
    }
    // 达成或超额：无负值灰色扇区；彩色扇区按当前组合构成绘制（合计 100%）。
    const overRaw = totalRaw - goalRaw;
    return {
      mode: 'goal',
      totalMarketValue: total,
      effectiveGoalAmount: formatFixed(goalRaw, SCALE_AMOUNT),
      segments: toSegments(input.categories, totalRaw, 'current'),
      progressRatio,
      remainingAmount: null,
      overAmount: overRaw > 0 ? formatFixed(overRaw, SCALE_AMOUNT) : null,
      note: overRaw > 0 ? '已完成目标：完成率为资产规模进度，可超过 100%，不代表收益率' : null,
    };
  }
  throw new RangeError('unreachable');
}

/** 目标完成率（0–∞）；未启用返回 null。 */
export function progressRatio(totalMarketValueRaw: number, goalRaw: number | null): number | null {
  if (goalRaw === null || goalRaw <= 0) return null;
  return totalMarketValueRaw / goalRaw;
}
