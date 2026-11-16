import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { auditMetrics, compareMetricObservations, parseMetricValue, pickMetricObservations,
  readStoredAudit, renderAuditReport } from '../scripts/audit-metrics.mjs';

const instrument = { type: 'INDEX' };
const observation = (value: unknown, asOfDate = '2026-11-16', definition: string | null = 'CSI_INDEX_ROLLING_PE') =>
  ({ value, asOfDate, provider: 'csindex', definition });

test('多源审计空白及非法数值为缺失，合法 0 不丢弃', () => {
  for (const value of ['', '   ', '\n', '-', 'NaN', 'Infinity', '0x10', null, undefined, false, {}, Infinity]) {
    assert.equal(parseMetricValue(value), null);
  }
  assert.equal(parseMetricValue('0'), 0);
  assert.equal(parseMetricValue(' 12.3 '), 12.3);
  const result = compareMetricObservations(observation(' '), observation(12));
  assert.equal(result.verdict, 'MISSING');
  assert.equal(result.diff, null);
});

test('多源审计异日、非法日期和未知口径不计算百分差', () => {
  for (const right of [observation(99, '2026-11-13'), observation(99, '2026-02-30'),
    observation(99, '2026-11-16', null), { ...observation(99), dateBasis: 'request-date' }]) {
    const result = compareMetricObservations(observation(10), right);
    assert.equal(result.verdict, 'NOT_COMPARABLE');
    assert.equal(result.comparable, false);
    assert.equal(result.diff, null);
  }
});

test('指数官方滚动 PE 与报价 PE、PE2 与 TTM 即使同日也不可比', () => {
  const rows = (metricKey: string, value: string) => [{ metricKey, value, asOfDate: '2026-11-16' }];
  const official = pickMetricObservations(rows('pe', '13.14'), instrument, 'csindex').pe;
  const quote = pickMetricObservations(rows('pe', '100'), instrument, 'tencent').pe;
  const pe2 = pickMetricObservations(rows('pe_official', '13.14'), instrument, 'csindex', 'xls').pe_official;
  for (const [left, right] of [[official, quote], [pe2, quote], [pe2, official]]) {
    const result = compareMetricObservations(left, right);
    assert.equal(result.verdict, 'NOT_COMPARABLE');
    assert.equal(result.diff, null);
    assert.equal(result.left.asOfDate, '2026-11-16');
    assert.ok(result.left.provider);
  }
});

test('同日同口径才使用差异阈值，零分母与已有冲突保留审计依据', () => {
  for (const [value, verdict] of [[100.5, 'CONSISTENT'], [102, 'DIFFERENT'], [107, 'REVIEW'], [120, 'CONFLICT']] as const) {
    const result = compareMetricObservations(observation(100), observation(value));
    assert.equal(result.comparable, true);
    assert.equal(result.verdict, verdict);
  }
  assert.equal(compareMetricObservations(observation(0), observation(0)).diff, 0);
  const zero = compareMetricObservations(observation(0), observation(1));
  assert.equal(zero.diff, null);
  assert.equal(zero.verdict, 'REVIEW');
  assert.equal(compareMetricObservations({ ...observation(100), quality: 'CONFLICT' }, observation(100)).verdict, 'CONFLICT');
});

test('多源审计直接读取 WAL 一致快照，保留日期来源且不修改库；全部外部请求可注入', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const parent = path.join(root, '.tmp/data-ai-audit-tests');
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, 'metrics-'));
  fs.mkdirSync(path.join(temp, 'data'));
  const dbPath = path.join(temp, 'data/invest.db');
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE instruments (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT, active INTEGER,
        market TEXT, currency TEXT, benchmark_index TEXT, secid TEXT, fund_code TEXT, tag TEXT,
        founded_date TEXT, scale_info TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE valuation_metrics (instrument_id TEXT, metric_key TEXT, value TEXT, as_of_date TEXT,
        provider TEXT, quality TEXT, PRIMARY KEY (instrument_id, metric_key, as_of_date)) WITHOUT ROWID;
      INSERT INTO instruments VALUES ('a', '000300', '沪深300', 'INDEX', 1, 'SH', 'CNY', NULL,
        '1.000300', NULL, '', NULL, NULL, '', '');
      INSERT INTO valuation_metrics VALUES ('a', 'pe', '13.14', '2026-11-16', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pb', '1.4', '2026-11-16', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'roe', '  ', '2026-11-16', 'eastmoney', 'FRESH');
    `);
    const dbBefore = fs.readFileSync(dbPath);
    const walBefore = fs.readFileSync(`${dbPath}-wal`);
    const stored = readStoredAudit(temp);
    assert.equal(stored.length, 1, '未 checkpoint 的 WAL 内容必须可见');
    assert.equal(stored[0].stored.pe.value, 13.14);
    assert.equal(stored[0].stored.roe.value, null);
    const report = await auditMetrics(temp, {
      tencent: { id: 'tencent', fetchMetrics: async () => [{ metricKey: 'pe', value: '90', asOfDate: '2026-11-16' }] },
      eastmoney: { id: 'eastmoney', fetchMetrics: async () => [{ metricKey: 'pe', value: '80', asOfDate: '2026-11-16' }] },
      fetchIndicator: async () => [{ tradeDate: '2026-11-13', peCalcShare: 11, peTotalShare: 12, dividendCalcShare: 3, dividendTotalShare: 4 }],
      fetchOfficial: async () => [{ indexName: '沪深300', tradeDate: '2026-11-16', peTtm: 13.14, pe: 13, pb: 1.4, dividendYield: 3 }],
    });
    const row = report[0];
    assert.equal(row.sources.stored.pe.provider, 'csindex');
    assert.equal(row.sources.tencent.pe.asOfDate, '2026-11-16');
    assert.equal(row.sources.csindex.pe_official.asOfDate, '2026-11-13');
    assert.equal(row.checks.find((check: { label: string }) => check.label === 'pe（库内 vs 官方 JSON）').verdict, 'CONSISTENT');
    assert.equal(row.checks.find((check: { label: string }) => check.label === 'pe（库内 vs 腾讯）').verdict, 'NOT_COMPARABLE');
    assert.ok(row.checks.some((check: { reason: string }) => check.reason.includes('请求日')));
    assert.ok(renderAuditReport(report, temp).includes('13.14（2026-11-16；csindex）'));
    assert.deepEqual(fs.readFileSync(dbPath), dbBefore);
    assert.deepEqual(fs.readFileSync(`${dbPath}-wal`), walBefore);
    assert.deepEqual(fs.readdirSync(temp), ['data']);
    const absent = path.join(temp, 'absent');
    assert.throws(() => readStoredAudit(absent));
    assert.equal(fs.existsSync(absent), false);
  } finally {
    writer.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
