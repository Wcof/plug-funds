/**
 * 常用指数一键导入。
 *
 * 只做「建标的 + 数据源映射」这一件事：不写入任何价格 / 估值数值，
 * 数值必须由 refresh_market_data 从真实数据源拉取。这样指数页才能从
 * 「结构预览」切换到「本机数据」，且不存在伪造行情的可能。
 */
import type { ServiceContext } from '../context.ts';
import { listInstruments, saveInstrument } from '../repo/instruments.ts';
import { refreshMarketData } from './refresh.ts';

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

/* ---------------- 一键建库 + 拉数 ---------------- */

export interface BootstrapIndicesResult {
  seeded: SeedIndicesResult;
  refresh: {
    total: number;
    ok: number;
    failed: number;
    /** 失败或带告警的标的（最多 8 条），让 UI 能直接显示原因而不是「没有数据」。 */
    problems: { code: string; name: string; error: string }[];
  };
  note: string;
}

/**
 * 指数页「一键可用」入口：先建常用指数标的，再立刻对这些标的拉一次真实行情。
 *
 * 为什么要有它：只建标的（seed_common_indices）而不拉数，指数页仍然是满屏「—」，
 * 用户看到的就是「没有数据」。这里把两步合并成一次调用，且不改动「只写真实数据」的边界——
 * 建标的只写代码 / 名称 / 数据源映射，价格与估值一律由 refresh_market_data 从数据源拉取。
 * 单个指数拉取失败不影响其它指数，失败原因原样回传，不做静默兜底或填 0。
 */
export async function bootstrapIndices(ctx: ServiceContext): Promise<BootstrapIndicesResult> {
  const seeded = seedCommonIndices(ctx);
  const ids = listInstruments(ctx.handle, { type: 'INDEX' }).map((i) => i.id);
  if (ids.length === 0) {
    return {
      seeded,
      refresh: { total: 0, ok: 0, failed: 0, problems: [] },
      note: '没有可刷新的指数标的。',
    };
  }

  const { results } = await refreshMarketData(ctx, { instrumentIds: ids });
  const ok = results.filter((r) => r.ok).length;
  const problems = results
    .filter((r) => !r.ok)
    .slice(0, 8)
    .map((r) => ({ code: r.code, name: r.name, error: r.error ?? '数据源未返回有效数据' }));

  return {
    seeded,
    refresh: { total: results.length, ok, failed: results.length - ok, problems },
    note: ok === results.length && results.length > 0
      ? `已就绪：${results.length} 个指数的行情与估值来自真实数据源。`
      : `部分指数未取到数据（${results.length - ok}/${results.length}）：可在「刷新数据」重试，或检查网络与数据源。`,
  };
}
