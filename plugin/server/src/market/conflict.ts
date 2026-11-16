/**
 * 多源交叉校验（PRD §5.4 数据源治理）。
 *
 * 目的：同一标的同一天拿到两个来源的价格时，显式暴露分歧，而不是「谁最后写入谁赢」。
 * 纪律：
 * - 只比较「同类型 + 同交易日」的报价，跨类型（实时价 vs 收盘价 vs 净值）不可比；
 * - 差异用相对值 |a-b| / max(a,b)，避免绝对值随价格量级失真；
 * - 超阈值只标记 CONFLICT 并保留双方记录，不擅自选一个当「正确答案」；
 * - 阈值是提示线，不是合规阈值。
 */
export const DEFAULT_CONFLICT_THRESHOLD = 0.01;

export interface QuoteCandidate {
  provider: string;
  value: string;
  priceType: string;
  tradingDate: string;
}

export interface ConflictFinding {
  tradingDate: string;
  priceType: string;
  primary: QuoteCandidate;
  secondary: QuoteCandidate;
  /** 相对差异（0–1）。 */
  diffPct: number;
}

export function relativeDiff(a: string, b: string): number | null {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  return Math.abs(x - y) / Math.max(x, y);
}

/**
 * 找出主源与其它源之间最大的分歧。
 * `candidates[0]` 视为主源（注册顺序决定）；没有可比项或差异未超阈值返回 null。
 */
export function detectConflict(
  candidates: QuoteCandidate[],
  threshold: number = DEFAULT_CONFLICT_THRESHOLD,
): ConflictFinding | null {
  if (candidates.length < 2) return null;
  const primary = candidates[0];
  let worst: ConflictFinding | null = null;
  for (const other of candidates.slice(1)) {
    if (other.provider === primary.provider) continue;
    if (other.priceType !== primary.priceType) continue;
    if (other.tradingDate !== primary.tradingDate) continue;
    const diff = relativeDiff(primary.value, other.value);
    if (diff === null || diff <= threshold) continue;
    if (!worst || diff > worst.diffPct) {
      worst = { tradingDate: primary.tradingDate, priceType: primary.priceType, primary, secondary: other, diffPct: diff };
    }
  }
  return worst;
}
