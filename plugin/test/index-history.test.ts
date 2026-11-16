import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIndexHistory, createIndexHistoryProvider, createOfficialIndexHistoryProvider, indexHistoryUrl } from '../server/src/market/index-history.ts';
import { planIndexHistory, saveIndexHistory, hasIndexYearEndBase } from '../server/src/services/index-history.ts';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { saveMarketPoints, historyPoints } from '../server/src/repo/market.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { refreshMarketData } from '../server/src/services/refresh.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { reconcileIndexHistories } from '../scripts/backfill-index-history.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/index-history.json', import.meta.url), 'utf8'));
const today = '2026-11-17';
const observedAt = '2026-11-16T16:00:00.000Z';
const range = { begin: '2025-12-17', end: '2026-11-16' };
const instrument = { id: 'test', code: '000300' };
const parse = (body = fixture.csindex) => parseIndexHistory(body, 'csindex', instrument, range, today, observedAt);
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-history-test-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  t.after(() => { handle.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ins = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  return { handle, dirs, ins };
}

test('官方日线真实 fixture：身份、close 列、源日期与四位精度', () => {
  const csi = parse();
  assert.equal(csi.length, 4); assert.equal(csi[1].tradingDate, '2025-12-31');
  assert.equal(Number(csi[1].value), fixture.csindex.data[1].close);
  assert.ok(csi.every((r) => r.priceType === 'CLOSE_PRICE' && r.provider === 'csindex-history'));
  const cn = parseIndexHistory(fixture.cnindex, 'cnindex', { id: 'test', code: '399001' }, range, today, observedAt);
  assert.equal(cn[1].tradingDate, '2025-12-31'); assert.equal(cn[1].value, '13525.0228');
  const moved = structuredClone(fixture.cnindex);
  moved.data.item.reverse(); moved.data.data.forEach((row) => row.reverse());
  assert.deepEqual(parseIndexHistory(moved, 'cnindex', { id: 'test', code: '399001' }, range, today, observedAt), cn);
  const precision = structuredClone(fixture.csindex); precision.data[0].close = 4600.123456;
  precision.data[0].high = 4700; precision.data[0].low = 4500;
  assert.equal(parse(precision)[0].value, '4600.1234', 'ROUND_DOWN，不四舍五入');
});

test('官方日线拒绝身份不符、重复日期、超区间、未来、非法价格和 OHLC；空数组保留无数据语义', () => {
  const bad = (change) => { const x = structuredClone(fixture.csindex); change(x); return x; };
  assert.throws(() => parse(bad((x) => x.data[0].indexCode = '000001')), /身份/);
  assert.throws(() => parse(bad((x) => x.data.push(x.data[0]))), /重复/);
  assert.throws(() => parse(bad((x) => x.data[0].tradeDate = '20250230')), /日期/);
  assert.throws(() => parse(bad((x) => x.data[0].tradeDate = '20261231')), /日期/);
  assert.throws(() => parse(bad((x) => x.data[0].tradeDate = '20251216')), /区间/);
  for (const close of [null, '', '123', NaN, Infinity, 0, -1]) assert.throws(() => parse(bad((x) => x.data[0].close = close)), /收盘价/);
  assert.throws(() => parse(bad((x) => x.data[0].high = 1)), /OHLC/);
  assert.deepEqual(parse({ code: 200, data: [] }), []);
  assert.throws(() => parse({ code: 200, data: null }), /格式/);
  const cn = structuredClone(fixture.cnindex); cn.data.data[0][0] += 1000;
  assert.throws(() => parseIndexHistory(cn, 'cnindex', { id: 'test', code: '399001' }, range, today, observedAt), /零点/);
  cn.data.item[5] = 'missing';
  assert.throws(() => parseIndexHistory(cn, 'cnindex', { id: 'test', code: '399001' }, range, today, observedAt), /列定义/);
  assert.throws(() => indexHistoryUrl('csindex', '000300&x=1', range), /代码/);
});

test('日线计划只读；同日差异保留双方与证据；幂等及事务回滚', (t) => {
  const { handle, ins } = setup(t);
  const incoming = parse().map((p) => ({ ...p, instrumentId: ins.id }));
  const old = { ...incoming[1], provider: 'tencent', value: '1000.0000' };
  saveMarketPoints(handle, [old]);
  const total = handle.db.prepare('SELECT total_changes() n').get().n;
  const plan = planIndexHistory(handle, ins.id, incoming);
  assert.equal(handle.db.prepare('SELECT total_changes() n').get().n, total);
  assert.equal(plan.comparisons.filter((c) => c.conflict).length, 1);
  handle.db.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON market_data WHEN NEW.provider='csindex-history' BEGIN SELECT RAISE(ABORT,'injected'); END;");
  assert.throws(() => saveIndexHistory(handle, ins.id, incoming), /injected/);
  assert.equal(historyPoints(handle, ins.id, ['CLOSE_PRICE']).length, 1);
  handle.db.exec('DROP TRIGGER fail_history;');
  saveIndexHistory(handle, ins.id, incoming);
  const sameDay = historyPoints(handle, ins.id, ['CLOSE_PRICE'], '2025-12-31', '2025-12-31');
  assert.equal(sameDay.length, 2); assert.ok(sameDay.every((p) => p.quality === 'CONFLICT'));
  assert.equal(handle.db.prepare('SELECT COUNT(*) n FROM data_source_runs').get().n, 1);
  assert.equal(planIndexHistory(handle, ins.id, incoming).changes.length, 0);
  saveIndexHistory(handle, ins.id, [{ ...old, quality: 'FRESH' }]);
  assert.ok(historyPoints(handle, ins.id, ['CLOSE_PRICE'], '2025-12-31', '2025-12-31').every((p) => p.quality === 'CONFLICT'));
});

test('年末窗口不足时官方日线补入正常刷新，重复刷新不再请求；YTD 用真实年末价', async (t) => {
  const { handle, dirs, ins } = setup(t);
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('本测试禁止外网'); };
  t.after(() => { globalThis.fetch = nativeFetch; });
  let calls = 0;
  const official = createIndexHistoryProvider('csindex', today, async (url) => { calls++; assert.ok(url.includes('indexCode=000300')); return fixture.csindex; });
  const recent = { ...parse().at(-1)!, instrumentId: ins.id, provider: 'fixture', tradingDate: '2026-11-16' };
  const ctx = { handle, dirs, today, hideAmount: false, registry: createRegistry([
    { id: 'fixture', supports: () => true, fetchQuote: async () => null, fetchHistory: async () => [recent] }, official,
  ]) };
  assert.equal(hasIndexYearEndBase(handle, ins.id, today), false);
  const first = await refreshMarketData(ctx);
  assert.equal(first.results[0].ok, true); assert.equal(calls, 1);
  assert.equal(hasIndexYearEndBase(handle, ins.id, today), true);
  const row = getIndexValuation(ctx).rows[0];
  assert.ok(row.ytdReturn !== null);
  const base = fixture.csindex.data.find((x) => x.tradeDate === '20251231').close;
  assert.ok(Math.abs(row.ytdReturn! - (Number(recent.value) / base - 1) * 100) < 1e-9);
  await refreshMarketData(ctx); assert.equal(calls, 1);
});

test('399 官方日线跨发行方兜底：第一源空或失败，第二源仍须核验身份', async () => {
  const instrument = { id: 'test', code: '399997', type: 'INDEX', market: 'SZ' } as any;
  const calls: string[] = [];
  const body = structuredClone(fixture.csindex); body.data.forEach((r) => r.indexCode = instrument.code);
  const provider = createOfficialIndexHistoryProvider(today, async (url) => {
    calls.push(url);
    if (url.includes('cnindex')) return { ...fixture.cnindex, data: { ...fixture.cnindex.data, indexCode: instrument.code, data: [] } };
    return body;
  });
  assert.equal((await provider.fetchHistory(instrument, range)).length, 4); assert.equal(calls.length, 2);
  const wrong = createOfficialIndexHistoryProvider(today, async () => fixture.csindex);
  await assert.rejects(wrong.fetchHistory(instrument, range), /身份/);
});

test('报价端长区间截断时单独取年末窗口，补齐后跳过官方重复请求', async (t) => {
  const { handle, dirs, ins } = setup(t); const calls: string[] = [];
  const original = globalThis.fetch; globalThis.fetch = async () => { throw new Error('禁止外网'); };
  t.after(() => { globalThis.fetch = original; });
  const source = { id: 'fixture', supports: () => true, fetchQuote: async () => null,
    async fetchHistory(_instrument, requested) {
      calls.push(requested.end);
      return requested.end === '2025-12-31'
        ? parse().filter((p) => p.tradingDate <= requested.end).map((p) => ({ ...p, instrumentId: ins.id, provider: 'fixture' }))
        : [{ ...parse().at(-1)!, instrumentId: ins.id, provider: 'fixture', tradingDate: '2026-11-16' }];
    } };
  const fallback = { id: 'official-index-history', supports: () => true, fetchQuote: async () => null,
    async fetchHistory() { assert.fail('已有基准不应重复请求'); } };
  await refreshMarketData({ handle, dirs, today, hideAmount: false, registry: createRegistry([source, fallback]) });
  assert.deepEqual(calls, [today, '2025-12-31']); assert.equal(hasIndexYearEndBase(handle, ins.id, today), true);
});

test('全量历史回填 dry-run 不写，失败整批回滚，成功后重复没有变化', (t) => {
  const { handle, ins } = setup(t);
  const second = saveInstrument(handle, { code: '000001', name: '上证指数', type: 'INDEX', market: 'SH' });
  const records = [ins, second].map((instrument) => ({ instrument, points: parse().map((p) => ({ ...p, instrumentId: instrument.id })), status: 'AVAILABLE' }));
  const plan = reconcileIndexHistories(handle, records, today);
  assert.equal(plan.counts.inserted, 8); assert.equal(plan.counts.filledYearEnd, 2);
  assert.equal(handle.db.prepare('SELECT COUNT(*) n FROM market_data').get().n, 0);
  handle.db.exec(`CREATE TEMP TRIGGER fail_batch BEFORE INSERT ON market_data WHEN NEW.instrument_id='${second.id}' BEGIN SELECT RAISE(ABORT,'injected batch'); END;`);
  assert.throws(() => reconcileIndexHistories(handle, records, today, true), /injected batch/);
  assert.equal(handle.db.prepare('SELECT COUNT(*) n FROM market_data').get().n, 0);
  handle.db.exec('DROP TRIGGER fail_batch;');
  assert.equal(reconcileIndexHistories(handle, records, today, true).counts.filledYearEnd, 2);
  const again = reconcileIndexHistories(handle, records, today);
  assert.equal(again.counts.inserted, 0); assert.equal(again.counts.revised, 0); assert.equal(again.counts.filledYearEnd, 0);
});

test('回填预览与落库一致：新增冲突使已有年末基准失效，手工价格仍按优先级生效', (t) => {
  const { handle, ins } = setup(t);
  const official = { ...parse()[1], instrumentId: ins.id };
  saveMarketPoints(handle, [{ ...official, provider: 'tencent', value: '1000' }]);
  const records = [{ instrument: ins, points: [official], status: 'AVAILABLE' }];
  assert.equal(hasIndexYearEndBase(handle, ins.id, today), true);
  assert.equal(reconcileIndexHistories(handle, records, today).rows[0].afterHasBase, false);
  assert.equal(hasIndexYearEndBase(handle, ins.id, today), true, '只读预览不能修改数据');
  assert.equal(reconcileIndexHistories(handle, records, today, true).rows[0].afterHasBase, false);
  assert.equal(reconcileIndexHistories(handle, records, today).rows[0].afterHasBase, false, '重复预览不能恢复既有冲突基准');
  saveMarketPoints(handle, [{ ...official, priceType: 'MANUAL_PRICE', provider: 'manual', quality: 'MANUAL' }]);
  assert.equal(reconcileIndexHistories(handle, records, today).rows[0].afterHasBase, true);
  assert.equal(reconcileIndexHistories(handle, records, today, true).rows[0].afterHasBase, true);
});
