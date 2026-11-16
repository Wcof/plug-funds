import { randomUUID } from 'node:crypto';
import { shanghaiParts } from '../../core/src/calendar.ts';

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 交易日期统一采用 UTC+8，不依赖宿主操作系统时区。 */
export function todayLocal(now: Date = new Date()): string {
  return shanghaiParts(now).date;
}
