/**
 * Eastmoney / 天天基金公开接口适配器（PRD §5.2 候选数据源）。
 *
 * 纪律（PRD §5.4 供应商治理）：
 * - 低频（模块级 400ms 间隔）+ 有界超时（15s）+ 缓存（market_data 表即缓存）；
 * - 失败显式抛出，不返回伪造数据；
 * - 正式净值（OFFICIAL_NAV）与估算净值（ESTIMATED_NAV）严格分离，估算不参与计价；
 * - 供个人本地研究用途；接口变更时只替换本适配器；
 * - 解析逻辑全部为纯函数，以 fixture 单测锁定（plugin/test/eastmoney.test.ts）。
 */
import { shanghaiParts } from '../../../core/src/calendar.ts';
import { SCALE_QTY, formatFixed, parseFixed } from '../../../core/src/money.ts';
import type { Instrument, MarketPoint } from '../../../core/src/types.ts';
import type { HistoryRequest, MarketProvider } from './provider.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 400;

/** 常见指数名称 → secid（图表对比与估值透传共用一份，避免两处漂移）。 */
export const INDEX_SECIDS: Record<string, string> = {
  沪深300: '1.000300',
  创业板指: '0.399006',
  上证指数: '1.000001',
  中证500: '1.000905',
  科创50: '1.000688',
};

let lastRequestAt = 0;

/** 交易日一律按 UTC+8：用 UTC 日期会在北京时间 00:00–08:00 把「当天」算成昨天。 */
function todayUtc8(): string {
  return shanghaiParts(new Date()).date;
}

async function paced(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const text = await fetchText(url, headers);
  return JSON.parse(text);
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  await paced();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function secidOf(instrument: Instrument): string | null {
  if (instrument.secid) return instrument.secid;
  if (instrument.market === 'SH') return `1.${instrument.code}`;
  if (instrument.market === 'SZ') return `0.${instrument.code}`;
  return null;
}

function point(partial: Omit<MarketPoint, 'currency'>): MarketPoint {
  return { currency: 'CNY', ...partial };
}

/* ---------------- 纯解析函数（fixture 测试锁定） ---------------- */

export interface StockGetPayload {
  data?: {
    f43?: number; f57?: string; f58?: string; f59?: number; f60?: number; f86?: number;
    /** PE-TTM（fltt=2 时 f115 常返回 "-"，真正可用的 TTM 是 f164）。 */
    f115?: number | string; f162?: number; f163?: number; f164?: number;
    f167?: number; f20?: number; f173?: number;
    /** 毛利率 / 净利率（%）。 */
    f187?: number; f188?: number;
    /** 营收同比 / 净利同比（%）。 */
    f184?: number; f186?: number;
  } | null;
}

function quoteDate(timestamp: unknown, today: string): string | null {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const instant = new Date(timestamp * 1000);
  if (!Number.isFinite(instant.getTime())) return null;
  const date = shanghaiParts(instant).date;
  return date >= '1990-01-01' && date <= today ? date : null;
}

/** push2 `qt/stock/get`（fltt=2：数值为原始浮点）。 */
export function parseStockQuote(payload: StockGetPayload, instrumentId: string, today: string): MarketPoint | null {
  const data = payload.data;
  if (!data || typeof data.f43 !== 'number' || !Number.isFinite(data.f43) || data.f43 <= 0) return null;
  const tradingDate = quoteDate(data.f86, today);
  if (!tradingDate) return null;
  return point({
    instrumentId,
    priceType: tradingDate === today ? 'REALTIME_PRICE' : 'CLOSE_PRICE',
    value: formatFixed(parseFixed(String(data.f43), SCALE_QTY), SCALE_QTY),
    tradingDate,
    observedAt: new Date().toISOString(),
    provider: 'eastmoney',
    quality: tradingDate === today ? 'FRESH' : 'DELAYED',
  });
}

/** push2 K 线（fields2=f51,f53：日期,收盘；fqt=1 前复权）。 */
export function parseKlines(payload: { data?: { klines?: string[] } | null }, instrumentId: string): MarketPoint[] {
  const out: MarketPoint[] = [];
  for (const line of payload.data?.klines ?? []) {
    const [date, close] = line.split(',');
    if (!date || !close) continue;
    out.push(point({
      instrumentId,
      priceType: 'CLOSE_PRICE',
      value: formatFixed(parseFixed(close, SCALE_QTY), SCALE_QTY),
      tradingDate: date,
      observedAt: new Date().toISOString(),
      provider: 'eastmoney',
      quality: 'FRESH',
    }));
  }
  return out;
}

export interface LsjzPayload {
  Data?: { LSJZList?: { FSRQ?: string; DWJZ?: string; JZZZL?: string }[] } | null;
  ErrCode?: number;
  ErrMsg?: string | null;
  TotalCount?: number;
}

/**
 * 天天基金历史净值（正式净值；空净值行跳过）。
 *
 * 端点说明（2026-11 本机实测）：`/f10/lsjz` 返回 `Data.LSJZList`；写成 `/f10/lsjnz`
 * 会拿到 `{"Data":null,"ErrCode":4,"ErrMsg":"404"}`——不是网络问题，是路径拼错。
 * 非法基金代码返回空列表且 `ErrCode=0`，只能按「无数据」处理。
 */
export function parseLsjz(payload: LsjzPayload, instrumentId: string, range?: { begin: string; end: string }): MarketPoint[] {
  const today = todayUtc8();
  const out: MarketPoint[] = [];
  for (const row of payload.Data?.LSJZList ?? []) {
    if (!row.FSRQ || !row.DWJZ) continue;
    if (range && (row.FSRQ < range.begin || row.FSRQ > range.end)) continue;
    out.push(point({
      instrumentId,
      priceType: 'OFFICIAL_NAV',
      value: formatFixed(parseFixed(row.DWJZ, SCALE_QTY), SCALE_QTY),
      tradingDate: row.FSRQ,
      observedAt: new Date().toISOString(),
      provider: 'eastmoney',
      // 非当日净值是「已确认但非最新」，标 DELAYED，不假装实时。
      quality: row.FSRQ === today ? 'FRESH' : 'DELAYED',
    }));
  }
  return out;
}

/**
 * 从 JS 赋值语句里切出数组字面量（`Data_netWorthTrend = [ ... ];`）。
 *
 * 不用正则 `\[.*?\]`：pingzhongdata 单文件 600 KB 以上，且数组元素里可能出现 `]`，
 * 手写扫描按括号深度配对，线性且不会被内容骗到。
 */
export function sliceJsArray(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('[', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 场外基金全量净值（`fund.eastmoney.com/pingzhongdata/<code>.js` 的 `Data_netWorthTrend`）。
 *
 * 为什么不用 lsjz 翻页：lsjz 服务端把每页硬性截到 20 条（pageSize 传 400 直接返回 0 行），
 * 取一年要 13 个请求；pingzhongdata 一次给全量（本机实测 4437 条 / 617 KB），
 * 既少请求又能一次拿到多年序列。时间戳是「北京时间零点」的 UTC 表示（16:00Z），
 * 必须 +8 小时再取日期，否则会整体差一天。
 */
export function parsePingzhongNav(text: string, instrumentId: string, range?: { begin: string; end: string }): MarketPoint[] {
  const raw = sliceJsArray(text, 'Data_netWorthTrend');
  if (!raw) return [];
  let rows: { x?: number; y?: number }[];
  try {
    rows = JSON.parse(raw) as { x?: number; y?: number }[];
  } catch {
    return [];
  }
  const today = todayUtc8();
  const out: MarketPoint[] = [];
  for (const row of rows) {
    if (typeof row.x !== 'number' || typeof row.y !== 'number' || row.y <= 0) continue;
    const tradingDate = new Date(row.x + 8 * 60 * 60_000).toISOString().slice(0, 10);
    if (range && (tradingDate < range.begin || tradingDate > range.end)) continue;
    out.push(point({
      instrumentId,
      priceType: 'OFFICIAL_NAV',
      value: formatFixed(parseFixed(String(row.y), SCALE_QTY), SCALE_QTY),
      tradingDate,
      observedAt: new Date().toISOString(),
      provider: 'eastmoney',
      quality: tradingDate === today ? 'FRESH' : 'DELAYED',
    }));
  }
  return out;
}

/** fundgz 估算净值：`jsonpgz({...});` 文本。 */
export function parseFundGz(text: string, instrumentId: string): MarketPoint | null {
  const match = /jsonpgz\((\{.*\})\);?/.exec(text);
  if (!match) return null;
  let parsed: { gsz?: string; gszzl?: string; gztime?: string };
  try {
    parsed = JSON.parse(match[1]) as { gsz?: string; gszzl?: string; gztime?: string };
  } catch {
    return null;
  }
  if (!parsed.gsz || !parsed.gztime) return null;
  const gzDate = parsed.gztime.slice(0, 10);
  return point({
    instrumentId,
    priceType: 'ESTIMATED_NAV',
    value: formatFixed(parseFixed(parsed.gsz, SCALE_QTY), SCALE_QTY),
    tradingDate: gzDate,
    observedAt: new Date().toISOString(),
    provider: 'eastmoney-estimate',
    quality: 'ESTIMATED',
  });
}

/**
 * 个股估值指标。口径按东财 push2 的字段语义落库，不做换算：
 * - `pe`：f164 = PE-TTM（f115 在 fltt=2 下常为 "-"，不可用）；
 * - `pe_dynamic` / `pe_static`：f162 / f163，供对照「动态 / 静态」口径差异；
 * - `pb`：f167；`roe`：f173；`gross_margin_pct`：f187；`net_margin_pct`：f188。
 * 日期来自报价时间；估值倍数要求正数，盈利率允许真实的零和负值。
 */
export function parseStockMetrics(
  payload: StockGetPayload,
  instrumentId: string,
  today: string,
): { metricKey: string; value: string | null; asOfDate: string; quality: MarketPoint['quality'] }[] {
  const data = payload.data;
  if (!data) return [];
  const asOfDate = quoteDate(data.f86, today);
  if (!asOfDate) return [];
  const quality = asOfDate === today ? 'FRESH' : 'DELAYED';
  const out: { metricKey: string; value: string | null; asOfDate: string; quality: MarketPoint['quality'] }[] = [];
  const take = (metricKey: string, raw: number | string | undefined, opts: { positive?: boolean } = {}): void => {
    if (raw == null || (typeof raw === 'string' && (raw.trim() === '' || raw.trim() === '-'))
      || (typeof raw !== 'number' && typeof raw !== 'string')) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    if (opts.positive !== false && value <= 0) return;
    out.push({ metricKey, value: String(value), asOfDate, quality });
  };
  take('pe', data.f164);
  take('pe_dynamic', data.f162);
  take('pe_static', data.f163);
  take('pb', data.f167);
  take('roe', data.f173, { positive: false });
  take('gross_margin_pct', data.f187, { positive: false });
  take('net_margin_pct', data.f188, { positive: false });
  if (typeof data.f20 === 'number' && Number.isFinite(data.f20) && data.f20 > 0) {
    out.push({ metricKey: 'scale_info', value: `总市值 ${data.f20 / 1e8} 亿`, asOfDate, quality });
  }
  return out;
}

/* ---------------- Provider 实现 ---------------- */

/** lsjz 服务端硬性每页 20 条（传更大值不会放大，传 400 直接返回 0 行）。 */
const FUND_NAV_PAGE_SIZE = 20;
/** 兜底翻页上限：40 页 ≈ 800 个净值日 ≈ 3.2 年。 */
const FUND_NAV_MAX_PAGES = 40;

/** 场外基金单页净值（lsjz）。 */
async function fetchFundNavPage(
  instrument: Instrument,
  pages: number,
  range?: { begin: string; end: string },
): Promise<MarketPoint[]> {
  const code = instrument.fundCode;
  if (!code) return [];
  const seen = new Set<string>();
  const out: MarketPoint[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const payload = (await fetchJson(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${FUND_NAV_PAGE_SIZE}&type=&_=x`,
      { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` },
    )) as LsjzPayload;
    const rows = payload.Data?.LSJZList ?? [];
    if (rows.length === 0) break;
    for (const p of parseLsjz({ Data: { LSJZList: rows } }, instrument.id, range)) {
      if (seen.has(p.tradingDate)) continue;
      seen.add(p.tradingDate);
      out.push(p);
    }
    const oldest = rows[rows.length - 1]?.FSRQ;
    // 已经翻过区间下界，或本页不足 20 条（说明是最后一页）。
    if (range && oldest !== undefined && oldest < range.begin) break;
    if (rows.length < FUND_NAV_PAGE_SIZE) break;
  }
  return out;
}

/** 场外基金全量净值（单请求），失败或为空时退回分页。 */
async function fetchFundNavFull(instrument: Instrument, range?: { begin: string; end: string }): Promise<MarketPoint[]> {
  const code = instrument.fundCode;
  if (!code) return [];
  try {
    const text = await fetchText(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`,
      { Referer: `https://fund.eastmoney.com/${code}.html` },
    );
    const full = parsePingzhongNav(text, instrument.id, range);
    if (full.length > 0) return full;
  } catch {
    /* 全量端点失败不致命：下面用分页兜底 */
  }
  return fetchFundNavPage(instrument, FUND_NAV_MAX_PAGES, range);
}

export function createEastmoneyProvider(): MarketProvider {
  const todayStr = todayUtc8;

  return {
    id: 'eastmoney',
    supports: (instrument) => secidOf(instrument) !== null || Boolean(instrument.fundCode),

    async fetchQuote(instrument) {
      const today = todayStr();
      if (instrument.type === 'OPEN_END_FUND' && instrument.fundCode) {
        // 取最新一条正式净值即可，不必拉全量。
        const points = await fetchFundNavPage(instrument, 1);
        return points.reduce<MarketPoint | null>(
          (latest, p) => (latest === null || p.tradingDate > latest.tradingDate ? p : latest),
          null,
        );
      }
      const secid = secidOf(instrument);
      if (!secid) return null;
      const payload = (await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2&fields=f43,f57,f58,f59,f60,f86`,
      )) as StockGetPayload;
      return parseStockQuote(payload, instrument.id, today);
    },

    async fetchHistory(instrument, range: HistoryRequest) {
      const secid = secidOf(instrument);
      if (!secid) {
        if (instrument.type === 'OPEN_END_FUND' && instrument.fundCode) {
          return fetchFundNavFull(instrument, range);
        }
        return [];
      }
      const beg = range.begin.replace(/-/g, '');
      const end = range.end.replace(/-/g, '');
      const payload = (await fetchJson(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=${beg}&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53`,
      )) as { data?: { klines?: string[] } | null };
      return parseKlines(payload, instrument.id);
    },

    async fetchMetrics(instrument) {
      const today = todayStr();
      // 个股与指数直接取自身；基金 / ETF 有跟踪指数映射时透传指数估值。
      const target = instrument.type === 'STOCK' || instrument.type === 'INDEX'
        ? instrument
        : (instrument.benchmarkIndex && INDEX_SECIDS[instrument.benchmarkIndex]
          ? { ...instrument, secid: INDEX_SECIDS[instrument.benchmarkIndex], type: 'STOCK' as const, market: 'SH' as const, code: INDEX_SECIDS[instrument.benchmarkIndex].split('.')[1] }
          : null);
      if (!target) return []; // 主动基金无实时穿透（诚实口径）
      const secid = secidOf(target);
      if (!secid) return [];
      const payload = (await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2&fields=f43,f57,f59,f86,f115,f162,f163,f164,f167,f173,f184,f186,f187,f188,f20`,
      )) as StockGetPayload;
      if (payload.data && payload.data.f57 !== target.code) throw new Error(`东财估值代码不匹配：请求 ${target.code}`);
      const metrics = parseStockMetrics(payload, instrument.id, today);
      // 指数透传时忽略 scale_info（是指数的市值，不是基金的）
      return instrument.type === 'STOCK' || instrument.type === 'INDEX' ? metrics : metrics.filter((m) => m.metricKey !== 'scale_info');
    },

    async fetchEstimate(instrument) {
      if (instrument.type !== 'OPEN_END_FUND' || !instrument.fundCode) return null;
      const text = await fetchText(
        `https://fundgz.1234567.com.cn/js/${instrument.fundCode}.js?rt=${Date.now()}`,
        { Referer: 'https://fund.eastmoney.com/' },
      );
      return parseFundGz(text, instrument.id);
    },
  };
}
