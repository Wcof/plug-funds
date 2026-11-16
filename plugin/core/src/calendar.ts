/**
 * A 股交易日历与会话判定（纯函数，无 I/O）。
 *
 * 设计原则：
 * - 周末一律休市（沪深交易所不因「调休上班」而开市），这条不需要外部数据；
 * - 工作日是否开市必须靠真实数据：优先使用本机已缓存的基准指数日线日期集合，
 *   其次退回「工作日即交易日」并显式标注 assumed，绝不假装知道没导入的节假日；
 * - 时间一律按 UTC+8 计算，不依赖宿主时区，避免跨时区跑出错误的「盘中」判断。
 */

export type CalendarSource = 'market' | 'weekday';

export interface TradingCalendar {
  source: CalendarSource;
  /** 已知交易日（升序，YYYY-MM-DD）；source='weekday' 时为空数组。 */
  days: string[];
  from: string | null;
  to: string | null;
  note: string;
}

export const WEEKDAY_CALENDAR: TradingCalendar = {
  source: 'weekday',
  days: [],
  from: null,
  to: null,
  note: '尚无指数日线数据，按「周一至周五即交易日」推断，节假日可能误判。导入指数并刷新行情后会自动改用真实交易日。',
};

const CN_OFFSET_MIN = 8 * 60;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 上海时间（UTC+8）下的日期、分钟数与星期（0=周日）。 */
export function shanghaiParts(now: Date): { date: string; minutes: number; weekday: number } {
  const shifted = new Date(now.getTime() + CN_OFFSET_MIN * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return {
    date,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** YYYY-MM-DD 的星期（0=周日）；纯字符串运算，不受时区影响。 */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
}

export interface DayClass {
  trading: boolean;
  /** true 表示该结论来自「工作日即交易日」的推测，而非真实行情日期。 */
  assumed: boolean;
}

/** 判定某日是否开市：周末恒 false；区间内有真实日期则查表，区间外退回工作日推断。 */
export function classifyDay(date: string, calendar: TradingCalendar): DayClass {
  if (isWeekend(date)) return { trading: false, assumed: false };
  if (calendar.source === 'market' && calendar.from !== null && calendar.to !== null
    && date >= calendar.from && date <= calendar.to) {
    return { trading: calendar.days.includes(date), assumed: false };
  }
  return { trading: true, assumed: true };
}

export function isTradingDay(date: string, calendar: TradingCalendar): boolean {
  return classifyDay(date, calendar).trading;
}

/** 区间内的工作日但不在交易日表里的日期 → 推导出的休市日（节假日 / 临时休市）。 */
export function derivedHolidays(calendar: TradingCalendar): string[] {
  if (calendar.source !== 'market' || calendar.from === null || calendar.to === null) return [];
  const known = new Set(calendar.days);
  const result: string[] = [];
  const [fy, fm, fd] = calendar.from.split('-').map(Number);
  const [ty, tm, td] = calendar.to.split('-').map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor.getTime() <= end) {
    const date = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
    if (!isWeekend(date) && !known.has(date)) result.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

/** 前一个交易日（不含 date 本身）。 */
export function previousTradingDay(date: string, calendar: TradingCalendar, maxLookback = 30): string | null {
  const [y, m, d] = date.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < maxLookback; i += 1) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const candidate = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
    if (isTradingDay(candidate, calendar)) return candidate;
  }
  return null;
}

export type SessionPhase = 'closed-day' | 'before' | 'morning' | 'lunch' | 'afternoon' | 'after';

export interface SessionState {
  phase: SessionPhase;
  /** 是否处于连续竞价时段（09:30–11:30 / 13:00–15:00）。 */
  open: boolean;
  date: string;
  time: string;
  assumed: boolean;
  label: string;
}

const PHASE_LABELS: Record<SessionPhase, string> = {
  'closed-day': '休市',
  before: '开盘前',
  morning: '上午盘中',
  lunch: '午间休市',
  afternoon: '下午盘中',
  after: '已收盘',
};

/** 会话判定：先用交易日历决定是否开市，再按 UTC+8 时间切分时段。 */
export function sessionState(now: Date, calendar: TradingCalendar): SessionState {
  const { date, minutes, weekday } = shanghaiParts(now);
  const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const dayClass = weekday === 0 || weekday === 6
    ? { trading: false, assumed: false }
    : classifyDay(date, calendar);

  let phase: SessionPhase;
  if (!dayClass.trading) phase = 'closed-day';
  else if (minutes < 570) phase = 'before';
  else if (minutes < 690) phase = 'morning';
  else if (minutes < 780) phase = 'lunch';
  else if (minutes < 900) phase = 'afternoon';
  else phase = 'after';

  return {
    phase,
    open: phase === 'morning' || phase === 'afternoon',
    date,
    time,
    assumed: dayClass.assumed,
    label: dayClass.trading ? PHASE_LABELS[phase] : `${PHASE_LABELS[phase]}（非交易日）`,
  };
}
