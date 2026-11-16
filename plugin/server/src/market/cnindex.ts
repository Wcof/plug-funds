/** 国证官网指数目录。日期取 queryDay，目录抓取前后必须一致；不使用抓取日补日期。 */
import type { DataQuality } from '../../../core/src/types.ts';
import type { MarketProvider } from './provider.ts';
import { todayLocal } from '../ids.ts';

export const CNINDEX_BASE = 'https://www.cnindex.com.cn';
export interface CnindexRow {
  code: string;
  name: string;
  pe: number | null;
  peStatic: number | null;
  pb: number | null;
  close: number | null;
  totalMarketValue: number | null;
  issues: string[];
}
export interface CnindexSnapshot { tradeDate: string; rows: CnindexRow[]; total: number }
export interface CnindexMetric { metricKey: string; value: string; asOfDate: string; quality: DataQuality }

export function parseCnindexDate(payload: unknown, today: string): string {
  const body = payload as { code?: unknown; data?: unknown };
  if (body?.code !== 200 || typeof body.data !== 'number' || !Number.isFinite(body.data)) {
    throw new Error('国证交易日响应无效');
  }
  const instant = new Date(body.data + 8 * 3600000);
  if (!Number.isFinite(instant.getTime())) throw new Error('国证交易日时间戳无效');
  const date = instant.toISOString().slice(0, 10);
  if (date < '1990-01-01' || date > today || instant.toISOString().slice(11) !== '00:00:00.000Z') {
    throw new Error(`国证交易日不合法或在未来：${date}`);
  }
  return date;
}

export function parseCnindexPage(payload: unknown): { total: number; rows: Record<string, unknown>[] } {
  const body = payload as { code?: unknown; data?: { total?: unknown; rows?: unknown } };
  const total = body?.data?.total;
  const rows = body?.data?.rows;
  if (body?.code !== 200 || !Number.isSafeInteger(total) || Number(total) < 1 || Number(total) > 20000
    || !Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) {
    throw new Error('国证指数目录响应无效');
  }
  return { total: Number(total), rows };
}

/** 完整目录先检查身份、总数与重复代码；国证自编 399 系列才作为本适配器的估值来源。 */
export function parseCnindexSnapshot(pages: unknown[], dateBefore: unknown, dateAfter: unknown, today: string): CnindexSnapshot {
  const tradeDate = parseCnindexDate(dateBefore, today);
  if (tradeDate !== parseCnindexDate(dateAfter, today)) throw new Error('国证交易日在目录抓取过程中变化，请重新刷新');
  const parsed = pages.map(parseCnindexPage);
  const total = parsed[0]?.total;
  const rawRows = parsed.flatMap((page) => page.rows);
  if (!total || parsed.some((page) => page.total !== total) || rawRows.length !== total) throw new Error('国证目录分页不完整或总数变化');
  const seen = new Set<string>();
  const rows: CnindexRow[] = [];
  for (const raw of rawRows) {
    if (typeof raw.indexcode !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(raw.indexcode) || seen.has(raw.indexcode)) {
      throw new Error('国证目录含无效或重复指数代码');
    }
    seen.add(raw.indexcode);
    if (!/^399\d{3}$/.test(raw.indexcode) || String(raw.indexsource) !== '1') continue;
    if (typeof raw.indexname !== 'string' || !raw.indexname.trim()) throw new Error(`国证 ${raw.indexcode} 名称缺失`);
    const issues: string[] = [];
    const positive = (key: string): number | null => {
      const value = raw[key];
      if (value == null || value === '-' || (typeof value === 'string' && value.trim() === '')) return null;
      const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
      if (!Number.isFinite(n) || n <= 0) { issues.push(`${key} 非正有限数值，不纳入估值`); return null; }
      return n;
    };
    rows.push({ code: raw.indexcode, name: raw.indexname.trim(), pe: positive('peDynamic'),
      peStatic: positive('peStatic'), pb: positive('pb'), close: positive('closeingPoint'),
      totalMarketValue: positive('totalMarketValue'), issues });
  }
  return { tradeDate, rows, total };
}

export function cnindexMetrics(row: CnindexRow, tradeDate: string, today: string): CnindexMetric[] {
  const age = (Date.parse(today) - Date.parse(tradeDate)) / 86400000;
  const quality: DataQuality = age > 7 ? 'STALE' : 'FRESH';
  const out: CnindexMetric[] = [];
  for (const [metricKey, value] of [['pe', row.pe], ['pe_official_static', row.peStatic], ['pb', row.pb]] as const) {
    if (value !== null) out.push({ metricKey, value: String(value), asOfDate: tradeDate, quality });
  }
  if (row.totalMarketValue !== null) out.push({ metricKey: 'scale_info',
    value: `总市值 ${row.totalMarketValue / 1e8} 亿`, asOfDate: tradeDate, quality });
  return out;
}

/** 运行包只依赖 Node 内置 fetch；读取正文也受同一个超时和 10 MB 上限约束。 */
async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${CNINDEX_BASE}/` } });
  if (!response.ok) throw new Error(`国证 HTTP ${response.status}`);
  if (!response.body) throw new Error('国证响应正文为空');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 10 * 1024 * 1024) throw new Error('国证响应超过 10 MB');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function fetchCnindexSnapshot(today = todayLocal(), loadJson = fetchJson): Promise<CnindexSnapshot> {
  const before = await loadJson(`${CNINDEX_BASE}/index/queryDay`);
  parseCnindexDate(before, today);
  const pages: unknown[] = [];
  let total = 0;
  let count = 0;
  for (let page = 1; page <= 10; page++) {
    const payload = await loadJson(`${CNINDEX_BASE}/index/indexList?channelCode=-1&rows=2000&pageNum=${page}`);
    const parsed = parseCnindexPage(payload);
    if (page > 1 && parsed.total !== total) throw new Error('国证目录总数在分页时变化');
    total = parsed.total;
    count += parsed.rows.length;
    pages.push(payload);
    if (count >= total) break;
    if (parsed.rows.length === 0) throw new Error('国证目录分页提前结束');
  }
  const after = await loadJson(`${CNINDEX_BASE}/index/queryDay`);
  return parseCnindexSnapshot(pages, before, after, today);
}

/** 每轮刷新新建一个实例；成功和失败均共享同一个 Promise，避免逐标的重复请求目录。 */
export function createCnindexProvider(today = todayLocal(), load = () => fetchCnindexSnapshot(today)): MarketProvider {
  let snapshot: Promise<CnindexSnapshot> | undefined;
  return {
    id: 'cnindex',
    supports: (instrument) => instrument.type === 'INDEX' && instrument.market === 'SZ' && /^399\d{3}$/.test(instrument.code),
    async fetchQuote() { return null; },
    async fetchHistory() { return []; },
    async fetchMetrics(instrument) {
      snapshot ??= load();
      const source = await snapshot;
      const row = source.rows.find((item) => item.code === instrument.code);
      if (!row) return [];
      if (row.issues.length) throw new Error(`国证 ${row.code}：${row.issues.join('；')}`);
      return cnindexMetrics(row, source.tradeDate, today);
    },
  };
}
