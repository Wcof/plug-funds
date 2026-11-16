/**
 * 中证官方覆盖清单（哪些指数代码在 csindex 有 PE 历史）。
 *
 * 为什么需要它：
 * - 中证 / 上证系列（000xxx）基本都有，但**深交所代码里也混着中证编制的指数**（中证白酒 399997、
 *   中证医疗 399989…），实测 340 个 399 代码里有 44 个能取到官方 PE 历史；
 * - 剩下 296 个是国证 / 深证自编系列，官网没有估值文件；
 * - 如果每次刷新都对 500+ 只逐个试探，既慢又白打接口，所以把「确认有覆盖」的代码存进
 *   `app_settings`，刷新时只对「000 前缀 + 清单内」的代码请求官方接口。
 *
 * 只在**成功拿到数据**时才写入清单：网络失败 / 限流不能当成「没有覆盖」，否则会永久漏掉。
 */
import type { DbHandle } from '../db.ts';
import { getSetting, setSetting } from '../repo/settings.ts';

const SETTING_KEY = 'csindex_covered_codes';

export function getCsindexCoveredCodes(handle: DbHandle): Set<string> {
  const raw = getSetting(handle, SETTING_KEY);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((item): item is string => typeof item === 'string' && /^\d{5,6}$/.test(item)));
}

export function rememberCsindexCovered(handle: DbHandle, code: string): void {
  const codes = getCsindexCoveredCodes(handle);
  if (codes.has(code)) return;
  codes.add(code);
  setSetting(handle, SETTING_KEY, [...codes].sort());
}
