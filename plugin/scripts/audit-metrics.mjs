/**
 * 估值指标多源核查：同一标的、同一指标，把各数据源的真实返回值摊开对比。
 *
 * 目的不是「挑一个信哪个」，而是让口径差异显式：
 * - 腾讯 PE 是报价端 TTM；东财 f164 也是 TTM，两者应接近（<1%）；
 * - 中证官网是官方加权口径（PE2 = 计算用股本），与报价端差 1–3% 属正常，
 *   因为样本日不同、股本口径不同 —— 报告里标「口径差异」而不是「错误」；
 * - 差异 >5% 才标「需复核」，>10% 标「冲突」。
 *
 * 用法：
 *   node plugin/scripts/audit-metrics.mjs                     # 用当前 ~/.plug-funds 的只读副本
 *   node plugin/scripts/audit-metrics.mjs --state <dir>        # 指定状态目录
 *   node plugin/scripts/audit-metrics.mjs --json out.json      # 另存机器可读结果
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');

const args = process.argv.slice(2);
const stateIndex = args.indexOf('--state');
const sourceState = stateIndex >= 0
  ? path.resolve(args[stateIndex + 1])
  : path.join(os.homedir(), '.plug-funds');
const jsonIndex = args.indexOf('--json');
const jsonPath = jsonIndex >= 0 ? path.resolve(args[jsonIndex + 1]) : null;

if (!fs.existsSync(sourceState)) {
  console.error(`状态目录不存在：${sourceState}`);
  process.exit(1);
}

// 复制一份再打开：openState 会跑迁移，绝不能动用户的真实库
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-audit-'));
fs.cpSync(sourceState, workDir, { recursive: true });
process.env.PLUG_FUNDS_STATE_DIR = workDir;

const { openState, resolveStateDirs } = await import(path.join(repoRoot, 'plugin/server/src/db.ts'));
const { listInstruments } = await import(path.join(repoRoot, 'plugin/server/src/repo/instruments.ts'));
const { latestValuationMetrics } = await import(path.join(repoRoot, 'plugin/server/src/repo/market.ts'));
const { createTencentProvider } = await import(path.join(repoRoot, 'plugin/server/src/market/tencent.ts'));
const { createEastmoneyProvider } = await import(path.join(repoRoot, 'plugin/server/src/market/eastmoney.ts'));
const { fetchCsindexIndicator } = await import(path.join(repoRoot, 'plugin/server/src/market/csindex.ts'));

const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: workDir });
const handle = openState(dirs, {});
const instruments = listInstruments(handle, { active: true });
const tencent = createTencentProvider();
const eastmoney = createEastmoneyProvider();

const pick = (rows, keys) => {
  const map = {};
  for (const row of rows ?? []) {
    if (!keys.includes(row.metricKey)) continue;
    if (row.value === null || row.value === undefined) continue;
    map[row.metricKey] = Number(row.value);
  }
  return map;
};

const pctDiff = (a, b) => (a === undefined || b === undefined || a === 0 || b === 0 ? null : ((b - a) / a) * 100);
const verdict = (diff) => {
  if (diff === null) return '—';
  const abs = Math.abs(diff);
  if (abs < 1) return '一致';
  if (abs < 5) return '口径差异';
  if (abs < 10) return '需复核';
  return '冲突';
};
const fmt = (value, digits = 2) => (value === undefined || value === null ? '—' : Number(value).toFixed(digits));

const report = [];
for (const instrument of instruments) {
  const row = { code: instrument.code, name: instrument.name, type: instrument.type, sources: {}, checks: [] };
  const stored = pick(latestValuationMetrics(handle, instrument.id), ['pe', 'pb', 'roe', 'dividend_yield', 'ps', 'pe_official', 'pe_official_total_share', 'dividend_yield_total_share']);

  let fromTencent = {};
  try { fromTencent = pick(await tencent.fetchMetrics(instrument), ['pe', 'pb', 'roe', 'dividend_yield']); } catch (error) { row.tencentError = String(error.message).slice(0, 80); }
  let fromEastmoney = {};
  try { fromEastmoney = pick(await eastmoney.fetchMetrics(instrument), ['pe', 'pb', 'roe', 'dividend_yield']); } catch (error) { row.eastmoneyError = String(error.message).slice(0, 80); }
  let fromCsindex = {};
  try {
    const snapshots = await fetchCsindexIndicator(instrument);
    if (snapshots.length > 0) {
      const newest = snapshots[0];
      row.csindexDate = newest.tradeDate;
      if (newest.peCalcShare !== null) fromCsindex.pe = newest.peCalcShare;
      if (newest.peTotalShare !== null) fromCsindex.peTotalShare = newest.peTotalShare;
      if (newest.dividendCalcShare !== null) fromCsindex.dividendYield = newest.dividendCalcShare;
      if (newest.dividendTotalShare !== null) fromCsindex.dividendYieldTotalShare = newest.dividendTotalShare;
    }
  } catch (error) { row.csindexError = String(error.message).slice(0, 80); }

  row.sources = { stored, tencent: fromTencent, eastmoney: fromEastmoney, csindex: fromCsindex };

  for (const metric of ['pe', 'pb', 'roe']) {
    const a = fromTencent[metric] ?? fromEastmoney[metric];
    const b = stored[metric];
    if (a === undefined || b === undefined) continue;
    const diff = pctDiff(b, a);
    row.checks.push({ metric, label: `${metric}（库内 vs 现取 ${fromTencent[metric] !== undefined ? '腾讯' : '东财'}）`, diff, verdict: verdict(diff) });
  }
  if (fromCsindex.pe !== undefined && fromTencent.pe !== undefined) {
    const diff = pctDiff(fromTencent.pe, fromCsindex.pe);
    row.checks.push({ metric: 'pe', label: 'pe（中证官方 PE2 vs 腾讯 TTM）', diff, verdict: verdict(diff) });
  }
  report.push(row);
}

/* ---------------- 输出 ---------------- */
const lines = [];
lines.push('# 估值指标多源核查报告');
lines.push('');
lines.push(`状态目录：${sourceState}（只读副本）`);
lines.push(`标的数：${report.length}　生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)}`);
lines.push('');
lines.push('| 代码 | 名称 | 类型 | 库内 PE | 腾讯 PE | 东财 PE | 库内官方 PE2 | 中证 PE2 | 中证 PE1 | 库内 PB | 腾讯 PB | 东财 PB | 库内股息率 | 中证股息率2 | 库内 ROE | 东财 ROE |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const row of report) {
  const s = row.sources;
  lines.push([
    row.code, row.name, row.type,
    fmt(s.stored.pe), fmt(s.tencent.pe), fmt(s.eastmoney.pe), fmt(s.stored.pe_official), fmt(s.csindex.pe), fmt(s.csindex.peTotalShare),
    fmt(s.stored.pb), fmt(s.tencent.pb), fmt(s.eastmoney.pb),
    fmt(s.stored.dividend_yield), fmt(s.csindex.dividendYield),
    fmt(s.stored.roe), fmt(s.eastmoney.roe),
  ].join(' | ').replace(/^/, '| ').concat(' |'));
}
lines.push('');
lines.push('## 一致性判定');
lines.push('');
const checks = report.flatMap((row) => row.checks.map((check) => ({ code: row.code, name: row.name, ...check })));
if (checks.length === 0) lines.push('（无可比对样本：本次未取到两源以上的同指标数值）');
else {
  lines.push('| 代码 | 名称 | 对比 | 相对差 | 判定 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const check of checks) {
    lines.push(`| ${check.code} | ${check.name} | ${check.label} | ${check.diff === null ? '—' : `${check.diff > 0 ? '+' : ''}${check.diff.toFixed(2)}%`} | ${check.verdict} |`);
  }
}
lines.push('');
lines.push('判定标准：|<1%| 一致；|<5%| 口径差异（样本日 / 股本口径不同）；|<10%| 需复核；|≥10%| 冲突。');
lines.push('注意：中证 PE1 为总股本口径、PE2 为计算用股本口径；腾讯 / 东财为报价端 TTM。同一指标不同口径本就不该完全相等。');

const text = lines.join('\n');
console.log(text);
if (jsonPath) {
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`\nJSON 明细已写入 ${jsonPath}`);
}
