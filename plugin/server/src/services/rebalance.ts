/**
 * 再平衡计划：目标权重 vs 当前实际权重 → 偏离与建议调整金额。
 *
 * 纪律：
 * - 只给「描述性建议」，不生成订单、不猜价格、不承诺收益；
 * - 缺失市值的持仓不按 0 计入分母（避免把缺数据算成 0 权重，误判为「超配」）；
 * - 目标权重合计允许 < 100%，剩余视为「未分配」，不强行摊派；
 * - 偏离在阈值内一律 HOLD，避免给出噪声交易。
 */
import type { ServiceContext } from '../context.ts';
import { formatFixed, parseFixed, SCALE_AMOUNT } from '../../../core/src/money.ts';
import { ValidationError } from '../errors.ts';
import { getSetting, setSetting } from '../repo/settings.ts';
import { listHoldings } from './holdings.ts';
import { cashTotal } from '../repo/cash.ts';

export const DEFAULT_REBALANCE_THRESHOLD = 0.05;

export const REBALANCE_CATEGORIES: { key: string; label: string }[] = [
  { key: 'stock', label: '股票' },
  { key: 'etf', label: 'ETF' },
  { key: 'fund', label: '场外基金' },
  { key: 'cash', label: '现金' },
];

const LABELS = new Map(REBALANCE_CATEGORIES.map((c) => [c.key, c.label]));

export interface RebalanceTargetRow {
  category: string;
  targetWeight: number;
}

export interface RebalanceRow {
  category: string;
  label: string;
  currentValue: string;
  currentWeight: number;
  targetWeight: number;
  /** currentWeight - targetWeight（正数表示超配）。 */
  drift: number;
  action: 'BUY' | 'SELL' | 'HOLD';
  /** 建议调整金额（绝对值，定点字符串）；HOLD 为 0。 */
  amount: string;
}

export interface RebalancePlan {
  totalAssets: string;
  investableAssets: string;
  cashTotal: string;
  rows: RebalanceRow[];
  targetsSum: number;
  threshold: number;
  missingValueCount: number;
  note: string;
}

export function listRebalanceTargets(ctx: ServiceContext): RebalanceTargetRow[] {
  const rows = ctx.handle.db
    .prepare('SELECT category, target_weight FROM rebalance_targets ORDER BY category')
    .all() as { category: string; target_weight: number }[];
  return rows.map((row) => ({ category: row.category, targetWeight: row.target_weight }));
}

export function saveRebalanceTargets(
  ctx: ServiceContext,
  targets: RebalanceTargetRow[],
  threshold?: number,
): { targets: RebalanceTargetRow[]; threshold: number } {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ValidationError('至少需要一项目标权重');
  }
  let sum = 0;
  for (const target of targets) {
    if (!LABELS.has(target.category)) {
      throw new ValidationError(`未知资产类别：${String(target.category)}`);
    }
    if (!Number.isFinite(target.targetWeight) || target.targetWeight < 0 || target.targetWeight > 1) {
      throw new ValidationError('目标权重必须在 0–1 之间（小数形式，如 0.4）');
    }
    sum += target.targetWeight;
  }
  if (sum > 1.0001) {
    throw new ValidationError(`目标权重合计 ${(sum * 100).toFixed(1)}% 超过 100%`);
  }
  if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new ValidationError('再平衡阈值必须在 0–1 之间');
  }

  const db = ctx.handle.db;
  db.exec('BEGIN;');
  try {
    db.prepare('DELETE FROM rebalance_targets').run();
    const stmt = db.prepare('INSERT INTO rebalance_targets (id,category,target_weight,updated_at) VALUES (?,?,?,?)');
    for (const target of targets) {
      stmt.run(`rb-${target.category}`, target.category, target.targetWeight, new Date().toISOString());
    }
    db.exec('COMMIT;');
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }

  if (threshold !== undefined) {
    setSetting(ctx.handle, 'rebalance_threshold', threshold);
  }
  return { targets, threshold: threshold ?? getRebalanceThreshold(ctx) };
}

export function getRebalanceThreshold(ctx: ServiceContext): number {
  const raw = getSetting(ctx.handle, 'rebalance_threshold');
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : DEFAULT_REBALANCE_THRESHOLD;
}

export function getRebalancePlan(ctx: ServiceContext): RebalancePlan {
  const holdings = listHoldings(ctx);
  const cash = cashTotal(ctx.handle);
  const targets = listRebalanceTargets(ctx);
  const threshold = getRebalanceThreshold(ctx);

  const byCategory = new Map<string, number>();
  let missingValueCount = 0;
  for (const row of holdings.rows) {
    if (row.marketValue === null) {
      missingValueCount += 1;
      continue;
    }
    const key = row.type === 'STOCK' ? 'stock' : row.type === 'ETF' ? 'etf' : row.type === 'OPEN_END_FUND' ? 'fund' : 'other';
    byCategory.set(key, (byCategory.get(key) ?? 0) + parseFixed(row.marketValue, SCALE_AMOUNT));
  }
  byCategory.set('cash', parseFixed(cash, SCALE_AMOUNT));

  const totalRaw = [...byCategory.values()].reduce((sum, v) => sum + v, 0);
  const targetsSum = targets.reduce((sum, t) => sum + t.targetWeight, 0);

  // 即使尚未设置目标权重，也返回各类别的当前权重，前端可直接在表格上填写目标值。
  const keys = new Set<string>([...byCategory.keys(), ...targets.map((t) => t.category)]);
  keys.delete('other');

  const rows: RebalanceRow[] = [];
  for (const key of keys) {
    const valueRaw = byCategory.get(key) ?? 0;
    const target = targets.find((t) => t.category === key);
    const targetWeight = target?.targetWeight ?? 0;
    const currentWeight = totalRaw > 0 ? valueRaw / totalRaw : 0;
    const drift = currentWeight - targetWeight;
    let action: RebalanceRow['action'] = 'HOLD';
    let amountRaw = 0;
    // 未设置目标时一律 HOLD：把「没填目标」当成「目标是 0」会给出全仓卖出的假建议。
    if (targets.length > 0 && Math.abs(drift) > threshold && totalRaw > 0) {
      if (drift > 0) {
        action = 'SELL';
        amountRaw = Math.round((currentWeight - targetWeight) * totalRaw);
      } else {
        action = 'BUY';
        amountRaw = Math.round((targetWeight - currentWeight) * totalRaw);
      }
    }
    rows.push({
      category: key,
      label: LABELS.get(key) ?? key,
      currentValue: formatFixed(valueRaw, SCALE_AMOUNT),
      currentWeight,
      targetWeight,
      drift,
      action,
      amount: formatFixed(amountRaw, SCALE_AMOUNT),
    });
  }
  rows.sort((a, b) => b.currentWeight - a.currentWeight);

  const actions = rows.filter((r) => r.action !== 'HOLD').length;
  return {
    totalAssets: formatFixed(totalRaw, SCALE_AMOUNT),
    investableAssets: formatFixed(totalRaw, SCALE_AMOUNT),
    cashTotal: cash,
    rows,
    targetsSum,
    threshold,
    missingValueCount,
    note: missingValueCount > 0
      ? `${missingValueCount} 个持仓缺价格，未计入分母；再平衡比例可能失真，建议先刷新行情。`
      : targets.length === 0
        ? '尚未设置目标权重。上表已给出各类别当前权重，可直接填写目标百分比后保存（仅建议，不下单）。'
        : actions > 0
          ? `${actions} 个类别偏离超过 ${(threshold * 100).toFixed(0)}%，已给出建议调整金额（仅建议，不生成订单）。`
          : `所有类别偏离均在 ${(threshold * 100).toFixed(0)}% 阈值内，无需调整。`,
  };
}
