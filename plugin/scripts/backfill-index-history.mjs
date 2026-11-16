/** 官方指数收盘回填与逐日核对。默认 dry-run；--apply 一致备份后事务写入。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openBackfillState } from './backfill-metrics.mjs';
import { listInstruments } from '../server/src/repo/instruments.ts';
import { getIndexReference } from '../server/src/repo/index-reference.ts';
import { indexHistoryUrl, parseIndexHistory } from '../server/src/market/index-history.ts';
import { planIndexHistory, saveIndexHistory, hasIndexYearEndBase, indexYearEndRange } from '../server/src/services/index-history.ts';
import { todayLocal } from '../server/src/ids.ts';
import { validReferenceDate } from '../server/src/market/index-reference.ts';
import { effectiveHistoryPoints } from '../server/src/repo/market.ts';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function reconcileIndexHistories(handle, records, today, apply = false) {
  const result = { today, apply, rows: [], counts: { instruments: records.length, inserted: 0, revised: 0, comparisons: 0, conflicts: 0, filledYearEnd: 0 } };
  if (apply) handle.db.exec('BEGIN IMMEDIATE;');
  try {
    for (const record of records) {
      const { instrument, points, ...evidence } = record;
      const beforeHasBase = hasIndexYearEndBase(handle, instrument.id, today);
      const planned = planIndexHistory(handle, instrument.id, points);
      const counts = { received: points.length, inserted: planned.changes.filter((r) => !r.before).length,
        revised: planned.changes.filter((r) => r.before).length, comparisons: planned.comparisons.length,
        conflicts: planned.comparisons.filter((r) => r.conflict).length };
      if (apply) saveIndexHistory(handle, instrument.id, points);
      const baseRange = indexYearEndRange(today);
      const basePoints = effectiveHistoryPoints(handle, instrument.id, 'INDEX', baseRange.begin, baseRange.end, today);
      const conflicts = new Set([...basePoints, ...planned.writes].filter((p) => p.quality === 'CONFLICT').map((p) => p.tradingDate));
      const usableBase = [...basePoints, ...planned.writes].some((p) => p.tradingDate >= baseRange.begin && p.tradingDate <= baseRange.end
        && p.priceType !== 'REALTIME_PRICE' && !['CONFLICT', 'MISSING'].includes(p.quality)
        && Number.isFinite(Number(p.value)) && Number(p.value) > 0
        && (p.priceType === 'MANUAL_PRICE' || !conflicts.has(p.tradingDate)));
      const afterHasBase = apply ? hasIndexYearEndBase(handle, instrument.id, today) : usableBase;
      result.rows.push({ code: instrument.code, name: instrument.name, instrumentId: instrument.id, ...evidence,
        beforeHasBase, afterHasBase, ...counts, changes: planned.changes,
        comparisonRange: planned.comparisons.length ? {
          minRelativeDifference: Math.min(...planned.comparisons.map((r) => r.relativeDifference)),
          maxRelativeDifference: Math.max(...planned.comparisons.map((r) => r.relativeDifference)),
        } : null,
        conflictEvidence: planned.comparisons.filter((r) => r.conflict),
      });
      for (const key of ['inserted', 'revised', 'comparisons', 'conflicts']) result.counts[key] += counts[key];
      if (!beforeHasBase && afterHasBase) result.counts.filledYearEnd++;
    }
    if (apply) handle.db.exec('COMMIT; PRAGMA optimize;');
    return result;
  } catch (error) { if (apply) handle.db.exec('ROLLBACK;'); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const today = todayLocal();
  const yesterday = new Date(`${today}T00:00:00Z`); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const range = { begin: arg('--begin', `${Number(today.slice(0, 4)) - 1}-01-01`), end: arg('--end', yesterday.toISOString().slice(0, 10)) };
  if (!validReferenceDate(range.begin, range.end) || !validReferenceDate(range.end, yesterday.toISOString().slice(0, 10))) throw new Error('回填只接受已结束交易日区间');
  const evidenceDir = path.resolve(arg('--evidence', `.tmp/index-history-${Date.now()}`));
  fs.mkdirSync(evidenceDir, { recursive: true });
  const manifestFile = path.join(evidenceDir, 'manifest.json');
  const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : {};
  const handle = openBackfillState(path.resolve(arg('--state', path.join(os.homedir(), '.plug-funds'))), args.includes('--apply'));
  try {
    const codes = arg('--codes')?.split(',');
    const instruments = listInstruments(handle, { type: 'INDEX', active: true }).filter((ins) => !codes || codes.includes(ins.code));
    const records = []; let cursor = 0; const blocked = new Map();
    const read = async (instrument) => {
      const source = getIndexReference(handle, instrument.id)?.provider ?? (instrument.code.startsWith('000') ? 'csindex' : 'cnindex');
      if (!['csindex', 'cnindex'].includes(source)) throw new Error('官方历史来源不明确');
      const url = indexHistoryUrl(source, instrument.code, range);
      let entry = manifest[instrument.code];
      try {
        if (entry?.status === 'OK') {
          if (entry.url !== url || path.basename(entry.file) !== entry.file) throw new Error('缓存 URL / 路径与请求不符；请指定新的证据目录');
        } else {
          if (args.includes('--offline')) throw new Error(entry?.reason ?? '离线证据未包含该指数，未重新请求');
          if ((blocked.get(source) ?? 0) >= 3) throw new Error('同一官方日线端点连续三次 403，停止后续请求');
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const { stdout } = await promisify(execFile)('curl', ['-fLsS', '--max-time', '20', '--max-filesize', '10000000', '-A', 'Mozilla/5.0', url], { timeout: 22000, maxBuffer: 10000000 });
          JSON.parse(stdout);
          entry = { code: instrument.code, source, url, range, file: `${instrument.code}.json`, observedAt: new Date().toISOString(), sha256: sha(stdout), status: 'OK' };
          fs.writeFileSync(path.join(evidenceDir, entry.file), stdout);
          manifest[instrument.code] = entry; blocked.set(source, 0);
        }
        const bytes = fs.readFileSync(path.join(evidenceDir, entry.file));
        if (sha(bytes) !== entry.sha256) throw new Error('原文 SHA-256 不匹配');
        const points = parseIndexHistory(JSON.parse(bytes.toString('utf8')), source, instrument, range, today, entry.observedAt);
        records.push({ instrument, points, source, url, sha256: entry.sha256, observedAt: entry.observedAt,
          status: points.length ? 'AVAILABLE' : 'EMPTY', reason: points.length ? null : '官方日线返回空数组，未填充价格' });
      } catch (error) {
        const reason = String(error.message);
        if (/403/.test(reason)) blocked.set(source, (blocked.get(source) ?? 0) + 1);
        records.push({ instrument, points: [], source, url, status: 'UNVERIFIED', reason });
        if (entry?.status !== 'OK' && !args.includes('--offline')) manifest[instrument.code] = { code: instrument.code, source, url, range,
          status: reason.includes('停止后续请求') ? 'NOT_ATTEMPTED' : 'FETCH_FAILED', reason };
      }
      const temp = `${manifestFile}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n'); fs.renameSync(temp, manifestFile);
    };
    // 对公开官方端点串行低频；离线重放直接读取本地证据。
    while (cursor < instruments.length) await read(instruments[cursor++]);
    records.sort((a, b) => a.instrument.code.localeCompare(b.instrument.code));
    let backupPath = null;
    if (args.includes('--apply')) {
      const backupDir = path.join(handle.dirs.data, 'backups'); fs.mkdirSync(backupDir, { recursive: true });
      backupPath = path.join(backupDir, `pre-index-history-${Date.now()}.db`);
      handle.db.prepare('VACUUM INTO ?').run(backupPath);
    }
    const report = { generatedAt: new Date().toISOString(), range, backupPath, ...reconcileIndexHistories(handle, records, today, args.includes('--apply')) };
    const output = path.resolve(arg('--json', path.join(evidenceDir, `${report.apply ? 'apply' : 'plan'}.json`)));
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, ...report.counts, unavailable: report.rows.filter((r) => r.status !== 'AVAILABLE').length, backupPath }, null, 2));
  } finally { handle.db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
