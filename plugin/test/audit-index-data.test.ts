import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const script = path.join(root, 'plugin/scripts/audit-index-data.mjs');

test('指数审计只读，按真实窗口、来源口径及逐键证据报告，不从代码推测缺失原因', () => {
  const parent = path.join(root, '.tmp/data-ai-audit-tests');
  fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, 'run-'));
  const state = path.join(temp, 'state');
  fs.mkdirSync(path.join(state, 'data'), { recursive: true });
  const dbPath = path.join(state, 'data/invest.db');
  const beforePath = path.join(temp, 'before.db');
  const jsonPath = path.join(temp, 'audit.json');
  const csvPath = path.join(temp, 'audit.csv');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE instruments (id TEXT PRIMARY KEY, code TEXT, name TEXT, type TEXT, active INTEGER,
        market TEXT, secid TEXT, founded_date TEXT);
      CREATE TABLE market_data (id TEXT PRIMARY KEY, instrument_id TEXT, price_type TEXT, value TEXT,
        trading_date TEXT, observed_at TEXT, provider TEXT, quality TEXT);
      CREATE TABLE valuation_metrics (instrument_id TEXT, metric_key TEXT, value TEXT, as_of_date TEXT,
        provider TEXT, quality TEXT, PRIMARY KEY (instrument_id, metric_key, as_of_date)) WITHOUT ROWID;
      INSERT INTO instruments VALUES ('a', '000300', '审计样例', 'INDEX', 1, 'SH', '1.000300', '2005-04-08');
      INSERT INTO instruments VALUES ('b', '399001', '缺失样例', 'INDEX', 1, 'SZ', '0.399001', NULL);
      INSERT INTO instruments VALUES ('c', '000901', '过期分位样例', 'INDEX', 1, 'SH', '1.000901', NULL);
      INSERT INTO instruments VALUES ('d', '000902', '基准边界样例', 'INDEX', 1, 'SH', '1.000902', NULL);
      INSERT INTO instruments VALUES ('e', '000903', '冲突基准样例', 'INDEX', 1, 'SH', '1.000903', NULL);
      INSERT INTO instruments VALUES ('f', '000904', '混合来源样例', 'INDEX', 1, 'SH', '1.000904', NULL);
      INSERT INTO market_data VALUES ('base', 'a', 'CLOSE_PRICE', '100', '2025-12-31', '2025-12-31T08:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('latest', 'a', 'REALTIME_PRICE', '110', '2026-11-16', '2026-11-16T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('premature', 'a', 'CLOSE_PRICE', '109', '2026-11-16', '2026-11-16T03:00:00Z', 'eastmoney', 'FRESH');
      INSERT INTO market_data VALUES ('b-base', 'b', 'REALTIME_PRICE', '100', '2025-12-31', '2025-12-31T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('b-now', 'b', 'REALTIME_PRICE', '110', '2026-11-16', '2026-11-16T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('d-base', 'd', 'CLOSE_PRICE', '100', '2025-12-17', '2025-12-17T08:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('d-intraday', 'd', 'REALTIME_PRICE', '70', '2025-12-31', '2025-12-31T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('d-now', 'd', 'REALTIME_PRICE', '110', '2026-11-16', '2026-11-16T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('e-old', 'e', 'CLOSE_PRICE', '100', '2025-12-16', '2025-12-16T08:00:00Z', 'tencent', 'FRESH');
      INSERT INTO market_data VALUES ('e-conflict', 'e', 'CLOSE_PRICE', '100', '2025-12-31', '2025-12-31T08:00:00Z', 'tencent', 'CONFLICT');
      INSERT INTO market_data VALUES ('e-now', 'e', 'REALTIME_PRICE', '110', '2026-11-16', '2026-11-16T03:00:00Z', 'tencent', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pe_quote', '30', '2026-11-15', 'tencent', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pb', '99', '2026-11-16', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'roe', '12', '2026-11-16', 'unknown', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'roe', '9', '2022-12-31', 'unknown', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'roe', '11', '2023-12-31', 'unknown', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'roe', '15', '2025-12-31', 'unknown', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('c', 'pe', '13', '2026-11-01', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('c', 'pe', '13', '2023-11-02', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('f', 'pe', '14', '2026-11-16', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'bad_date', '1', '2026-02-30', 'fixture', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'turnover_rate', '1.23', '2026-11-16', 'tencent', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('b', 'turnover_rate', '  ', '2026-11-16', 'tencent', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pe_official_static', '14', '2026-11-16', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pe_official', '15', '2026-11-13', 'csindex', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'pb', 'Infinity', '2026-01-01', 'fixture', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'scale_info', '总市值 100 亿', '2026-11-15', 'tencent', 'CONFLICT');
      INSERT INTO valuation_metrics VALUES ('a', 'scale_info', '总市值 999 亿', '2026-11-17', 'tencent', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('a', 'future_only', '3', '2026-11-17', 'fixture', 'FRESH');
      INSERT INTO valuation_metrics VALUES ('b', 'bad_quality', '1', '2026-11-16', 'fixture', 'UNKNOWN');
      INSERT INTO market_data VALUES ('invalid-price', 'a', 'CLOSE_PRICE', '-1', '2024-01-01', '2024-01-01T08:00:00Z', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('blank-price', 'a', 'CLOSE_PRICE', ' ', '2024-01-02', '2024-01-02T08:00:00Z', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('nonfinite-price', 'a', 'CLOSE_PRICE', 'Infinity', '2024-01-03', '2024-01-03T08:00:00Z', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('bad-price-date', 'a', 'CLOSE_PRICE', '100', '2026-02-30', '2026-02-28T08:00:00Z', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('future-price', 'a', 'CLOSE_PRICE', '100', '2026-11-17', '2026-11-17T08:00:00Z', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('bad-observation', 'b', 'CLOSE_PRICE', '100', '2024-01-04', 'not-a-date', 'fixture', 'FRESH');
      INSERT INTO market_data VALUES ('remaining-premature', 'b', 'CLOSE_PRICE', '100', '2026-10-01', '2026-10-01T03:00:00Z', 'fixture', 'FRESH');
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
      INSERT INTO app_settings VALUES ('api_key', '"SECRET_MUST_NOT_BE_READ"', '2026-11-16T00:00:00Z');
      ALTER TABLE instruments ADD COLUMN private_extension TEXT;
      UPDATE instruments SET private_extension='SECRET_MUST_NOT_BE_EXPORTED';
    `);
    const put = db.prepare("INSERT INTO valuation_metrics VALUES ('a', 'pe', ?, ?, 'csindex', 'FRESH')");
    for (let day = 1; day <= 20; day++) {
      put.run(String(10 + day), `2022-10-${String(day).padStart(2, '0')}`);
      put.run(String(20 + day), `2026-10-${String(day).padStart(2, '0')}`);
    }
    const putSeries = db.prepare("INSERT INTO valuation_metrics VALUES (?, 'pe', '12', ?, ?, 'FRESH')");
    for (let day = 1; day <= 20; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day * 10)).toISOString().slice(0, 10);
      putSeries.run('c', date, 'csindex');
      putSeries.run('f', date, 'tencent');
    }
    db.close();
    fs.copyFileSync(dbPath, beforePath);
    const current = new DatabaseSync(dbPath);
    current.exec("DELETE FROM market_data WHERE id='premature'");
    current.close();
    const original = fs.readFileSync(dbPath);
    const beforeOriginal = fs.readFileSync(beforePath);

    const result = spawnSync(process.execPath, [script, '--state', state, '--today', '2026-11-16',
      '--before-db', beforePath, '--json', jsonPath, '--csv', csvPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(dbPath), original, '审计不得修改当前库');
    assert.deepEqual(fs.readFileSync(beforePath), beforeOriginal, '审计不得修改备份库');
    assert.deepEqual(fs.readdirSync(state), ['data'], '审计不得创建缓存或日志目录');
    const report = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const a = report.rows.find((row: { code: string }) => row.code === '000300');
    const b = report.rows.find((row: { code: string }) => row.code === '399001');
    const c = report.rows.find((row: { code: string }) => row.code === '000901');
    const d = report.rows.find((row: { code: string }) => row.code === '000902');
    const e = report.rows.find((row: { code: string }) => row.code === '000903');
    const f = report.rows.find((row: { code: string }) => row.code === '000904');
    assert.equal(a.pe.samples, 20, '超过 3 年的样本不能扩大分位窗口');
    assert.equal(a.pe.percentile, null, '近期样本跨度不足不能生成分位');
    assert.equal(a.peComparison.verdict, 'NOT_COMPARABLE');
    assert.equal(a.peComparison.comparable, false);
    assert.equal(b.fieldStates.pe.state, 'MISSING', '399 前缀不足以证明无官方数据');
    assert.equal(a.fieldStates.pb.state, 'SUSPECT', '极端值须进入字段状态和汇总');
    assert.equal(a.fieldStates.roe.state, 'SUSPECT', '观察年份不能冒充财报年度');
    assert.deepEqual(a.roe.observations, [
      { observationYear: '2023', value: 11 }, { observationYear: '2024', value: null }, { observationYear: '2025', value: 15 },
    ], '固定前 3 / 2 / 1 个日历年，当前年和更早观测不得挤占缺失年');
    assert.equal(a.priceType, 'REALTIME_PRICE');
    assert.equal(a.ytdBaseDate, '2025-12-31');
    assert.ok(Math.abs(a.ytdReturn - 10) < 1e-8);
    assert.equal(b.ytdReturn, null, '历史盘中价不能充当上年末基准');
    assert.equal(d.ytdBaseDate, '2025-12-17', '14 天应从上年末而非新年第一天计算');
    assert.ok(Math.abs(d.ytdReturn - 10) < 1e-8);
    assert.equal(e.ytdReturn, null, '冲突基准须排除，15 天前的正常值也不能替代');
    assert.equal(c.pe.windowStart, '2023-11-01');
    assert.equal(c.pe.windowEnd, '2026-11-01');
    assert.equal(c.pe.samples, 22, '基础指标日三年窗口不得被审计日缩短');
    assert.equal(c.pe.percentile, null);
    assert.equal(c.fieldStates.pePercentile.state, 'STALE', '样本充足仍不能把过期基础值标为当前有效分位');
    assert.equal(f.pe.samples, 1, '报价历史不得与单个官方样本混算分位');
    assert.equal(f.pe.excludedSourceSamples, 20);
    assert.equal(f.pe.percentile, null);
    assert.equal(f.fieldStates.pePercentile.state, 'MISSING');
    assert.equal(a.meta.code, '000300');
    assert.equal(a.meta.type, 'INDEX');
    assert.equal(a.meta.active, true);
    assert.equal(a.turnoverRate, 1.23);
    assert.equal(a.turnoverProvider, 'tencent');
    assert.equal(a.fieldStates.turnoverRate.state, 'VALID');
    assert.equal(b.turnoverRate, null, '空白换手率不能转换成 0');
    assert.equal(b.fieldStates.turnoverRate.state, 'MISSING');
    assert.equal(a.marketValue, 100, '未来总市值记录不能取代非未来截面');
    assert.equal(a.marketValueAsOfDate, '2026-11-15');
    assert.equal(a.marketValueProvider, 'tencent');
    assert.equal(a.marketValueQuality, 'CONFLICT');
    assert.equal(a.fieldStates.marketValue.state, 'CONFLICT');
    const staticPe = a.latestMetrics.find((metric: { metricKey: string }) => metric.metricKey === 'pe_official_static');
    assert.deepEqual([staticPe.rawValue, staticPe.value, staticPe.asOfDate, staticPe.provider, staticPe.quality, staticPe.state],
      ['14', 14, '2026-11-16', 'csindex', 'FRESH', 'VALID']);
    assert.ok(a.latestMetrics.some((metric: { metricKey: string }) => metric.metricKey === 'pe_quote'));
    assert.ok(a.latestMetrics.some((metric: { metricKey: string }) => metric.metricKey === 'pe_official'));
    assert.ok(!a.latestMetrics.some((metric: { metricKey: string }) => metric.metricKey === 'future_only'));
    const blankTurnover = b.latestMetrics.find((metric: { metricKey: string }) => metric.metricKey === 'turnover_rate');
    assert.deepEqual([blankTurnover.rawValue, blankTurnover.value, blankTurnover.state], ['  ', null, 'MISSING']);
    const invalidPb = a.rawDataAnomalies.find((entry: { table: string; rowKey: { metricKey: string; asOfDate: string } }) =>
      entry.table === 'valuation_metrics' && entry.rowKey.metricKey === 'pb' && entry.rowKey.asOfDate === '2026-01-01');
    assert.equal(invalidPb.rawValue, 'Infinity');
    assert.ok(invalidPb.checks.some((item: { code: string }) => item.code === 'INVALID_NUMBER'));
    const invalidPrice = a.rawDataAnomalies.find((entry: { rowKey: { id: string } }) => entry.rowKey.id === 'invalid-price');
    assert.equal(invalidPrice.rowKey.instrumentId, 'a');
    assert.equal(invalidPrice.rowKey.tradingDate, '2024-01-01');
    assert.equal(invalidPrice.provider, 'fixture');
    assert.ok(invalidPrice.checks.some((item: { code: string }) => item.code === 'INVALID_PRICE'));
    const premature = b.rawDataAnomalies.find((entry: { rowKey: { id: string } }) => entry.rowKey.id === 'remaining-premature');
    assert.ok(premature.checks.some((item: { code: string }) => item.code === 'PREMATURE_CLOSE'));
    const rawChecks = report.databaseChecks.rawDataChecks;
    assert.equal(rawChecks.valuationMetrics.byCode.INVALID_NUMBER, 1);
    assert.equal(rawChecks.valuationMetrics.byCode.MISSING_VALUE, 1);
    assert.equal(rawChecks.valuationMetrics.byCode.FUTURE_DATE, 2);
    assert.equal(rawChecks.valuationMetrics.byCode.INVALID_QUALITY, 1);
    assert.equal(rawChecks.marketData.byCode.INVALID_PRICE, 3);
    assert.equal(rawChecks.marketData.byCode.INVALID_DATE, 1);
    assert.equal(rawChecks.marketData.byCode.FUTURE_DATE, 1);
    assert.equal(rawChecks.marketData.byCode.FUTURE_OBSERVED_AT, 1);
    assert.equal(rawChecks.marketData.byCode.INVALID_OBSERVED_AT, 1);
    assert.equal(rawChecks.marketData.byCode.PREMATURE_CLOSE, 1);
    assert.ok(!JSON.stringify(report).includes('SECRET_MUST_NOT'));
    assert.deepEqual(a.corrections.map((row: { action: string; provider: string; previousValue: string }) =>
      [row.action, row.provider, row.previousValue]), [['REMOVE_PREMATURE_CLOSE', 'eastmoney', '109']]);
    assert.equal(report.databaseChecks.badMetricDates, 1, '日期校验须拒绝 2 月 30 日');
    assert.deepEqual(report.databaseChecks.integrityCheck, ['ok']);
    const csv = fs.readFileSync(csvPath, 'utf8');
    assert.ok(csv.includes('""observations""'));
    assert.ok(csv.split('\n')[0].includes('latestMetrics,meta,rawDataAnomalies'));
    assert.ok(csv.includes('pe_official_static'));
    assert.ok(!csv.includes('[object Object]'));

    const absent = path.join(temp, 'absent');
    const missing = spawnSync(process.execPath, [script, '--state', absent], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.equal(fs.existsSync(absent), false, '不存在的状态目录不能由只读审计自动创建');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
