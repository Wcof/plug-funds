/**
 * 中证指数官方估值（xls → 快照）：解析真实文件样本，锁定列定位与数值口径。
 * fixture 为 csindex.com.cn 发布的 000300indicator.xls 原件（20 个交易日截面）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  csindexIndicatorUrl,
  parseBiffCells,
  parseCsindexIndicator,
  readOleWorkbook,
  snapshotToMetrics,
  supportsCsindex,
} from '../server/src/market/csindex.ts';
import type { Instrument } from '../core/src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, 'fixtures', '000300indicator.xls'));

test('csindex：OLE2 + BIFF8 解析出真实单元格', () => {
  const workbook = readOleWorkbook(fixture);
  assert.ok(workbook.length > 1000);
  const cells = parseBiffCells(workbook);
  assert.ok(cells.length > 100, `单元格太少：${cells.length}`);
  const texts = cells.filter((c) => typeof c.value === 'string').map((c) => String(c.value));
  assert.ok(texts.some((t) => t.includes('市盈率')), '应能读到表头');
});

test('csindex：按表头定位列，解析出 20 个交易日官方 PE / 股息率', () => {
  const snapshots = parseCsindexIndicator(readOleWorkbook(fixture));
  assert.equal(snapshots.length, 20);
  const newest = snapshots[0];
  assert.equal(newest.code, '000300');
  assert.match(newest.tradeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(newest.name, '沪深300');
  // 官方文件同时给总股本口径与计算用股本口径，两者不能相等（否则说明取错列）
  assert.ok(newest.peTotalShare !== null && newest.peCalcShare !== null);
  assert.notEqual(newest.peTotalShare, newest.peCalcShare);
  assert.ok(newest.peCalcShare > newest.peTotalShare, '计算用股本 PE 应高于总股本 PE（自由流通盘更小）');
  assert.ok((newest.dividendCalcShare ?? 0) > 0 && (newest.dividendCalcShare ?? 0) < (newest.dividendTotalShare ?? 0));
  // 日期严格倒序，且相邻交易日间隔在合理范围
  for (let i = 1; i < snapshots.length; i += 1) {
    assert.ok(snapshots[i - 1].tradeDate > snapshots[i].tradeDate, '快照应按日期倒序');
    const gap = (Date.parse(`${snapshots[i - 1].tradeDate}T00:00:00Z`) - Date.parse(`${snapshots[i].tradeDate}T00:00:00Z`)) / 86_400_000;
    assert.ok(gap >= 1 && gap <= 5, `相邻截面间隔异常：${gap} 天`);
  }
});

test('csindex：官方 PE 走独立键，不顶替报价端口径的 pe', () => {
  const snapshots = parseCsindexIndicator(readOleWorkbook(fixture));
  const { latest, history } = snapshotToMetrics('ins1', snapshots);
  const keys = new Set(latest.map((m) => m.metricKey));
  assert.ok(!keys.has('pe'), '不得写入 pe：官方口径与腾讯 / 东财 TTM 不同，混用会让分位跳变');
  assert.ok(keys.has('pe_official'));
  assert.ok(keys.has('pe_official_total_share'));
  assert.ok(keys.has('dividend_yield_calc_share'), '计算用股本股息率必须独立留档');
  assert.ok(!keys.has('dividend_yield'), 'XLS 不能直接抢占 JSON 主股息率键');
  // 历史截面逐日写入，供分位累积
  assert.equal(history.length, snapshots.length * 4);
  assert.equal(history.filter((row) => row.metricKey === 'pe_official').length, 20);
});

test('csindex：坏文件 / 空文件显式失败或返回空，不伪造数值', () => {
  assert.throws(() => readOleWorkbook(Buffer.from('not an ole file at all')), /OLE2/);
  const garbage = Buffer.alloc(600);
  garbage.writeUInt32LE(0xe011cfd0, 0);
  // 头部魔数对、扇区大小非法 → 明确报错，由上层记「中证官方估值失败」
  assert.throws(() => readOleWorkbook(garbage), /OLE2/);
  assert.deepEqual(parseCsindexIndicator(Buffer.alloc(0)), []);
  // 空工作簿（没有任何单元格）→ 空数组，而不是编造行
  assert.deepEqual(parseCsindexIndicator(Buffer.from([0x0a, 0x00, 0x00, 0x00])), []);
});

test('csindex：只对中证 / 上证系列建 URL，国证系列不生成', () => {
  const base = (code: string, type: Instrument['type'] = 'INDEX'): Instrument => ({ code, type } as Instrument);
  assert.equal(supportsCsindex(base('000300')), true);
  assert.equal(supportsCsindex(base('000001')), true);
  assert.equal(supportsCsindex(base('930748')), true);
  // 深证成指 / 创业板指由国证发布，中证文件不存在
  assert.equal(supportsCsindex(base('399006')), true, '代码形态合法，仍会尝试；404 时返回空数组');
  assert.equal(supportsCsindex(base('600036', 'STOCK')), false);
  assert.match(csindexIndicatorUrl('000300'), /000300indicator\.xls$/);
});
