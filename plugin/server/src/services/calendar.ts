/**
 * 交易日历服务：用「本机真实指数日线」反推交易日，而不是硬编码一份会过期的节假日表。
 *
 * 逻辑：
 * - 优先选 000300（沪深300）的日线日期；没有则取历史最长的 INDEX 标的；
 * - 有效日期 >= 20 天才认定 source='market'（样本太少时区间外全是「推测」，意义有限）；
 * - 没有指数数据时退回 WEEKDAY_CALENDAR，并明确说明节假日可能误判。
 */
import type { ServiceContext } from '../context.ts';
import { listInstruments } from '../repo/instruments.ts';
import { effectiveHistoryPoints } from '../repo/market.ts';
import {
  WEEKDAY_CALENDAR, derivedHolidays, isWeekend, sessionState, type SessionState, type TradingCalendar,
} from '../../../core/src/calendar.ts';

const MIN_MARKET_DAYS = 20;
const PREFERRED_BENCHMARK = '000300';

const cache = new WeakMap<object, { signature: string; calendar: TradingCalendar }>();

function pickSourceInstrument(ctx: ServiceContext): { id: string; code: string; name: string } | null {
  const indices = listInstruments(ctx.handle).filter((i) => i.type === 'INDEX' && i.active !== false);
  if (indices.length === 0) return null;
  const preferred = indices.find((i) => i.code === PREFERRED_BENCHMARK);
  if (preferred) return { id: preferred.id, code: preferred.code, name: preferred.name };
  let best: { id: string; code: string; name: string; count: number } | null = null;
  for (const index of indices) {
    const count = effectiveHistoryPoints(ctx.handle, index.id, index.type).length;
    if (!best || count > best.count) best = { id: index.id, code: index.code, name: index.name, count };
  }
  return best ? { id: best.id, code: best.code, name: best.name } : null;
}

export function buildTradingCalendar(ctx: ServiceContext): TradingCalendar {
  const instrument = pickSourceInstrument(ctx);
  if (!instrument) return WEEKDAY_CALENDAR;

  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
  const dates = [...new Set(points.map((p) => p.tradingDate).filter((d) => !isWeekend(d)))].sort();
  // 缓存签名：日期数 + 首尾日期，避免每次判定都重算整段区间。
  const signature = `${instrument.id}:${dates.length}:${dates[0] ?? ''}:${dates[dates.length - 1] ?? ''}`;
  const hit = cache.get(ctx.handle);
  if (hit && hit.signature === signature) return hit.calendar;

  const calendar: TradingCalendar = dates.length < MIN_MARKET_DAYS
    ? { ...WEEKDAY_CALENDAR, note: `${instrument.name} 只有 ${dates.length} 个交易日样本（需 ≥ ${MIN_MARKET_DAYS}），暂按工作日推断，节假日可能误判。` }
    : {
      source: 'market',
      days: dates,
      from: dates[0],
      to: dates[dates.length - 1],
      note: `交易日取自本机 ${instrument.name}（${instrument.code}）日线，共 ${dates.length} 个交易日，覆盖 ${dates[0]} → ${dates[dates.length - 1]}；区间外按工作日推断。`,
    };

  cache.set(ctx.handle, { signature, calendar });
  return calendar;
}

export interface TradingCalendarInfo {
  calendar: TradingCalendar;
  session: SessionState;
  holidayCount: number;
  recentHolidays: string[];
  tradingDayCount: number;
}

export function getTradingCalendarInfo(ctx: ServiceContext, now: Date = new Date()): TradingCalendarInfo {
  const calendar = buildTradingCalendar(ctx);
  const holidays = derivedHolidays(calendar);
  return {
    calendar,
    session: sessionState(now, calendar),
    holidayCount: holidays.length,
    recentHolidays: holidays.slice(-12),
    tradingDayCount: calendar.days.length,
  };
}

/** 供定时刷新使用：只有「确认开市」且处于连续竞价时段才自动刷新。 */
export function isMarketOpen(ctx: ServiceContext, now: Date = new Date()): boolean {
  return sessionState(now, buildTradingCalendar(ctx)).open;
}
