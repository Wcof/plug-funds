import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { csindexOfficialCode } from '../server/src/market/index-identities.ts';
import { parseCsindexFactsheet, parsePublishDate, parseFundReference } from '../server/src/market/index-reference.ts';
import { parseIndexHistory, indexHistoryUrl } from '../server/src/market/index-history.ts';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { planIndexReference, applyIndexReference } from '../scripts/backfill-index-reference.mjs';

// 官方 H30086 单张的事实字段，省略说明性正文；完整原文 URL / SHA 保留在报告中。
const sheet = '2026年10月30日\n全称 中证800金融指数 指数代码 H30086\n发布日期 2013年5月9日\n货币 人民币 彭博代码 SH000974\n滚动市盈率 7.56\n市净率 .71\n股息率 4.10%\n注：指数指标均采用个股“计算用股本”计算得出';
const today = '2026-11-17';

test('仅映射官方明确并列代码，发布日期、产品、单张、日线按实际官方身份校验', () => {
  assert.equal(csindexOfficialCode('000974'), 'H30086'); assert.equal(csindexOfficialCode('399903'), '000903');
  assert.equal(csindexOfficialCode('399998'), '399998');
  const factsheet = parseCsindexFactsheet(sheet, '000974', today);
  assert.equal(factsheet.officialCode, 'H30086'); assert.equal(factsheet.pb, 0.71); assert.equal(factsheet.publishDate, '2013-05-09');
  assert.throws(() => parseCsindexFactsheet(sheet, '000975', today), /代码/);
  assert.equal(parsePublishDate({ code: 200, data: { indexCode: '000903', publishDate: '2006-05-29' } }, 'csindex', '399903', today), '2006-05-29');
  assert.equal(parseFundReference({ code: 200, data: [{ indexCode: '000903', productCode: '515100', exchange: '上海证券交易所' }] }, 'csindex', '399903', today).on, 1);
  const range = { begin: '2025-12-17', end: '2025-12-31' };
  assert.ok(indexHistoryUrl('csindex', '000974', range).includes('indexCode=H30086'));
  const points = parseIndexHistory({ code: 200, data: [{ indexCode: '000903', tradeDate: '20251231', close: 100 }] },
    'csindex', { id: 'local-sz', code: '399903' }, range, today, '2026-11-16T00:00:00Z');
  assert.equal(points[0].instrumentId, 'local-sz');
});

test('目录请求失败仍可独立核验官方固定路径单张，SHA 和身份错误不写值', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-proof-'));
  const handle = openState(resolveStateDirs({ PLUG_FUNDS_STATE_DIR: root } as NodeJS.ProcessEnv), { inMemory: true });
  t.after(() => { handle.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const ins = saveInstrument(handle, { code: '000974', name: '800金融', type: 'INDEX', market: 'SH' });
  const file = 'official.pdf'; fs.writeFileSync(path.join(root, file), sheet);
  const manifest = { '000974-factsheet': { status: 'OK', file,
    url: 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/H30086factsheet.pdf',
    sha256: createHash('sha256').update(sheet).digest('hex'), capturedAt: '2026-11-16T12:00:00Z' },
    '000974-csdetails': { status: 'FETCH_FAILED', reason: 'HTTP 403' } };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const plan = await planIndexReference({ handle, evidenceDir: root, today, extractPdf: async () => sheet });
  assert.equal(plan.rows[0].reference.publishDate, '2013-05-09');
  assert.ok(plan.rows[0].errors.some((e) => e.field === 'factsheetCatalog' && e.reason === 'HTTP 403'));
  assert.ok(plan.rows[0].desired.some((m) => m.metricKey === 'pb' && m.value === '0.71'));
  assert.equal(handle.db.prepare('SELECT founded_date FROM instruments WHERE id=?').get(ins.id).founded_date, null);
  applyIndexReference(handle, plan);
  assert.equal(handle.db.prepare('SELECT founded_date FROM instruments WHERE id=?').get(ins.id).founded_date, '2013-05-09');
  manifest['000974-factsheet'].sha256 = 'invalid';
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  const rejected = await planIndexReference({ handle, evidenceDir: root, today, extractPdf: async () => sheet });
  assert.equal(rejected.rows[0].desired.length, 0); assert.ok(rejected.rows[0].errors.some((e) => /SHA256/.test(e.reason)));
});
