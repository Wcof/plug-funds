/**
 * 估值与风险指标（PRD §4.1.5 / §4.6.6）。
 *
 * 全部为纯函数；样本不足 / 数据不可用时返回 null，由上层显示
 * 「样本不足 / 不可计算」，绝不伪造数值。
 */

/** 经验分位：100 × count(history ≤ current) / 有效样本数。 */
export function percentile(series: number[], current: number): number | null {
  const valid = series.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  let count = 0;
  for (const v of valid) if (v <= current) count += 1;
  return (100 * count) / valid.length;
}

/** 日收益率序列（r[i] = nav[i]/nav[i-1] − 1）。 */
export function dailyReturns(nav: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nav.length; i += 1) {
    const prev = nav[i - 1];
    if (prev > 0 && Number.isFinite(nav[i])) out.push(nav[i] / prev - 1);
  }
  return out;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 样本标准差（n−1）；样本 < 2 返回 null；全部相同 → 精确 0。 */
export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const first = values[0];
  if (values.every((v) => v === first)) return 0;
  const m = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m) * (v - m), 0);
  return Math.sqrt(ss / (values.length - 1));
}

/**
 * 夏普比率（PRD §4.1.5）：年化平均超额收益 ÷ 年化收益标准差。
 * 日频默认按 252 个交易日年化；无风险利率默认年化 1.5%。
 * 样本不足（< minSamples）或波动率为 0 → null。
 */
export function sharpeRatio(
  dailyReturnsSeries: number[],
  options: { rfAnnual?: number; periodsPerYear?: number; minSamples?: number } = {},
): number | null {
  const { rfAnnual = 0.015, periodsPerYear = 252, minSamples = 30 } = options;
  if (dailyReturnsSeries.length < minSamples) return null;
  const sd = stdev(dailyReturnsSeries);
  // sd === 0（完全相同）或数值噪声级的近零波动都视为不可计算。
  if (sd === null || sd < 1e-12) return null;
  const rfDaily = rfAnnual / periodsPerYear;
  const excess = mean(dailyReturnsSeries) - rfDaily;
  return (excess / sd) * Math.sqrt(periodsPerYear);
}

/** 年化波动率 = 日频标准差 × √252；样本不足返回 null。 */
export function annualVolatility(
  dailyReturnsSeries: number[],
  options: { periodsPerYear?: number; minSamples?: number } = {},
): number | null {
  const { periodsPerYear = 252, minSamples = 30 } = options;
  if (dailyReturnsSeries.length < minSamples) return null;
  const sd = stdev(dailyReturnsSeries);
  if (sd === null) return null;
  return sd * Math.sqrt(periodsPerYear);
}

/** 最大回撤：净值序列峰谷最大跌幅（正分数）；样本 < 2 返回 null。 */
export function maxDrawdown(navSeries: number[]): number | null {
  if (navSeries.length < 2) return null;
  let peak = navSeries[0];
  let mdd = 0;
  for (const v of navSeries) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}

/**
 * 组合 XIRR（PRD §4.4.3/§4.4.5）。
 *
 * 约定：投入为负、取出与期末市值为正。
 * `flows` 至少包含一笔投入与一笔期末估值（或由调用方合并传入），
 * 按 NPV = Σ cfᵢ / (1+r)^(tᵢ) = 0 用二分求解。
 * 无法求解（现金流同号 / 不收敛）返回 null，不得编造。
 */
export function xirr(flows: { date: string; amount: number }[]): number | null {
  const sorted = flows
    .filter((f) => Number.isFinite(f.amount) && f.amount !== 0)
    .map((f) => ({ t: Date.parse(`${f.date}T00:00:00Z`) / 86_400_000, cf: f.amount }))
    .sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return null;
  const t0 = sorted[0].t;
  const years = sorted.map((f) => ({ dt: (f.t - t0) / 365, cf: f.cf }));
  const npv = (rate: number): number =>
    years.reduce((acc, f) => acc + f.cf / Math.pow(1 + rate, f.dt), 0);

  const hasNegative = years.some((f) => f.cf < 0);
  const hasPositive = years.some((f) => f.cf > 0);
  if (!hasNegative || !hasPositive) return null;

  let low = -0.9999;
  let high = 10;
  let fLow = npv(low);
  let fHigh = npv(high);
  if (fLow === 0) return low;
  if (fHigh === 0) return high;
  if (fLow * fHigh > 0) return null; // 区间不夹根
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (fMid === 0) return mid;
    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return (low + high) / 2;
}

/** 阶段涨幅：nav 序列首尾比较；无有效数据返回 null。 */
export function periodReturn(navSeries: number[]): number | null {
  const first = navSeries.find((v) => Number.isFinite(v) && v > 0);
  if (first === undefined) return null;
  const last = [...navSeries].reverse().find((v) => Number.isFinite(v) && v > 0);
  if (last === undefined || last === first) return null;
  return last / first - 1;
}
