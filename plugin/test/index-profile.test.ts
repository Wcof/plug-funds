import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseIndexProfile, indexMetricApplicability } from '../server/src/market/index-profile.ts';
import { parseCsindexFactsheet } from '../server/src/market/index-reference.ts';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { saveIndexReference } from '../server/src/repo/index-reference.ts';
import { latestValuationMetrics, analysisValuationMetrics, saveValuationMetric, saveMarketPoints } from '../server/src/repo/market.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { getIndexAnalytics } from '../server/src/services/index-analytics.ts';
import { getHoldingsValuation } from '../server/src/services/valuation-view.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { execFileSync } from 'node:child_process';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/index-profile.json', import.meta.url), 'utf8'));
const today = '2026-11-17';

test('官方样本字段确认 15 个债券和 5 个基金指数；股票币种独立核实，不按名称猜测', () => {
  const profiles = fixture.map((r) => ({ code: r.code, ...parseIndexProfile(r.payload, r.source, r.code) }));
  assert.equal(profiles.filter((r) => r.assetClass === 'BOND').length, 15);
  assert.equal(profiles.filter((r) => r.assetClass === 'FUND').length, 5);
  assert.equal(profiles.find((r) => r.code === '000003').currency, 'USD');
  assert.equal(profiles.find((r) => r.code === '399001').currency, null);
  for (const p of profiles) {
    for (const key of ['pe', 'pe_quote', 'pe_official_static', 'pe_percentile', 'pb', 'pb_percentile', 'ps', 'roe']) {
      assert.equal(indexMetricApplicability(p, key)?.state ?? null, ['BOND', 'FUND'].includes(p.assetClass) ? 'NOT_APPLICABLE' : null);
    }
    assert.equal(indexMetricApplicability(p, 'turnover_rate'), null);
  }
  assert.equal(parseIndexProfile({ code: 200, data: { xyfw: '未知', name: '债券指数' } }, 'cnindex', '399001').assetClass, 'UNKNOWN');
  assert.equal(parseIndexProfile({ code: 200, data: { indexCode: '000011', indexType: 'other' } }, 'csindex', '000011').assetClass, 'UNKNOWN');
  assert.throws(() => parseIndexProfile(fixture[0].payload, 'csindex', '000300'), /代码/);
  assert.throws(() => parseIndexProfile({ code: 200, data: { ...fixture[0].payload.data, currencyCn: '人民币' } }, 'csindex', '000003'), /计价币/);
  assert.throws(() => parseIndexProfile({ code: 200, data: null }, 'cnindex', '399001'), /无效/);
});

test('美元单张仅在同码基本资料确认货币后采用，PB 比值不换汇', () => {
  const text = '2026年10月30日\n全称 上证B股指数 指数代码 000003\n发布日期 1992年8月17日\n货币 美元\n滚动市盈率 7.85\n市净率 .75\n股息率 1.47%\n注：指数指标均采用个股“计算用股本”计算得出';
  assert.throws(() => parseCsindexFactsheet(text, '000003', today), /货币/);
  assert.throws(() => parseCsindexFactsheet(text, '000003', today, null), /货币/);
  const profile = parseIndexProfile(fixture[0].payload, 'csindex', '000003');
  const parsed = parseCsindexFactsheet(text, '000003', today, profile.currency);
  assert.equal(parsed.pb, 0.75); assert.equal(parsed.currency, 'USD'); assert.equal(parsed.quality, 'STALE');
});

test('不适用估值在 API、分析和评分均为空，原始截面保持可审计；未知类别不误删', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-profile-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  t.after(() => { handle.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ins = saveInstrument(handle, { code: '000012', name: '国债指数', type: 'INDEX', market: 'SH' });
  const input = fixture.find((r) => r.code === ins.code);
  const profile = parseIndexProfile(input.payload, input.source, input.code);
  saveIndexReference(handle, ins.id, { code: ins.code, provider: 'csindex', observedDate: today, publishDate: null,
    publishStatus: { state: 'MISSING', reason: 'fixture' }, funds: null, unavailable: {}, evidence: [], profile });
  for (const key of ['pe', 'pb', 'ps', 'roe', 'pe_percentile', 'pb_percentile']) saveValuationMetric(handle,
    { instrumentId: ins.id, metricKey: key, value: '10', provider: 'manual', quality: 'MANUAL', asOfDate: today });
  saveMarketPoints(handle, [{ instrumentId: ins.id, priceType: 'CLOSE_PRICE', value: '100', tradingDate: '2026-11-16',
    observedAt: '2026-11-16T08:00:00Z', currency: 'CNY', provider: 'fixture', quality: 'FRESH' }]);
  const ctx = { handle, dirs, registry: createRegistry([]), today, hideAmount: false };
  assert.equal(latestValuationMetrics(handle, ins.id, today).length, 6);
  assert.equal(analysisValuationMetrics(handle, ins.id, today).length, 0);
  const row = getIndexValuation(ctx).rows[0];
  for (const key of ['pe', 'pb', 'ps']) {
    assert.equal(row[key].current, null); assert.equal(row[key].avg, null); assert.equal(row[key].samples, 0);
    assert.equal(row[key].percentileStatus.state, 'NOT_APPLICABLE'); assert.equal(row.fieldStates[key].state, 'NOT_APPLICABLE');
  }
  assert.deepEqual(row.roe, [null, null, null]);
  assert.equal(row.profile?.currency, 'CNY');
  const analytics = getIndexAnalytics(ctx);
  assert.equal(analytics.graham[0].grahamIndex, null); assert.equal(analytics.rows[0].pb, null);
  const view = await getHoldingsValuation(ctx, { scope: 'all' });
  assert.equal(view.rows[0].pe, null); assert.equal(view.rows[0].pbPercentile, null);
  assert.ok(view.rows[0].caliber.includes('不适用'));
  assert.equal(latestValuationMetrics(handle, ins.id, today).length, 6, '分析不得删改原始记录');
  const other = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH' });
  saveValuationMetric(handle, { instrumentId: other.id, metricKey: 'pe', value: '12', asOfDate: today, provider: 'manual', quality: 'MANUAL' });
  assert.equal(analysisValuationMetrics(handle, other.id, today)[0].value, '12');
});

test('只读审计与 CSV 明确不适用并保留原值、资产类别和计价币', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-profile-audit-'));
  const handle = openState(resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ins = saveInstrument(handle, { code: '000012', name: '国债指数', type: 'INDEX', market: 'SH' });
  const input = fixture.find((r) => r.code === ins.code);
  saveIndexReference(handle, ins.id, { code: ins.code, provider: 'csindex', observedDate: today, publishDate: '2003-01-02',
    publishStatus: { state: 'VALID', reason: null }, funds: null, unavailable: {}, evidence: [],
    profile: parseIndexProfile(input.payload, input.source, input.code) });
  saveValuationMetric(handle, { instrumentId: ins.id, metricKey: 'pe', value: '10', asOfDate: today, provider: 'manual', quality: 'MANUAL' });
  handle.db.close();
  const json = path.join(root, 'audit.json'), csv = path.join(root, 'audit.csv');
  execFileSync(process.execPath, ['plugin/scripts/audit-index-data.mjs', '--state', root, '--today', today, '--json', json, '--csv', csv]);
  const row = JSON.parse(fs.readFileSync(json, 'utf8')).rows[0];
  assert.equal(row.fieldStates.pe.state, 'NOT_APPLICABLE'); assert.equal(row.pe.current, null);
  assert.equal(row.pe.avg, null); assert.equal(row.pe.percentileStatus.state, 'NOT_APPLICABLE');
  assert.equal(row.latestMetrics[0].rawValue, '10'); assert.equal(row.latestMetrics[0].applicability.state, 'NOT_APPLICABLE');
  assert.equal(row.profile.assetClass, 'BOND'); assert.equal(row.profile.currency, 'CNY');
  assert.match(fs.readFileSync(csv, 'utf8'), /NOT_APPLICABLE/);
});
