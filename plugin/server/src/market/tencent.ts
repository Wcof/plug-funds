/**
 * 腾讯财经公开接口适配器（qt.gtimg.cn 实时 / web.ifzq.gtimg.cn K 线）。
 *
 * 为什么需要它：
 * - 东财 push2 / push2his 在部分网络环境不可达（本机实测 HTTP 000），需要可切换的第二源；
 * - 腾讯同时覆盖 A 股、ETF、指数、港股、美股与场外基金最新净值，字段密度足够做估值截面与交叉校验。
 *
 * 纪律（与 eastmoney.ts 一致）：
 * - 低频 + 有界超时 + 失败显式抛出，不返回伪造数据；
 * - GBK 响应必须按 GBK 解码，否则名称乱码；
 * - 港股 / 美股的字段位次与 A 股不同，PB 只在 A 股取；取不到就 null，绝不猜；
 * - 场外基金只提供最新正式净值（OFFICIAL_NAV），不提供历史与盘中估算；
 * - 解析逻辑拆成纯函数，以 fixture 单测锁定，不依赖网络。
 */
import { SCALE_QTY, formatFixed, parseFixed } from '../../../core/src/money.ts';
import type { Instrument, MarketPoint } from '../../../core/src/types.ts';
import type { HistoryRequest, MarketProvider } from './provider.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 12_000;
const MIN_INTERVAL_MS = 200;

let lastRequestAt = 0;

async function paced(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

/** 腾讯行情接口返回 GBK；Node 22 自带 full-icu，可直接解码。 */
async function fetchGbkText(url: string): Promise<string> {
  await paced();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      return new TextDecoder('gbk').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string): Promise<unknown> {
  await paced();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 代码映射 ---------------- */

/** 东财 secid 前缀 → 腾讯市场前缀（用于用户从东财习惯迁移过来的标的）。 */
const SECID_PREFIX_MARKET: Record<string, string> = { '1': 'sh', '0': 'sz', '116': 'hk', '105': 'us', '106': 'us' };

export function tencentSymbol(instrument: Instrument): string | null {
  if (instrument.type === 'OPEN_END_FUND') {
    return instrument.fundCode ? `jj${instrument.fundCode}` : null;
  }
  if (instrument.secid) {
    const [prefix, code] = instrument.secid.split('.');
    const market = SECID_PREFIX_MARKET[prefix];
    if (market && code) return `${market}${code}`;
  }
  const market = instrument.market?.toUpperCase();
  if (market === 'SH' || market === 'SZ' || market === 'HK' || market === 'US') {
    return `${market.toLowerCase()}${instrument.code}`;
  }
  return null;
}

/* ---------------- 纯解析函数（fixture 测试锁定） ---------------- */

export interface TencentQuoteFields {
  /** 市场标识：1=A 股、100=港股、200=美股。 */
  marketFlag: string;
  name: string;
  code: string;
  price: number;
  prevClose: number;
  open: number;
  tradingDate: string | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  turnoverRate: number | null;
  pe: number | null;
  /** 仅 A 股取 PB（港股 / 美股字段位次不同，取不到就是 null）。 */
  pb: number | null;
  floatCapYi: number | null;
  totalCapYi: number | null;
}

/** 把 `20261113161455` / `2026/11/13 16:08:22` / `2026-11-13 16:00:01` 统一成 `YYYY-MM-DD`。 */
export function normalizeTencentDate(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4);
  const m = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function positive(raw: string | undefined): number | null {
  const value = num(raw);
  return value !== null && value > 0 ? value : null;
}

/** 从 `v_sh600519="1~贵州茅台~600519~1435.26~...";` 提取引号内的 ~ 分隔字段。 */
export function parseTencentFields(text: string): string[] | null {
  const match = /="([^"]*)"/.exec(text);
  if (!match) return null;
  const fields = match[1].split('~');
  return fields.length >= 6 ? fields : null;
}

export function decodeTencentFields(fields: string[]): TencentQuoteFields | null {
  const price = positive(fields[3]);
  if (price === null) return null;
  const marketFlag = fields[0] ?? '';
  return {
    marketFlag,
    name: fields[1] ?? '',
    code: fields[2] ?? '',
    price,
    prevClose: positive(fields[4]) ?? 0,
    open: positive(fields[5]) ?? 0,
    tradingDate: normalizeTencentDate(fields[30] ?? ''),
    changePct: num(fields[32]),
    high: positive(fields[33]),
    low: positive(fields[34]),
    turnoverRate: num(fields[38]),
    pe: positive(fields[39]),
    // 仅 A 股（marketFlag=1）的 46 位是 PB；港股 / 美股该位是名称或其它字段。
    pb: marketFlag === '1' ? positive(fields[46]) : null,
    floatCapYi: positive(fields[44]),
    totalCapYi: positive(fields[45]),
  };
}

export function parseTencentQuote(text: string, instrumentId: string, today: string): MarketPoint | null {
  const fields = parseTencentFields(text);
  if (!fields) return null;
  const decoded = decodeTencentFields(fields);
  if (!decoded) return null;
  const tradingDate = decoded.tradingDate ?? today;
  return {
    instrumentId,
    priceType: tradingDate === today ? 'REALTIME_PRICE' : 'CLOSE_PRICE',
    value: formatFixed(parseFixed(String(decoded.price), SCALE_QTY), SCALE_QTY),
    tradingDate,
    observedAt: new Date().toISOString(),
    provider: 'tencent',
    quality: tradingDate === today ? 'FRESH' : 'DELAYED',
    currency: 'CNY',
  };
}

/** `v_jj110022="110022~名称~0~0~~2.9800~2.9800~1.8107~2026-11-13~";` */
export interface TencentFundFields {
  code: string;
  name: string;
  nav: number;
  accNav: number | null;
  changePct: number | null;
  tradingDate: string | null;
}

export function decodeTencentFundFields(fields: string[]): TencentFundFields | null {
  const nav = positive(fields[5]);
  if (nav === null) return null;
  return {
    code: fields[0] ?? '',
    name: fields[1] ?? '',
    nav,
    accNav: positive(fields[6]),
    changePct: num(fields[7]),
    tradingDate: normalizeTencentDate(fields[8] ?? ''),
  };
}

export function parseTencentFundQuote(text: string, instrumentId: string, today: string): MarketPoint | null {
  const fields = parseTencentFields(text);
  if (!fields) return null;
  const decoded = decodeTencentFundFields(fields);
  if (!decoded) return null;
  return {
    instrumentId,
    priceType: 'OFFICIAL_NAV',
    value: formatFixed(parseFixed(String(decoded.nav), SCALE_QTY), SCALE_QTY),
    tradingDate: decoded.tradingDate ?? today,
    observedAt: new Date().toISOString(),
    provider: 'tencent',
    quality: decoded.tradingDate === today ? 'FRESH' : 'DELAYED',
    currency: 'CNY',
  };
}

/** `web.ifzq.gtimg.cn/appstock/app/fqkline/get`：data[symbol].qfqday = [[date, open, close, high, low, volume], ...] */
export function parseTencentKline(payload: unknown, symbol: string, instrumentId: string): MarketPoint[] {
  const data = (payload as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> } | null)?.data;
  const node = data?.[symbol];
  const rows = node?.qfqday ?? node?.day ?? [];
  const out: MarketPoint[] = [];
  for (const row of rows) {
    const [date, , close] = row;
    if (!date || !close) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(close);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      instrumentId,
      priceType: 'CLOSE_PRICE',
      value: formatFixed(parseFixed(close, SCALE_QTY), SCALE_QTY),
      tradingDate: date,
      observedAt: new Date().toISOString(),
      provider: 'tencent',
      quality: 'FRESH',
      currency: 'CNY',
    });
  }
  return out;
}

export function parseTencentMetrics(
  text: string,
  instrumentId: string,
  today: string,
): { metricKey: string; value: string | null; asOfDate: string; quality: MarketPoint['quality'] }[] {
  const fields = parseTencentFields(text);
  if (!fields) return [];
  const decoded = decodeTencentFields(fields);
  if (!decoded) return [];
  const asOfDate = decoded.tradingDate ?? today;
  const out: { metricKey: string; value: string | null; asOfDate: string; quality: MarketPoint['quality'] }[] = [];
  if (decoded.pe !== null) out.push({ metricKey: 'pe', value: String(decoded.pe), asOfDate, quality: 'FRESH' });
  if (decoded.pb !== null) out.push({ metricKey: 'pb', value: String(decoded.pb), asOfDate, quality: 'FRESH' });
  if (decoded.turnoverRate !== null) {
    out.push({ metricKey: 'turnover_rate', value: String(decoded.turnoverRate), asOfDate, quality: 'FRESH' });
  }
  if (decoded.totalCapYi !== null) {
    out.push({ metricKey: 'scale_info', value: `总市值 ${decoded.totalCapYi.toFixed(0)} 亿`, asOfDate, quality: 'FRESH' });
  }
  return out;
}

/* ---------------- Provider 实现 ---------------- */

export function createTencentProvider(): MarketProvider {
  const todayStr = (): string => new Date().toISOString().slice(0, 10);

  return {
    id: 'tencent',
    supports: (instrument) => tencentSymbol(instrument) !== null,

    async fetchQuote(instrument) {
      const symbol = tencentSymbol(instrument);
      if (!symbol) return null;
      const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbol}`);
      return instrument.type === 'OPEN_END_FUND'
        ? parseTencentFundQuote(text, instrument.id, todayStr())
        : parseTencentQuote(text, instrument.id, todayStr());
    },

    async fetchHistory(instrument, range: HistoryRequest) {
      const symbol = tencentSymbol(instrument);
      // 腾讯不提供场外基金历史净值；交给东财 /f10/lsjz（或 pingzhongdata 全量）。
      if (!symbol || instrument.type === 'OPEN_END_FUND') return [];
      const days = Math.max(
        30,
        Math.min(1200, Math.round((Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.begin}T00:00:00Z`)) / 86_400_000) + 10),
      );
      const payload = await fetchJson(
        `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${range.begin},${range.end},${days},qfq`,
      );
      return parseTencentKline(payload, symbol, instrument.id);
    },

    async fetchMetrics(instrument) {
      const symbol = tencentSymbol(instrument);
      if (!symbol || instrument.type === 'OPEN_END_FUND') return [];
      const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbol}`);
      return parseTencentMetrics(text, instrument.id, todayStr());
    },
  };
}
