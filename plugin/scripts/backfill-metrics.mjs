/**
 * 官方估值全量回填 / 逐项校验。默认 dry-run，只有 --apply 才写库。
 * 用法：node plugin/scripts/backfill-metrics.mjs [--apply] [--state <dir>] [--json <report.json>]
 *
 * 数据源可注入；网络请求完成后才开启每标的事务。历史先于快照，旧值先校验再写。
 * 报价 PE 与官方滚动 PE 分开留档；发生同日来源冲突时保留双方证据，不假装等价。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { SCHEMA_VERSION } from '../core/src/types.ts';
import { percentile } from '../core/src/valuation.ts';
import { resolveStateDirs } from '../server/src/db.ts';
import { todayLocal } from '../server/src/ids.ts';
import { listInstruments } from '../server/src/repo/instruments.ts';
import { saveValuationMetric } from '../server/src/repo/market.ts';
import { fetchPeTtmHistory, fetchValuationSnapshot, snapshotToMetrics } from '../server/src/market/csindex-valuation.ts';
import { rememberCsindexCovered } from '../server/src/market/csindex-coverage.ts';

const AUDIT_KIND = 'backfill-metrics-audit';
const MIN_PERCENTILE_SAMPLES = 20;
const MIN_PERCENTILE_SPAN_DAYS = 180;
const DAY_MS = 86_400_000;
const keyOf = (row) => `${row.metricKey}:${row.asOfDate}`;
const counts = () => ({ matched: 0, inserted: 0, changed: 0 });
const same = (a, b) => a && a.value === b.value && a.provider === b.provider && a.quality === b.quality;
const positive = (value) => value !== null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const invalidSource = (message) => Object.assign(new Error(message), { code: 'SOURCE_INVALID' });

function normalizeHistory(points, today) {
  if (!Array.isArray(points)) throw invalidSource('官方 PE 历史返回值不是数组');
  const byDate = new Map();
  for (const point of points) {
    if (!validDate(point?.tradeDate) || !positive(point?.peTtm)) throw invalidSource('官方 PE 历史含无效日期或非正有限数值');
    if (point.tradeDate > today) throw invalidSource(`官方 PE 历史日期在未来：${point.tradeDate} > ${today}`);
    const existing = byDate.get(point.tradeDate);
    if (existing && existing.peTtm !== Number(point.peTtm)) throw invalidSource(`官方 PE 历史同日存在多个值：${point.tradeDate}`);
    byDate.set(point.tradeDate, { tradeDate: point.tradeDate, peTtm: Number(point.peTtm) });
  }
  return [...byDate.values()].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
}

function normalizeSnapshot(rows, today) {
  if (!Array.isArray(rows)) throw invalidSource('官方估值快照返回值不是数组');
  for (const row of rows) {
    if (!validDate(row?.tradeDate) || typeof row?.indexName !== 'string' || row.indexName.trim() === '') {
      throw invalidSource('官方估值快照含无效日期或指数名称');
    }
    if (row.tradeDate > today) throw invalidSource(`官方估值快照日期在未来：${row.tradeDate} > ${today}`);
    for (const metric of snapshotToMetrics(row)) {
      const value = Number(metric.value);
      if (!Number.isFinite(value) || (metric.metricKey === 'dividend_yield' ? value < 0 : value <= 0)) {
        throw invalidSource(`官方估值快照含无效 ${metric.metricKey}`);
      }
    }
  }
  return rows;
}

function auditMetrics(before, desired, targetCounts, changes, phase) {
  for (const metric of desired) {
    const prior = before.get(keyOf(metric)) ?? null;
    const kind = !prior ? 'inserted' : same(prior, metric) ? 'matched' : 'changed';
    targetCounts[kind] += 1;
    if (kind !== 'matched') changes.push({ phase, kind, metricKey: metric.metricKey, asOfDate: metric.asOfDate, before: prior, after: metric });
  }
}

function saveAudit(handle, instrument, row) {
  const payload = {
    kind: AUDIT_KIND, instrumentId: instrument.id, code: instrument.code,
    quoteCollisions: row.quoteCollisions, removedPercentiles: row.removedPercentiles,
    // 新增历史可由数据源重建；所有覆盖原值与删除原值必须留档。
    changes: row.changes.filter((change) => change.before !== null),
    sourceConflicts: row.checks.filter((check) => check.code === 'OFFICIAL_SOURCE_CONFLICT'),
  };
  if (!payload.quoteCollisions.length && !payload.removedPercentiles.length && !payload.changes.length && !payload.sourceConflicts.length) return;
  const note = JSON.stringify(payload);
  const id = `backfill-${createHash('sha256').update(note).digest('hex')}`;
  const now = new Date().toISOString();
  handle.db.prepare(`INSERT OR IGNORE INTO data_source_runs
    (id, started_at, finished_at, instruments, ok, failed, note) VALUES (?, ?, ?, 1, 1, 0, ?)`)
    .run(id, now, now, note);
  row.auditId = id;
}

/**
 * 返回全部逐标的审计结果，不输出、不关闭 handle。
 * fetchSnapshot() -> CsindexValuationSnapshot[]；fetchHistory(code) -> CsindexPePoint[]。
 * dry-run 只构造内存中的结果投影，对调用者传入的数据库也不进行任何写入。
 */
export async function backfillMetrics({
  handle,
  apply = false,
  fetchSnapshot = fetchValuationSnapshot,
  fetchHistory = fetchPeTtmHistory,
  onInstrument = null,
  today = todayLocal(),
} = {}) {
  if (!handle?.db) throw new TypeError('backfillMetrics 需要 DbHandle');
  if (!validDate(today)) throw new TypeError('today 必须是有效的 YYYY-MM-DD 日期');
  const instruments = listInstruments(handle, { type: 'INDEX', active: true });
  const report = { generatedAt: new Date().toISOString(), today, apply, instruments: [] };
  let snapshot = [];
  let snapshotError = null;
  let snapshotErrorCode = null;
  try {
    snapshot = normalizeSnapshot(await fetchSnapshot(), today);
  } catch (error) { snapshot = []; snapshotError = String(error?.message ?? error); snapshotErrorCode = error?.code === 'SOURCE_INVALID' ? 'SOURCE_INVALID' : 'NETWORK_UNAVAILABLE'; }
  report.snapshot = { status: snapshotError ? 'FETCH_FAILED' : snapshot.length ? 'AVAILABLE' : 'NO_DATA', rows: snapshot.length, error: snapshotError };

  for (const instrument of instruments) {
    const row = {
      code: instrument.code, name: instrument.name,
      snapshotKeys: [], snapshotDate: null, historyRows: 0, historyFrom: null, historyTo: null,
      sourceStatus: { snapshot: 'NO_DATA', history: 'NO_DATA' },
      counts: counts(), historyCounts: counts(), snapshotCounts: counts(),
      changes: [], sourceChanges: [], quoteMigrations: [], quoteCollisions: [], removedPercentiles: [],
      written: 0, checks: [], notes: [],
    };
    const matched = snapshot.find((item) => item.indexName === instrument.name);
    row.sourceStatus.snapshot = snapshotError ? 'FETCH_FAILED' : matched ? 'AVAILABLE' : 'NO_DATA';
    if (snapshotError) {
      row.checks.push({ code: snapshotErrorCode, metric: 'snapshot', verdict: 'UNVERIFIED', detail: snapshotError });
      row.notes.push('官方快照抓取失败，不能据此判断数据源未覆盖');
    } else if (!matched) row.notes.push('官方快照本次没有该指数，PB / 股息率 / 静态 PE 保留原状态');
    const snapshotMetrics = matched ? snapshotToMetrics(matched).map((metric) => ({ ...metric, provider: 'csindex' })) : [];
    row.snapshotKeys = snapshotMetrics.map((metric) => `${metric.metricKey}=${metric.value}`);
    row.snapshotDate = matched?.tradeDate ?? null;
    let points = [];
    let historyError = null;
    let historyErrorCode = null;
    try { points = normalizeHistory(await fetchHistory(instrument.code), today); }
    catch (error) { historyError = String(error?.message ?? error); historyErrorCode = error?.code === 'SOURCE_INVALID' ? 'SOURCE_INVALID' : 'NETWORK_UNAVAILABLE'; }
    row.sourceStatus.history = historyError ? 'FETCH_FAILED' : points.length ? 'AVAILABLE' : 'NO_DATA';
    if (historyError) {
      row.checks.push({ code: historyErrorCode, metric: 'pe', verdict: 'UNVERIFIED', detail: historyError });
      row.notes.push('PE 历史抓取失败，保留已有历史；未把网络失败判成数据源未覆盖');
    } else if (!points.length) {
      row.checks.push({ code: 'UNSUPPORTED', metric: 'pe', verdict: 'NO_DATA', detail: '本次官方历史接口未返回数据，不推断其他来源不可用' });
    } else {
      row.historyRows = points.length;
      row.historyFrom = points[0].tradeDate;
      row.historyTo = points.at(-1).tradeDate;
    }

    // 以下步骤不再含网络 IO；事务中重读现状，防止后台刷新改变审计前值。
    if (apply) handle.db.exec('BEGIN IMMEDIATE;');
    try {
      const stored = handle.db.prepare(`SELECT metric_key AS metricKey, as_of_date AS asOfDate, value, provider, quality
        FROM valuation_metrics WHERE instrument_id = ? ORDER BY metric_key, as_of_date`).all(instrument.id);
      const before = new Map(stored.map((metric) => [keyOf(metric), { ...metric }]));
      const working = new Map(before);
      const desired = new Map();
      const deleted = new Map();
      const put = (metric) => { const value = { ...metric }; working.set(keyOf(value), value); desired.set(keyOf(value), value); deleted.delete(keyOf(value)); };
      const remove = (metric) => { working.delete(keyOf(metric)); desired.delete(keyOf(metric)); deleted.set(keyOf(metric), metric); };
      const historyMetrics = points.map((point) => ({ metricKey: 'pe', asOfDate: point.tradeDate, value: String(point.peTtm), provider: 'csindex', quality: 'FRESH' }));
      auditMetrics(before, historyMetrics, row.historyCounts, row.sourceChanges, 'history');
      auditMetrics(before, snapshotMetrics, row.snapshotCounts, row.sourceChanges, 'snapshot');
      const officialAvailable = historyMetrics.length > 0 || snapshotMetrics.some((metric) => metric.metricKey === 'pe');
      const quotes = stored.filter((metric) => metric.metricKey === 'pe' && metric.provider !== 'csindex');
      const migratedDates = new Set();
      if (officialAvailable) {
        for (const quote of quotes) {
          const archive = { ...quote, metricKey: 'pe_quote' };
          const existing = working.get(keyOf(archive));
          if (!existing) put(archive);
          else if (!same(existing, archive)) row.quoteCollisions.push({ asOfDate: quote.asOfDate, existing, incoming: quote });
          row.quoteMigrations.push({ asOfDate: quote.asOfDate, before: quote, target: existing ?? archive,
            action: !existing ? 'inserted' : same(existing, archive) ? 'matched' : 'collision_archived' });
          migratedDates.add(quote.asOfDate);
          remove(quote);
        }
      }
      // 历史先写入投影，快照随后补充。相同日期的官方端点发生矛盾时保留历史原值并标记冲突。
      for (const metric of historyMetrics) put(metric);
      const historyByDate = new Map(historyMetrics.map((metric) => [metric.asOfDate, metric]));
      for (const metric of snapshotMetrics) {
        const historyMetric = metric.metricKey === 'pe' ? historyByDate.get(metric.asOfDate) : null;
        if (historyMetric && Number(historyMetric.value) !== Number(metric.value)) {
          row.checks.push({ code: 'OFFICIAL_SOURCE_CONFLICT', metric: 'pe', asOfDate: metric.asOfDate,
            stored: historyMetric.value, official: metric.value, diff: null, verdict: 'SUSPECT',
            detail: '同日官方历史与快照不同，保留官方历史值，质量标为 CONFLICT，暂停派生分位' });
          put({ ...historyMetric, quality: 'CONFLICT' });
        } else put(metric);
      }

      const officialSeries = [...working.values()].filter((metric) => metric.metricKey === 'pe'
        && metric.provider === 'csindex' && validDate(metric.asOfDate) && metric.asOfDate <= today
        && positive(metric.value)).sort((a, b) => a.asOfDate.localeCompare(b.asOfDate));
      const officialLast = officialSeries.at(-1);
      row.latestOfficialDate = officialLast?.asOfDate ?? null;
      const latestQuote = [...stored.filter((metric) => metric.metricKey === 'pe_quote'), ...quotes]
        .sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)).at(-1);
      if (latestQuote && officialLast && positive(latestQuote.value)) {
        const sameDate = latestQuote.asOfDate === officialLast.asOfDate;
        row.checks.push({ code: sameDate ? 'DIFFERENT_METHODOLOGY' : 'NOT_COMPARABLE', metric: 'pe_quote',
          stored: latestQuote.value, storedDate: latestQuote.asOfDate, official: officialLast.value,
          officialDate: officialLast.asOfDate, diff: sameDate ? Math.abs(Number(latestQuote.value) - Number(officialLast.value)) / Number(officialLast.value) : null,
          verdict: sameDate ? '口径不同，仅留差异证据，不判定数值错误' : '日期及口径不同，不作数值一致性结论' });
      }

      // 清理只能被官方序列证明无效的派生值；数据源失败不触发报价序列迁移。
      const usesOfficial = officialSeries.length > 0;
      for (const metric of [...working.values()]) {
        if (!['pe_percentile', 'pb_percentile'].includes(metric.metricKey) || metric.provider !== 'derived') continue;
        const baseKey = metric.metricKey === 'pe_percentile' ? 'pe' : 'pb';
        const base = working.get(`${baseKey}:${metric.asOfDate}`);
        const noBase = !base || !positive(base.value) || (baseKey === 'pe' && usesOfficial && base.provider !== 'csindex');
        const contaminated = baseKey === 'pe' && migratedDates.has(metric.asOfDate);
        if (noBase || contaminated) {
          row.removedPercentiles.push({ ...metric, reason: noBase ? 'NO_SAME_DAY_BASE' : 'QUOTE_SERIES_REPLACED' });
          remove(metric);
        }
      }
      if (officialLast) {
        const since = new Date(`${officialLast.asOfDate}T00:00:00Z`);
        since.setUTCFullYear(since.getUTCFullYear() - 3);
        const sinceDate = since.toISOString().slice(0, 10);
        const series = officialSeries.filter((metric) => metric.asOfDate >= sinceDate && metric.asOfDate <= officialLast.asOfDate);
        const span = (Date.parse(`${officialLast.asOfDate}T00:00:00Z`) - Date.parse(`${series[0].asOfDate}T00:00:00Z`)) / DAY_MS;
        const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${officialLast.asOfDate}T00:00:00Z`)) / DAY_MS;
        const stale = ageDays > 7;
        const eligible = series.length >= MIN_PERCENTILE_SAMPLES && span >= MIN_PERCENTILE_SPAN_DAYS
          && !stale && series.every((metric) => metric.quality !== 'CONFLICT');
        if (stale) row.checks.push({ code: 'STALE_BASE', metric: 'pe', asOfDate: officialLast.asOfDate,
          ageDays, verdict: 'STALE', detail: `基础估值距 ${today} 超过 7 天，不能视为当前分位` });
        if (eligible) {
          const value = percentile(series.map((metric) => Number(metric.value)), Number(officialLast.value));
          if (value !== null) put({ metricKey: 'pe_percentile', asOfDate: officialLast.asOfDate,
            value: (Math.round(value * 100) / 100).toFixed(2), provider: 'derived', quality: 'FRESH' });
          row.notes.push(`分位截面 ${officialLast.asOfDate}，近 3 年样本 ${series.length}，跨度 ${Math.round(span)} 天`);
        } else {
          const oldPercentile = working.get(`pe_percentile:${officialLast.asOfDate}`);
          if (oldPercentile?.provider === 'derived') {
            row.removedPercentiles.push({ ...oldPercentile, reason: stale ? 'STALE_BASE' : 'INSUFFICIENT_OR_CONFLICTING_HISTORY' });
            remove(oldPercentile);
          }
          row.notes.push(`分位未写：样本 ${series.length}、跨度 ${Math.round(span)} 天、基准距今 ${ageDays} 天；要求至少 20 个样本、180 天、基准在 7 天内且无来源冲突`);
        }
      }

      // 逐个最终目标与事务开始时的原值核对，再统一落库；matched 不重复写。
      auditMetrics(before, [...desired.values()], row.counts, row.changes, 'final');
      for (const metric of stored) {
        if (!validDate(metric.asOfDate) || metric.asOfDate > today) {
          row.checks.push({ code: 'INVALID_STORED_DATE', metric: metric.metricKey,
            asOfDate: metric.asOfDate, stored: metric.value, verdict: 'UNVERIFIED' });
        }
        if (!['pe', 'pb', 'dividend_yield', 'turnover_rate', 'pe_percentile', 'pb_percentile'].includes(metric.metricKey)
          || metric.value === null) continue;
        const number = Number(metric.value);
        const invalid = String(metric.value).trim() === '' || !Number.isFinite(number)
          || (['pe', 'pb'].includes(metric.metricKey) ? number <= 0 : number < 0)
          || (metric.metricKey.endsWith('_percentile') && number > 100);
        if (invalid) row.checks.push({ code: 'INVALID_STORED_VALUE', metric: metric.metricKey,
          asOfDate: metric.asOfDate, stored: metric.value, verdict: desired.has(keyOf(metric)) ? 'REPAIRED_FROM_SOURCE' : 'UNVERIFIED' });
      }
      row.written = row.counts.inserted + row.counts.changed;
      row.deleted = deleted.size;
      if (apply) {
        saveAudit(handle, instrument, row);
        const deleteMetric = handle.db.prepare(`DELETE FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? AND as_of_date = ?`);
        for (const metric of deleted.values()) deleteMetric.run(instrument.id, metric.metricKey, metric.asOfDate);
        // desired 的顺序是报价归档、历史、快照、分位；同日 PE 已在投影中统一确定。
        for (const metric of desired.values()) if (!same(before.get(keyOf(metric)), metric)) saveValuationMetric(handle, { instrumentId: instrument.id, ...metric });
        if (points.length > 0 && !instrument.code.startsWith('000')) rememberCsindexCovered(handle, instrument.code);
        handle.db.exec('COMMIT;');
      }
    } catch (error) {
      if (apply) handle.db.exec('ROLLBACK;');
      error.message = `${instrument.code} ${instrument.name}：${error.message}`;
      throw error;
    }
    report.instruments.push(row);
    if (onInstrument) await onInstrument(row);
  }
  if (apply) handle.db.exec('PRAGMA optimize;');
  return report;
}

export const runBackfill = backfillMetrics;

/** 仅打开已存在、已升级的库；脚本不隐式创建目录、迁移 schema 或改运行时设置。 */
export function openBackfillState(stateDir, apply = false) {
  const dirs = resolveStateDirs({ ...process.env, PLUG_FUNDS_STATE_DIR: stateDir });
  const dbPath = path.join(dirs.data, 'invest.db');
  if (!fs.existsSync(dbPath)) throw new Error(`状态库不存在：${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: !apply });
  try {
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value);
    if (version !== SCHEMA_VERSION) throw new Error(`schema ${version} 与脚本 ${SCHEMA_VERSION} 不一致，请先用兼容插件升级，脚本不会自动迁移`);
    db.exec('PRAGMA busy_timeout = 15000;');
    return { db, dirs, engine: 'sqlite', schemaVersion: version, isNew: false };
  } catch (error) { db.close(); throw error; }
}

function printRow(row, apply) {
  console.log(`== ${row.code} ${row.name}：历史 ${row.historyRows} 行（${row.historyFrom ?? '—'} → ${row.historyTo ?? '—'}）`);
  console.log(`   一致 ${row.counts.matched}，新增 ${row.counts.inserted}，修正 ${row.counts.changed}；${apply ? '已删除' : '拟删除'}孤儿/污染分位 ${row.removedPercentiles.length}`);
  for (const check of row.checks) console.log(`   ${check.code} ${check.metric}：${check.verdict}`);
  for (const note of row.notes) console.log(`   ${note}`);
}

async function main() {
  const args = process.argv.slice(2);
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    if (index < 0) return null;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} 缺少参数`);
    return args[index + 1];
  };
  const apply = args.includes('--apply');
  const stateDir = path.resolve(valueFor('--state') ?? process.env.PLUG_FUNDS_STATE_DIR ?? path.join(os.homedir(), '.plug-funds'));
  const jsonArgument = valueFor('--json');
  const jsonPath = jsonArgument ? path.resolve(jsonArgument) : null;
  const handle = openBackfillState(stateDir, apply);
  try {
    console.log(`[backfill] ${apply ? 'APPLY（写库）' : 'DRY-RUN（只读）'}｜${stateDir}`);
    let backupPath = null;
    if (apply) {
      const backupDir = path.join(handle.dirs.data, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(backupDir, `pre-metrics-backfill-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      // SQLite 生成一致副本，不能直接复制 WAL 模式下仍在写入的主文件。
      handle.db.prepare('VACUUM INTO ?').run(backupPath);
      console.log(`[backfill] 写入前备份：${backupPath}`);
    }
    const report = await backfillMetrics({ handle, apply, onInstrument: (row) => printRow(row, apply) });
    report.stateDir = stateDir;
    report.backupPath = backupPath;
    if (jsonPath) { fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2)); console.log(`[backfill] 报告已写入 ${jsonPath}`); }
    console.log(`[backfill] 完成：${report.instruments.length} 个标的${apply ? '已处理' : '已校验，未写库'}`);
  } finally { handle.db.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(`[backfill] 失败：${error.message}`); process.exitCode = 1; });
}
