/**
 * 批量刷新（目录导入后的一次性补齐）。
 *
 * 为什么需要它：插件内的自动刷新一次只跑一轮、且默认 60s 间隔，
 * 500+ 只标的靠它补齐要等很久；这里按批调用同一个 `refreshMarketData`，
 * 走完全一样的 provider / 落库 / 分位链路，只是把「谁先谁后」显式化。
 *
 * 用法：
 *   node plugin/scripts/refresh-catalog.mjs                 # 全部 active INDEX
 *   node plugin/scripts/refresh-catalog.mjs --batch 25      # 每批 25 只
 *   node plugin/scripts/refresh-catalog.mjs --only 000      # 只刷某个前缀
 *   node plugin/scripts/refresh-catalog.mjs --state <dir>
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const batchIndex = args.indexOf('--batch');
const batchSize = batchIndex >= 0 ? Math.max(1, Number(args[batchIndex + 1]) || 25) : 25;
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? String(args[onlyIndex + 1]) : null;
const stateIndex = args.indexOf('--state');
const stateDir = stateIndex >= 0 ? path.resolve(args[stateIndex + 1]) : path.join(os.homedir(), '.plug-funds');

const { openState, resolveStateDirs } = await import(path.join(repoRoot, 'plugin/server/src/db.ts'));
const { listInstruments } = await import(path.join(repoRoot, 'plugin/server/src/repo/instruments.ts'));
const { createDefaultRegistry } = await import(path.join(repoRoot, 'plugin/server/src/market/provider.ts'));
const { refreshMarketData } = await import(path.join(repoRoot, 'plugin/server/src/services/refresh.ts'));
const { shanghaiParts } = await import(path.join(repoRoot, 'plugin/core/src/calendar.ts'));

process.env.PLUG_FUNDS_STATE_DIR = stateDir;
const dirs = resolveStateDirs();
const handle = openState(dirs);
handle.db.exec('PRAGMA busy_timeout = 20000;');

const today = shanghaiParts(new Date()).date;

const all = listInstruments(handle, { type: 'INDEX', active: true })
  .filter((i) => !only || i.code.startsWith(only));
console.log(`[refresh] 指数 ${all.length} 只｜每批 ${batchSize}｜状态目录 ${stateDir}`);

const ctx = { handle, dirs, registry: createDefaultRegistry(), today, hideAmount: false };
const started = Date.now();
let ok = 0; let failed = 0; let quotes = 0; let history = 0; let metrics = 0;
const failures = [];

for (let offset = 0; offset < all.length; offset += batchSize) {
  const chunk = all.slice(offset, offset + batchSize).map((i) => i.id);
  const { results } = await refreshMarketData(ctx, { instrumentIds: chunk });
  for (const r of results) {
    if (r.ok) ok += 1; else { failed += 1; failures.push(`${r.code} ${r.name}: ${r.error ?? '无数据'}`); }
    quotes += r.quotes; history += r.history; metrics += r.metrics;
  }
  const done = Math.min(offset + batchSize, all.length);
  const pct = ((done / all.length) * 100).toFixed(1);
  console.log(`[refresh] ${done}/${all.length} (${pct}%)  成功 ${ok} 失败 ${failed}  报价 ${quotes} 历史 ${history} 指标 ${metrics}  ${Math.round((Date.now() - started) / 1000)}s`);
}

console.log(`\n[refresh] 完成：${ok} 成功 / ${failed} 失败，用时 ${Math.round((Date.now() - started) / 1000)}s`);
if (failures.length > 0) {
  console.log('[refresh] 失败样例（最多 15 条）：');
  for (const line of failures.slice(0, 15)) console.log('  -', line);
}
