/**
 * 行情刷新服务（PRD §4.5 / §5.2）：Provider Adapter 拉取 → 幂等落库 → 失败显式。
 *
 * 多源策略（本轮升级）：
 * - 对同一标的所有可用 Provider 依次尝试：报价取第一个成功的为主源，历史取第一个有数据的，
 *   估值指标按 metricKey 先到先得（腾讯在前，东财补细节），任一源失败不影响其它源；
 * - 主源与其它源同日同类型报价差异超阈值时，主源质量标记 CONFLICT 并在结果里返回明细，
 *   不擅自「选一个当正确答案」；
 * - 指数（INDEX）也参与刷新（此前被排除，导致指数页永远没有数据）。
 */
import { percentile } from '../../../core/src/valuation.ts';
import { replayPositions } from '../../../core/src/ledger.ts';
import { formatFixed, SCALE_AMOUNT } from '../../../core/src/money.ts';
import type { DataQuality, MarketPoint } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { allTransactions } from '../repo/transactions.ts';
import { listInstruments } from '../repo/instruments.ts';
import { metricHistory, saveMarketPoints, saveValuationMetric } from '../repo/market.ts';
import { detectConflict, type QuoteCandidate } from '../market/conflict.ts';
import { listHoldings } from './holdings.ts';
import { newId, nowIso, todayLocal } from '../ids.ts';

/** 经验分位的最小样本数；不足则不产生分位（UI 显示「样本不足」）。 */
const MIN_PERCENTILE_SAMPLES = 20;

export interface RefreshConflict {
  primary: string;
  secondary: string;
  diffPct: number;
  tradingDate: string;
}

export interface RefreshItemResult {
  instrumentId: string;
  code: string;
  name: string;
  ok: boolean;
  /** 主源（报价优先，其次历史 / 指标）。 */
  provider: string | null;
  /** 实际参与的源（含兜底成功的）。 */
  providers: string[];
  quotes: number;
  history: number;
  metrics: number;
  error: string | null;
  conflict: RefreshConflict | null;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function messageOf(error: unknown): string {
  return String((error as Error).message ?? error).slice(0, 200);
}

export async function refreshMarketData(
  ctx: ServiceContext,
  filter: { instrumentIds?: string[] } = {},
): Promise<{ results: RefreshItemResult[]; startedAt: string; snapshots: { portfolio: boolean; holdings: number } }> {
  const startedAt = new Date().toISOString();
  const today = todayLocal();
  const instruments = listInstruments(ctx.handle, { active: true }).filter(
    (i) => !filter.instrumentIds || filter.instrumentIds.includes(i.id),
  );
  const results: RefreshItemResult[] = [];

  for (const instrument of instruments) {
    const providers = ctx.registry.resolveAll(instrument);
    const item: RefreshItemResult = {
      instrumentId: instrument.id, code: instrument.code, name: instrument.name,
      ok: false, provider: null, providers: providers.map((p) => p.id),
      quotes: 0, history: 0, metrics: 0, error: null, conflict: null,
    };
    if (providers.length === 0) {
      item.error = '无可用数据源适配器（可手工录入价格）';
      results.push(item);
      continue;
    }

    const candidates: QuoteCandidate[] = [];
    const quotes: { quote: MarketPoint; provider: string }[] = [];
    const notes: string[] = [];
    const writtenMetricKeys = new Set<string>();
    const currentMetrics = new Map<string, { value: string; asOfDate: string }>();
    let historyDone = false;
    let estimateTried = false;

    for (const provider of providers) {
      try {
        const quote = await provider.fetchQuote(instrument);
        if (quote) {
          quotes.push({ quote, provider: provider.id });
          candidates.push({
            provider: provider.id, value: quote.value,
            priceType: quote.priceType, tradingDate: quote.tradingDate,
          });
        }
      } catch (error) {
        notes.push(`${provider.id} 报价失败：${messageOf(error)}`);
      }

      if (!historyDone) {
        try {
          const history = await provider.fetchHistory(instrument, { begin: daysAgo(400), end: today });
          if (history.length > 0) {
            saveMarketPoints(ctx.handle, history);
            item.history = history.length;
            historyDone = true;
            item.provider = item.provider ?? provider.id;
          }
        } catch (error) {
          notes.push(`${provider.id} 历史失败：${messageOf(error)}`);
        }
      }

      if (provider.fetchMetrics) {
        try {
          const metrics = await provider.fetchMetrics(instrument);
          for (const metric of metrics) {
            if (writtenMetricKeys.has(metric.metricKey)) continue;
            saveValuationMetric(ctx.handle, {
              instrumentId: instrument.id,
              metricKey: metric.metricKey,
              value: metric.value,
              asOfDate: metric.asOfDate,
              provider: provider.id,
              quality: metric.quality,
            });
            writtenMetricKeys.add(metric.metricKey);
            item.metrics += 1;
            if (metric.value !== null) currentMetrics.set(metric.metricKey, { value: metric.value, asOfDate: metric.asOfDate });
          }
        } catch (error) {
          notes.push(`${provider.id} 估值失败：${messageOf(error)}`);
        }
      }

      // 盘中估算净值：只取第一个提供者，仅展示（ESTIMATED_NAV 不参与计价）
      if (!estimateTried && provider.fetchEstimate) {
        estimateTried = true;
        try {
          const estimate = await provider.fetchEstimate(instrument);
          if (estimate) saveMarketPoints(ctx.handle, [estimate]);
        } catch {
          /* 估算失败不影响正式数据 */
        }
      }

      if (!item.provider) item.provider = provider.id;
    }

    // 冲突判定：主源 vs 其它源（同日同类型才可比）
    const conflict = detectConflict(candidates);
    if (quotes.length > 0) {
      const primary = quotes[0];
      const quality: DataQuality = conflict ? 'CONFLICT' : primary.quote.quality;
      saveMarketPoints(ctx.handle, [{ ...primary.quote, quality }]);
      item.quotes = 1;
      item.provider = primary.provider;
      if (conflict) {
        item.conflict = {
          primary: conflict.primary.provider,
          secondary: conflict.secondary.provider,
          diffPct: Math.round(conflict.diffPct * 10000) / 10000,
          tradingDate: conflict.tradingDate,
        };
        notes.push(
          `多源分歧 ${(conflict.diffPct * 100).toFixed(2)}%：${conflict.primary.provider}=${conflict.primary.value} vs ${conflict.secondary.provider}=${conflict.secondary.value}`,
        );
      }
    }

    // PE / PB 历史分位：由已落库的历史截面积累自动计算（样本不足不写，不伪造）
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCFullYear(since.getUTCFullYear() - 3);
    const sinceDate = since.toISOString().slice(0, 10);
    for (const key of ['pe', 'pb'] as const) {
      const current = currentMetrics.get(key);
      if (!current) continue;
      const history = metricHistory(ctx.handle, instrument.id, key, sinceDate).map((h) => h.value);
      if (history.length < MIN_PERCENTILE_SAMPLES) continue;
      const pct = percentile(history, Number(current.value));
      if (pct === null) continue;
      saveValuationMetric(ctx.handle, {
        instrumentId: instrument.id,
        metricKey: `${key}_percentile`,
        value: (Math.round(pct * 100) / 100).toFixed(2),
        asOfDate: current.asOfDate,
        provider: 'derived',
        quality: 'FRESH',
      });
    }

    item.ok = item.quotes > 0 || item.history > 0 || item.metrics > 0;
    if (!item.ok) {
      item.error = notes.length > 0 ? notes.join('；').slice(0, 300) : '数据源未返回有效数据';
    } else if (notes.length > 0) {
      item.error = notes.join('；').slice(0, 300);
    }
    results.push(item);
  }

  const snapshots = saveDailySnapshots(ctx, today);
  recordRun(ctx, startedAt, results);
  return { results, startedAt, snapshots };
}

/** 每日组合 / 持仓快照（PRD §7.1）：同日重复刷新覆盖，不产生重复行。 */
function saveDailySnapshots(ctx: ServiceContext, date: string): { portfolio: boolean; holdings: number } {
  const holdings = listHoldings(ctx);
  const priced = holdings.rows.filter((r) => r.marketValue !== null).length;
  const coverage = holdings.rows.length > 0 ? priced / holdings.rows.length : 0;
  let realized = 0;
  let dividends = 0;
  for (const pos of replayPositions(allTransactions(ctx.handle)).values()) {
    realized += pos.realizedRaw;
    dividends += pos.dividendsRaw;
  }
  const db = ctx.handle.db;
  db.exec('BEGIN;');
  try {
    db.prepare(`INSERT INTO portfolio_snapshots
      (id,snapshot_date,total_market_value,total_cost,realized,dividends,positions,coverage,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date) DO UPDATE SET
        total_market_value=excluded.total_market_value, total_cost=excluded.total_cost,
        realized=excluded.realized, dividends=excluded.dividends,
        positions=excluded.positions, coverage=excluded.coverage, created_at=excluded.created_at`)
      .run(newId(), date, holdings.totalMarketValue, holdings.totalCost,
        formatFixed(realized, SCALE_AMOUNT), formatFixed(dividends, SCALE_AMOUNT),
        holdings.rows.length, coverage, nowIso());
    const stmt = db.prepare(`INSERT INTO holding_snapshots
      (id,snapshot_date,account_id,instrument_id,qty,cost_total,market_value,price,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date,account_id,instrument_id) DO UPDATE SET
        qty=excluded.qty, cost_total=excluded.cost_total,
        market_value=excluded.market_value, price=excluded.price, created_at=excluded.created_at`);
    for (const row of holdings.rows) {
      stmt.run(newId(), date, row.accountId, row.instrumentId, row.qty, row.costTotal, row.marketValue, row.price, nowIso());
    }
    db.exec('COMMIT;');
    return { portfolio: true, holdings: holdings.rows.length };
  } catch {
    db.exec('ROLLBACK;');
    return { portfolio: false, holdings: 0 };
  }
}

function recordRun(ctx: ServiceContext, startedAt: string, results: RefreshItemResult[]): void {
  const ok = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => r.conflict !== null).length;
  try {
    ctx.handle.db.prepare(
      'INSERT INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)',
    ).run(
      newId(), startedAt, nowIso(), results.length, ok, results.length - ok,
      conflicts > 0 ? `refresh_market_data | conflicts:${conflicts}` : 'refresh_market_data',
    );
  } catch {
    /* 运行日志不影响刷新结果 */
  }
}
