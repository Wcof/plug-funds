/**
 * 全量指数字段审计。
 *
 * 输出每个 active INDEX 标的的字段值、来源、状态和问题：
 * VALID / MISSING / UNSUPPORTED / STALE / CONFLICT / SUSPECT。
 * 只读数据库；可用 --before-db 指向本次任务前的备份，用于记录已清理的错误收盘价。
 *
 * 用法：
 *   node plugin/scripts/audit-index-data.mjs \
 *     --state ~/.plug-funds \
 *     --before-db .tmp/fill-all-20261116/invest.db.backup \
 *     --json .tmp/fill-all-20261116/index-audit.json \
 *     --csv .tmp/fill-all-20261116/index-audit.csv
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const stateDir = path.resolve(arg('--state', path.join(os.homedir(), '.plug-funds')));
const beforeDbPath = arg('--before-db');
const jsonPath = arg('--json');
const csvPath = arg('--csv');

const { effectiveHistoryPoints, metricHistory, latestValuationMetrics } = await import(path.join(repoRoot, 'plugin/server/src/repo/market.ts'));
const { percentile } = await import(path.join(repoRoot, 'plugin/core/src/valuation.ts'));
const { getIndexReference } = await import(path.join(repoRoot, 'plugin/server/src/repo/index-reference.ts'));

// openState 会建目录、更新 schema；审计必须直接只读打开，绝不隐式迁移。
const handle = { db: new DatabaseSync(path.join(stateDir, 'data', 'invest.db'), { readOnly: true }) };
handle.db.exec('PRAGMA busy_timeout = 15000; BEGIN;');
try {
const instruments = handle.db
  .prepare("SELECT * FROM instruments WHERE active=1 AND type='INDEX' ORDER BY code")
  .all();

const today = arg('--today', new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()));

const num = (v) => {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  if (typeof v === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(`${v}T00:00:00Z`))
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
if (!validDate(today)) throw new Error('--today 必须是有效的 YYYY-MM-DD 日期');
const daysBetween = (a, b) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
const status = (state, reason = null) => ({ state, reason });
const QUALITY_VALUES = new Set(['FRESH', 'DELAYED', 'STALE', 'MISSING', 'ESTIMATED', 'MANUAL', 'CONFLICT']);
const PRICE_TYPES = new Set(['REALTIME_PRICE', 'CLOSE_PRICE', 'OFFICIAL_NAV', 'ESTIMATED_NAV', 'IOPV', 'MANUAL_PRICE']);
const POSITIVE_METRICS = new Set(['pe', 'pe_quote', 'pe_official', 'pe_official_static', 'pe_official_total_share', 'pe_dynamic', 'pe_static', 'pb', 'ps']);
const NONNEGATIVE_METRICS = new Set(['dividend_yield', 'dividend_yield_total_share', 'turnover_rate']);
const scaleValue = (value) => {
  const match = typeof value === 'string' ? /^总市值\s+(\d+(?:\.\d+)?)\s+亿$/.exec(value.trim()) : null;
  return match && num(match[1]) > 0 ? num(match[1]) : null;
};
const check = (code, state, reason) => ({ code, state, reason });
const evidenceStatus = (checks) => {
  for (const state of ['SUSPECT', 'CONFLICT', 'MISSING', 'STALE']) {
    const selected = checks.find((item) => item.state === state);
    if (selected) return status(state, selected.reason);
  }
  return status('VALID');
};
function qualityChecks(quality) {
  if (!QUALITY_VALUES.has(quality)) return [check('INVALID_QUALITY', 'SUSPECT', '质量标记不属于已定义枚举')];
  if (quality === 'CONFLICT') return [check('QUALITY_CONFLICT', 'CONFLICT', '库内保留未解决的来源冲突')];
  if (quality === 'MISSING') return [check('QUALITY_MISSING', 'MISSING', '库内质量标记为缺失')];
  if (quality === 'STALE' || quality === 'DELAYED') return [check(`QUALITY_${quality}`, 'STALE', '库内质量标记为过期或延迟')];
  if (quality === 'ESTIMATED') return [check('QUALITY_ESTIMATED', 'SUSPECT', '估算记录需要保留估算性质，不能视为正式已核实数据')];
  return [];
}
function commonChecks(date, provider, quality) {
  const checks = qualityChecks(quality);
  if (!validDate(date)) checks.push(check('INVALID_DATE', 'SUSPECT', '日期不是合法日历日期'));
  else if (date > today) checks.push(check('FUTURE_DATE', 'SUSPECT', '日期晚于审计日'));
  if (typeof provider !== 'string' || provider.trim() === '') checks.push(check('MISSING_PROVIDER', 'SUSPECT', '来源缺失，无法追溯'));
  return checks;
}
function metricChecks(row) {
  const checks = commonChecks(row.as_of_date, row.provider, row.quality);
  if (row.metric_key === 'scale_info') {
    if (scaleValue(row.value) === null) checks.push(check('INVALID_SCALE_TEXT', 'SUSPECT', '总市值文本不能解析为正有限数值'));
  } else {
    const value = num(row.value);
    if (row.value === null || row.value === undefined || String(row.value).trim() === '') checks.push(check('MISSING_VALUE', 'MISSING', '数值缺失或空白，不能作为 0'));
    else if (value === null) checks.push(check('INVALID_NUMBER', 'SUSPECT', '数值指标不是有限十进制数值'));
    else if (POSITIVE_METRICS.has(row.metric_key) && value <= 0) checks.push(check('NON_POSITIVE_METRIC', 'SUSPECT', '该估值指标须为正数'));
    else if (NONNEGATIVE_METRICS.has(row.metric_key) && value < 0) checks.push(check('NEGATIVE_METRIC', 'SUSPECT', '该指标不能为负数'));
    else if (typeof row.metric_key === 'string' && row.metric_key.endsWith('_percentile') && (value < 0 || value > 100)) checks.push(check('PERCENTILE_OUT_OF_RANGE', 'SUSPECT', '分位必须在 0 至 100 之间'));
  }
  if (typeof row.metric_key !== 'string' || row.metric_key.trim() === '') checks.push(check('MISSING_METRIC_KEY', 'SUSPECT', '指标键缺失'));
  return checks;
}

function stats(history, metric, metricStatus) {
  const current = metric?.value ?? null;
  const end = validDate(metric?.asOfDate) && metric.asOfDate <= today ? metric.asOfDate : today;
  const since = new Date(`${end}T00:00:00Z`);
  since.setUTCFullYear(since.getUTCFullYear() - 3);
  history = history.filter((p) => validDate(p.asOfDate) && p.asOfDate >= since.toISOString().slice(0, 10) && p.asOfDate <= end && p.value > 0);
  const excludedSourceSamples = history.filter((p) => p.provider !== metric?.provider).length;
  history = history.filter((p) => p.provider === metric?.provider);
  const conflictingSamples = history.filter((p) => p.quality === 'CONFLICT').length;
  const values = history.map((p) => p.value).filter(Number.isFinite).sort((a, b) => a - b);
  const first = history[0]?.asOfDate ?? null;
  const last = history.at(-1)?.asOfDate ?? null;
  const spanDays = first && last ? daysBetween(first, last) : 0;
  const percentileStatus = current === null ? status('MISSING', '当前基础指标缺失')
    : metric && validDate(metric.asOfDate) && daysBetween(metric.asOfDate, today) > 7 ? status('STALE', '基础指标超过 7 天，不能视为当前分位')
      : conflictingSamples > 0 || metricStatus.state === 'CONFLICT' ? status('CONFLICT', '基础指标或同源历史存在未解决的冲突')
        : values.length < 20 || spanDays < 180 ? status('MISSING', `同源样本 ${values.length} 个、跨度 ${Math.round(spanDays)} 天，要求至少 20 个且 180 天`)
          : metricStatus.state !== 'VALID' ? { ...metricStatus, reason: `基础指标未通过校验：${metricStatus.reason}` }
            : status('VALID');
  return {
    current,
    percentile: percentileStatus.state === 'VALID' ? percentile(values, current) : null,
    percentileStatus,
    avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
    min: values.length ? values[0] : null,
    p20: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.2))] : null,
    p50: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.5))] : null,
    p80: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.8))] : null,
    max: values.length ? values.at(-1) : null,
    samples: values.length,
    from: first,
    to: last,
    spanDays,
    excludedSourceSamples,
    conflictingSamples,
    windowStart: since.toISOString().slice(0, 10),
    windowEnd: end,
  };
}

function metricMap(id) {
  return new Map(latestValuationMetrics(handle, id, today).map((m) => [m.metricKey, m]));
}

function auditMetricHistory(id, key) {
  return handle.db.prepare('SELECT as_of_date, value, provider, quality FROM valuation_metrics WHERE instrument_id=? AND metric_key=? AND as_of_date<=? ORDER BY as_of_date')
    .all(id, key, today).map((p) => ({ asOfDate: p.as_of_date, value: num(p.value), provider: p.provider, quality: p.quality }));
}

function currentMetric(map, key) {
  const row = map.get(key);
  return row ? { value: num(row.value), rawValue: row.value, asOfDate: row.asOfDate, provider: row.provider, quality: row.quality } : null;
}

function fieldStatusForMetric(metric, key) {
  if (!metric) {
    if (key === 'ps' || key === 'roe') return status('UNSUPPORTED', '当前项目未接入该指数指标的数据源；不代表外部没有数据');
    return status('MISSING', '本地缺少有效值；没有逐字段请求证据，缺失原因待核实');
  }
  if (metric.rawValue === null || metric.rawValue === undefined || String(metric.rawValue).trim() === '') return status('MISSING', '已存值缺失或空白，不能作为 0');
  if (metric.value === null || !Number.isFinite(metric.value)) return status('SUSPECT', '已存值不是有效有限数值');
  if (!validDate(metric.asOfDate) || metric.asOfDate > today) return status('SUSPECT', '指标日期非法或在未来');
  const quality = qualityChecks(metric.quality);
  if (quality.length > 0) return evidenceStatus(quality);
  if (typeof metric.provider !== 'string' || metric.provider.trim() === '') return status('SUSPECT', '指标来源缺失');
  if ((key === 'pe' || key === 'pb') && metric.value <= 0) return status('SUSPECT', `${key.toUpperCase()} 必须为正数`);
  if (key === 'dividend_yield' && metric.value < 0) return status('SUSPECT', '股息率不能为负数');
  if (key === 'turnover_rate' && metric.value < 0) return status('SUSPECT', '换手率不能为负数');
  if (key === 'pe' && !['csindex', 'cnindex'].includes(metric.provider)) return status('SUSPECT', '报价端 PE 口径未核实，不等同于已证明数值错误');
  if (key === 'pe' && metric.value > 200) return status('SUSPECT', 'PE > 200，属于极端值，保留并要求人工复核');
  if (key === 'pb' && metric.value > 20) return status('SUSPECT', 'PB > 20，属于极端值，保留并要求人工复核');
  if (key === 'dividend_yield' && metric.value > 20) return status('SUSPECT', '股息率 > 20%，属于极端值，保留并要求人工复核');
  if (daysBetween(metric.asOfDate, today) > 7) return status('STALE', `数据日期 ${metric.asOfDate} 超过 7 个自然日，是否为最近可用数据需复核`);
  return status('VALID');
}

function compareVerdict(official, quote) {
  return {
    comparable: false,
    verdict: 'NOT_COMPARABLE',
    official: { value: official.value, asOfDate: official.asOfDate, provider: official.provider },
    quote: { value: quote.value, asOfDate: quote.asOfDate, provider: quote.provider },
    reason: official.asOfDate === quote.asOfDate
      ? '报价 PE 与官方滚动 PE 的计算口径未证明一致，不能据差值判断数值错误'
      : '日期不同且口径未对齐，不能据差值判断数值错误',
  };
}

// 任务前备份中存在、当前已删除的未收盘 CLOSE_PRICE，按标的记录修正。
const removedPrematureClose = new Map();
const prematureClose = (point) => {
  const instant = Date.parse(point.observed_at);
  return point.price_type === 'CLOSE_PRICE' && validDate(point.trading_date) && Number.isFinite(instant)
    && new Date(instant + 8 * 3600000).toISOString().slice(0, 10) === point.trading_date
    && instant < Date.parse(`${point.trading_date}T15:00:00+08:00`);
};
if (beforeDbPath) {
  const before = new DatabaseSync(path.resolve(beforeDbPath), { readOnly: true });
  try {
  before.exec('PRAGMA busy_timeout=15000;');
  const rows = before.prepare("SELECT * FROM market_data WHERE price_type='CLOSE_PRICE'").all();
  const current = handle.db.prepare('SELECT * FROM market_data WHERE instrument_id=? AND price_type=? AND trading_date=? AND provider=?');
  for (const row of rows.filter(prematureClose)) {
    const now = current.get(row.instrument_id, row.price_type, row.trading_date, row.provider);
    if (now && prematureClose(now)) continue;
    const changes = removedPrematureClose.get(row.instrument_id) ?? [];
    changes.push({ action: now ? 'REPLACE_PREMATURE_CLOSE' : 'REMOVE_PREMATURE_CLOSE',
      tradingDate: row.trading_date, provider: row.provider, previousValue: row.value,
      previousObservedAt: row.observed_at, currentValue: now?.value ?? null, rows: 1,
      reason: '备份中存在的当日未收盘记录，当前按标的/价格类型/日期/来源逐键确认已移除或替换' });
    removedPrematureClose.set(row.instrument_id, changes);
  }
  } finally { before.close(); }
}

// 全量历史逐行检查；只读取市场/标的表，不读取账户、流水、设置或秘密。
const latestRawById = new Map();
const anomaliesById = new Map();
const rawDataChecks = {
  valuationMetrics: { rows: 0, numericRows: 0, anomalyRows: 0, anomalyCount: 0, byCode: {}, qualityCounts: {} },
  marketData: { rows: 0, anomalyRows: 0, anomalyCount: 0, byCode: {}, qualityCounts: {} },
};
function recordRawCheck(table, row, checks, summary) {
  summary.rows++;
  const qualityKey = String(row.quality ?? '(missing)');
  summary.qualityCounts[qualityKey] = (summary.qualityCounts[qualityKey] ?? 0) + 1;
  if (checks.length === 0) return;
  summary.anomalyRows++;
  summary.anomalyCount += checks.length;
  for (const issue of checks) summary.byCode[issue.code] = (summary.byCode[issue.code] ?? 0) + 1;
  const evidence = { table, instrumentId: row.instrument_id,
    rowKey: table === 'valuation_metrics'
      ? { instrumentId: row.instrument_id, metricKey: row.metric_key, asOfDate: row.as_of_date }
      : { id: row.id, instrumentId: row.instrument_id, priceType: row.price_type, tradingDate: row.trading_date, provider: row.provider },
    rawValue: row.value, value: row.metric_key === 'scale_info' ? scaleValue(row.value) : num(row.value),
    provider: row.provider, quality: row.quality, observedAt: row.observed_at ?? null,
    ...evidenceStatus(checks), checks };
  const evidenceList = anomaliesById.get(row.instrument_id) ?? [];
  evidenceList.push(evidence);
  anomaliesById.set(row.instrument_id, evidenceList);
}
for (const row of handle.db.prepare('SELECT instrument_id, metric_key, value, as_of_date, provider, quality FROM valuation_metrics').iterate()) {
  if (row.metric_key !== 'scale_info') rawDataChecks.valuationMetrics.numericRows++;
  recordRawCheck('valuation_metrics', row, metricChecks(row), rawDataChecks.valuationMetrics);
  if (typeof row.as_of_date === 'string' && row.as_of_date <= today) {
    const latest = latestRawById.get(row.instrument_id) ?? new Map();
    const previous = latest.get(row.metric_key);
    if (!previous || row.as_of_date >= previous.as_of_date) latest.set(row.metric_key, row);
    latestRawById.set(row.instrument_id, latest);
  }
}
const auditEnd = Date.parse(`${today}T23:59:59.999+08:00`);
for (const row of handle.db.prepare('SELECT id, instrument_id, price_type, value, trading_date, observed_at, provider, quality FROM market_data').iterate()) {
  const checks = commonChecks(row.trading_date, row.provider, row.quality);
  const value = num(row.value);
  if (value === null || value <= 0) checks.push(check('INVALID_PRICE', 'SUSPECT', '行情值必须为正有限数值；空白不能作为 0'));
  if (!PRICE_TYPES.has(row.price_type)) checks.push(check('INVALID_PRICE_TYPE', 'SUSPECT', '价格类型不属于已定义枚举'));
  const instant = Date.parse(row.observed_at);
  if (typeof row.observed_at !== 'string' || !validDate(row.observed_at.slice(0, 10)) || !Number.isFinite(instant)) {
    checks.push(check('INVALID_OBSERVED_AT', 'SUSPECT', '采集时刻缺失或非法'));
  } else if (instant > auditEnd) checks.push(check('FUTURE_OBSERVED_AT', 'SUSPECT', '采集时刻晚于审计日'));
  if (prematureClose(row)) checks.push(check('PREMATURE_CLOSE', 'SUSPECT', '当日北京时间 15:00 前采集的 K 线被标成收盘价'));
  recordRawCheck('market_data', row, checks, rawDataChecks.marketData);
}
function latestMetricDetails(row) {
  const checks = metricChecks(row);
  const isText = row.metric_key === 'scale_info';
  const value = isText ? scaleValue(row.value) : num(row.value);
  const structuralStatus = evidenceStatus(checks);
  const fieldStatus = structuralStatus.state === 'VALID'
    ? fieldStatusForMetric({ value, rawValue: row.value, asOfDate: row.as_of_date, provider: row.provider, quality: row.quality }, row.metric_key)
    : structuralStatus;
  return { metricKey: row.metric_key, rawValue: row.value, value, valueKind: isText ? 'parsed-market-value-yi' : 'number',
    asOfDate: row.as_of_date, provider: row.provider, quality: row.quality, ...fieldStatus, checks };
}

const rows = [];
const counts = {};
const addCount = (key) => { counts[key] = (counts[key] ?? 0) + 1; };

for (const instrument of instruments) {
  const metrics = metricMap(instrument.id);
  const rawLatest = latestRawById.get(instrument.id) ?? new Map();
  const latestMetrics = [...rawLatest.values()].sort((a, b) => String(a.metric_key).localeCompare(String(b.metric_key))).map(latestMetricDetails);
  const peHistory = auditMetricHistory(instrument.id, 'pe');
  const pbHistory = auditMetricHistory(instrument.id, 'pb');
  const psHistory = auditMetricHistory(instrument.id, 'ps');
  const roeHistory = metricHistory(handle, instrument.id, 'roe', undefined, today).filter((p) => validDate(p.asOfDate));
  const points = effectiveHistoryPoints(handle, instrument.id, instrument.type, undefined, today, today)
    .filter((p) => validDate(p.tradingDate) && num(p.value) !== null && num(p.value) > 0);
  const numbers = points.map((p) => num(p.value)).filter((v) => v !== null);
  const close = numbers.length ? numbers.at(-1) : null;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const yearEnd = `${Number(today.slice(0, 4)) - 1}-12-31`;
  const yearEndBase = points.filter((p) => p.tradingDate < yearStart && p.priceType !== 'REALTIME_PRICE'
    && !['CONFLICT', 'MISSING'].includes(p.quality)).at(-1);
  const firstValue = yearEndBase && daysBetween(yearEndBase.tradingDate, yearEnd) <= 14 ? num(yearEndBase.value) : null;
  const ytdReturn = close !== null && firstValue !== null && firstValue > 0 && points.at(-1)?.tradingDate >= yearStart
    ? (close / firstValue - 1) * 100 : null;
  const pe = currentMetric(metrics, 'pe');
  const pb = currentMetric(metrics, 'pb');
  const ps = currentMetric(metrics, 'ps');
  const dividend = currentMetric(metrics, 'dividend_yield');
  const turnover = currentMetric(metrics, 'turnover_rate');
  const roeByYear = new Map();
  for (const p of roeHistory) roeByYear.set(p.asOfDate.slice(0, 4), p.value);
  const roeYears = [3, 2, 1].map((offset) => String(Number(today.slice(0, 4)) - offset));
  const scale = rawLatest.get('scale_info');
  const marketValue = scaleValue(scale?.value);
  const marketValueDetail = scale ? latestMetricDetails(scale) : null;
  const marketValueStatus = marketValueDetail ? status(marketValueDetail.state, marketValueDetail.reason) : status('MISSING', '本地无非未来总市值记录；缺失原因待核实');
  const issues = [];
  const corrections = [];

  const reference = getIndexReference(handle, instrument.id);
  const funds = reference?.funds ?? null;
  const publishStatus = reference?.publishStatus ?? (instrument.founded_date
    ? (validDate(instrument.founded_date) && instrument.founded_date <= today ? status('VALID') : status('SUSPECT', '发布日期非法或在未来'))
    : status('MISSING', '缺少发布日期；不能由代码前缀推定无公开来源或网络故障'));
  if (publishStatus.state !== 'VALID') issues.push({ field: 'publishDate', ...publishStatus });

  const closeStatus = close === null ? status('MISSING', '没有有效价格；缺失原因待核实')
    : points.at(-1)?.quality === 'CONFLICT' ? status('CONFLICT', '有效价格仍有来源冲突')
      : points.at(-1)?.tradingDate < today ? status('STALE', `最近价格日期为 ${points.at(-1)?.tradingDate}，是否最近交易日待核实`) : status('VALID');
  if (closeStatus.state !== 'VALID') issues.push({ field: 'close', ...closeStatus });
  const ytdStatus = ytdReturn === null ? status('MISSING', '缺少上年末 14 天内基准价或当年价格；不以当年首个样本冒充全年基准')
    : Math.abs(ytdReturn) > 200 ? status('SUSPECT', '年初至今收益率绝对值 > 200%，属于极端值') : status('VALID');
  if (ytdStatus.state !== 'VALID') issues.push({ field: 'ytdReturn', ...ytdStatus });

  const peStatus = fieldStatusForMetric(pe, 'pe');
  const pbStatus = !pb && reference?.unavailable.pb ? status('MISSING', reference.unavailable.pb) : fieldStatusForMetric(pb, 'pb');
  const psStatus = !ps && reference ? status('MISSING', reference.unavailable.ps) : fieldStatusForMetric(ps, 'ps');
  const divStatus = fieldStatusForMetric(dividend, 'dividend_yield');
  const turnoverStatus = fieldStatusForMetric(turnover, 'turnover_rate');
  for (const [field, s] of [['pe.current', peStatus], ['pb.current', pbStatus], ['ps.current', psStatus], ['dividendYield', divStatus], ['turnoverRate', turnoverStatus]]) {
    if (s.state !== 'VALID') issues.push({ field, ...s });
  }

  const peStats = stats(peHistory, pe, peStatus);
  const pbStats = stats(pbHistory, pb, pbStatus);
  const psStats = stats(psHistory, ps, psStatus);
  for (const [key, s] of [['pe.percentile', peStats], ['pb.percentile', pbStats], ['ps.percentile', psStats]]) {
    if (s.percentileStatus.state !== 'VALID') issues.push({ field: key, ...s.percentileStatus });
    if (s.excludedSourceSamples > 0) issues.push({ field: key, state: 'SUSPECT', reason: `历史包含 ${s.excludedSourceSamples} 个其他来源样本，已排除以保持同一来源口径` });
  }

  const roe = [0, 1, 2].map((i) => roeByYear.get(roeYears[i]) ?? null);
  const roeStatus = roe.some((v) => v !== null) ? status('SUSPECT', '只有观察日期，财报年度与计算口径未核实，不能宣称为近 3 个财年的 ROE')
    : roeHistory.length > 0 ? status('MISSING', '已有其他年份观测，但前 3 个日历年缺少可用 ROE 观测')
      : reference ? status('MISSING', reference.unavailable.roe) : status('UNSUPPORTED', '项目未接入指数 ROE 数据源，不代表外部不存在该数据');
  issues.push({ field: 'roe', ...roeStatus });
  if (marketValueStatus.state !== 'VALID') issues.push({ field: 'marketValue', ...marketValueStatus });
  const fundStatus = funds?.status ?? status('MISSING', reference?.unavailable.funds ?? '尚未取得官方关联产品清单');
  if (fundStatus.state !== 'VALID') issues.push({ field: 'fundOn/fundOff', ...fundStatus });

  const quote = currentMetric(metrics, 'pe_quote');
  const peComparison = pe && ['csindex', 'cnindex'].includes(pe.provider) && quote ? compareVerdict(pe, quote) : null;
  corrections.push(...(removedPrematureClose.get(instrument.id) ?? []));

  const fieldStates = {
    publishDate: publishStatus,
    close: closeStatus,
    ytdReturn: ytdStatus,
    pe: peStatus,
    pb: pbStatus,
    ps: psStatus,
    pePercentile: peStats.percentileStatus,
    pbPercentile: pbStats.percentileStatus,
    psPercentile: psStats.percentileStatus,
    roe: roeStatus,
    dividendYield: divStatus,
    turnoverRate: turnoverStatus,
    marketValue: marketValueStatus,
    fundOn: fundStatus,
    fundOff: fundStatus,
  };
  for (const state of Object.values(fieldStates)) addCount(state.state);
  rows.push({
    code: instrument.code,
    name: instrument.name,
    instrumentId: instrument.id,
    meta: {
      id: instrument.id, code: instrument.code, name: instrument.name, type: instrument.type,
      market: instrument.market, currency: instrument.currency ?? null, benchmarkIndex: instrument.benchmark_index ?? null,
      secid: instrument.secid ?? null, fundCode: instrument.fund_code ?? null, tag: instrument.tag ?? null,
      foundedDate: instrument.founded_date ?? null, scaleInfo: instrument.scale_info ?? null, active: instrument.active === 1,
      createdAt: instrument.created_at ?? null, updatedAt: instrument.updated_at ?? null,
    },
    market: instrument.market,
    secid: instrument.secid,
    publishDate: instrument.founded_date,
    close,
    closeDate: points.at(-1)?.tradingDate ?? null,
    closeProvider: points.at(-1)?.provider ?? null,
    priceType: points.at(-1)?.priceType ?? null,
    priceLabel: '有效点位；REALTIME_PRICE 不是收盘价',
    ytdReturn,
    ytdBaseDate: firstValue === null ? null : yearEndBase.tradingDate,
    fundOn: funds?.on ?? null,
    fundOff: funds?.off ?? null,
    fundReference: funds,
    reference,
    pe: { ...peStats, provider: pe?.provider ?? null, asOfDate: pe?.asOfDate ?? null },
    pb: { ...pbStats, provider: pb?.provider ?? null, asOfDate: pb?.asOfDate ?? null },
    ps: { ...psStats, provider: ps?.provider ?? null, asOfDate: ps?.asOfDate ?? null },
    roe: { observations: roeYears.map((year) => ({ observationYear: year, value: roeByYear.get(year) ?? null })),
      note: '固定前 3 / 2 / 1 个日历年末次观测，缺年留 null；没有财报年度，不能宣称为近 3 个财年的 ROE' },
    dividendYield: dividend?.value ?? null,
    dividendAsOfDate: dividend?.asOfDate ?? null,
    dividendProvider: dividend?.provider ?? null,
    turnoverRate: turnover?.value ?? null,
    turnoverAsOfDate: turnover?.asOfDate ?? null,
    turnoverProvider: turnover?.provider ?? null,
    turnoverQuality: turnover?.quality ?? null,
    marketValue,
    marketValueRaw: scale?.value ?? null,
    marketValueAsOfDate: scale?.as_of_date ?? null,
    marketValueProvider: scale?.provider ?? null,
    marketValueQuality: scale?.quality ?? null,
    latestMetrics,
    rawDataAnomalies: anomaliesById.get(instrument.id) ?? [],
    fieldStates,
    peComparison,
    corrections,
    issues,
  });
}

// DB 复合主键不允许真正重复；保留显式断言以便审计结果可复核。
const duplicateKeys = handle.db.prepare(
  'SELECT COUNT(*) n FROM (SELECT instrument_id, metric_key, as_of_date, COUNT(*) c FROM valuation_metrics GROUP BY 1,2,3 HAVING c>1)',
).get().n;
const metricDates = handle.db.prepare('SELECT as_of_date, COUNT(*) n FROM valuation_metrics GROUP BY as_of_date').all();
const badDates = metricDates.filter((row) => !validDate(row.as_of_date)).reduce((sum, row) => sum + row.n, 0);
const futureDates = metricDates.filter((row) => validDate(row.as_of_date) && row.as_of_date > today).reduce((sum, row) => sum + row.n, 0);
const integrityCheck = handle.db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
const report = {
  generatedAt: new Date().toISOString(),
  today,
  stateDir,
  rules: {
    percentile: '基础指标日前向 3 年，同一来源样本数 >= 20 且跨度 >= 180 天；基础指标超过 7 天标 STALE，基础指标或历史冲突/存疑时不产生当前分位',
    effectivePrice: 'MANUAL_PRICE > 当日 REALTIME_PRICE > CLOSE_PRICE / OFFICIAL_NAV',
    pe: '指数优先采用已有中证官方滚动 PE；国证自编目录覆盖时采用国证官方滚动 PE，二者不拼接历史；报价端 pe 口径待核实，标记 SUSPECT；跨日期/口径比较为 NOT_COMPARABLE',
    sources: 'Touzid 仅用于字段结构参考，不写入本地真实数值；本脚本不发起外部请求',
    missing: '没有逐字段请求证据时使用 MISSING，不由代码前缀或缺值推断网络故障/无公开来源',
    ytd: '使用距上一年 12 月 31 日不超过 14 天的最近有效价作为基准，排除 REALTIME_PRICE、CONFLICT、MISSING；缺基准时不计算',
    roe: '固定前 3 / 2 / 1 个日历年末次 ROE 观测，缺年留 null；观测年不等同财报年度',
    close: '北京时间 15:00 前的当日 K 线不得写入 CLOSE_PRICE',
    latestMetrics: '列出每个已存 metric_key 的最新非未来记录，保留原文、数值、日期、来源、质量及状态；主展示 PE 仍按官方优先口径选择，两者选择依据不同',
    rawData: '遍历全部 valuation_metrics 和 market_data 行；scale_info 按总市值文本解析，其余估值键按有限数值校验；行情值必须正且有限；逐行核查日历、未来日期、质量和误标收盘价',
    validState: 'VALID 只表示本地结构与已定义校验规则通过，不等于已逐笔向外部重新核实',
  },
  databaseChecks: { instrumentCount: rows.length, integrityCheck, duplicateMetricKeys: duplicateKeys, badMetricDates: badDates, futureMetricDates: futureDates, rawDataChecks },
  counts,
  rows,
  otherInstrumentAnomalies: [...anomaliesById.entries()].filter(([id]) => !instruments.some((instrument) => instrument.id === id))
    .map(([instrumentId, evidence]) => ({ instrumentId, evidence })),
};

const csvFields = [
  'code', 'name', 'market', 'secid', 'publishDate', 'close', 'closeDate', 'priceType', 'closeProvider', 'ytdReturn', 'ytdBaseDate',
  'fundOn', 'fundOff', 'pe.current', 'pe.percentile', 'pe.samples', 'pe.from', 'pe.to', 'pe.provider',
  'pb.current', 'pb.percentile', 'pb.samples', 'pb.from', 'pb.to', 'pb.provider',
  'ps.current', 'ps.percentile', 'ps.samples', 'roe', 'dividendYield', 'marketValue',
  'fieldStates', 'peComparison', 'corrections', 'issues',
  'turnoverRate', 'turnoverAsOfDate', 'turnoverProvider', 'turnoverQuality', 'marketValueAsOfDate', 'marketValueProvider', 'marketValueQuality',
  'latestMetrics', 'meta', 'rawDataAnomalies',
];
const readField = (row, key) => {
  if (key.includes('.')) {
    const [a, b] = key.split('.');
    return row[a]?.[b] ?? null;
  }
  if (['roe', 'fieldStates', 'peComparison', 'corrections', 'issues', 'latestMetrics', 'meta', 'rawDataAnomalies'].includes(key)) return JSON.stringify(row[key]);
  return row[key] ?? null;
};
const csvEscape = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
const csv = [csvFields.join(','), ...rows.map((row) => csvFields.map((f) => csvEscape(readField(row, f))).join(','))].join('\n');
if (jsonPath) { fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true }); fs.writeFileSync(path.resolve(jsonPath), JSON.stringify(report, null, 2)); }
if (csvPath) { fs.mkdirSync(path.dirname(path.resolve(csvPath)), { recursive: true }); fs.writeFileSync(path.resolve(csvPath), `\ufeff${csv}`); }
console.log(JSON.stringify({ instrumentCount: rows.length, counts, duplicateMetricKeys: duplicateKeys, badMetricDates: badDates, jsonPath, csvPath }));
} finally { handle.db.close(); }
