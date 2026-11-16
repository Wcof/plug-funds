import type { DataQuality, EffectivePrice, MarketPoint, PriceType } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import { shanghaiParts } from '../../../core/src/calendar.ts';
import { createHash } from 'node:crypto';
import { getIndexReference } from './index-reference.ts';
import { indexMetricApplicability } from '../market/index-profile.ts';

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
  through?: string,
): MarketPoint | null {
  if (priceTypes.length === 0) return null;
  const placeholders = priceTypes.map(() => '?').join(',');
  const clauses = `instrument_id = ? AND price_type IN (${placeholders})${through ? ' AND trading_date <= ?' : ''}`;
  const args = [instrumentId, ...priceTypes, ...(through ? [through] : [])];
  const rows = handle.db
    .prepare(`SELECT * FROM market_data WHERE ${clauses}
              AND trading_date = (SELECT MAX(trading_date) FROM market_data WHERE ${clauses})`)
    .all(...args, ...args) as MarketRow[];
  if (rows.length === 0) return null;
  const points = rows.map(toPoint).sort(compareSources);
  return preserveConflict(points[0], points);
}

/** 默认主源与刷新注册表一致；未知源按名称稳定排序，不能由抓取先后决定计价。 */
function compareSources(a: MarketPoint, b: MarketPoint): number {
  const rank = (provider: string): number => provider === 'tencent' ? 0 : provider === 'eastmoney' ? 1 : 2;
  return rank(a.provider) - rank(b.provider)
    || a.provider.localeCompare(b.provider)
    || b.observedAt.localeCompare(a.observedAt)
    || a.priceType.localeCompare(b.priceType);
}

function preserveConflict(selected: MarketPoint, candidates: MarketPoint[]): MarketPoint {
  return candidates.some((point) => point.priceType === selected.priceType && point.quality === 'CONFLICT')
    ? { ...selected, quality: 'CONFLICT' }
    : selected;
}

function ageQuality(point: MarketPoint, fallback: DataQuality): DataQuality {
  return point.quality === 'CONFLICT' || point.quality === 'MISSING' ? point.quality : fallback;
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
  const manual = latestPoint(handle, instrument.id, ['MANUAL_PRICE'], today);
  if (manual) {
    return { value: manual.value, priceType: manual.priceType, quality: 'MANUAL', tradingDate: manual.tradingDate, observedAt: manual.observedAt };
  }
  if (instrument.type === 'OPEN_END_FUND') {
    const nav = latestPoint(handle, instrument.id, ['OFFICIAL_NAV'], today);
    if (nav) {
      return {
        value: nav.value,
        priceType: nav.priceType,
        quality: ageQuality(nav, nav.tradingDate === today ? 'FRESH' : 'DELAYED'),
        tradingDate: nav.tradingDate,
        observedAt: nav.observedAt,
      };
    }
    return null;
  }
  const realtime = latestPoint(handle, instrument.id, ['REALTIME_PRICE'], today);
  if (realtime && realtime.tradingDate === today) {
    return { value: realtime.value, priceType: realtime.priceType, quality: ageQuality(realtime, 'FRESH'), tradingDate: realtime.tradingDate, observedAt: realtime.observedAt };
  }
  const close = latestPoint(handle, instrument.id, ['CLOSE_PRICE'], today);
  if (close) {
    return {
      value: close.value,
      priceType: close.priceType,
      quality: ageQuality(close, close.tradingDate === today ? 'FRESH' : 'DELAYED'),
      tradingDate: close.tradingDate,
      observedAt: close.observedAt,
    };
  }
  return realtime ? { value: realtime.value, priceType: realtime.priceType, quality: ageQuality(realtime, 'STALE'), tradingDate: realtime.tradingDate, observedAt: realtime.observedAt } : null;
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

const VAL_UPSERT = `INSERT INTO valuation_metrics (instrument_id, metric_key, value, as_of_date, provider, quality)
                    VALUES (?,?,?,?,?,?)
                    ON CONFLICT (instrument_id, metric_key, as_of_date) DO UPDATE SET
                      value = excluded.value, provider = excluded.provider, quality = excluded.quality`;

export function saveValuationMetric(handle: DbHandle, row: Omit<ValuationMetricRow, 'instrumentId'> & { instrumentId: string }): void {
  handle.db.prepare(VAL_UPSERT).run(row.instrumentId, row.metricKey, row.value, row.asOfDate, row.provider, row.quality);
}

/** 首次接入官方滚动 PE 时隔离旧报价序列，不能把不同口径混入同一历史分位。 */
export function archiveIndexQuoteMetric(handle: DbHandle, instrumentId: string, key: 'pe' | 'pb'): void {
  handle.db.exec('SAVEPOINT archive_index_quote_pe;');
  try {
    const incoming = handle.db.prepare("SELECT * FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND provider NOT IN ('csindex', 'cnindex', 'csindex-factsheet')").all(instrumentId, key) as ValRow[];
    const quoteCollisions = incoming.flatMap((row) => {
      const existing = handle.db.prepare("SELECT * FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND as_of_date = ?").get(instrumentId, `${key}_quote`, row.as_of_date) as ValRow | undefined;
      return existing && (existing.value !== row.value || existing.provider !== row.provider || existing.quality !== row.quality)
        ? [{ asOfDate: row.as_of_date, existing, incoming: row }] : [];
    });
    const migratedDates = new Set(incoming.map((row) => row.as_of_date));
    const removedDerivedPercentiles = (handle.db.prepare(`SELECT * FROM valuation_metrics
      WHERE instrument_id = ? AND metric_key = ? AND provider = 'derived'`).all(instrumentId, `${key}_percentile`) as ValRow[])
      .filter((row) => migratedDates.has(row.as_of_date) || !handle.db.prepare(`SELECT 1 FROM valuation_metrics
        WHERE instrument_id = ? AND metric_key = ? AND as_of_date = ? AND provider IN ('csindex', 'cnindex', 'csindex-factsheet')`).get(instrumentId, key, row.as_of_date));
    if (quoteCollisions.length > 0 || removedDerivedPercentiles.length > 0) {
      const note = JSON.stringify({ kind: `index-quote-${key}-archive`, instrumentId, quoteCollisions, removedDerivedPercentiles });
      const id = `quote-archive-${createHash('sha256').update(note).digest('hex')}`;
      const now = nowIso();
      handle.db.prepare('INSERT OR IGNORE INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)')
        .run(id, now, now, 1, 1, 0, note);
    }
    handle.db.prepare(`INSERT INTO valuation_metrics (instrument_id, metric_key, value, as_of_date, provider, quality)
      SELECT instrument_id, ?, value, as_of_date, provider, quality FROM valuation_metrics
      WHERE instrument_id = ? AND metric_key = ? AND provider NOT IN ('csindex', 'cnindex', 'csindex-factsheet')
      ON CONFLICT (instrument_id, metric_key, as_of_date) DO NOTHING`).run(`${key}_quote`, instrumentId, key);
    handle.db.prepare("DELETE FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND provider NOT IN ('csindex', 'cnindex', 'csindex-factsheet')").run(instrumentId, key);
    for (const row of removedDerivedPercentiles) {
      handle.db.prepare("DELETE FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND provider = 'derived' AND as_of_date = ?")
        .run(instrumentId, `${key}_percentile`, row.as_of_date);
    }
    handle.db.exec('RELEASE archive_index_quote_pe;');
  } catch (error) {
    handle.db.exec('ROLLBACK TO archive_index_quote_pe; RELEASE archive_index_quote_pe;');
    throw error;
  }
}

export function archiveIndexQuotePe(handle: DbHandle, instrumentId: string): void {
  archiveIndexQuoteMetric(handle, instrumentId, 'pe');
}

export function officialIndexMetricProvider(handle: DbHandle, instrumentId: string, key: string, through = shanghaiParts(new Date()).date): string | null {
  const row = handle.db.prepare(`SELECT p.provider FROM valuation_metrics p JOIN instruments i ON i.id = p.instrument_id
    WHERE i.id = ? AND i.type = 'INDEX' AND p.metric_key = ? AND p.value IS NOT NULL AND p.as_of_date <= ?
    AND p.provider IN ('csindex', 'cnindex', 'csindex-factsheet')
    ORDER BY CASE p.provider WHEN 'csindex' THEN 0 WHEN 'cnindex' THEN 1 ELSE 2 END, p.as_of_date DESC LIMIT 1`).get(instrumentId, key, through) as { provider: string } | undefined;
  return row?.provider ?? null;
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
  today: string = shanghaiParts(new Date()).date,
): MarketPoint[] {
  const types: PriceType[] = instrumentType === 'OPEN_END_FUND'
    ? ['OFFICIAL_NAV', 'MANUAL_PRICE']
    : ['CLOSE_PRICE', 'REALTIME_PRICE', 'MANUAL_PRICE'];
  const priority = (point: MarketPoint): number => point.priceType === 'MANUAL_PRICE' ? 3
    : point.priceType === 'REALTIME_PRICE' ? (point.tradingDate === today ? 2 : 0) : 1;
  const byDate = new Map<string, MarketPoint[]>();
  const through = end && end < today ? end : today;
  for (const point of historyPoints(handle, instrumentId, types, begin, through)) {
    const day = byDate.get(point.tradingDate) ?? [];
    day.push(point);
    byDate.set(point.tradingDate, day);
  }
  return [...byDate.values()].map((day) => {
    day.sort((a, b) => priority(b) - priority(a) || compareSources(a, b));
    const selected = preserveConflict(day[0], day);
    // 只有历史盘中报价、没有已收盘值时保留证据，但不能继续宣称 FRESH。
    return selected.priceType === 'REALTIME_PRICE' && selected.tradingDate !== today
      ? { ...selected, quality: ageQuality(selected, 'STALE') }
      : selected;
  }).sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
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
  until?: string,
): { asOfDate: string; value: number }[] {
  const clauses = ['instrument_id = ?', 'metric_key = ?', 'value IS NOT NULL'];
  const args: (string | number)[] = [instrumentId, metricKey];
  if (since) { clauses.push('as_of_date >= ?'); args.push(since); }
  if (until) { clauses.push('as_of_date <= ?'); args.push(until); }
  if (metricKey === 'pe' || metricKey === 'pb') {
    const official = officialIndexMetricProvider(handle, instrumentId, metricKey, until);
    const latest = handle.db.prepare(`SELECT provider FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ?
      AND as_of_date <= ? ORDER BY as_of_date DESC LIMIT 1`).get(instrumentId, metricKey, until ?? shanghaiParts(new Date()).date) as { provider: string } | undefined;
    if (official || latest) { clauses.push('provider = ?'); args.push(official ?? latest!.provider); }
  }
  const rows = handle.db.prepare(
    `SELECT as_of_date, value FROM valuation_metrics WHERE ${clauses.join(' AND ')} ORDER BY as_of_date ASC`,
  ).all(...args) as { as_of_date: string; value: string }[];
  return rows
    .filter((r) => r.value.trim() !== '')
    .map((r) => ({ asOfDate: r.as_of_date, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

/**
 * 某指标的最新截面日期（可按 provider 过滤）。
 *
 * 用于增量回填：判断「官方序列已到哪一天」时必须只看官方来源的行，
 * 否则报价端写了一条更新的 pe（例如今天），会把官方历史整体判成「已是最新」而永不回填。
 */
export function latestMetricDate(
  handle: DbHandle,
  instrumentId: string,
  metricKey: string,
  provider?: string,
): string | null {
  const clauses = ['instrument_id = ?', 'metric_key = ?', 'value IS NOT NULL'];
  const args: string[] = [instrumentId, metricKey];
  if (provider) {
    clauses.push('provider = ?');
    args.push(provider);
  }
  const row = handle.db
    .prepare(`SELECT MAX(as_of_date) AS latest FROM valuation_metrics WHERE ${clauses.join(' AND ')}`)
    .get(...args) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

/** 每个指标取最新截面（as_of_date 最大）。 */
export function latestValuationMetrics(handle: DbHandle, instrumentId: string, today = shanghaiParts(new Date()).date): ValuationMetricRow[] {
  const rows = handle.db
    .prepare(`SELECT instrument_id, metric_key, value, as_of_date, provider, quality
              FROM valuation_metrics WHERE instrument_id = ? AND as_of_date <= ?
              ORDER BY metric_key, as_of_date`)
    .all(instrumentId, today) as ValRow[];
  const latest = new Map<string, ValRow>();
  const officialSources = new Map(['pe', 'pb', 'pe_official_static'].map((key) => [key, officialIndexMetricProvider(handle, instrumentId, key, today)]));
  for (const row of rows) {
    const official = officialSources.get(row.metric_key);
    if (official && row.provider !== official) continue;
    latest.set(row.metric_key, row);
  }
  // 派生分位必须绑定当前基础指标的同日截面，旧报价遗留分位不能压过官方值。
  for (const key of ['pe', 'pb']) {
    const base = latest.get(key);
    const derived = rows.filter((row) => row.metric_key === `${key}_percentile`
      && (row.provider !== 'derived' || (base && row.as_of_date === base.as_of_date))).at(-1);
    if (derived) latest.set(`${key}_percentile`, derived);
    else latest.delete(`${key}_percentile`);
  }
  return [...latest.values()].map((row) => ({
    instrumentId: row.instrument_id,
    metricKey: row.metric_key,
    value: row.value,
    asOfDate: row.as_of_date,
    provider: row.provider,
    quality: row.quality as DataQuality,
  }));
}

/** 分析入口排除已证实不适用的股票估值；原始读取与备份仍保留全部观测。 */
export function analysisValuationMetrics(handle: DbHandle, instrumentId: string, today = shanghaiParts(new Date()).date): ValuationMetricRow[] {
  const profile = getIndexReference(handle, instrumentId)?.profile;
  return latestValuationMetrics(handle, instrumentId, today).filter((row) => !indexMetricApplicability(profile, row.metricKey));
}
