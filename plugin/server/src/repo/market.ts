import type { DataQuality, EffectivePrice, MarketPoint, PriceType } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

interface MarketRow {
  id: string;
  instrument_id: string;
  price_type: string;
  value: string;
  trading_date: string;
  observed_at: string;
  provider: string;
  quality: string;
}

function toPoint(row: MarketRow): MarketPoint {
  return {
    instrumentId: row.instrument_id,
    priceType: row.price_type as PriceType,
    value: row.value,
    tradingDate: row.trading_date,
    observedAt: row.observed_at,
    provider: row.provider,
    quality: row.quality as DataQuality,
  };
}

const UPSERT = `INSERT INTO market_data (id, instrument_id, price_type, value, trading_date, observed_at, provider, quality)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT (instrument_id, price_type, trading_date, provider) DO UPDATE SET
                  value = excluded.value, observed_at = excluded.observed_at, quality = excluded.quality`;

/** 幂等 upsert（PRD §13.2：重复拉取不产生重复记录）。 */
export function saveMarketPoints(handle: DbHandle, points: MarketPoint[]): number {
  const stmt = handle.db.prepare(UPSERT);
  let count = 0;
  for (const point of points) {
    stmt.run(newId(), point.instrumentId, point.priceType, point.value, point.tradingDate, point.observedAt, point.provider, point.quality);
    count += 1;
  }
  return count;
}

export function latestPoint(
  handle: DbHandle,
  instrumentId: string,
  priceTypes: PriceType[],
): MarketPoint | null {
  const placeholders = priceTypes.map(() => '?').join(',');
  const row = handle.db
    .prepare(`SELECT * FROM market_data WHERE instrument_id = ? AND price_type IN (${placeholders})
              ORDER BY trading_date DESC, observed_at DESC LIMIT 1`)
    .get(instrumentId, ...priceTypes) as MarketRow | undefined;
  return row ? toPoint(row) : null;
}

export function historyPoints(
  handle: DbHandle,
  instrumentId: string,
  priceTypes: PriceType[],
  begin?: string,
  end?: string,
): MarketPoint[] {
  const placeholders = priceTypes.map(() => '?').join(',');
  const clauses = [`instrument_id = ?`, `price_type IN (${placeholders})`];
  const args: (string | number)[] = [instrumentId, ...priceTypes];
  if (begin) { clauses.push('trading_date >= ?'); args.push(begin); }
  if (end) { clauses.push('trading_date <= ?'); args.push(end); }
  const rows = handle.db
    .prepare(`SELECT * FROM market_data WHERE ${clauses.join(' AND ')} ORDER BY trading_date ASC, observed_at ASC`)
    .all(...args) as MarketRow[];
  return rows.map(toPoint);
}

/**
 * 有效价格（PRD §6.1）：按标的类型给出优先级——
 * 股票/ETF：实时（当日新鲜）→ 收盘；基金：正式净值（MANUAL_PRICE 恒优先）。
 * 估算净值绝不进入正式计价。
 */
export function effectivePrice(handle: DbHandle, instrument: { id: string; type: string }, today: string): EffectivePrice | null {
  const manual = latestPoint(handle, instrument.id, ['MANUAL_PRICE']);
  if (manual) {
    return { value: manual.value, priceType: manual.priceType, quality: 'MANUAL', tradingDate: manual.tradingDate, observedAt: manual.observedAt };
  }
  if (instrument.type === 'OPEN_END_FUND') {
    const nav = latestPoint(handle, instrument.id, ['OFFICIAL_NAV']);
    if (nav) {
      return {
        value: nav.value,
        priceType: nav.priceType,
        quality: nav.tradingDate === today ? 'FRESH' : 'DELAYED',
        tradingDate: nav.tradingDate,
        observedAt: nav.observedAt,
      };
    }
    return null;
  }
  const realtime = latestPoint(handle, instrument.id, ['REALTIME_PRICE']);
  if (realtime && realtime.tradingDate === today) {
    return { value: realtime.value, priceType: realtime.priceType, quality: 'FRESH', tradingDate: realtime.tradingDate, observedAt: realtime.observedAt };
  }
  const close = latestPoint(handle, instrument.id, ['CLOSE_PRICE']);
  if (close) {
    return {
      value: close.value,
      priceType: close.priceType,
      quality: close.tradingDate === today ? 'FRESH' : 'DELAYED',
      tradingDate: close.tradingDate,
      observedAt: close.observedAt,
    };
  }
  return realtime ? { value: realtime.value, priceType: realtime.priceType, quality: 'STALE', tradingDate: realtime.tradingDate, observedAt: realtime.observedAt } : null;
}

/* ---------------- 估值指标（valuation_metrics） ---------------- */

export interface ValuationMetricRow {
  instrumentId: string;
  metricKey: string;
  /** 定点字符串或文本；缺失为 null。 */
  value: string | null;
  asOfDate: string;
  provider: string;
  quality: DataQuality;
}

interface ValRow {
  instrument_id: string;
  metric_key: string;
  value: string | null;
  as_of_date: string;
  provider: string;
  quality: string;
}

const VAL_UPSERT = `INSERT INTO valuation_metrics (id, instrument_id, metric_key, value, as_of_date, provider, quality)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT (instrument_id, metric_key, as_of_date) DO UPDATE SET
                      value = excluded.value, provider = excluded.provider, quality = excluded.quality`;

export function saveValuationMetric(handle: DbHandle, row: Omit<ValuationMetricRow, 'instrumentId'> & { instrumentId: string }): void {
  handle.db.prepare(VAL_UPSERT).run(newId(), row.instrumentId, row.metricKey, row.value, row.asOfDate, row.provider, row.quality);
}

/**
 * 计价用的历史序列：与 effectivePrice 同口径（MANUAL > 当日 REALTIME > CLOSE / OFFICIAL_NAV），
 * 同一交易日多来源只保留优先级最高的一条，避免图表 / 指标重复计数。
 */
export function effectiveHistoryPoints(
  handle: DbHandle,
  instrumentId: string,
  instrumentType: string,
  begin?: string,
  end?: string,
): MarketPoint[] {
  const types: PriceType[] = instrumentType === 'OPEN_END_FUND'
    ? ['OFFICIAL_NAV', 'MANUAL_PRICE']
    : ['CLOSE_PRICE', 'REALTIME_PRICE', 'MANUAL_PRICE'];
  const priority: Record<string, number> = {
    MANUAL_PRICE: 3, REALTIME_PRICE: 2, CLOSE_PRICE: 1, OFFICIAL_NAV: 1,
  };
  const byDate = new Map<string, MarketPoint>();
  for (const point of historyPoints(handle, instrumentId, types, begin, end)) {
    const previous = byDate.get(point.tradingDate);
    if (!previous || (priority[point.priceType] ?? 0) >= (priority[previous.priceType] ?? 0)) {
      byDate.set(point.tradingDate, point);
    }
  }
  return [...byDate.values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}

/**
 * 某指标的历史截面（按估值日期升序）：用于 PE / PB 近 3 年经验分位。
 * 样本不足时由调用方决定「不写分位 / 显示样本不足」，绝不伪造。
 */
export function metricHistory(
  handle: DbHandle,
  instrumentId: string,
  metricKey: string,
  since?: string,
): { asOfDate: string; value: number }[] {
  const clauses = ['instrument_id = ?', 'metric_key = ?', 'value IS NOT NULL'];
  const args: (string | number)[] = [instrumentId, metricKey];
  if (since) { clauses.push('as_of_date >= ?'); args.push(since); }
  const rows = handle.db.prepare(
    `SELECT as_of_date, value FROM valuation_metrics WHERE ${clauses.join(' AND ')} ORDER BY as_of_date ASC`,
  ).all(...args) as { as_of_date: string; value: string }[];
  return rows
    .map((r) => ({ asOfDate: r.as_of_date, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

/** 每个指标取最新截面（as_of_date 最大）。 */
export function latestValuationMetrics(handle: DbHandle, instrumentId: string): ValuationMetricRow[] {
  const rows = handle.db
    .prepare(`SELECT instrument_id, metric_key, value, as_of_date, provider, quality
              FROM valuation_metrics WHERE instrument_id = ?
              ORDER BY metric_key, as_of_date`)
    .all(instrumentId) as ValRow[];
  const latest = new Map<string, ValRow>();
  for (const row of rows) latest.set(row.metric_key, row);
  return [...latest.values()].map((row) => ({
    instrumentId: row.instrument_id,
    metricKey: row.metric_key,
    value: row.value,
    asOfDate: row.as_of_date,
    provider: row.provider,
    quality: row.quality as DataQuality,
  }));
}
