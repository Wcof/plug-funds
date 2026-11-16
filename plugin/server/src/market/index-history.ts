/** 官方指数日线：只读取同码价格指数的 close，不使用图表修饰值或估值字段。 */
import type { Instrument, MarketPoint } from '../../../core/src/types.ts';
import { formatFixed, parseFixed, SCALE_QTY } from '../../../core/src/money.ts';
import { todayLocal } from '../ids.ts';
import { validReferenceDate } from './index-reference.ts';
import { csindexOfficialCode } from './index-identities.ts';
import type { HistoryRequest, MarketProvider } from './provider.ts';

export type IndexHistorySource = 'csindex' | 'cnindex';
export function indexHistoryUrl(source: IndexHistorySource, code: string, range: HistoryRequest): string {
  if (!/^(000|399)\d{3}$/.test(code)) throw new Error('官方日线指数代码无效');
  if (!validReferenceDate(range.begin, range.end) || !validReferenceDate(range.end, range.end)) throw new Error('官方日线请求日期无效');
  return source === 'csindex'
    ? `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=${csindexOfficialCode(code)}&startDate=${range.begin.replaceAll('-', '')}&endDate=${range.end.replaceAll('-', '')}`
    : `https://hq.cnindex.com.cn/market/market/getIndexDailyData?indexCode=${code}&startDate=${range.begin}&endDate=${range.end}`;
}

export function parseIndexHistory(payload: any, source: IndexHistorySource, instrument: Pick<Instrument, 'id' | 'code'>,
  range: HistoryRequest, today: string, observedAt: string): MarketPoint[] {
  indexHistoryUrl(source, instrument.code, range);
  if (!payload || String(payload.code) !== '200') throw new Error('官方日线响应失败');
  let rows: { date: string; close: unknown; open?: unknown; high?: unknown; low?: unknown }[];
  if (source === 'csindex') {
    if (!Array.isArray(payload.data)) throw new Error('中证日线数据格式无效');
    rows = payload.data.map((row: any) => {
      if (row?.indexCode !== csindexOfficialCode(instrument.code)) throw new Error('中证日线指数身份不符');
      if (typeof row.tradeDate !== 'string' || !/^\d{8}$/.test(row.tradeDate)) throw new Error('中证日线交易日格式无效');
      return { date: row.tradeDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), close: row.close, open: row.open, high: row.high, low: row.low };
    });
  } else {
    const data = payload.data;
    if (data?.indexCode !== instrument.code) throw new Error('国证日线指数身份不符');
    if (!Array.isArray(data.item) || !Array.isArray(data.data) || new Set(data.item).size !== data.item.length
      || !['timestamp', 'close'].every((key) => data.item.includes(key))) throw new Error('国证日线列定义无效');
    const get = (row: unknown[], key: string) => row[data.item.indexOf(key)];
    rows = data.data.map((row: any) => {
      if (!Array.isArray(row) || row.length !== data.item.length) throw new Error('国证日线行长度无效');
      const timestamp = get(row, 'timestamp');
      if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) throw new Error('国证日线时间戳无效');
      const instant = new Date(timestamp + 8 * 3600000);
      if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(11) !== '00:00:00.000Z') throw new Error('国证日线时间戳不是北京时间零点');
      return { date: instant.toISOString().slice(0, 10), close: get(row, 'close'), open: get(row, 'open'), high: get(row, 'high'), low: get(row, 'low') };
    });
  }
  if (rows.length > 10000) throw new Error('官方日线超过单次 10000 行上限');
  const dates = new Set<string>();
  return rows.map((row) => {
    if (!validReferenceDate(row.date, today) || row.date < range.begin || row.date > range.end) throw new Error(`官方日线日期非法、未来或超出请求区间：${row.date}`);
    if (dates.has(row.date)) throw new Error(`官方日线日期重复：${row.date}`);
    dates.add(row.date);
    if (typeof row.close !== 'number' || !Number.isFinite(row.close) || row.close <= 0) throw new Error(`官方日线收盘价无效：${row.date}`);
    const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (valid(row.high) && valid(row.low) && (row.high < row.low || row.close > row.high || row.close < row.low
      || (valid(row.open) && (row.open > row.high || row.open < row.low)))) throw new Error(`官方日线 OHLC 不一致：${row.date}`);
    const [integer, decimal = ''] = String(row.close).split('.');
    const raw = parseFixed(decimal ? `${integer}.${decimal.slice(0, SCALE_QTY)}` : integer, SCALE_QTY);
    if (raw <= 0) throw new Error(`官方日线收盘价低于有效精度：${row.date}`);
    return { instrumentId: instrument.id, priceType: 'CLOSE_PRICE' as const,
      value: formatFixed(raw, SCALE_QTY), tradingDate: row.date,
      provider: `${source}-history`, quality: 'FRESH' as const, observedAt };
  }).sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`官方日线 HTTP ${response.status}`);
  if (!response.body) throw new Error('官方日线响应为空');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 10 * 1024 * 1024) throw new Error('官方日线响应超过 10 MB');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export function createIndexHistoryProvider(source: IndexHistorySource, today = todayLocal(), fetchJson = loadJson): MarketProvider {
  return { id: `${source}-history`,
    supports: (instrument) => instrument.type === 'INDEX' && /^(000|399)\d{3}$/.test(instrument.code),
    async fetchQuote() { return null; },
    async fetchHistory(instrument, range) {
      const payload = await fetchJson(indexHistoryUrl(source, instrument.code, range));
      return parseIndexHistory(payload, source, instrument, range, today, new Date().toISOString());
    },
  };
}

/** 报价历史缺年末基准时使用；399 先试国证，再试中证，返回身份已校验的第一份非空日线。 */
export function createOfficialIndexHistoryProvider(today?: string, fetchJson = loadJson): MarketProvider {
  const blockedUntil = new Map<IndexHistorySource, number>();
  let lastRequestAt = 0;
  return { id: 'official-index-history',
    supports: (instrument) => instrument.type === 'INDEX' && /^(000|399)\d{3}$/.test(instrument.code),
    async fetchQuote() { return null; },
    async fetchHistory(instrument, range) {
      const sources: IndexHistorySource[] = instrument.code.startsWith('000') ? ['csindex'] : ['cnindex', 'csindex'];
      const errors: string[] = [];
      for (const source of sources) {
        try {
          if ((blockedUntil.get(source) ?? 0) > Date.now()) throw new Error('上游 403 后退避 15 分钟，尚未重新请求');
          if (fetchJson === loadJson) {
            const wait = lastRequestAt + 1000 - Date.now();
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            lastRequestAt = Date.now();
          }
          const points = await createIndexHistoryProvider(source, today ?? todayLocal(), fetchJson).fetchHistory(instrument, range);
          if (points.length) return points;
        } catch (error) {
          const message = String((error as Error).message).slice(0, 200);
          if (/HTTP 403/.test(message)) blockedUntil.set(source, Date.now() + 15 * 60000);
          errors.push(`${source}: ${message}`);
        }
      }
      if (errors.length) throw new Error(errors.join('；'));
      return [];
    },
  };
}
