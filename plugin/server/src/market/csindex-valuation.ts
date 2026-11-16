/**
 * 中证指数官网官方估值（JSON 接口）。
 *
 * 为什么需要它（与 `csindex.ts` 的 OSS xls 并存）：
 * - OSS 的 `indicator/<code>indicator.xls` 只给 PE1 / PE2 / 股息率1 / 股息率2，**没有 PB**，
 *   而且该 OSS 有 WAF，非浏览器指纹的请求会被整段拦截（403 + 65 KB 拦截页）；
 * - 官网自身的 `data-service/indexValuation` 与 `perf/indexCsiDsPe` 走 www 域名，稳定可取，
 *   前者给「静态 PE / 滚动 PE / PB / 股息率」当期快照，后者给**逐日滚动 PE 全量历史**
 *   （沪深300 可回溯到 2011 年），正好用来算真实分位。
 *
 * 口径（实测 2026-11 对齐）：
 * - `indexValuation.peg` 与 `indexCsiDsPe.peg` 的最新值完全一致（沪深300 均为 13.14），
 *   说明两者是同一套「滚动市盈率」口径，可以拼成一条连续序列；
 * - `indexValuation.pe` 是静态市盈率，与滚动值不同，落独立键 `pe_official_static`；
 * - **指数的 `pe` 采用官方滚动值**：报价端（腾讯）给指数的 PE 与官方差 1.2%–59.2%
 *   （科创50 91.23 vs 57.31），口径不可比，若与官方序列混用会让分位静默跳变。
 *
 * 覆盖边界（不得声称全覆盖）：
 * - 快照接口只返回官网仪表盘固定列出的 8 只指数（上证指数 / 上证180 / 上证50 / 沪深300 /
 *   上证380 / 红利指数 / 中证红利 / 中证500），不在其中的指数（科创50、中证1000）拿不到 PB / 股息率；
 * - 历史接口按代码取，中证 / 上证系列可用，**国证系列（深证成指 399001、创业板指 399006）返回空数组**，
 *   属数据源未覆盖，不是抓取失败。
 */
import type { DataQuality } from '../../../core/src/types.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 15_000;
const BASE = 'https://www.csindex.com.cn/csindex-home';

/** 已核实的仪表盘快照覆盖，用于失败时禁止切换到不同股本口径。 */
export const CSINDEX_SNAPSHOT_CODES: ReadonlySet<string> = new Set([
  '000001', '000009', '000010', '000015', '000016', '000300', '000905', '000922',
]);

export interface CsindexValuationSnapshot {
  /** 交易日期，YYYY-MM-DD（接口原始是 YYYYMMDD）。 */
  tradeDate: string;
  indexName: string;
  /** 静态市盈率。 */
  pe: number | null;
  /** 滚动市盈率（TTM / 接口字段名 peg）。 */
  peTtm: number | null;
  /** 市净率。 */
  pb: number | null;
  /** 股息率（百分数，3.03 表示 3.03%）。 */
  dividendYield: number | null;
  peLastYear: number | null;
  peTtmLastYear: number | null;
  pbLastYear: number | null;
}

export interface CsindexPePoint {
  tradeDate: string;
  peTtm: number;
}

export interface CsindexMetric {
  metricKey: string;
  value: string;
  asOfDate: string;
  quality: DataQuality;
}

function num(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 正数才接受：0 / 负 PE 在中证口径里表示「未计算」，不能当有效值写库。 */
function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

/** YYYYMMDD → YYYY-MM-DD；格式不符或不是有效公历日期时返回 null。 */
export function normalizeTradeDate(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{8}$/.test(text) || Number(text.slice(0, 4)) < 1) return null;
  const normalized = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const date = new Date(`${normalized}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) return null;
  return normalized;
}

/**
 * 解析 `data-service/indexValuation`：`{ data: { tradeDate, indexValuations: [...] } }`。
 * 逐行校验，缺 PE / PB 的行保留（只把该字段置 null），整行日期非法的丢弃。
 * 封套声明日期时必须有效且与行日期一致；冲突不可静默拼接成一个截面。
 */
export function parseValuationSnapshot(payload: unknown): CsindexValuationSnapshot[] {
  const data = (payload as { data?: { tradeDate?: unknown; indexValuations?: unknown } } | null)?.data;
  const list = data?.indexValuations;
  if (!Array.isArray(list)) return [];
  const snapshotDate = normalizeTradeDate(data?.tradeDate);
  if (data?.tradeDate !== undefined && snapshotDate === null) {
    throw Object.assign(new Error(`csindex 快照日期无效：${String(data.tradeDate)}`), { code: 'SOURCE_INVALID' });
  }
  const out: CsindexValuationSnapshot[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const tradeDate = normalizeTradeDate(row.tradeDate);
    const indexName = typeof row.indexName === 'string' ? row.indexName.trim() : '';
    if (!tradeDate || indexName === '') continue;
    if (snapshotDate !== null && tradeDate !== snapshotDate) {
      throw Object.assign(new Error(`csindex 快照日期冲突：封套 ${snapshotDate}，${indexName} 行 ${tradeDate}`), { code: 'SOURCE_INVALID' });
    }
    out.push({
      tradeDate,
      indexName,
      pe: positive(row.pe),
      peTtm: positive(row.peg),
      pb: positive(row.pb),
      // 股息率允许 0（不分红的指数），但不接受负数
      dividendYield: (() => {
        const n = num(row.dp);
        return n !== null && n >= 0 ? n : null;
      })(),
      peLastYear: positive(row.peLastYear),
      peTtmLastYear: positive(row.pegLastYear),
      pbLastYear: positive(row.pbLastYear),
    });
  }
  return out;
}

/** 解析 `perf/indexCsiDsPe`；同日同值去重，异值拒绝整份历史并报告冲突。 */
export function parsePeTtmHistory(payload: unknown): CsindexPePoint[] {
  const list = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) return [];
  const byDate = new Map<string, number>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const tradeDate = normalizeTradeDate(row.tradeDate);
    const peTtm = positive(row.peg);
    if (!tradeDate || peTtm === null) continue;
    const previous = byDate.get(tradeDate);
    if (previous !== undefined && previous !== peTtm) {
      throw Object.assign(new Error(`csindex PE 历史同日数值冲突：${tradeDate}（${previous} / ${peTtm}）`), { code: 'SOURCE_INVALID' });
    }
    byDate.set(tradeDate, peTtm);
  }
  // 接口本身按日期升序，这里再排一次以防上游变动
  return [...byDate].map(([tradeDate, peTtm]) => ({ tradeDate, peTtm })).sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

/**
 * 快照 → 指标写入项。
 *
 * 键位说明（与「官方值不许顶替 pe」的旧约定不同，此处是有依据的例外）：
 * - `pe` 写**官方滚动市盈率**。实测（2026-11-16）报价端给指数的 PE 与官方滚动 PE 差
 *   1.2%–59.2%（科创50 91.23 vs 57.31、中证1000 37.62 vs 26.64），不是同一口径，
 *   不能当作「同一指标的不同来源」并列；分位与横向比较必须用一致序列，故指数的 `pe`
 *   以官方滚动值为准，provider 记 csindex 保留可追溯性；
 * - `pe_official_static` 静态市盈率（口径不同，独立键，不与 pe 混用）；
 * - `pb` 市净率——指数的报价端（腾讯 / 东财）一律返回 0，官方 PB 是唯一真实来源；
 * - `dividend_yield` 股息率（百分数），只有官方源提供。
 */
export function snapshotToMetrics(snapshot: CsindexValuationSnapshot): CsindexMetric[] {
  const out: CsindexMetric[] = [];
  const push = (metricKey: string, value: number | null): void => {
    if (value === null) return;
    out.push({ metricKey, value: String(value), asOfDate: snapshot.tradeDate, quality: 'FRESH' });
  };
  push('pe', snapshot.peTtm);
  push('pe_official_static', snapshot.pe);
  push('pb', snapshot.pb);
  push('dividend_yield', snapshot.dividendYield);
  return out;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.csindex.com.cn/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    const text = await response.text();
    // 官网异常时会返回 HTML 错误页；先挡掉再 JSON.parse，避免抛 SyntaxError 掩盖真实原因
    if (!text.trimStart().startsWith('{')) throw new Error(`csindex 返回非 JSON（可能是拦截页）${url.slice(0, 100)}`);
    const parsed = JSON.parse(text) as { code?: string; msg?: string; success?: boolean };
    if (parsed.code !== '200') throw new Error(`csindex ${parsed.code ?? '?'} ${parsed.msg ?? ''}`.trim());
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** 当期官方估值快照（固定 8 只仪表盘指数）。 */
export async function fetchValuationSnapshot(): Promise<CsindexValuationSnapshot[]> {
  return parseValuationSnapshot(await fetchJson(`${BASE}/data-service/indexValuation`));
}

/** 逐日滚动 PE 全量历史；国证系列返回空数组（数据源未覆盖，不抛错）。 */
export async function fetchPeTtmHistory(indexCode: string): Promise<CsindexPePoint[]> {
  return parsePeTtmHistory(await fetchJson(`${BASE}/perf/indexCsiDsPe?indexCode=${encodeURIComponent(indexCode)}`));
}
