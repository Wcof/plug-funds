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
import { archiveIndexQuotePe, latestMetricDate, metricHistory, officialIndexMetricProvider, saveMarketPoints, saveValuationMetric } from '../repo/market.ts';
import { createCnindexProvider, type CnindexMetric } from '../market/cnindex.ts';
import { saveCnindexMetrics } from './cnindex-valuation.ts';
import { hasIndexYearEndBase, indexYearEndRange, saveIndexHistory } from './index-history.ts';
import { CSINDEX_IDENTITIES } from '../market/index-identities.ts';
import { detectConflict, type QuoteCandidate } from '../market/conflict.ts';
import { fetchCsindexIndicator, snapshotToMetrics, type CsindexMetric } from '../market/csindex.ts';
import {
  CSINDEX_SNAPSHOT_CODES,
  fetchPeTtmHistory,
  fetchValuationSnapshot,
  snapshotToMetrics as snapshotToOfficialMetrics,
} from '../market/csindex-valuation.ts';
import { getCsindexCoveredCodes, rememberCsindexCovered } from '../market/csindex-coverage.ts';
import { listHoldings } from './holdings.ts';
import { getTradingCalendarInfo } from './calendar.ts';
import { newId, nowIso, todayLocal } from '../ids.ts';

/** 经验分位的最小样本数；不足则不产生分位（UI 显示「样本不足」）。 */
const MIN_PERCENTILE_SAMPLES = 20;
/**
 * 分位的最小时间跨度（天）。
 * 只有样本数够但跨度太短时（例如刚从中证官网导入 20 个交易日），算出来的是「近 1 月分位」，
 * 用它去套「近 3 年分位」的阈值会产生看似确定、实则无意义的结论 —— 宁可不写。
 */
const MIN_PERCENTILE_SPAN_DAYS = 180;

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

function daysAgo(days: number, today: string): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function messageOf(error: unknown): string {
  return String((error as Error).message ?? error).slice(0, 200);
}

/**
 * 过滤掉「当日未收盘」的 CLOSE_PRICE。
 *
 * 盘中（含午休）K 线最后一根是当日未完成 bar，写进历史会被当成收盘价。
 * 收盘后（`closeSettled`）原样返回，不做任何取舍。
 */
export function dropUnsettledClose(points: MarketPoint[], today: string, closeSettled: boolean): MarketPoint[] {
  if (closeSettled) return points;
  return points.filter((point) => !(point.tradingDate === today && point.priceType === 'CLOSE_PRICE'));
}

export async function refreshMarketData(
  ctx: ServiceContext,
  filter: { instrumentIds?: string[] } = {},
): Promise<{ results: RefreshItemResult[]; startedAt: string; snapshots: { portfolio: boolean; holdings: number } }> {
  const startedAt = new Date().toISOString();
  const today = ctx.today;
  const instruments = listInstruments(ctx.handle, { active: true }).filter(
    (i) => !filter.instrumentIds || filter.instrumentIds.includes(i.id),
  );
  const results: RefreshItemResult[] = [];
  const cnindex = createCnindexProvider(today);

  /**
   * 中证官方估值快照一轮只拉一次。
   * 快照接口返回的是固定 8 只仪表盘指数的**同一份**数据，若放在标的循环里，
   * 500+ 只指数就是 500+ 次重复请求（既慢又容易被 WAF 盯上）。
   */
  let officialSnapshot: Awaited<ReturnType<typeof fetchValuationSnapshot>> | null = null;
  let officialSnapshotError: string | null = null;
  let snapshotErrorNoted = false;
  const getOfficialSnapshot = async (): Promise<Awaited<ReturnType<typeof fetchValuationSnapshot>>> => {
    if (officialSnapshot !== null) return officialSnapshot;
    try {
      officialSnapshot = await fetchValuationSnapshot();
    } catch (error) {
      officialSnapshot = [];
      officialSnapshotError = messageOf(error);
    }
    return officialSnapshot;
  };

  /**
   * 中证官网的覆盖范围 = 000 前缀（中证 / 上证系列）+ 已验证有数据的深市代码。
   * 399 里混着中证编制的指数（中证白酒 399997 等，实测 44 个），其余是国证 / 深证自编，
   * 官网没有估值文件；逐个试探会白打 300+ 次接口，因此用持久化的覆盖清单判断。
   */
  const coveredCodes = getCsindexCoveredCodes(ctx.handle);
  const hasCsindexCoverage = (code: string): boolean => code.startsWith('000') || coveredCodes.has(code) || Boolean(CSINDEX_IDENTITIES[code]);

  /**
   * 收盘价只在**收盘之后**才允许写。
   * 盘中（含 11:30–13:00 午休）K 线的最后一根是「当日未收盘 bar」，把它当 CLOSE_PRICE 落库
   * 等于把一个时刻的盘中价冒充当日收盘价，而同一天还有一条真的 REALTIME_PRICE。
   * 判据用会话阶段而不是 `open`：午休时 open=false，但当天收盘价同样还没定。
   */
  let closeSettled = false;
  try {
    const phase = getTradingCalendarInfo(ctx).session.phase;
    closeSettled = today < todayLocal() || (today === todayLocal() && (phase === 'after' || phase === 'closed-day'));
  } catch {
    closeSettled = false;
  }

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
    /** 本轮或历史库里已有中证官方滚动 PE：只有这时才拒绝报价端的 pe。 */
    let officialPe = false;

    // 指数：优先取中证指数官网的官方估值（PE1/PE2 + 股息率1/2，20 个交易日截面）。
    // 注意官方 PE 落的是 `pe_official`，不覆盖报价端的 `pe`（口径差 2%–19%，混用会让分位跳变）；
    // XLS 股息率1/2分别留档，JSON主值不能被计算用股本口径提前占位。
    if (instrument.type === 'INDEX') {
      const csindexCovered = hasCsindexCoverage(instrument.code);
      let xlsDividendHistory: CsindexMetric[] = [];
      let matchedJsonSnapshot = false;
      try {
        const snapshots = csindexCovered ? await fetchCsindexIndicator(instrument) : [];
        if (snapshots.length > 0) {
          const { latest, history } = snapshotToMetrics(instrument.id, snapshots);
          xlsDividendHistory = history.filter((row) => row.metricKey === 'dividend_yield_calc_share');
          for (const row of history) {
            saveValuationMetric(ctx.handle, {
              instrumentId: instrument.id, metricKey: row.metricKey, value: row.value,
              asOfDate: row.asOfDate, provider: 'csindex', quality: row.quality,
            });
          }
          for (const metric of latest) {
            writtenMetricKeys.add(metric.metricKey);
            item.metrics += 1;
            if (metric.value !== null) currentMetrics.set(metric.metricKey, { value: metric.value, asOfDate: metric.asOfDate });
          }
          item.provider = item.provider ?? 'csindex';
          item.providers = [...new Set([...item.providers, 'csindex'])];
        }
      } catch (error) {
        notes.push(`中证官方估值(xls)失败：${messageOf(error)}`);
      }

      // 逐日滚动 PE 历史：必须先于快照写入。
      // 快照会先落一条「最新日」的 pe，若之后才判增量，`lastDate` 就等于最新日，
      // 历史点全部 <= lastDate 而被判成「已是最新」，首次接入会只写 1 条。
      try {
        const lastDate = latestMetricDate(ctx.handle, instrument.id, 'pe', 'csindex');
        const points = (csindexCovered ? await fetchPeTtmHistory(instrument.code) : []).filter((point) => point.tradeDate <= today);
        if (points.length > 0) archiveIndexQuotePe(ctx.handle, instrument.id);
        // 首次接入只补最近 60 个交易日；完整历史由 scripts/backfill-metrics.mjs 显式回填，
        // 避免每次自动刷新都把十几年数据重写一遍。
        const fresh = lastDate === null
          ? points.slice(-60)
          : points.filter((point) => point.tradeDate > lastDate);
        for (const point of fresh) {
          saveValuationMetric(ctx.handle, {
            instrumentId: instrument.id, metricKey: 'pe', value: String(point.peTtm),
            asOfDate: point.tradeDate, provider: 'csindex', quality: 'FRESH',
          });
        }
        if (points.length > 0) {
          const latest = points[points.length - 1];
          officialPe = true;
          if (!coveredCodes.has(instrument.code)) {
            coveredCodes.add(instrument.code);
            rememberCsindexCovered(ctx.handle, instrument.code);
          }
          // 快照未覆盖的指数（科创50 / 中证1000）也要有 current，分位才算得出来
          if (!currentMetrics.has('pe')) currentMetrics.set('pe', { value: String(latest.peTtm), asOfDate: latest.tradeDate });
          item.provider = item.provider ?? 'csindex';
          item.providers = [...new Set([...item.providers, 'csindex'])];
        }
      } catch (error) {
        notes.push(`中证官方 PE 历史失败：${messageOf(error)}`);
      }

      // 指数：中证官网 JSON 官方估值（与上面的 xls 互补）。
      // xls 有 PE1/PE2/股息率但没有 PB，且该 OSS 有 WAF 会整段拦截；
      // JSON 给 PB + 静态 PE + 滚动 PE，另有逐日滚动 PE 全量历史（沪深300 可回溯到 2011 年）。
      try {
        const valuation = csindexCovered ? await getOfficialSnapshot() : [];
        const matched = valuation.find((row) => row.indexName === instrument.name && row.tradeDate <= today);
        if (matched) {
          matchedJsonSnapshot = true;
          if (snapshotToOfficialMetrics(matched).some((metric) => metric.metricKey === 'pe')) archiveIndexQuotePe(ctx.handle, instrument.id);
          for (const metric of snapshotToOfficialMetrics(matched)) {
            if (writtenMetricKeys.has(metric.metricKey)) continue;
            saveValuationMetric(ctx.handle, {
              instrumentId: instrument.id, metricKey: metric.metricKey, value: metric.value,
              asOfDate: metric.asOfDate, provider: 'csindex', quality: metric.quality,
            });
            writtenMetricKeys.add(metric.metricKey);
            item.metrics += 1;
            if (metric.metricKey === 'pe') officialPe = true;
            currentMetrics.set(metric.metricKey, { value: metric.value, asOfDate: metric.asOfDate });
          }
          item.provider = item.provider ?? 'csindex';
          item.providers = [...new Set([...item.providers, 'csindex'])];
        }
      } catch (error) {
        notes.push(`中证官方估值(JSON)失败：${messageOf(error)}`);
      }
      // 已知 JSON 覆盖或曾有 JSON 静态 PE 的标的，失败时保持原口径，不用 XLS 覆盖。
      // 其余标的使用 XLS 兜底时在 provider 明确标出计算用股本口径。
      const hasJsonSnapshot = matchedJsonSnapshot || CSINDEX_SNAPSHOT_CODES.has(instrument.code)
        || latestMetricDate(ctx.handle, instrument.id, 'pe_official_static', 'csindex') !== null;
      if (!hasJsonSnapshot && xlsDividendHistory.length > 0) {
        for (const metric of xlsDividendHistory) {
          saveValuationMetric(ctx.handle, { instrumentId: instrument.id, metricKey: 'dividend_yield',
            value: metric.value, asOfDate: metric.asOfDate, provider: 'csindex-xls-calc-share', quality: metric.quality });
        }
        const latestDividend = xlsDividendHistory.reduce((latest, metric) => metric.asOfDate > latest.asOfDate ? metric : latest);
        writtenMetricKeys.add('dividend_yield');
        item.metrics += 1;
        if (latestDividend.value !== null) currentMetrics.set('dividend_yield', { value: latestDividend.value, asOfDate: latestDividend.asOfDate });
      }
      if (csindexCovered && officialSnapshotError && !snapshotErrorNoted) {
        snapshotErrorNoted = true;
        notes.push(`中证官方估值快照不可用：${officialSnapshotError}`);
      }
    }

    // 国证自编目录补充官方滚动 PE / PB；已有中证主序列时不拼接来源。
    // 未取得官方值的指标仍保留报价端值，并在展示层标注口径待核实。
    if (cnindex.supports(instrument)) {
      try {
        const metrics = await cnindex.fetchMetrics!(instrument) as CnindexMetric[];
        const accepted = saveCnindexMetrics(ctx.handle, instrument.id, metrics);
        for (const metric of accepted) {
          writtenMetricKeys.add(metric.metricKey);
          currentMetrics.set(metric.metricKey, { value: metric.value, asOfDate: metric.asOfDate });
        }
        if (accepted.length) {
          item.metrics += accepted.length;
          item.providers.push('cnindex');
          item.provider ??= 'cnindex';
        }
      } catch (error) { notes.push(`国证官方估值失败：${messageOf(error)}`); }
    }
    const hasOfficialPe = officialPe || officialIndexMetricProvider(ctx.handle, instrument.id, 'pe', today) !== null;
    const hasOfficialPb = officialIndexMetricProvider(ctx.handle, instrument.id, 'pb', today) !== null;
    if (instrument.type === 'INDEX' && hasOfficialPe) archiveIndexQuotePe(ctx.handle, instrument.id);

    for (const provider of providers) {
      try {
        const quote = await provider.fetchQuote(instrument);
        if (quote && quote.tradingDate <= today && dropUnsettledClose([quote], today, closeSettled).length > 0) {
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
          const history = await provider.fetchHistory(instrument, { begin: daysAgo(400, today), end: today });
          const usable = dropUnsettledClose(history.filter((point) => point.tradingDate <= today), today, closeSettled);
          if (usable.length > 0) {
            if (instrument.type === 'INDEX') {
              const saved = saveIndexHistory(ctx.handle, instrument.id, usable);
              const conflicts = saved.comparisons.filter((row) => row.conflict);
              if (conflicts.length) notes.push(`${provider.id} 历史收盘 ${conflicts.length} 项同日多源差异超过 1%，保留双方并标记冲突`);
            } else saveMarketPoints(ctx.handle, usable);
            item.history += usable.length;
            // 短历史不能阻止后续官方源补齐上年末基准；已有合格基准时不重复请求。
            historyDone = instrument.type !== 'INDEX' || hasIndexYearEndBase(ctx.handle, instrument.id, today);
            if (!historyDone && provider.id !== 'official-index-history') {
              // 部分报价端长区间被条数上限截断；单独请求年末窗口，避免把“有部分历史”当成完整。
              const baseRange = indexYearEndRange(today);
              const base = (await provider.fetchHistory(instrument, baseRange))
                .filter((p) => p.tradingDate >= baseRange.begin && p.tradingDate <= baseRange.end && p.priceType === 'CLOSE_PRICE');
              const saved = saveIndexHistory(ctx.handle, instrument.id, base);
              if (saved.comparisons.some((row) => row.conflict)) notes.push(`${provider.id} 年末收盘存在同日多源冲突，未用于 YTD`);
              item.history += base.length;
              historyDone = hasIndexYearEndBase(ctx.handle, instrument.id, today);
            }
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
            // 指数已有官方 PE / PB 时，报价独立留档；未证明同口径的来源不混入主序列。
            if (metric.asOfDate > today) continue;
            const officialQuote = instrument.type === 'INDEX'
              && ((metric.metricKey === 'pe' && hasOfficialPe) || (metric.metricKey === 'pb' && hasOfficialPb));
            const metricKey = officialQuote ? `${metric.metricKey}_quote` : metric.metricKey;
            if (writtenMetricKeys.has(metricKey)) continue;
            saveValuationMetric(ctx.handle, {
              instrumentId: instrument.id,
              metricKey,
              value: metric.value,
              asOfDate: metric.asOfDate,
              provider: provider.id,
              quality: metric.quality,
            });
            writtenMetricKeys.add(metricKey);
            item.metrics += 1;
            if (metric.value !== null) currentMetrics.set(metricKey, { value: metric.value, asOfDate: metric.asOfDate });
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
      saveMarketPoints(ctx.handle, quotes.map(({ quote }) => ({ ...quote, quality: conflict
        && quote.tradingDate === conflict.tradingDate && quote.priceType === primary.quote.priceType
        ? 'CONFLICT' as DataQuality : quote.quality })));
      item.quotes = quotes.length;
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
    for (const key of ['pe', 'pb'] as const) {
      const current = currentMetrics.get(key);
      if (!current) continue;
      const ageDays = (Date.parse(today) - Date.parse(current.asOfDate)) / 86_400_000;
      if (ageDays < 0 || ageDays > 7) continue;
      // 与官方回填一致：窗口属于该基础指标截面，不能随刷新日期漂移。
      const since = new Date(`${current.asOfDate}T00:00:00Z`);
      since.setUTCFullYear(since.getUTCFullYear() - 3);
      const sinceDate = since.toISOString().slice(0, 10);
      const series = metricHistory(ctx.handle, instrument.id, key, sinceDate, current.asOfDate);
      if (series.length < MIN_PERCENTILE_SAMPLES) continue;
      // 跨度守卫：样本够但只看了一个月 → 那是「近 1 月分位」，不能当近 3 年分位用
      const spanDays = (Date.parse(`${current.asOfDate}T00:00:00Z`) - Date.parse(`${series[0].asOfDate}T00:00:00Z`)) / 86_400_000;
      if (!Number.isFinite(spanDays) || spanDays < MIN_PERCENTILE_SPAN_DAYS) continue;
      const pct = percentile(series.map((h) => h.value), Number(current.value));
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
