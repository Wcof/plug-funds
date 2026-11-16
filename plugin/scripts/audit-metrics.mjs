/**
 * 估值指标多源核查：保留数值、来源、日期与计算口径。
 * 只有同日且已知同口径的数据才计算相对差；其余为 NOT_COMPARABLE。
 * 数据库通过只读事务取得一致快照，不复制 WAL 文件、不迁移、不写业务数据。
 *
 * 用法：node plugin/scripts/audit-metrics.mjs [--state <dir>] [--json out.json]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { listInstruments } from '../server/src/repo/instruments.ts';
import { latestValuationMetrics } from '../server/src/repo/market.ts';
import { createTencentProvider } from '../server/src/market/tencent.ts';
import { createEastmoneyProvider } from '../server/src/market/eastmoney.ts';
import { fetchCsindexIndicator } from '../server/src/market/csindex.ts';
import { fetchValuationSnapshot } from '../server/src/market/csindex-valuation.ts';

const METRIC_KEYS = ['pe', 'pb', 'roe', 'dividend_yield', 'ps', 'pe_quote', 'pe_official',
  'pe_official_static', 'pe_official_total_share', 'dividend_yield_total_share'];
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function parseMetricValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function definitionFor(type, key, provider, origin) {
  if (provider === 'csindex') {
    if (key === 'pe') return 'CSI_INDEX_ROLLING_PE';
    if (key === 'pe_official') return 'CSI_PE2_CALC_SHARE';
    if (key === 'pe_official_total_share') return 'CSI_PE1_TOTAL_SHARE';
    if (key === 'pe_official_static') return 'CSI_JSON_STATIC_PE';
    if (key === 'pb') return 'CSI_JSON_PB';
    // 历史库的 dividend_yield 同时接收 XLS/JSON，现有键不足以证明端点口径一致。
    if (key === 'dividend_yield') return origin === 'official' ? 'CSI_JSON_DIVIDEND_YIELD'
      : origin === 'xls' ? 'CSI_XLS_DIVIDEND_CALC_SHARE' : null;
    if (key === 'dividend_yield_total_share') return 'CSI_XLS_DIVIDEND_TOTAL_SHARE';
    return null;
  }
  if (!['tencent', 'eastmoney'].includes(provider)) return null;
  if (['pe', 'pe_quote', 'pb', 'roe', 'ps'].includes(key)) {
    // 不把不同报价商同名字段自动视为等价；基金穿透口径也需单独保留。
    return `${provider}:${type}:${key === 'pe_quote' ? 'pe' : key}`;
  }
  return null;
}

export function pickMetricObservations(rows, instrument, provider = null, origin = 'stored') {
  const out = {};
  for (const row of rows ?? []) {
    if (!METRIC_KEYS.includes(row.metricKey)) continue;
    const source = row.provider ?? provider;
    out[row.metricKey] = {
      metricKey: row.metricKey,
      value: parseMetricValue(row.value),
      rawValue: row.value ?? null,
      asOfDate: row.asOfDate ?? null,
      provider: source,
      quality: row.quality ?? null,
      definition: definitionFor(instrument.type, row.metricKey, source, origin),
      // 东财当前适配器只把请求日写作 asOfDate，无法证明是上游估值日。
      dateBasis: source === 'eastmoney' ? 'request-date' : 'provider-recorded-date',
    };
  }
  return out;
}

export function compareMetricObservations(left, right) {
  const result = { left: left ?? null, right: right ?? null, comparable: false, diff: null, verdict: 'NOT_COMPARABLE', reason: '' };
  const a = parseMetricValue(left?.value);
  const b = parseMetricValue(right?.value);
  if (a === null || b === null) return { ...result, verdict: 'MISSING', reason: '至少一侧缺少有效有限数值；空白不作为 0' };
  if (!validDate(left.asOfDate) || !validDate(right.asOfDate)) return { ...result, reason: '估值日期缺失或非法' };
  if (left.asOfDate !== right.asOfDate) return { ...result, reason: '估值日期不同，不能据差值判断数值错误' };
  if (left.dateBasis === 'request-date' || right.dateBasis === 'request-date') return { ...result, reason: '适配器日期为请求日，未取得上游估值日证据' };
  if (!left.definition || !right.definition || left.definition !== right.definition) {
    return { ...result, reason: '计算口径不同或未核实；指数官方滚动 PE、报价 PE、PE2 不得混比' };
  }
  const diff = a === 0 ? (b === 0 ? 0 : null) : ((b - a) / Math.abs(a)) * 100;
  if (left.quality === 'CONFLICT' || right.quality === 'CONFLICT') {
    return { ...result, comparable: true, diff, verdict: 'CONFLICT', reason: '至少一侧已有未解决的来源冲突标记' };
  }
  if (diff === null) return { ...result, comparable: true, verdict: 'REVIEW', reason: '基准值为 0，不能计算相对差；两侧数值不同' };
  const abs = Math.abs(diff);
  return { ...result, comparable: true, diff,
    verdict: abs < 1 ? 'CONSISTENT' : abs < 5 ? 'DIFFERENT' : abs < 10 ? 'REVIEW' : 'CONFLICT',
    reason: '同日同口径的数值差异；差异本身不能确定哪一侧错误',
  };
}

export function readStoredAudit(sourceState) {
  const db = new DatabaseSync(path.join(sourceState, 'data', 'invest.db'), { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=15000; PRAGMA query_only=ON; BEGIN;');
    const handle = { db };
    return listInstruments(handle, { active: true }).map((instrument) => ({
      instrument,
      stored: pickMetricObservations(latestValuationMetrics(handle, instrument.id), instrument),
    }));
  } finally {
    // 关闭连接结束只读事务；不运行 openState、迁移或 checkpoint。
    db.close();
  }
}

export async function auditMetrics(sourceState, dependencies = {}) {
  const storedRows = readStoredAudit(sourceState);
  const tencent = dependencies.tencent ?? createTencentProvider();
  const eastmoney = dependencies.eastmoney ?? createEastmoneyProvider();
  const fetchIndicator = dependencies.fetchIndicator ?? fetchCsindexIndicator;
  const fetchOfficial = dependencies.fetchOfficial ?? fetchValuationSnapshot;
  let officialSnapshot = [];
  let officialError = null;
  if (storedRows.some(({ instrument }) => instrument.type === 'INDEX')) {
    try { officialSnapshot = await fetchOfficial(); } catch (error) { officialError = String(error?.message ?? error).slice(0, 200); }
  }
  const report = [];
  for (const { instrument, stored } of storedRows) {
    const row = { code: instrument.code, name: instrument.name, type: instrument.type, sources: {}, sourceErrors: {}, checks: [] };
    const fetchMetrics = async (provider) => {
      try { return pickMetricObservations(await provider.fetchMetrics(instrument), instrument, provider.id); }
      catch (error) { row.sourceErrors[provider.id] = String(error?.message ?? error).slice(0, 200); return {}; }
    };
    const fromTencent = await fetchMetrics(tencent);
    const fromEastmoney = await fetchMetrics(eastmoney);
    let fromCsindex = {};
    if (instrument.type === 'INDEX') {
      try {
        const snapshots = await fetchIndicator(instrument);
        const newest = snapshots.filter((item) => validDate(item.tradeDate)).sort((a, b) => b.tradeDate.localeCompare(a.tradeDate))[0];
        if (newest) {
          fromCsindex = pickMetricObservations([
            ['pe_official', newest.peCalcShare], ['pe_official_total_share', newest.peTotalShare],
            ['dividend_yield', newest.dividendCalcShare], ['dividend_yield_total_share', newest.dividendTotalShare],
          ].map(([metricKey, value]) => ({ metricKey, value, asOfDate: newest.tradeDate })), instrument, 'csindex', 'xls');
        }
      } catch (error) { row.sourceErrors.csindex = String(error?.message ?? error).slice(0, 200); }
    }
    const official = instrument.type === 'INDEX' ? officialSnapshot.find((item) => item.indexName === instrument.name) : null;
    const fromOfficial = official ? pickMetricObservations([
      ['pe', official.peTtm], ['pe_official_static', official.pe], ['pb', official.pb], ['dividend_yield', official.dividendYield],
    ].map(([metricKey, value]) => ({ metricKey, value, asOfDate: official.tradeDate })), instrument, 'csindex', 'official') : {};
    if (officialError && instrument.type === 'INDEX') row.sourceErrors.official = officialError;
    row.sources = { stored, tencent: fromTencent, eastmoney: fromEastmoney, csindex: fromCsindex, official: fromOfficial };
    const check = (metric, label, left, right) => {
      if (!left && !right) return;
      row.checks.push({ metric, label, ...compareMetricObservations(left, right) });
    };
    for (const metric of ['pe', 'pb', 'roe', 'dividend_yield', 'ps']) {
      check(metric, `${metric}（库内 vs 腾讯）`, stored[metric], fromTencent[metric]);
      check(metric, `${metric}（库内 vs 东财）`, stored[metric], fromEastmoney[metric]);
      check(metric, `${metric}（腾讯 vs 东财）`, fromTencent[metric], fromEastmoney[metric]);
    }
    for (const metric of ['pe', 'pb', 'pe_official_static', 'dividend_yield']) {
      check(metric, `${metric}（库内 vs 官方 JSON）`, stored[metric], fromOfficial[metric]);
    }
    for (const metric of ['pe_official', 'pe_official_total_share', 'dividend_yield', 'dividend_yield_total_share']) {
      check(metric, `${metric}（库内 vs 官方 XLS）`, stored[metric], fromCsindex[metric]);
    }
    check('pe', 'pe（中证 PE2 vs 腾讯报价）', fromCsindex.pe_official, fromTencent.pe);
    report.push(row);
  }
  return report;
}

const fmt = (observation) => observation?.value === null || observation?.value === undefined ? '—'
  : `${observation.value.toFixed(2)}（${observation.asOfDate ?? '日期缺失'}；${observation.provider ?? '来源缺失'}）`;
const cell = (value) => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderAuditReport(report, sourceState) {
  const lines = ['# 估值指标多源核查报告', '', `状态目录：${sourceState}（只读事务快照）`,
    `标的数：${report.length}　生成时间：${new Date().toISOString()}`, '',
    '| 代码 | 名称 | 类型 | 库内 PE | 腾讯 PE | 东财 PE | 官方滚动 PE | 库内 PE2 | 官方 PE2 | 官方 PE1 | 库内 PB | 腾讯 PB | 东财 PB | 官方 PB | 库内股息率 | XLS 股息率 | JSON 股息率 | 库内 ROE | 东财 ROE |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const row of report) {
    const s = row.sources;
    lines.push(`| ${[row.code, row.name, row.type,
      fmt(s.stored.pe), fmt(s.tencent.pe), fmt(s.eastmoney.pe), fmt(s.official.pe), fmt(s.stored.pe_official), fmt(s.csindex.pe_official), fmt(s.csindex.pe_official_total_share),
      fmt(s.stored.pb), fmt(s.tencent.pb), fmt(s.eastmoney.pb), fmt(s.official.pb),
      fmt(s.stored.dividend_yield), fmt(s.csindex.dividend_yield), fmt(s.official.dividend_yield), fmt(s.stored.roe), fmt(s.eastmoney.roe),
    ].map(cell).join(' | ')} |`);
  }
  lines.push('', '## 一致性判定', '', '| 代码 | 名称 | 对比 | 左侧日期 | 右侧日期 | 相对差 | 判定 | 依据 |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of report) for (const check of row.checks) {
    lines.push(`| ${[row.code, row.name, check.label, check.left?.asOfDate, check.right?.asOfDate,
      check.diff === null ? '—' : `${check.diff.toFixed(2)}%`, check.verdict, check.reason].map(cell).join(' | ')} |`);
  }
  lines.push('', '仅明确同日同口径时判定数值差异：绝对相对差 < 1% 为 CONSISTENT；< 5% 为 DIFFERENT；< 10% 为 REVIEW；其余为 CONFLICT。',
    '不同日期、口径不同或未核实、仅有请求日期时使用 NOT_COMPARABLE，且不计算相对差。空白或非有限数值为 MISSING。',
    '指数官方滚动 PE、报价端 PE、PE2、静态 PE 分别保留；股息率历史记录缺少 XLS/JSON 端点血缘时也不宣称可比。',
    '缺失仅表示本轮未取得可用值，不能据此推断数据源没有覆盖。请求失败如下：');
  for (const row of report) for (const [source, error] of Object.entries(row.sourceErrors)) lines.push(`- ${row.code} ${cell(row.name)} / ${source}：${cell(error)}`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const argument = (name, fallback = null) => {
    const index = args.indexOf(name);
    if (index < 0) return fallback;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} 缺少参数`);
    return args[index + 1];
  };
  const sourceState = path.resolve(argument('--state', path.join(os.homedir(), '.plug-funds')));
  const jsonPath = argument('--json');
  const report = await auditMetrics(sourceState);
  console.log(renderAuditReport(report, sourceState));
  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonPath), JSON.stringify(report, null, 2));
    console.log(`\nJSON 明细已写入 ${path.resolve(jsonPath)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(String(error?.message ?? error)); process.exitCode = 1; });
}
