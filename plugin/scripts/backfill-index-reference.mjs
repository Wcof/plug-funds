/** 重放官方原文，补发布日期、关联产品统计及单张 PB。默认 dry-run；--apply 写前备份。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openBackfillState } from './backfill-metrics.mjs';
import { parsePublishDate, parseFundReference, parseCsindexFactsheet } from '../server/src/market/index-reference.ts';
import { listInstruments } from '../server/src/repo/instruments.ts';
import { officialIndexMetricProvider, saveValuationMetric, archiveIndexQuoteMetric, latestValuationMetrics } from '../server/src/repo/market.ts';
import { getIndexReference, saveIndexReference } from '../server/src/repo/index-reference.ts';
import { todayLocal } from '../server/src/ids.ts';
import { shanghaiParts } from '../core/src/calendar.ts';
import { parseCnindexSnapshot, CNINDEX_BASE } from '../server/src/market/cnindex.ts';
import { csindexOfficialCode, CSINDEX_IDENTITIES } from '../server/src/market/index-identities.ts';
import { parseIndexProfile, indexMetricApplicability } from '../server/src/market/index-profile.ts';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const rootUrl = (kind, code) => ({
  cnintro: `https://www.cnindex.com.cn/index-intro?indexcode=${code}`,
  cnfunds: `https://www.cnindex.com.cn/info/fund?indexCode=${code}&pageNum=1&rows=2000`,
  csinfo: `https://www.csindex.com.cn/csindex-home/indexInfo/index-basic-info/${csindexOfficialCode(code)}`,
  csfunds: `https://www.csindex.com.cn/csindex-home/index-list/queryByIndexCode/${csindexOfficialCode(code)}?indexCode=${csindexOfficialCode(code)}`,
  csdetails: `https://www.csindex.com.cn/csindex-home/indexInfo/index-details-data?fileLang=2&indexCode=${csindexOfficialCode(code)}`,
  factsheet: `https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/${csindexOfficialCode(code)}factsheet.pdf`,
})[kind];

export async function planIndexReference({ handle, evidenceDir, today = todayLocal(), extractPdf = async () => { throw new Error('未配置 PDF 提取器'); } }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'manifest.json'), 'utf8'));
  const catalogEntries = Object.entries(manifest).filter(([key]) => /^catalog-part\d+$/.test(key))
    .sort(([a], [b]) => Number(a.slice(12)) - Number(b.slice(12)));
  const catalogPayloads = catalogEntries.map(([, entry]) => {
    if (entry.status !== 'OK' || path.basename(entry.file) !== entry.file) throw new Error('国证目录证据不完整');
    const url = new URL(entry.url);
    if (url.origin !== CNINDEX_BASE || !['/index/queryDay', '/index/indexList'].includes(url.pathname)) throw new Error('国证目录证据 URL 无效');
    const bytes = fs.readFileSync(path.join(evidenceDir, entry.file));
    if (sha(bytes) !== entry.sha256) throw new Error('国证目录原文 SHA256 不匹配');
    return JSON.parse(bytes.toString('utf8'));
  });
  const cnCodes = new Set(catalogPayloads.length >= 3 ? parseCnindexSnapshot(catalogPayloads.slice(1,-1),catalogPayloads[0],catalogPayloads.at(-1),today).rows.map((r) => r.code) : []);
  const report = { generatedAt: new Date().toISOString(), today, rows: [] };
  for (const ins of listInstruments(handle, { type: 'INDEX', active: true })) {
    const errors = [];
    const evidence = [];
    const capturedDate = (kind) => {
      const instant = new Date(manifest[`${ins.code}-${kind}`]?.capturedAt ?? '');
      if (!Number.isFinite(instant.getTime())) throw new Error('资料缺少有效采集时间');
      return shanghaiParts(instant).date;
    };
    const read = (kind) => {
      const entry = manifest[`${ins.code}-${kind}`];
      if (!entry || entry.status !== 'OK') throw new Error(entry?.reason ?? '本次资料未取得');
      if (entry.url !== rootUrl(kind, ins.code) || path.basename(entry.file) !== entry.file) throw new Error('资料 URL 或路径与目标指数不匹配');
      const file = path.join(evidenceDir, entry.file);
      const bytes = fs.readFileSync(file);
      if (sha(bytes) !== entry.sha256) throw new Error('来源原文 SHA256 不匹配');
      evidence.push({ url: entry.url, sha256: entry.sha256 });
      return kind === 'factsheet' ? { file, bytes } : JSON.parse(bytes.toString('utf8'));
    };
    // 国证 intro 仅在真实完整目录中确认代码存在后选择；其他代码使用中证自带身份的基本资料。
    const isCn = cnCodes.has(ins.code);
    const provider = isCn ? 'cnindex' : 'csindex';
    const oldReference = getIndexReference(handle, ins.id);
    let profile = oldReference?.profile;
    let publishDate = null, funds = null, factsheet = null;
    let basic = null;
    try { basic = read(isCn ? 'cnintro' : 'csinfo'); publishDate = parsePublishDate(basic, provider, ins.code, today); }
    catch (error) { errors.push({ field: 'publishDate', reason: error.message }); }
    try {
      const kind = isCn ? 'cnintro' : 'csinfo';
      const entry = manifest[`${ins.code}-${kind}`];
      profile = { ...parseIndexProfile(basic, provider, ins.code),
        evidence: { url: entry.url, sha256: entry.sha256, observedDate: capturedDate(kind) } };
    }
    catch (error) { errors.push({ field: 'profile', reason: error.message }); }
    try { funds = parseFundReference(read(isCn ? 'cnfunds' : 'csfunds'), provider, ins.code, capturedDate(isCn ? 'cnfunds' : 'csfunds')); }
    catch (error) { errors.push({ field: 'fundOn/fundOff', reason: error.message }); }
    if (!isCn) {
      try {
        const details = read('csdetails');
        const selected = details?.data?.['指数单张']?.find((row) => row.fileName === `${csindexOfficialCode(ins.code)}factsheet.pdf`);
        if (!selected || selected.filePath !== rootUrl('factsheet', ins.code)) throw new Error('资料目录未提供预期单张链接，独立核验官网固定路径文件');
      } catch (error) { errors.push({ field: 'factsheetCatalog', reason: error.message }); }
      try {
        const document = read('factsheet');
        const text = await extractPdf(document.file);
        factsheet = parseCsindexFactsheet(text, ins.code, today, profile?.currency ?? 'CNY');
        if (!profile) profile = { assetClass: 'UNKNOWN', provider,
          classification: { field: 'factsheet', value: null, reason: '本次基本资料未取得，不能只凭单张标题判定资产类别' },
          currency: factsheet.currency, currencyReason: '已核验同码官方单张货币栏；指数点位计价币，不是账本金额币种',
          evidence: { url: rootUrl('factsheet', ins.code), sha256: sha(document.bytes), observedDate: capturedDate('factsheet') } };
        if (!publishDate && factsheet.publishDate) publishDate = factsheet.publishDate;
        else if (publishDate && factsheet.publishDate && publishDate !== factsheet.publishDate) {
          errors.push({ field: 'publishDate', reason: `官方基本资料 ${publishDate} 与单张 ${factsheet.publishDate} 不一致` });
          publishDate = null;
        }
      } catch (error) { errors.push({ field: 'factsheet', reason: error.message }); }
    }
    const recordedDates = evidence.map((e) => Object.values(manifest).find((entry) => entry.url === e.url && entry.sha256 === e.sha256)?.capturedAt)
      .filter((v) => typeof v === 'string').sort();
    const observedDate = recordedDates.length ? shanghaiParts(new Date(recordedDates.at(-1))).date : today;
    const reference = { code: ins.code, provider, observedDate, publishDate,
      ...(CSINDEX_IDENTITIES[ins.code] ? { identity: CSINDEX_IDENTITIES[ins.code] } : {}),
      ...(profile ? { profile } : {}),
      publishStatus: publishDate ? { state: 'VALID', reason: null } : { state: 'MISSING', reason: errors.find((e) => e.field === 'publishDate')?.reason ?? '官方基本资料未列出发布日期' },
      funds: funds ?? oldReference?.funds ?? null,
      unavailable: {
        ps: `${provider} 本次指数目录/基本资料${factsheet ? '及官方单张' : ''}未提供 PS；没有同日同口径的成分股收入聚合数据，不由 PE/PB 换算`,
        roe: `${provider} 本次资料未提供前 3 个财年的指数 ROE；缺少对应报告期的成分股利润和净资产数据，不用 PB/PE 推算`,
        ...(funds ? {} : { funds: errors.find((e) => e.field === 'fundOn/fundOff')?.reason ?? '官方产品目录缺失' }),
        pb: factsheet ? (factsheet.pb === null ? `中证 ${factsheet.date} 官方单张市净率栏为缺失符号，保留空值` : `中证 ${factsheet.date} 月度单张提供 PB，不能视为当前日频估值`)
          : isCn ? '本次国证完整目录未返回该指数的有效 PB，未用零值补齐' : errors.find((e) => e.field === 'factsheet')?.reason ?? '未取得可核实 PB 的官方单张',
        ...(factsheet ? {} : { factsheet: errors.find((e) => e.field === 'factsheet')?.reason ?? '国证目录仅有本期估值，没有同源 PB 历史' }),
      }, evidence };
    const desired = [];
    if (factsheet && !indexMetricApplicability(profile, 'pb')) {
      const primaryPb = officialIndexMetricProvider(handle, ins.id, 'pb', today);
      const base = { asOfDate: factsheet.date, provider: 'csindex-factsheet', quality: factsheet.quality };
      if (factsheet.pb !== null && (!primaryPb || primaryPb === 'csindex-factsheet')) desired.push({ ...base, metricKey: 'pb', value: String(factsheet.pb) });
      else if (factsheet.pb !== null) desired.push({ ...base, metricKey: 'pb_factsheet', value: String(factsheet.pb) });
      if (factsheet.pe !== null) desired.push({ ...base, metricKey: 'pe_factsheet', value: String(factsheet.pe) });
      if (factsheet.dividendYield !== null) {
        desired.push({ ...base, metricKey: 'dividend_yield_factsheet', value: String(factsheet.dividendYield) });
        const existing = latestValuationMetrics(handle, ins.id, today).find((m) => m.metricKey === 'dividend_yield');
        if (!existing || existing.provider === 'csindex-factsheet') desired.push({ ...base, metricKey: 'dividend_yield', value: String(factsheet.dividendYield) });
      }
    }
    const changes = desired.flatMap((metric) => {
      const old = handle.db.prepare('SELECT * FROM valuation_metrics WHERE instrument_id=? AND metric_key=? AND as_of_date=?')
        .get(ins.id, metric.metricKey, metric.asOfDate) ?? null;
      return !old || old.value !== metric.value || old.provider !== metric.provider || old.quality !== metric.quality ? [{ before: old, after: metric }] : [];
    });
    report.rows.push({ instrumentId: ins.id, code: ins.code, name: ins.name, previousPublishDate: ins.foundedDate,
      previousProfile: oldReference?.profile ?? null,
      nameChanged: Boolean(CSINDEX_IDENTITIES[ins.code] && CSINDEX_IDENTITIES[ins.code].name !== ins.name),
      canonicalName: CSINDEX_IDENTITIES[ins.code]?.name ?? ins.name,
      publishChanged: publishDate !== null && publishDate !== ins.foundedDate,
      referenceChanged: JSON.stringify(oldReference) !== JSON.stringify(reference), reference, desired, changes, errors, factsheet });
  }
  return report;
}

export function applyIndexReference(handle, report) {
  handle.db.exec('BEGIN IMMEDIATE;');
  try {
    for (const row of report.rows) {
      if (row.nameChanged) handle.db.prepare('UPDATE instruments SET name=?, updated_at=? WHERE id=?')
        .run(row.canonicalName, new Date().toISOString(), row.instrumentId);
      if (row.publishChanged) handle.db.prepare('UPDATE instruments SET founded_date=?, updated_at=? WHERE id=?')
        .run(row.reference.publishDate, new Date().toISOString(), row.instrumentId);
      if (row.referenceChanged) saveIndexReference(handle, row.instrumentId, row.reference);
      if (row.desired.some((m) => m.metricKey === 'pb')) archiveIndexQuoteMetric(handle, row.instrumentId, 'pb');
      for (const metric of row.desired) saveValuationMetric(handle, { instrumentId: row.instrumentId, ...metric });
      if (row.nameChanged || row.publishChanged || row.referenceChanged || row.changes.some((c) => c.before)) {
        const note = JSON.stringify({ kind: 'index-reference-update', code: row.code, instrumentId: row.instrumentId,
          previousPublishDate: row.previousPublishDate, publishDate: row.reference.publishDate, changes: row.changes,
          previousName: row.name, name: row.canonicalName ?? row.name, identity: row.reference.identity ?? null,
          previousProfile: row.previousProfile ?? null, profile: row.reference.profile ?? null,
          evidence: row.reference.evidence });
        const now = new Date().toISOString();
        handle.db.prepare('INSERT OR IGNORE INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)')
          .run(`reference-${sha(note)}`, now, now, 1, 1, 0, note);
      }
    }
    handle.db.exec('COMMIT; PRAGMA optimize;');
  } catch (error) { handle.db.exec('ROLLBACK;'); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  if (!arg('--evidence')) throw new Error('需指定 collect-index-reference.mjs 输出的 --evidence 目录');
  const evidenceDir = path.resolve(arg('--evidence'));
  const handle = openBackfillState(path.resolve(arg('--state', path.join(os.homedir(), '.plug-funds'))), args.includes('--apply'));
  try {
    const python = arg('--python', 'python3');
    const extractPdf = async (file) => {
      const { stdout } = await promisify(execFile)(python, ['-c', 'import sys;from pypdf import PdfReader;print("\\n".join(p.extract_text(extraction_mode="layout") or "" for p in PdfReader(sys.argv[1]).pages))', file],
        { encoding: 'utf8', timeout: 30000, maxBuffer: 3000000 });
      return stdout;
    };
    const report = await planIndexReference({ handle, evidenceDir, extractPdf });
    report.apply = args.includes('--apply');
    if (report.apply) {
      const backupDir = path.join(handle.dirs.data, 'backups'); fs.mkdirSync(backupDir, { recursive: true });
      report.backupPath = path.join(backupDir, `pre-index-reference-${Date.now()}.db`);
      handle.db.prepare('VACUUM INTO ?').run(report.backupPath);
      applyIndexReference(handle, report);
    }
    const output = path.resolve(arg('--json', path.join(evidenceDir, `reference-${report.apply ? 'apply' : 'plan'}-${Date.now()}.json`)));
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: output, instruments: report.rows.length,
      publishChanged: report.rows.filter((r) => r.publishChanged).length,
      funds: report.rows.filter((r) => r.reference.funds).length, factsheets: report.rows.filter((r) => r.factsheet).length,
      metricChanges: report.rows.reduce((n,r) => n + r.changes.length, 0), backupPath: report.backupPath ?? null }, null, 2));
  } finally { handle.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
