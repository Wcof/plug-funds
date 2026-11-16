import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePublishDate, parseFundReference, parseCsindexFactsheet } from '../server/src/market/index-reference.ts';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { saveIndexReference } from '../server/src/repo/index-reference.ts';
import { getIndexValuation } from '../server/src/services/index-valuation.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { saveValuationMetric, latestValuationMetrics, archiveIndexQuotePe } from '../server/src/repo/market.ts';
import { applyIndexReference } from '../scripts/backfill-index-reference.mjs';

const today = '2026-11-16';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/index-reference.json', import.meta.url), 'utf8'));
const sheet = fs.readFileSync(new URL('./fixtures/csindex-factsheet-000688.txt', import.meta.url), 'utf8');

test('官方发布日期与基日严格区分；代码、未来及无效日拒绝', () => {
  assert.equal(parsePublishDate(fixture.cnintro, 'cnindex', '399001', today), '1995-01-23');
  assert.equal(parsePublishDate(fixture.csinfo, 'csindex', '000688', today), '2020-07-23');
  assert.throws(() => parsePublishDate(fixture.csinfo, 'csindex', '000300', today), /代码/);
  for (const fbrq of ['2027-01-01', '2026-02-30']) assert.throws(() => parsePublishDate({ code: 200, data: { fbrq } }, 'cnindex', '399001', today), /非法/);
  assert.equal(parsePublishDate({ code: 200, data: { jr: '1994-07-20' } }, 'cnindex', '399001', today), null);
});

test('国证关联产品按上市属性计数，保留陈旧统计日；null、分页、错码、重复拒绝', () => {
  const stats = parseFundReference(fixture.cnfunds, 'cnindex', '399001', today);
  assert.equal(stats.on, 4); assert.equal(stats.off, 1); assert.equal(stats.sourceDate, '2026-09-30');
  assert.equal(stats.status.state, 'STALE');
  assert.throws(() => parseFundReference({ code: 200, data: null, total: 0 }, 'cnindex', '399001', today), /无效/);
  const incomplete = structuredClone(fixture.cnfunds); incomplete.data.total++;
  assert.throws(() => parseFundReference(incomplete, 'cnindex', '399001', today), /分页/);
  assert.throws(() => parseFundReference(fixture.cnfunds, 'cnindex', '399006', today), /不匹配/);
  const duplicate = structuredClone(fixture.cnfunds); duplicate.data.rows[1] = duplicate.data.rows[0];
  assert.throws(() => parseFundReference(duplicate, 'cnindex', '399001', today), /重复/);
});

test('中证目录未给统计日时只列观察记录；分类存疑和原文错码不伪造完整数量', () => {
  const rows = [{ productCode: '510300', indexCode: '000300', coverage: '境内', exchange: '上海证券交易所', fundType: 'ETF' },
    { productCode: '000051', indexCode: '000300', coverage: '境内', exchange: '-', fundType: '指数基金' },
    { productCode: '300X', indexCode: '000300', coverage: '境外', exchange: 'Tokyo', fundType: 'ETF' }];
  const result = parseFundReference({ code: '200', data: rows }, 'csindex', '000300', today);
  assert.equal(result.on, 1); assert.equal(result.off, 1); assert.equal(result.excluded, 1); assert.equal(result.sourceDate, null);
  assert.equal(result.status.state, 'SUSPECT');
  rows[1].fundType = '未知';
  assert.equal(parseFundReference({ code: '200', data: rows }, 'csindex', '000300', today).on, null);
  rows[1].productCode = '399001';
  assert.throws(() => parseFundReference({ code: '200', data: rows }, 'csindex', '000300', today), /错码/);
});

test('中证 PDF 单张按表头解析，月度数据陈旧，零开头省略小数仍可读；错码及歧义拒绝', () => {
  const result = parseCsindexFactsheet(sheet, '000688', today);
  assert.equal(result.pb, 6.06); assert.equal(result.pe, 55.41); assert.equal(result.dividendYield, 0.34);
  assert.equal(result.date, '2026-10-30'); assert.equal(result.publishDate, '2020-07-23'); assert.equal(result.quality, 'STALE');
  assert.equal(parseCsindexFactsheet(sheet.replace('6.06', '.84'), '000688', today).pb, 0.84);
  assert.throws(() => parseCsindexFactsheet(sheet, '000300', today), /代码/);
  assert.throws(() => parseCsindexFactsheet(sheet + '\n市净率 1.11\n', '000688', today), /歧义/);
  assert.throws(() => parseCsindexFactsheet(sheet.replace('人民币', '美元'), '000688', today), /货币/);
  assert.throws(() => parseCsindexFactsheet(sheet, '000688', '2026-10-01'), /日期/);
});

test('参考资料进入 API，陈旧单张 PB 不产生分位，写入回滚不改已有数据', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'index-reference-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv);
  const handle = openState(dirs, { inMemory: true });
  t.after(() => { handle.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ins = saveInstrument(handle, { code: '000688', name: '科创50', type: 'INDEX', market: 'SH' });
  const reference = { code: ins.code, provider: 'csindex', observedDate: today, publishDate: '2020-07-23',
    publishStatus: { state: 'VALID' as const, reason: null }, funds: parseFundReference(fixture.cnfunds, 'cnindex', '399001', today),
    unavailable: { ps: '已核对官方单张未列 PS', roe: '已核对官方单张未列财年 ROE' }, evidence: [] };
  saveIndexReference(handle, ins.id, reference);
  saveValuationMetric(handle, { instrumentId: ins.id, metricKey: 'pb', value: '6.06', asOfDate: '2026-10-30', provider: 'csindex-factsheet', quality: 'STALE' });
  saveValuationMetric(handle, { instrumentId: ins.id, metricKey: 'pb', value: '3', asOfDate: today, provider: 'tencent', quality: 'FRESH' });
  archiveIndexQuotePe(handle, ins.id);
  const ctx = { handle, dirs, today, registry: createRegistry([]), hideAmount: false };
  const view = getIndexValuation(ctx).rows[0];
  assert.equal(view.pb.current, 6.06); assert.equal(view.pb.percentileStatus.state, 'STALE'); assert.equal(view.pb.percentile, null);
  assert.equal(view.fundOn, 4); assert.equal(view.fundReference?.sourceDate, '2026-09-30');
  assert.equal(view.fieldStates.ps.reason, reference.unavailable.ps);
  const changes = [{ instrumentId: ins.id, code: ins.code, publishChanged: true, referenceChanged: false, previousPublishDate: null,
    reference, desired: [{ metricKey: 'pb', value: 'bad', asOfDate: '2026-10-30', provider: 'csindex-factsheet', quality: 'STALE' }], changes: [] }];
  handle.db.exec("CREATE TEMP TRIGGER fail_reference BEFORE INSERT ON valuation_metrics BEGIN SELECT RAISE(ABORT, 'fail'); END;");
  assert.throws(() => applyIndexReference(handle, { rows: changes }), /fail/);
  assert.equal(handle.db.prepare('SELECT founded_date FROM instruments WHERE id=?').get(ins.id).founded_date, null);
  assert.equal(latestValuationMetrics(handle, ins.id, today).find((m) => m.metricKey === 'pb')?.value, '6.06');
});
