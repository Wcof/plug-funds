/**
 * 补指数发布日期（`instruments.founded_date`）。
 *
 * 来源：中证官网 `indexInfo/index-basic-info/<code>` 的 `publishDate`。
 * 边界：
 * - 只覆盖中证 / 上证系列（000 前缀）以及部分深市代码；国证自编系列没有公开的发布日期接口；
 * - 该端点有独立 WAF：短时间批量请求后会整段 403（返回拦截页 HTML），此时必须退避重试，
 *   不能把 403 当成「没有数据」写空。
 *
 * 用法：
 *   node plugin/scripts/fill-index-dates.mjs              # dry-run，只统计能补多少
 *   node plugin/scripts/fill-index-dates.mjs --apply      # 写入
 *   node plugin/scripts/fill-index-dates.mjs --apply --delay 1500 --backoff 90
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const stateIndex = args.indexOf('--state');
const stateDir = stateIndex >= 0 ? path.resolve(args[stateIndex + 1]) : path.join(os.homedir(), '.plug-funds');
const delayIndex = args.indexOf('--delay');
const delayMs = delayIndex >= 0 ? Math.max(200, Number(args[delayIndex + 1]) || 1200) : 1200;
const backoffIndex = args.indexOf('--backoff');
const backoffSec = backoffIndex >= 0 ? Math.max(10, Number(args[backoffIndex + 1]) || 60) : 60;

const { openState, resolveStateDirs } = await import(path.join(repoRoot, 'plugin/server/src/db.ts'));

process.env.PLUG_FUNDS_STATE_DIR = stateDir;
const handle = openState(resolveStateDirs());
handle.db.exec('PRAGMA busy_timeout = 15000;');

const targets = handle.db
  .prepare("SELECT id, code, name FROM instruments WHERE type='INDEX' AND (founded_date IS NULL OR founded_date='') ORDER BY code")
  .all();
const covered = targets.filter((t) => t.code.startsWith('000'));
console.log(`[dates] 待补 ${targets.length} 个（000 系列 ${covered.length} 个有公开来源；其余 ${targets.length - covered.length} 个国证 / 深证自编系列无接口）`);
console.log(`[dates] 模式 ${apply ? 'APPLY' : 'DRY-RUN'}｜间隔 ${delayMs}ms｜403 退避 ${backoffSec}s`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const update = handle.db.prepare('UPDATE instruments SET founded_date = ?, updated_at = ? WHERE id = ?');

let ok = 0; let blocked = 0; const missing = [];
for (const [index, item] of covered.entries()) {
  let attempt = 0;
  while (attempt < 3) {
    attempt += 1;
    try {
      const response = await fetch(`https://www.csindex.com.cn/csindex-home/indexInfo/index-basic-info/${item.code}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.csindex.com.cn/' },
        signal: AbortSignal.timeout(12_000),
      });
      if (response.status === 403) {
        blocked += 1;
        if (blocked >= 5) {
          console.log('[dates] 连续 403：该端点仍处于 WAF 封禁期，本次中止。冷却后再跑本脚本即可续补。');
          process.exit(2);
        }
        console.log(`[dates] ${item.code} 403（第 ${attempt} 次），退避 ${backoffSec}s 后重试`);
        await sleep(backoffSec * 1000);
        continue;
      }
      const text = await response.text();
      if (!text.trimStart().startsWith('{')) throw new Error('返回非 JSON（疑似拦截页）');
      const payload = JSON.parse(text);
      const date = payload?.data?.publishDate;
      if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        if (apply) update.run(date, new Date().toISOString(), item.id);
        ok += 1;
        if (apply) console.log(`[dates] ${item.code} ${item.name} → ${date}`);
      } else {
        missing.push(`${item.code} 无 publishDate`);
      }
      break;
    } catch (error) {
      if (attempt >= 3) missing.push(`${item.code} ${String(error.message).slice(0, 50)}`);
      else await sleep(1500 * attempt);
    }
  }
  await sleep(delayMs);
  if ((index + 1) % 40 === 0) console.log(`[dates] 进度 ${index + 1}/${covered.length}｜已补 ${ok}`);
}

console.log(`\n[dates] 完成：${apply ? '写入' : '可补'} ${ok} 个，403 次数 ${blocked}，跳过/失败 ${missing.length}`);
for (const line of missing.slice(0, 10)) console.log('  -', line);
if (!apply) console.log('[dates] dry-run 未写库；加 --apply 落库');
