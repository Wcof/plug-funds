/**
 * 交易日历回归：纯函数规则 + 真实日线驱动 + RPC 输出。
 *
 * 为什么重要：节假日把「工作日」当成交易日，会让定时刷新在休市日空转并写失败记录；
 * 反过来把交易日当成休市，则会漏掉整段行情。两条都不能靠猜。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import { saveMarketPoints } from '../server/src/repo/market.ts';
import {
  WEEKDAY_CALENDAR, classifyDay, derivedHolidays, isWeekend, previousTradingDay,
  sessionState, shanghaiParts, weekdayOf, type TradingCalendar,
} from '../core/src/calendar.ts';
import { buildTradingCalendar } from '../server/src/services/calendar.ts';
import type { ServiceContext } from '../server/src/context.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-cal-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

/* ---------------- 1. 基础日期函数 ---------------- */

test('星期与周末：2026-11-16 是周一，11-14 / 11-15 是周末', () => {
  assert.equal(weekdayOf('2026-11-16'), 1);
  assert.equal(isWeekend('2026-11-14'), true);
  assert.equal(isWeekend('2026-11-15'), true);
  assert.equal(isWeekend('2026-11-16'), false);
});

test('上海时间换算不依赖宿主时区：UTC 01:30 → 09:30', () => {
  const parts = shanghaiParts(new Date('2026-11-16T01:30:00Z'));
  assert.equal(parts.date, '2026-11-16');
  assert.equal(parts.minutes, 570);
  // UTC 17:00（前一天）在上海已是次日 01:00
  const next = shanghaiParts(new Date('2026-11-16T17:00:00Z'));
  assert.equal(next.date, '2026-11-17');
  assert.equal(next.minutes, 60);
});

test('会话切分：开盘前 / 上午 / 午休 / 下午 / 收盘后', () => {
  const at = (iso: string): string => sessionState(new Date(iso), WEEKDAY_CALENDAR).phase;
  assert.equal(at('2026-11-16T01:00:00Z'), 'before');    // 09:00
  assert.equal(at('2026-11-16T01:30:00Z'), 'morning');   // 09:30
  assert.equal(at('2026-11-16T03:29:00Z'), 'morning');   // 11:29
  assert.equal(at('2026-11-16T03:30:00Z'), 'lunch');     // 11:30
  assert.equal(at('2026-11-16T05:00:00Z'), 'afternoon'); // 13:00
  assert.equal(at('2026-11-16T07:00:00Z'), 'after');     // 15:00
  assert.equal(at('2026-11-15T02:00:00Z'), 'closed-day'); // 周日
});

/* ---------------- 2. 真实日历驱动 ---------------- */

const MARKET_CALENDAR: TradingCalendar = {
  source: 'market',
  days: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16'],
  from: '2026-11-09',
  to: '2026-11-16',
  note: 'fixture',
};

test('真实日历：区间内的工作日按日期表判定，缺的那天算休市', () => {
  // 2026-11-14/15 是周末；构造一个区间内的工作日缺口
  const withGap: TradingCalendar = { ...MARKET_CALENDAR, days: ['2026-11-09', '2026-11-10', '2026-11-12', '2026-11-13'] };
  assert.deepEqual(classifyDay('2026-11-11', withGap), { trading: false, assumed: false });
  assert.deepEqual(classifyDay('2026-11-12', withGap), { trading: true, assumed: false });
});

test('真实日历：区间外退回工作日推断并标记 assumed', () => {
  assert.deepEqual(classifyDay('2026-12-01', MARKET_CALENDAR), { trading: true, assumed: true });
  assert.deepEqual(classifyDay('2026-12-05', MARKET_CALENDAR), { trading: false, assumed: false });
});

test('推导出的节假日只包含「区间内的工作日缺口」', () => {
  const withGap: TradingCalendar = {
    source: 'market',
    days: ['2026-10-09', '2026-10-12'],
    from: '2026-10-09',
    to: '2026-10-12',
    note: 'fixture',
  };
  // 10-10 / 10-11 是周末，不算推导节假日
  assert.deepEqual(derivedHolidays(withGap), []);
  const withHoliday: TradingCalendar = {
    ...withGap,
    days: ['2026-10-09', '2026-10-13', '2026-10-14'],
    to: '2026-10-14',
  };
  assert.deepEqual(derivedHolidays(withHoliday), ['2026-10-12']);
});

test('前一个交易日会跳过周末与休市日', () => {
  assert.equal(previousTradingDay('2026-11-16', MARKET_CALENDAR), '2026-11-13');
  assert.equal(previousTradingDay('2026-11-13', MARKET_CALENDAR), '2026-11-12');
});

/* ---------------- 3. 无指数数据时退回工作日并显式说明 ---------------- */

test('无 INDEX 标的：calendar.source=weekday，并在 note 里说明可能误判', async () => {
  const calendar = buildTradingCalendar(ctx);
  assert.equal(calendar.source, 'weekday');
  assert.equal(calendar.days.length, 0);
  assert.match(calendar.note, /节假日/);
});

test('指数日线样本不足 20 天：仍退化为工作日推断', async () => {
  const index = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  saveMarketPoints(handle, ['2026-11-09', '2026-11-10', '2026-11-11'].map((date) => ({
    instrumentId: index.id, priceType: 'CLOSE_PRICE' as const, value: '4000.0000',
    currency: 'CNY', tradingDate: date, observedAt: `${date}T15:00:00.000Z`,
    provider: 'fixture', quality: 'FRESH' as const,
  })));
  const calendar = buildTradingCalendar(ctx);
  assert.equal(calendar.source, 'weekday');
  assert.match(calendar.note, /样本/);
});

test('指数日线足够时改用真实交易日，并排除周末与节假日', async () => {
  const index = await rpc<{ id: string }>('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  // 构造 25 个工作日，其中 2026-10-01 / 10-02 故意缺失（国庆），验证不按工作日算交易日。
  const days: string[] = [];
  const cursor = new Date(Date.UTC(2026, 8, 21)); // 2026-09-21 周一
  while (days.length < 25) {
    const date = cursor.toISOString().slice(0, 10);
    if (!isWeekend(date) && date !== '2026-10-01' && date !== '2026-10-02') days.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  saveMarketPoints(handle, days.map((date) => ({
    instrumentId: index.id, priceType: 'CLOSE_PRICE' as const, value: '4000.0000',
    currency: 'CNY', tradingDate: date, observedAt: `${date}T15:00:00.000Z`,
    provider: 'fixture', quality: 'FRESH' as const,
  })));

  const calendar = buildTradingCalendar(ctx);
  assert.equal(calendar.source, 'market');
  assert.equal(calendar.days.length, 25);
  assert.equal(calendar.days.includes('2026-10-01'), false);
  assert.equal(classifyDay('2026-10-01', calendar).trading, false);
  assert.deepEqual(derivedHolidays(calendar), ['2026-10-01', '2026-10-02']);
});

/* ---------------- 4. RPC 输出 ---------------- */

test('get_trading_calendar 返回日历、会话与推导出的休市日', async () => {
  const info = await rpc<{
    calendar: { source: string; days: string[] }; session: { phase: string; label: string };
    holidayCount: number; tradingDayCount: number;
  }>('get_trading_calendar', { now: '2026-11-16T02:00:00Z' }); // 周一 10:00
  assert.equal(info.calendar.source, 'weekday');
  assert.equal(info.session.phase, 'morning');
  assert.equal(info.holidayCount, 0);
  assert.equal(info.tradingDayCount, 0);
});

test('get_refresh_settings 的 inTradingHours 走日历判定（周末为 false）', async () => {
  const weekday = await rpc<{ inTradingHours: boolean; session: { phase: string }; note: string }>('get_refresh_settings');
  // 该 RPC 用「当前真实时间」，因此只断言字段形状与 note 口径，不断言具体真假。
  assert.equal(typeof weekday.inTradingHours, 'boolean');
  assert.ok(typeof weekday.session.phase === 'string');
  assert.match(weekday.note, /09:30–11:30/);
});
