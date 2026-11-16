/**
 * 指标表结构回归（v4）：复合主键 + WITHOUT ROWID，且 upsert 幂等。
 *
 * 背景：原表用 `id TEXT PRIMARY KEY`，代码只写不读，却额外维护一棵 38 MB 的索引；
 * 指标行 79 万（pe 占 99.8%）时总占用 176.9 MB，去掉 id 后实测 57.4 MB。
 * 这里锁死三件事：没有 id 列、是 WITHOUT ROWID、同 (标的, 指标, 日期) 重复写入不新增行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs } from '../server/src/db.ts';
import { saveInstrument } from '../server/src/repo/instruments.ts';
import { metricHistory, saveValuationMetric } from '../server/src/repo/market.ts';

function open(): ReturnType<typeof openState> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-vm-schema-'));
  return openState(resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv), { inMemory: true });
}

test('valuation_metrics：无 id 列，声明为 WITHOUT ROWID', () => {
  const handle = open();
  const columns = (handle.db.prepare('PRAGMA table_info(valuation_metrics)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns.sort(), ['as_of_date', 'instrument_id', 'metric_key', 'provider', 'quality', 'value']);
  assert.equal(columns.includes('id'), false, '冗余 id 主键必须去掉');

  const ddl = (handle.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='valuation_metrics'").get() as { sql: string }).sql;
  assert.match(ddl, /WITHOUT ROWID/i, '必须使用 WITHOUT ROWID，避免额外的行表与主键索引');
  assert.match(ddl, /PRIMARY KEY \(instrument_id, metric_key, as_of_date\)/i);

  // 只有一个索引结构（主键即聚簇），不再有多余的 UNIQUE 索引
  const indexes = handle.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='valuation_metrics'").all();
  assert.deepEqual(indexes, [], 'WITHOUT ROWID 下不应再出现额外索引');
});

test('valuation_metrics：同键同日重复写入只保留一行并更新值', () => {
  const handle = open();
  const instrument = saveInstrument(handle, { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH', secid: '1.000300' });
  const base = { instrumentId: instrument.id, metricKey: 'pe', asOfDate: '2026-11-11', provider: 'csindex', quality: 'FRESH' as const };

  saveValuationMetric(handle, { ...base, value: '13.14' });
  saveValuationMetric(handle, { ...base, value: '13.20' });

  const rows = metricHistory(handle, instrument.id, 'pe');
  assert.equal(rows.length, 1, '复合主键必须让 upsert 幂等');
  assert.equal(rows[0].value, 13.2);
});
