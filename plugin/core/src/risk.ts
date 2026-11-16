/**
 * 组合风险统计（纯函数）。
 *
 * 纪律：
 * - 入参是「已按日期对齐、等长同序」的收益率序列，对齐由服务层负责；
 * - 样本不足返回 null，不返回 0 或猜测值；
 * - 无风险利率只作为显式参数传入，不在本层内置隐含假设。
 */

function pairs(a: number[], b: number[]): { a: number[]; b: number[] } | null {
  if (a.length !== b.length || a.length < 2) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  return xs.length >= 2 ? { a: xs, b: ys } : null;
}

function meanOf(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** 皮尔逊相关系数（-1 ~ 1）；样本不足返回 null。 */
export function correlation(a: number[], b: number[]): number | null {
  const aligned = pairs(a, b);
  if (!aligned) return null;
  const meanA = meanOf(aligned.a);
  const meanB = meanOf(aligned.b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < aligned.a.length; i += 1) {
    const da = aligned.a[i] - meanA;
    const db = aligned.b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return cov / Math.sqrt(varA * varB);
}

/** Beta = Cov(asset, bench) / Var(bench)；基准无波动时返回 null。 */
export function beta(assetReturns: number[], benchReturns: number[]): number | null {
  const aligned = pairs(assetReturns, benchReturns);
  if (!aligned) return null;
  const meanA = meanOf(aligned.a);
  const meanB = meanOf(aligned.b);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < aligned.a.length; i += 1) {
    const db = aligned.b[i] - meanB;
    cov += (aligned.a[i] - meanA) * db;
    varB += db * db;
  }
  if (varB <= 0) return null;
  return cov / varB;
}

/** 跟踪误差：超额收益序列的年化标准差（252 交易日）。 */
export function trackingError(assetReturns: number[], benchReturns: number[]): number | null {
  const aligned = pairs(assetReturns, benchReturns);
  if (!aligned) return null;
  const diffs = aligned.a.map((v, i) => v - aligned.b[i]);
  const mean = meanOf(diffs);
  const variance = diffs.reduce((sum, d) => sum + (d - mean) ** 2, 0) / (diffs.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/** 年化波动率（样本标准差 × √252）；少于 2 个样本返回 null。 */
export function annualizedVolatility(returns: number[]): number | null {
  const clean = returns.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const mean = meanOf(clean);
  const variance = clean.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * 股债性价比（ERP，盈利收益率口径）：1 / PE - 无风险利率。
 * PE 缺失或非正返回 null；不填充 0。
 */
export function equityRiskPremium(pe: number | null, riskFreeRate: number): number | null {
  if (pe === null || !Number.isFinite(pe) || pe <= 0) return null;
  if (!Number.isFinite(riskFreeRate)) return null;
  return 1 / pe - riskFreeRate;
}
