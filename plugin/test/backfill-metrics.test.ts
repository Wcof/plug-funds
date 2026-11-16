/**
 * 官方估值回填的行为契约测试。
 *
 * 所有测试使用内存 SQLite 和注入的 fixture，不访问真实状态目录或网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import {
  metricHistory,
  saveValuationMetric,
} from '../server/src/repo/market.ts';
import { backfillMetrics, openBackfillState, runBackfill } from '../scripts/backfill-metrics.mjs';

const SNAPSHOT_DATE = '2026-11-11';
const TODAY = '2026-11-16';
const CODE = '399997';
const TEMP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.tmp/backfill-integrity-tests');

type Snapshot = {
  tradeDate: string;
  indexName: string;
  pe: number | null;
  peTtm: number | null;
  pb: number | null;
  dividendYield: number | null;
  peLastYear?: number | null;
  peTtmLastYear?: number | null;
  pbLastYear?: number | null;
};

type Point = { tradeDate: string; peTtm: number };

function makeHistory(count = 25): Point[] {
  return Array.from({ length: count }, (_, i) => {
    const d = new Date('2024-11-11T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i);
    return { tradeDate: d.toISOString().slice(0, 10), peTtm: 12 + i * 0.1 };
  });
}

function snapshot(indexName = '中证白酒', peTtm = 14.4): Snapshot {
  return {
    tradeDate: SNAPSHOT_DATE,
    indexName,
    pe: 18.2,
    peTtm,
    pb: 2.1,
    dividendYield: 1.2,
    peLastYear: null,
    peTtmLastYear: null,
    pbLastYear: null,
  };
}

function setup(inMemory = true): { handle: DbHandle; instrument: ReturnType<typeof saveInstrument>; root: string } {
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, 'state-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory });
  const instrument = saveInstrument(handle, {
    code: CODE,
    name: '中证白酒',
    type: 'INDEX',
    market: 'SZ',
    secid: '0.399997',
  });
  return { handle, instrument, root };
}

function teardown(handle: DbHandle, root: string): void {
  try { handle.db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function changes(handle: DbHandle): number {
  return Number((handle.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
}

function metricRows(handle: DbHandle, instrumentId: string, key: string): Array<Record<string, unknown>> {
  return handle.db.prepare(
    'SELECT metric_key, value, as_of_date, provider, quality FROM valuation_metrics WHERE instrument_id = ? AND metric_key = ? ORDER BY as_of_date',
  ).all(instrumentId, key) as Array<Record<string, unknown>>;
}

function invoke(input: {
  handle: DbHandle;
  apply?: boolean;
  snapshots?: Snapshot[];
  history?: Point[];
  historyError?: Error;
}) {
  const snapshots = input.snapshots ?? [snapshot()];
  const history = input.history ?? makeHistory();
  return backfillMetrics({
    handle: input.handle,
    apply: input.apply ?? false,
    today: TODAY,
    fetchSnapshot: async () => snapshots,
    fetchHistory: async () => {
      if (input.historyError) throw input.historyError;
      return history;
    },
  });
}

test('dry-run 不写覆盖清单、指标或 total_changes', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe',
      value: '9.9',
      asOfDate: '2026-11-11',
      provider: 'tencent',
      quality: 'FRESH',
    });
    const beforeChanges = changes(handle);
    const beforeMetrics = metricRows(handle, instrument.id, 'pe');
    const beforeCoverage = handle.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('csindex_covered_codes');

    const report = await invoke({ handle });

    assert.equal(report.apply, false);
    assert.deepEqual(metricRows(handle, instrument.id, 'pe'), beforeMetrics);
    assert.deepEqual(handle.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('csindex_covered_codes'), beforeCoverage);
    assert.equal(changes(handle), beforeChanges);
  } finally {
    teardown(handle, root);
  }
});

test('默认打开已有数据库为只读，未找到的状态目录不隐式初始化', async () => {
  const { handle, instrument, root } = setup(false);
  handle.db.close();
  let readOnly: DbHandle | undefined;
  try {
    const missingRoot = path.join(root, 'not-created');
    assert.throws(() => openBackfillState(missingRoot), /状态库不存在/);
    assert.equal(fs.existsSync(missingRoot), false);
    readOnly = openBackfillState(root);
    const report = await invoke({ handle: readOnly });
    assert.equal(report.apply, false);
    assert.equal(changes(readOnly), 0);
    assert.throws(() => saveValuationMetric(readOnly!, {
      instrumentId: instrument.id,
      metricKey: 'pe',
      value: '12',
      asOfDate: SNAPSHOT_DATE,
      provider: 'csindex',
      quality: 'FRESH',
    }), /readonly/i);
  } finally {
    try { readOnly?.db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('历史逐行校验基于修复前值，明确区分一致、新增与修正', async () => {
  const { handle, instrument, root } = setup();
  try {
    const history = makeHistory(3);
    for (const [index, value] of [[0, '12'], [1, '99']] as const) {
      saveValuationMetric(handle, {
        instrumentId: instrument.id,
        metricKey: 'pe',
        value,
        asOfDate: history[index].tradeDate,
        provider: 'csindex',
        quality: 'FRESH',
      });
    }
    const expectedCounts = { matched: 1, inserted: 1, changed: 1 };
    const beforeRows = metricRows(handle, instrument.id, 'pe');
    const preview = await invoke({ handle, history, snapshots: [] });
    assert.deepEqual(preview.instruments[0].historyCounts, expectedCounts);
    assert.deepEqual(metricRows(handle, instrument.id, 'pe'), beforeRows);
    const corrected = preview.instruments[0].sourceChanges.find((change: { phase: string; kind: string }) => (
      change.phase === 'history' && change.kind === 'changed'
    ));
    assert.equal(corrected?.asOfDate, history[1].tradeDate);
    assert.equal(corrected?.before.value, '99');
    assert.equal(corrected?.after.value, '12.1');
    const applied = await invoke({ handle, apply: true, history, snapshots: [] });
    assert.deepEqual(applied.instruments[0].historyCounts, expectedCounts);
    assert.equal(metricRows(handle, instrument.id, 'pe')[1].value, '12.1');
    const repeated = await invoke({ handle, apply: true, history, snapshots: [] });
    assert.deepEqual(repeated.instruments[0].historyCounts, { matched: 3, inserted: 0, changed: 0 });
    assert.equal(repeated.instruments[0].sourceChanges.length, 0);
  } finally {
    teardown(handle, root);
  }
});

test('外部历史抓取在写事务之外执行，并区分 NETWORK_UNAVAILABLE 与 UNSUPPORTED', async () => {
  const first = setup();
  try {
    const observed: boolean[] = [];
    const report = await backfillMetrics({
      handle: first.handle,
      apply: true,
      today: TODAY,
      fetchSnapshot: async () => {
        observed.push((first.handle.db as unknown as { isTransaction: boolean }).isTransaction);
        return [snapshot()];
      },
      fetchHistory: async () => {
        observed.push((first.handle.db as unknown as { isTransaction: boolean }).isTransaction);
        throw new Error('socket closed');
      },
    });
    assert.equal(observed.length, 2);
    assert.deepEqual(observed, [false, false], '抓取快照和历史时都不能持有事务');
    const row = report.instruments.find((item: { code: string }) => item.code === CODE);
    assert.equal(row?.sourceStatus.history, 'FETCH_FAILED');
    assert.match(JSON.stringify(row), /NETWORK_UNAVAILABLE/);
    assert.doesNotMatch(JSON.stringify(row), /UNSUPPORTED/);
  } finally {
    teardown(first.handle, first.root);
  }

  const second = setup();
  try {
    const report = await invoke({ handle: second.handle, apply: true, history: [] });
    const row = report.instruments.find((item: { code: string }) => item.code === CODE);
    assert.equal(row?.sourceStatus.history, 'NO_DATA');
    assert.match(JSON.stringify(row), /UNSUPPORTED/);
  } finally {
    teardown(second.handle, second.root);
  }
});

test('非法日期或负 PE 标为 SOURCE_INVALID，并保留已有数据', async () => {
  const cases = [
    { snapshots: [{ ...snapshot(), tradeDate: '2026-02-30' }], history: [{ tradeDate: SNAPSHOT_DATE, peTtm: -1 }] },
    { snapshots: [snapshot('中证白酒', -1)], history: [{ tradeDate: '2026-02-30', peTtm: 14.4 }] },
  ];
  for (const input of cases) {
    const { handle, instrument, root } = setup();
    try {
      saveValuationMetric(handle, {
        instrumentId: instrument.id,
        metricKey: 'pe',
        value: '9.9',
        asOfDate: SNAPSHOT_DATE,
        provider: 'tencent',
        quality: 'FRESH',
      });
      const beforeRows = metricRows(handle, instrument.id, 'pe');
      const beforeChanges = changes(handle);
      const report = await invoke({ handle, apply: true, ...input });
      const row = report.instruments[0];
      assert.deepEqual(row.sourceStatus, { snapshot: 'FETCH_FAILED', history: 'FETCH_FAILED' });
      assert.equal(row.checks.filter((check: { code: string }) => check.code === 'SOURCE_INVALID').length, 2);
      assert.ok(row.checks.every((check: { code: string }) => !['NETWORK_UNAVAILABLE', 'UNSUPPORTED'].includes(check.code)));
      assert.deepEqual(metricRows(handle, instrument.id, 'pe'), beforeRows);
      assert.equal(metricRows(handle, instrument.id, 'pe_quote').length, 0);
      assert.equal(changes(handle), beforeChanges);
    } finally {
      teardown(handle, root);
    }
  }
});

test('任一未来日期使快照与历史批次拒绝入库，标记 SOURCE_INVALID', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe',
      value: '9.9',
      asOfDate: SNAPSHOT_DATE,
      provider: 'tencent',
      quality: 'FRESH',
    });
    const beforeRows = metricRows(handle, instrument.id, 'pe');
    const beforeChanges = changes(handle);
    const report = await invoke({
      handle,
      apply: true,
      snapshots: [snapshot(), { ...snapshot('未来指数'), tradeDate: '2026-11-17' }],
      history: [...makeHistory(), { tradeDate: '2026-11-17', peTtm: 14.7 }],
    });
    const row = report.instruments[0];
    assert.deepEqual(row.sourceStatus, { snapshot: 'FETCH_FAILED', history: 'FETCH_FAILED' });
    assert.equal(row.checks.filter((check: { code: string }) => check.code === 'SOURCE_INVALID').length, 2);
    assert.deepEqual(metricRows(handle, instrument.id, 'pe'), beforeRows);
    assert.equal(metricRows(handle, instrument.id, 'pe_quote').length, 0);
    assert.equal(changes(handle), beforeChanges);
  } finally {
    teardown(handle, root);
  }
});

test('apply 先写官方历史再写快照，保留报价端与官方同日证据', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe',
      value: '21.0',
      asOfDate: SNAPSHOT_DATE,
      provider: 'tencent',
      quality: 'FRESH',
    });
    const report = await invoke({ handle, apply: true, history: makeHistory().map((point, index, all) => (
      index === all.length - 1 ? { ...point, tradeDate: SNAPSHOT_DATE, peTtm: 14.4 } : point
    )) });
    assert.equal(metricRows(handle, instrument.id, 'pe').at(-1)?.value, '14.4');
    assert.equal(metricRows(handle, instrument.id, 'pe').at(-1)?.provider, 'csindex');
    const quotes = metricRows(handle, instrument.id, 'pe_quote');
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].value, '21.0');
    assert.equal(quotes[0].as_of_date, SNAPSHOT_DATE);
    assert.ok(report.instruments[0].quoteMigrations.length >= 1);
  } finally {
    teardown(handle, root);
  }
});

test('同日 pe_quote 冲突保留既有值并记录可追溯审计', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe',
      value: '21.0',
      asOfDate: SNAPSHOT_DATE,
      provider: 'tencent',
      quality: 'FRESH',
    });
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe_quote',
      value: '20.0',
      asOfDate: SNAPSHOT_DATE,
      provider: 'eastmoney',
      quality: 'FRESH',
    });
    const report = await invoke({ handle, apply: true });
    const quotes = metricRows(handle, instrument.id, 'pe_quote');
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].value, '20.0');
    assert.equal(quotes[0].provider, 'eastmoney');
    assert.equal(report.instruments[0].quoteCollisions.length, 1);
    const audit = handle.db.prepare('SELECT note FROM data_source_runs ORDER BY started_at DESC LIMIT 1').get() as { note: string };
    const note = JSON.parse(audit.note) as { kind: string; quoteCollisions: unknown[] };
    assert.equal(note.kind, 'backfill-metrics-audit');
    assert.equal(note.quoteCollisions.length, 1);
    assert.match(JSON.stringify(note.quoteCollisions), /21\.0/);
    assert.match(JSON.stringify(note.quoteCollisions), /20\.0/);
    assert.match(JSON.stringify(note.quoteCollisions), /tencent/);
    assert.match(JSON.stringify(note.quoteCollisions), /eastmoney/);
    await invoke({ handle, apply: true });
    assert.equal((handle.db.prepare('SELECT COUNT(*) AS n FROM data_source_runs').get() as { n: number }).n, 1);
  } finally {
    teardown(handle, root);
  }
});

test('回填幂等：重复 apply 不新增指标，也不产生 changed', async () => {
  const { handle, instrument, root } = setup();
  try {
    const first = await invoke({ handle, apply: true });
    const firstCount = Number((handle.db.prepare('SELECT COUNT(*) AS n FROM valuation_metrics WHERE instrument_id = ?').get(instrument.id) as { n: number }).n);
    const second = await invoke({ handle, apply: true });
    const secondCount = Number((handle.db.prepare('SELECT COUNT(*) AS n FROM valuation_metrics WHERE instrument_id = ?').get(instrument.id) as { n: number }).n);
    assert.equal(secondCount, firstCount);
    assert.equal(second.instruments[0].counts.inserted, 0);
    assert.equal(second.instruments[0].counts.changed, 0);
    assert.ok(first.instruments[0].counts.inserted > 0);
    assert.ok(second.instruments[0].counts.matched > 0);
  } finally {
    teardown(handle, root);
  }
});

test('晚于官方 PE 的污染分位被清理，并按官方日期重新生成', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe_percentile',
      value: '88.00',
      asOfDate: '2026-11-20',
      provider: 'derived',
      quality: 'FRESH',
    });
    const report = await invoke({ handle, apply: true });
    const rows = metricRows(handle, instrument.id, 'pe_percentile');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].as_of_date, SNAPSHOT_DATE);
    assert.ok(report.instruments[0].removedPercentiles.length >= 1);
  } finally {
    teardown(handle, root);
  }
});

test('官方样本不足时清理旧派生分位，不把短跨度样本当成近三年', async () => {
  const { handle, instrument, root } = setup();
  try {
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe_percentile',
      value: '88.00',
      asOfDate: SNAPSHOT_DATE,
      provider: 'derived',
      quality: 'FRESH',
    });
    const history = Array.from({ length: 25 }, (_, i) => {
      const d = new Date('2026-10-18T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return { tradeDate: d.toISOString().slice(0, 10), peTtm: 12 + i * 0.1 };
    });
    const report = await invoke({ handle, apply: true, history });
    assert.equal(metricHistory(handle, instrument.id, 'pe_percentile').length, 0);
    assert.ok(report.instruments[0].removedPercentiles.length >= 1);
  } finally {
    teardown(handle, root);
  }
});

test('官方历史只有 19 个长跨度样本时，不能继续使用已有分位', async () => {
  const { handle, instrument, root } = setup();
  try {
    const history = makeHistory(19);
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe_percentile',
      value: '75.00',
      asOfDate: history.at(-1)!.tradeDate,
      provider: 'derived',
      quality: 'FRESH',
    });
    const report = await invoke({ handle, apply: true, history, snapshots: [] });
    assert.equal(metricHistory(handle, instrument.id, 'pe_percentile').length, 0);
    assert.equal(report.instruments[0].removedPercentiles.length, 1);
  } finally {
    teardown(handle, root);
  }
});

test('官方基准停留在 2014 年时标记 STALE_BASE，并归档删除旧分位', async () => {
  const { handle, instrument, root } = setup();
  try {
    const history = Array.from({ length: 25 }, (_, i) => {
      const date = new Date('2012-05-27T00:00:00Z');
      date.setUTCMonth(date.getUTCMonth() + i);
      return { tradeDate: date.toISOString().slice(0, 10), peTtm: 12 + i * 0.1 };
    });
    const lastDate = history.at(-1)!.tradeDate;
    assert.equal(lastDate, '2014-05-27');
    saveValuationMetric(handle, {
      instrumentId: instrument.id,
      metricKey: 'pe_percentile',
      value: '75.00',
      asOfDate: lastDate,
      provider: 'derived',
      quality: 'FRESH',
    });
    const report = await invoke({ handle, apply: true, history, snapshots: [] });
    const row = report.instruments[0];
    assert.ok(row.checks.some((check: { code: string; verdict: string }) => (
      check.code === 'STALE_BASE' && check.verdict === 'STALE'
    )));
    assert.equal(row.removedPercentiles.length, 1);
    assert.equal(metricRows(handle, instrument.id, 'pe_percentile').length, 0);
    assert.equal(metricRows(handle, instrument.id, 'pe').length, 25);
    const audit = handle.db.prepare('SELECT note FROM data_source_runs LIMIT 1').get() as { note: string };
    const note = JSON.parse(audit.note) as { removedPercentiles: Array<{ asOfDate: string; value: string }> };
    assert.equal(note.removedPercentiles.length, 1);
    assert.equal(note.removedPercentiles[0].asOfDate, lastDate);
    assert.equal(note.removedPercentiles[0].value, '75.00');
    await invoke({ handle, apply: true, history, snapshots: [] });
    assert.equal(metricRows(handle, instrument.id, 'pe_percentile').length, 0);
  } finally {
    teardown(handle, root);
  }
});

test('快照 PE 与历史 PE 同日不一致时标记 SUSPECT，并保留历史官方值', async () => {
  const { handle, instrument, root } = setup();
  try {
    const history = makeHistory().map((point, index, all) => (
      index === all.length - 1 ? { ...point, tradeDate: SNAPSHOT_DATE, peTtm: 15.0 } : point
    ));
    const report = await invoke({
      handle,
      apply: true,
      history,
      snapshots: [snapshot('中证白酒', 14.0)],
    });
    const row = report.instruments[0];
    assert.ok(row.checks.some((check: { verdict: string }) => check.verdict === 'SUSPECT'));
    const latest = metricRows(handle, instrument.id, 'pe').at(-1);
    assert.equal(latest?.value, '15');
    assert.equal(latest?.provider, 'csindex');
    assert.equal(latest?.quality, 'CONFLICT');
    assert.equal(metricRows(handle, instrument.id, 'pe_percentile').length, 0);
  } finally {
    teardown(handle, root);
  }
});

// Keep the compatibility export referenced so a future rename cannot silently break callers.
assert.equal(runBackfill, backfillMetrics);
