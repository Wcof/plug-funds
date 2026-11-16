import type { MarketPoint } from '../../../core/src/types.ts';
import { createHash } from 'node:crypto';
import type { DbHandle } from '../db.ts';
import { effectiveHistoryPoints, historyPoints, saveMarketPoints } from '../repo/market.ts';
import { detectConflict } from '../market/conflict.ts';

/** 上年末 14 天窗口，和指数 YTD 的基准选择一致。 */
export function indexYearEndRange(today: string) {
  const year = Number(today.slice(0, 4)) - 1;
  return { begin: `${year}-12-17`, end: `${year}-12-31` };
}

export function hasIndexYearEndBase(handle: DbHandle, instrumentId: string, today: string): boolean {
  const range = indexYearEndRange(today);
  return effectiveHistoryPoints(handle, instrumentId, 'INDEX', range.begin, range.end, today)
    .some((point) => point.priceType !== 'REALTIME_PRICE' && !['CONFLICT', 'MISSING'].includes(point.quality)
      && Number.isFinite(Number(point.value)) && Number(point.value) > 0);
}

/** 同日收盘比较，保留双方；报价或官方来源均不能把已有冲突标记静默洗掉。 */
export function planIndexHistory(handle: DbHandle, instrumentId: string, incoming: MarketPoint[]) {
  const writes: MarketPoint[] = [];
  const comparisons: { date: string; provider: string; value: string; official: string; relativeDifference: number; conflict: boolean }[] = [];
  const changes: { before: MarketPoint | null; after: MarketPoint; reason: string }[] = [];
  const stored = historyPoints(handle, instrumentId, ['CLOSE_PRICE']);
  const byDate = new Map<string, MarketPoint[]>();
  for (const point of stored) { const list = byDate.get(point.tradingDate) ?? []; list.push(point); byDate.set(point.tradingDate, list); }
  for (const point of incoming) {
    if (point.instrumentId !== instrumentId || point.priceType !== 'CLOSE_PRICE') throw new Error('指数历史写入身份或价格类型不符');
    const existing = byDate.get(point.tradingDate) ?? [];
    const same = existing.find((p) => p.provider === point.provider);
    const others = existing.filter((p) => p.provider !== point.provider);
    for (const other of others) {
      const difference = Math.abs(Number(other.value) - Number(point.value)) / Math.max(Number(other.value), Number(point.value));
      comparisons.push({ date: point.tradingDate, provider: other.provider, value: other.value, official: point.value, relativeDifference: difference, conflict: difference > 0.01 });
    }
    const conflict = detectConflict([point, ...others]) !== null || existing.some((p) => p.quality === 'CONFLICT');
    const after = { ...point, quality: conflict ? 'CONFLICT' as const : point.quality };
    if (!same || same.value !== after.value || same.quality !== after.quality) {
      writes.push(after); changes.push({ before: same ?? null, after, reason: same ? '同源收盘更新或多源冲突标记' : '新增来源收盘记录' });
    }
    if (conflict) for (const other of others.filter((p) => p.quality !== 'CONFLICT')) {
      const marked = { ...other, quality: 'CONFLICT' as const };
      writes.push(marked); changes.push({ before: other, after: marked, reason: '同日同类型收盘差异超过 1%，保留双方' });
    }
  }
  return { writes, changes, comparisons };
}

export function saveIndexHistory(handle: DbHandle, instrumentId: string, points: MarketPoint[]) {
  const plan = planIndexHistory(handle, instrumentId, points);
  handle.db.exec('SAVEPOINT index_history;');
  try {
    saveMarketPoints(handle, plan.writes);
    const revised = plan.changes.filter((change) => change.before !== null);
    if (revised.length) {
      const note = JSON.stringify({ kind: 'index-history-reconciliation', instrumentId, changes: revised });
      const id = `index-history-${createHash('sha256').update(note).digest('hex')}`;
      const now = new Date().toISOString();
      handle.db.prepare('INSERT OR IGNORE INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)')
        .run(id, now, now, 1, 1, 0, note);
    }
    handle.db.exec('RELEASE index_history;');
    return plan;
  } catch (error) { handle.db.exec('ROLLBACK TO index_history; RELEASE index_history;'); throw error; }
}
