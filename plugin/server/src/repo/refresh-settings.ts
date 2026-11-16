/**
 * 行情自动刷新配置（PRD §4.5.2）：交易时段按配置间隔刷新，默认 60 秒，允许关闭。
 *
 * 交易日判定已迁移到 core/src/calendar.ts + services/calendar.ts：
 * 用本机指数日线反推真实交易日（含节假日），定时器读的是 isMarketOpen(ctx)。
 * 本文件保留的 isTradingHours 只是「周一至周五 + 时段」的基础判断，供无日线数据时的
 * 退化路径与单测使用，不再作为主链路依据。
 *
 * 定时调度由 DSH Host 生命周期托管（见 targets/dsh/host/glue.ts），server 层只提供配置与判定。
 */
import type { DbHandle } from '../db.ts';
import { ValidationError } from '../errors.ts';
import { getSetting, setSetting } from './settings.ts';

const KEY = 'refresh_settings';

export const MIN_REFRESH_INTERVAL_SEC = 15;
export const MAX_REFRESH_INTERVAL_SEC = 3600;

export interface RefreshSettings {
  enabled: boolean;
  intervalSec: number;
  tradingHoursOnly: boolean;
}

export const DEFAULT_REFRESH_SETTINGS: RefreshSettings = {
  enabled: true,
  intervalSec: 60,
  tradingHoursOnly: true,
};

export function getRefreshSettings(handle: DbHandle): RefreshSettings {
  const stored = getSetting(handle, KEY) as Partial<RefreshSettings> | null;
  if (!stored) return { ...DEFAULT_REFRESH_SETTINGS };
  const intervalSec = Number(stored.intervalSec);
  return {
    enabled: stored.enabled === true,
    intervalSec: Number.isFinite(intervalSec) && intervalSec >= MIN_REFRESH_INTERVAL_SEC && intervalSec <= MAX_REFRESH_INTERVAL_SEC
      ? Math.round(intervalSec)
      : DEFAULT_REFRESH_SETTINGS.intervalSec,
    tradingHoursOnly: stored.tradingHoursOnly !== false,
  };
}

export function saveRefreshSettings(handle: DbHandle, input: Partial<RefreshSettings>): RefreshSettings {
  const current = getRefreshSettings(handle);
  const raw = input.intervalSec === undefined ? current.intervalSec : Number(input.intervalSec);
  if (!Number.isFinite(raw) || raw < MIN_REFRESH_INTERVAL_SEC || raw > MAX_REFRESH_INTERVAL_SEC) {
    throw new ValidationError(`刷新间隔必须是 ${MIN_REFRESH_INTERVAL_SEC}–${MAX_REFRESH_INTERVAL_SEC} 秒之间的整数`);
  }
  const next: RefreshSettings = {
    enabled: input.enabled === undefined ? current.enabled : input.enabled === true,
    intervalSec: Math.round(raw),
    tradingHoursOnly: input.tradingHoursOnly === undefined
      ? current.tradingHoursOnly
      : input.tradingHoursOnly === true,
  };
  setSetting(handle, KEY, next);
  return next;
}

/** 基础时段判断（宿主本地时间，不含节假日）；主链路请用 services/calendar.ts 的 isMarketOpen。 */
export function isTradingHours(now: Date = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  return (minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900);
}
