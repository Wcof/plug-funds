/**
 * 常用指数一键导入。
 *
 * 只做「建标的 + 数据源映射」这一件事：不写入任何价格 / 估值数值，
 * 数值必须由 refresh_market_data 从真实数据源拉取。这样指数页才能从
 * 「结构预览」切换到「本机数据」，且不存在伪造行情的可能。
 */
import type { ServiceContext } from '../context.ts';
import { listInstruments, saveInstrument } from '../repo/instruments.ts';

export interface CommonIndexSeed {
  code: string;
  name: string;
  market: 'SH' | 'SZ';
  secid: string;
  tag: string;
}

export const COMMON_INDICES: CommonIndexSeed[] = [
  { code: '000300', name: '沪深300', market: 'SH', secid: '1.000300', tag: '宽基' },
  { code: '000905', name: '中证500', market: 'SH', secid: '1.000905', tag: '宽基' },
  { code: '000852', name: '中证1000', market: 'SH', secid: '1.000852', tag: '宽基' },
  { code: '000016', name: '上证50', market: 'SH', secid: '1.000016', tag: '宽基' },
  { code: '000001', name: '上证指数', market: 'SH', secid: '1.000001', tag: '宽基' },
  { code: '399001', name: '深证成指', market: 'SZ', secid: '0.399001', tag: '宽基' },
  { code: '399006', name: '创业板指', market: 'SZ', secid: '0.399006', tag: '宽基' },
  { code: '000688', name: '科创50', market: 'SH', secid: '1.000688', tag: '宽基' },
];

export interface SeedIndicesResult {
  created: string[];
  existing: string[];
  total: number;
  note: string;
}

export function seedCommonIndices(ctx: ServiceContext): SeedIndicesResult {
  const before = new Set(
    listInstruments(ctx.handle, { type: 'INDEX' }).map((i) => `${i.code}:${i.market}`),
  );
  const created: string[] = [];
  const existing: string[] = [];

  for (const item of COMMON_INDICES) {
    saveInstrument(ctx.handle, {
      code: item.code,
      name: item.name,
      type: 'INDEX',
      market: item.market,
      secid: item.secid,
      tag: item.tag,
    });
    if (before.has(`${item.code}:${item.market}`)) existing.push(item.name);
    else created.push(item.name);
  }

  const total = listInstruments(ctx.handle, { type: 'INDEX' }).length;
  return {
    created,
    existing,
    total,
    note: created.length > 0
      ? `已创建 ${created.length} 个指数标的；点「刷新」从真实数据源拉取价格与估值，数值不会自动填充。`
      : '常用指数均已存在；点「刷新」更新数据。',
  };
}
