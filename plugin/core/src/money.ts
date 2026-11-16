/**
 * 十进制定点（语义对齐旧 fund `fixed.rs` / PRD §6.4）。
 *
 * - 金额、费用：scale=2；份额、净值、单价：scale=4。
 * - 内部一律 raw 整数（number，安全整数范围内），禁用二进制浮点累计。
 * - 舍入：ROUND_DOWN（向零截断），与旧实现一致。
 * - 输出为正规化字符串（去掉纯零尾随小数位），便于 UI 与 JSON 直接呈现。
 */

export const SCALE_AMOUNT = 2;
export const SCALE_QTY = 4;

const POW10: Record<number, number> = {
  0: 1, 1: 10, 2: 100, 3: 1000, 4: 10000, 5: 100000, 6: 1000000,
  7: 10000000, 8: 100000000, 9: 1000000000, 10: 10000000000, 11: 100000000000,
};

function pow10(scale: number): number {
  const p = POW10[scale];
  if (p === undefined) throw new RangeError(`unsupported scale: ${scale}`);
  return p;
}

export class PrecisionError extends Error {
  override name = 'PrecisionError';
  constructor(message = '小数位超出目标精度且存在非零尾数') {
    super(message);
  }
}

export class FixedRangeError extends Error {
  override name = 'FixedRangeError';
  constructor(message = '数值超出安全整数范围') {
    super(message);
  }
}

function assertSafe(raw: number): number {
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new FixedRangeError(`非整数定点值: ${String(raw)}`);
  }
  if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) {
    throw new FixedRangeError(`超出安全整数范围: ${String(raw)}`);
  }
  return raw;
}

/** 向零截断的整数除法（ROUND_DOWN，对负数也向零）。 */
export function truncDiv(a: number, b: number): number {
  assertSafe(a);
  assertSafe(b);
  if (b === 0) throw new RangeError('除数为 0');
  const q = Math.trunc(a / b);
  // f64 除法在大数值下可能出现 `a/b` 恰为 x.999… 的表示误差，用余数校正。
  const remainder = a - q * b;
  if (Math.abs(remainder) >= Math.abs(b)) {
    const sign = (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1);
    return assertSafe(q + sign);
  }
  return assertSafe(q);
}

/** 解析定点字符串为 raw；小数位超出 scale 且有非零尾数时抛 PrecisionError。 */
export function parseFixed(text: string, scale: number): number {
  const s = String(text).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) {
    throw new PrecisionError(`非法定点字符串: ${JSON.stringify(text)}`);
  }
  const negative = s.startsWith('-');
  const unsigned = s.replace(/^[+-]/, '');
  const [intPart, decPart = ''] = unsigned.split('.');
  let raw: number;
  if (decPart.length <= scale) {
    raw = Number(intPart) * pow10(scale) + Number(decPart.padEnd(scale, '0'));
  } else {
    if (/[^0]/.test(decPart.slice(scale))) {
      throw new PrecisionError(`超出 ${scale} 位精度: ${text}`);
    }
    raw = Number(intPart) * pow10(scale) + Number(decPart.slice(0, scale));
  }
  return assertSafe(negative ? -raw : raw);
}

/** raw → 正规化定点字符串（去掉纯零尾随小数位）。 */
export function formatFixed(raw: number, scale: number): string {
  assertSafe(raw);
  const negative = raw < 0;
  const abs = Math.abs(raw);
  const p = pow10(scale);
  const int = Math.floor(abs / p);
  let dec = String(abs % p).padStart(scale, '0');
  dec = dec.replace(/0+$/, '');
  if (scale === 0) return negative ? String(-int) : String(int);
  return `${negative ? '-' : ''}${int}${dec ? `.${dec}` : ''}`;
}

/** 同 scale 加法。 */
export function addFixed(aRaw: number, bRaw: number, scale: number): number {
  assertSafe(aRaw + bRaw);
  return aRaw + bRaw;
}

/** 同 scale 减法。 */
export function subFixed(aRaw: number, bRaw: number, scale: number): number {
  return addFixed(aRaw, -bRaw, scale);
}

/**
 * 乘法并降到目标 scale：如 价格(s4) × 份额(s4) → 金额(s2)。
 * `mulDiv(aRaw, bRaw, aScale + bScale - outScale)`。
 */
export function mulToScale(aRaw: number, bRaw: number, outScale: number, inScales: number): number {
  const prod = aRaw * bRaw;
  assertSafe(prod);
  return truncDiv(prod, pow10(inScales - outScale));
}

/**
 * 除法并升到目标 scale：如 金额(s2) ÷ 份额(s4) → 单位成本(s4)。
 * `divToScale(aRaw, aScale, bRaw, bScale, outScale)`。
 */
export function divToScale(
  aRaw: number,
  aScale: number,
  bRaw: number,
  bScale: number,
  outScale: number,
): number {
  if (bRaw === 0) throw new RangeError('除数为 0');
  const scaleDiff = outScale + bScale - aScale;
  if (scaleDiff < 0) return truncDiv(aRaw, bRaw * pow10(-scaleDiff));
  return truncDiv(aRaw * pow10(scaleDiff), bRaw);
}

/** 定点字符串乘法：price(s4) × qty(s4) → amount 字符串(s2)。 */
export function mulAmount(priceRaw: number, qtyRaw: number): number {
  return mulToScale(priceRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
}

/** 金额(s2) ÷ 份额(s4) → 单位成本/单价(s4)。 */
export function unitFromAmount(amountRaw: number, qtyRaw: number): number {
  return divToScale(amountRaw, SCALE_AMOUNT, qtyRaw, SCALE_QTY, SCALE_QTY);
}
