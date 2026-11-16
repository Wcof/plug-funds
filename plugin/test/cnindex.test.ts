import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseCnindexSnapshot, fetchCnindexSnapshot, createCnindexProvider, cnindexMetrics } from '../server/src/market/cnindex.ts';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { saveValuationMetric, latestValuationMetrics, metricHistory } from '../server/src/repo/market.ts';
import { saveCnindexMetrics } from '../server/src/services/cnindex-valuation.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { refreshMarketData } from '../server/src/services/refresh.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { backfillCnindex } from '../scripts/backfill-cnindex.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/cnindex-snapshot.json', import.meta.url), 'utf8'));
const today = '2026-11-16';
const parse = (page = fixture.page, before = fixture.date, after = fixture.date) => parseCnindexSnapshot([page], before, after, today);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cnindex-test-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  t.after(() => { handle.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { handle, dirs };
}

test('国证真实 fixture：PB、滚动 PE、静态 PE、单位与交易日期分开保留', () => {
  const snapshot = parse();
  assert.equal(snapshot.tradeDate, '2026-11-13');
  const row = snapshot.rows.find((r) => r.code === '399001')!;
  assert.equal(row.pb, 2.16);
  assert.equal(row.pe, 19.258);
  assert.equal(row.peStatic, 23.0624);
  assert.equal(row.totalMarketValue, 23276633043254.82);
  const metrics = cnindexMetrics(row, snapshot.tradeDate, today);
  assert.ok(metrics.every((m) => m.asOfDate === '2026-11-13'));
  assert.equal(metrics.find((m) => m.metricKey === 'pb')?.value, '2.16');
  assert.ok(cnindexMetrics(row, snapshot.tradeDate, '2026-12-01').every((m) => m.quality === 'STALE'));
  const bonds = snapshot.rows.find((r) => r.code === '399289')!;
  assert.equal(bonds.pe, null); assert.equal(bonds.pb, null);
  assert.ok(!cnindexMetrics(bonds, snapshot.tradeDate, today).some((m) => m.metricKey === 'pb'));
});

test('国证拒绝日期错位、未来日期、分页缺失、重复代码；异常字段不能变为零', () => {
  assert.throws(() => parse(fixture.page, fixture.date, { code: 200, data: fixture.date.data + 86400000 }), /变化/);
  assert.throws(() => parse(fixture.page, { code: 200, data: Date.parse('2027-01-01T00:00:00+08:00') }), /未来/);
  assert.throws(() => parse({ code: 200, data: { total: 4, rows: fixture.page.data.rows } }), /不完整/);
  assert.throws(() => parse({ code: 200, data: { total: 2, rows: [fixture.page.data.rows[0], fixture.page.data.rows[0]] } }), /重复/);
  const bad = structuredClone(fixture.page);
  bad.data.rows[0].pb = ' '; bad.data.rows[0].peDynamic = false; bad.data.rows[0].peStatic = -1;
  const row = parse(bad).rows[0];
  assert.equal(row.pb, null); assert.equal(row.pe, null); assert.equal(row.peStatic, null);
  assert.equal(row.issues.length, 2);
  const mixed = structuredClone(fixture.page);
  mixed.data.rows.push({ indexcode: '39926401', indexsource: '0' }, { indexcode: 'CESAIT', indexsource: '0' });
  mixed.data.total += 2;
  assert.equal(parse(mixed).rows.length, 3, '公开目录的收益版长代码和境外字母代码不能误配成本地指数');
});

test('国证全量回填 dry-run 只读、apply 幂等、任一写入失败整批回滚', (t) => {
  const { handle } = setup(t);
  saveInstrument(handle, { code: '399001', name: '深证成指', type: 'INDEX', market: 'SZ' });
  const b = saveInstrument(handle, { code: '399006', name: '创业板指', type: 'INDEX', market: 'SZ' });
  saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  const before = handle.db.prepare('SELECT total_changes() n').get().n;
  const planned = backfillCnindex({ handle, snapshot: parse(), today });
  assert.equal(planned.rows.length, 3); assert.equal(planned.counts.covered, 2);
  assert.equal(planned.counts.inserted, 8);
  assert.equal(handle.db.prepare('SELECT total_changes() n').get().n, before);
  handle.db.exec(`CREATE TEMP TRIGGER fail_cnindex BEFORE INSERT ON valuation_metrics
    WHEN NEW.instrument_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'injected'); END;`);
  assert.throws(() => backfillCnindex({ handle, snapshot: parse(), today, apply: true }), /injected/);
  assert.equal(handle.db.prepare('SELECT COUNT(*) n FROM valuation_metrics').get().n, 0);
  handle.db.exec('DROP TRIGGER fail_cnindex;');
  backfillCnindex({ handle, snapshot: parse(), today, apply: true });
  const repeat = backfillCnindex({ handle, snapshot: parse(), today });
  assert.equal(repeat.counts.inserted, 0); assert.equal(repeat.counts.changed, 0); assert.equal(repeat.counts.archived, 0);
  assert.equal(repeat.counts.matched, 8);
});

test('国证按实际返回页数加载并核对日期，单轮 provider 只读取一次快照', async (t) => {
  const calls: string[] = [];
  const result = await fetchCnindexSnapshot(today, async (url) => {
    calls.push(url);
    if (url.includes('queryDay')) return fixture.date;
    const p = Number(new URL(url).searchParams.get('pageNum'));
    return { code: 200, data: { total: 3, rows: fixture.page.data.rows.slice(p - 1, p) } };
  });
  assert.equal(calls.length, 5);
  assert.equal(result.rows.length, 3);
  const { handle } = setup(t);
  const one = saveInstrument(handle, { code: '399001', name: '深证成指', type: 'INDEX', market: 'SZ' });
  const two = saveInstrument(handle, { code: '399006', name: '创业板指', type: 'INDEX', market: 'SZ' });
  let count = 0;
  const provider = createCnindexProvider(today, async () => { count++; return result; });
  await Promise.all([provider.fetchMetrics!(one), provider.fetchMetrics!(two)]);
  assert.equal(count, 1);
  const failure = createCnindexProvider(today, async () => { count++; throw new Error('upstream failed'); });
  await assert.rejects(failure.fetchMetrics!(one), /upstream failed/);
  await assert.rejects(failure.fetchMetrics!(two), /upstream failed/);
  assert.equal(count, 2, '同一轮失败也不能为每只指数重复请求');
});

test('国证写入隔离原报价，保持中证优先；重复执行幂等且分位不混源', (t) => {
  const { handle } = setup(t);
  const ins = saveInstrument(handle, { code: '399001', name: '深证成指', type: 'INDEX', market: 'SZ' });
  for (const key of ['pe', 'pb']) {
    for (let i = 0; i < 24; i++) saveValuationMetric(handle, { instrumentId: ins.id, metricKey: key,
      value: '30', asOfDate: `2024-${String(i % 12 + 1).padStart(2, '0')}-${i < 12 ? '01' : '15'}`, provider: 'tencent', quality: 'FRESH' });
  }
  const metrics = cnindexMetrics(parse().rows[0], '2026-11-13', today);
  saveCnindexMetrics(handle, ins.id, metrics);
  const before = handle.db.prepare('SELECT * FROM valuation_metrics ORDER BY metric_key,as_of_date').all();
  saveCnindexMetrics(handle, ins.id, metrics);
  assert.deepEqual(handle.db.prepare('SELECT * FROM valuation_metrics ORDER BY metric_key,as_of_date').all(), before);
  assert.equal(metricHistory(handle, ins.id, 'pe_quote').length, 24);
  assert.equal(metricHistory(handle, ins.id, 'pb_quote').length, 24);
  assert.equal(metricHistory(handle, ins.id, 'pe').length, 1);
  assert.equal(metricHistory(handle, ins.id, 'pb').length, 1);
  saveValuationMetric(handle, { instrumentId: ins.id, metricKey: 'pb', value: '1.9', asOfDate: today, provider: 'tencent', quality: 'FRESH' });
  assert.equal(latestValuationMetrics(handle, ins.id, today).find((r) => r.metricKey === 'pb')?.value, '2.16');
  saveValuationMetric(handle, { instrumentId: ins.id, metricKey: 'pe', value: '18', asOfDate: '2026-11-12', provider: 'csindex', quality: 'FRESH' });
  saveCnindexMetrics(handle, ins.id, metrics);
  assert.equal(latestValuationMetrics(handle, ins.id, today).find((r) => r.metricKey === 'pe')?.value, '18');
  assert.equal(metricHistory(handle, ins.id, 'pe').length, 1);
});

test('刷新链路采集一次目录；官方失败不覆盖已存值，报价 PB 和 PE 保留独立键', async (t) => {
  const { handle, dirs } = setup(t);
  const a = saveInstrument(handle, { code: '399001', name: '深证成指', type: 'INDEX', market: 'SZ' });
  const b = saveInstrument(handle, { code: '399006', name: '创业板指', type: 'INDEX', market: 'SZ' });
  const registry = createRegistry([{ id: 'stub', supports: () => true, fetchQuote: async () => null, fetchHistory: async () => [],
    fetchMetrics: async () => ['pe', 'pb'].map((metricKey) => ({ metricKey, value: '50', asOfDate: today, quality: 'FRESH' as const })) }]);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => { calls++; return Response.json(String(url).includes('queryDay') ? fixture.date : fixture.page); };
  try {
    const ctx = { handle, dirs, registry, today, hideAmount: false };
    const result = await refreshMarketData(ctx);
    assert.ok(result.results.every((r) => r.ok && r.providers.includes('cnindex')));
    assert.equal(calls, 3);
    for (const ins of [a, b]) {
      const map = new Map(latestValuationMetrics(handle, ins.id, today).map((m) => [m.metricKey, m]));
      assert.equal(map.get('pe')?.provider, 'cnindex');
      assert.equal(map.get('pb')?.provider, 'cnindex');
      assert.equal(map.get('pe_quote')?.value, '50');
      assert.equal(map.get('pb_quote')?.value, '50');
    }
    const view = getIndexValuation(ctx).rows.find((r) => r.id === a.id)!;
    assert.equal(view.pb.current, 2.16); assert.equal(view.pb.percentile, null); assert.equal(view.pb.samples, 1);
    globalThis.fetch = async () => new Response('bad', { status: 503 });
    const failed = await refreshMarketData(ctx);
    assert.ok(failed.results.every((r) => r.error?.includes('国证官方估值失败')));
    assert.equal(getIndexValuation(ctx).rows.find((r) => r.id === a.id)?.pb.current, 2.16);
  } finally { globalThis.fetch = original; }
});
