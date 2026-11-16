/** 国证官方目录估值回填。默认只读；--apply 写前 VACUUM 备份，整批事务，原文 SHA256 留证。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openBackfillState } from './backfill-metrics.mjs';
import { fetchCnindexSnapshot, cnindexMetrics } from '../server/src/market/cnindex.ts';
import { saveCnindexMetrics } from '../server/src/services/cnindex-valuation.ts';
import { listInstruments } from '../server/src/repo/instruments.ts';
import { latestValuationMetrics, officialIndexMetricProvider } from '../server/src/repo/market.ts';
import { todayLocal } from '../server/src/ids.ts';

export function backfillCnindex({ handle, snapshot, today = todayLocal(), apply = false }) {
  const report = { generatedAt: new Date().toISOString(), apply, today, tradeDate: snapshot.tradeDate,
    sourceTotal: snapshot.total, rows: [], counts: { covered: 0, inserted: 0, changed: 0, matched: 0, archived: 0 } };
  if (snapshot.tradeDate > today) throw new Error('国证快照日期在未来');
  if (apply) handle.db.exec('BEGIN IMMEDIATE;');
  else handle.db.exec('BEGIN;');
  try {
    const source = new Map(snapshot.rows.map((row) => [row.code, row]));
    for (const instrument of listInstruments(handle, { type: 'INDEX', active: true })) {
      const data = instrument.market === 'SZ' ? source.get(instrument.code) : null;
      const row = { code: instrument.code, name: instrument.name, sourceName: data?.name ?? null,
        status: !data ? 'NOT_IN_CATALOG' : data.issues.length ? 'SUSPECT' : 'AVAILABLE',
        reason: !data ? '本次完整国证目录没有该代码；不能推定其他官方渠道也无数据' : data.issues.join('；') || null,
        missing: data ? ['pe', 'pb', 'peStatic', 'totalMarketValue'].filter((key) => data[key] === null) : [],
        before: latestValuationMetrics(handle, instrument.id, today), changes: [], archives: [], preserved: [], desired: [] };
      if (data && !data.issues.length) {
        report.counts.covered++;
        for (const metric of cnindexMetrics(data, snapshot.tradeDate, today)) {
          if (officialIndexMetricProvider(handle, instrument.id, metric.metricKey, today) === 'csindex') {
            row.preserved.push({ metricKey: metric.metricKey, reason: '已有中证官方序列，保留其来源，不拼接国证口径' });
            continue;
          }
          const previous = handle.db.prepare('SELECT * FROM valuation_metrics WHERE instrument_id=? AND metric_key=? AND as_of_date=?')
            .get(instrument.id, metric.metricKey, metric.asOfDate) ?? null;
          const archived = ['pe', 'pb'].includes(metric.metricKey) && previous && !['csindex', 'cnindex'].includes(previous.provider);
          const kind = !previous || archived ? 'inserted' : previous.value === metric.value && previous.provider === 'cnindex' && previous.quality === metric.quality ? 'matched' : 'changed';
          report.counts[kind]++;
          row.desired.push(metric);
          if (kind !== 'matched') row.changes.push({ kind, before: previous, after: { ...metric, provider: 'cnindex' } });
          if (['pe', 'pb'].includes(metric.metricKey)) {
            const old = handle.db.prepare("SELECT * FROM valuation_metrics WHERE instrument_id=? AND metric_key=? AND provider NOT IN ('csindex','cnindex')")
              .all(instrument.id, metric.metricKey);
            row.archives.push(...old.map((m) => ({ before: m, targetKey: `${metric.metricKey}_quote`, reason: '来源口径隔离；差值不等同数据错误' })));
          }
        }
        report.counts.archived += row.archives.length;
        if (apply) saveCnindexMetrics(handle, instrument.id, row.desired);
      }
      report.rows.push(row);
    }
    handle.db.exec(apply ? 'COMMIT;' : 'ROLLBACK;');
    if (apply) handle.db.exec('PRAGMA optimize;');
    return report;
  } catch (error) { handle.db.exec('ROLLBACK;'); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const apply = args.includes('--apply');
  const evidenceDir = path.resolve(arg('--evidence', `.tmp/cnindex-backfill-${Date.now()}`));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const evidence = [];
  const load = async (url) => {
    // curl 继承本机 HTTPS_PROXY；只读取官方公开端点，不带 cookie 或账号凭据。
    const { stdout } = await promisify(execFile)('curl', ['-fLsS', '--max-time', '20', '--max-filesize', '10485760',
      '-A', 'Mozilla/5.0', '-H', 'Referer: https://www.cnindex.com.cn/', url], { encoding: 'utf8', timeout: 25000, maxBuffer: 10485760 });
    const sha256 = createHash('sha256').update(stdout).digest('hex');
    const filename = `${sha256}.json`;
    if (!fs.existsSync(path.join(evidenceDir, filename))) fs.writeFileSync(path.join(evidenceDir, filename), stdout, { flag: 'wx' });
    evidence.push({ url, capturedAt: new Date().toISOString(), sha256, file: filename });
    return JSON.parse(stdout);
  };
  const today = todayLocal();
  const snapshot = await fetchCnindexSnapshot(today, load);
  const handle = openBackfillState(path.resolve(arg('--state', path.join(os.homedir(), '.plug-funds'))), apply);
  try {
    let backupPath = null;
    if (apply) {
      const dir = path.join(handle.dirs.data, 'backups'); fs.mkdirSync(dir, { recursive: true });
      backupPath = path.join(dir, `pre-cnindex-${Date.now()}.db`);
      handle.db.prepare('VACUUM INTO ?').run(backupPath);
    }
    const report = { ...backfillCnindex({ handle, snapshot, today, apply }), backupPath, evidence };
    const output = path.resolve(arg('--json', path.join(evidenceDir, `${apply ? 'apply' : 'dry-run'}-${Date.now()}.json`)));
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ apply, tradeDate: report.tradeDate, instruments: report.rows.length,
      counts: report.counts, backupPath, report: output }, null, 2));
  } finally { handle.db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
