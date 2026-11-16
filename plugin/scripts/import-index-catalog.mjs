/**
 * 沪深指数目录导入（一次性建标的，不写任何行情 / 估值数值）。
 *
 * 数据来源：东财公开指数目录（`push2/api/qt/clist/get`，`fs=m:1+s:2,m:0+t:5`），
 * 只取代码 / 名称 / 市场这三项标识信息，不取它的行情数值——价格与估值仍由
 * provider 与中证官网各自提供，避免「目录源」变成第二份数据权威。
 *
 * 范围：代码前缀 000（中证 / 上证）、399（深证 / 国证）、395（深证系列），
 * 排除深港通 / 港股通 / 港币 / 全收益 / 净价等份额与币种变体。
 *
 * 用法：
 *   node plugin/scripts/import-index-catalog.mjs            # dry-run，只统计
 *   node plugin/scripts/import-index-catalog.mjs --apply    # 真正建标的
 *   node plugin/scripts/import-index-catalog.mjs --state <dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const stateIndex = args.indexOf('--state');
const stateDir = stateIndex >= 0 ? path.resolve(args[stateIndex + 1]) : path.join(os.homedir(), '.plug-funds');
const catalogIndex = args.indexOf('--catalog');
const catalogPath = catalogIndex >= 0 ? path.resolve(args[catalogIndex + 1]) : null;

const { openState, resolveStateDirs } = await import(path.join(repoRoot, 'plugin/server/src/db.ts'));
const { saveInstrument, listInstruments } = await import(path.join(repoRoot, 'plugin/server/src/repo/instruments.ts'));

process.env.PLUG_FUNDS_STATE_DIR = stateDir;
const handle = openState(resolveStateDirs());
handle.db.exec('PRAGMA busy_timeout = 15000;');

const PREFIXES = ['000', '399', '395'];
/** 份额 / 币种 / 计价变体，不是独立指数口径，建了只会让表变脏 */
const VARIANT = /（港币）|（美元）|全收益|净价|\(港币\)|\(美元\)/;

/**
 * 抓目录页。
 *
 * 用 curl 而不是 Node fetch：本机（以及不少公司网络）通过 `HTTPS_PROXY` 出网，
 * 而 Node 的 fetch/undici **不读** env 代理，直连会拿到 `UND_ERR_SOCKET`；
 * curl 默认读代理变量，因此这里以 curl 为准，失败再退回 fetch（无代理环境可用）。
 */
function fetchJsonText(url) {
  try {
    return execFileSync('/usr/bin/curl', ['-sS', '-m', '20', '-A', 'Mozilla/5.0', url], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`curl 失败：${String(error.message).slice(0, 120)}`);
  }
}

async function fetchCatalog() {
  const out = [];
  for (let pn = 1; pn <= 15; pn += 1) {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:1+s:2,m:0+t:5&fields=f12,f13,f14`;
    let payload = null;
    for (let attempt = 1; attempt <= 3 && payload === null; attempt += 1) {
      try {
        payload = JSON.parse(fetchJsonText(url));
      } catch (error) {
        if (attempt === 3) throw new Error(`目录接口第 ${pn} 页失败：${error.message}`);
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }
    const rows = payload?.data?.diff ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      out.push({
        code: String(row.f12),
        name: String(row.f14),
        market: row.f13 === 1 ? 'SH' : 'SZ',
        secid: `${row.f13 === 1 ? 1 : 0}.${row.f12}`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return out;
}

const catalog = catalogPath
  ? JSON.parse(fs.readFileSync(catalogPath, 'utf8'))
  : await fetchCatalog();
if (catalogPath) console.log(`[catalog] 使用本地清单 ${catalogPath}（${catalog.length} 条）`);
const wanted = catalog.filter((item) => PREFIXES.some((p) => item.code.startsWith(p)));
const filtered = wanted.filter((item) => !VARIANT.test(item.name));
const seen = new Set();
const unique = [];
for (const item of filtered) {
  const key = `${item.market}.${item.code}`;
  if (seen.has(key)) continue;
  seen.add(key);
  unique.push(item);
}

const existing = new Set(listInstruments(handle).filter((i) => i.type === 'INDEX').map((i) => `${i.market}.${i.code}`));
const toCreate = unique.filter((item) => !existing.has(`${item.market}.${item.code}`));

const byPrefix = {};
for (const item of unique) {
  const key = item.code.slice(0, 3);
  byPrefix[key] = (byPrefix[key] ?? 0) + 1;
}

console.log(`[catalog] 目录 ${catalog.length} 条 → 目标前缀 ${wanted.length} → 去掉变体 ${unique.length}（${JSON.stringify(byPrefix)}）`);
console.log(`[catalog] 已存在 ${unique.length - toCreate.length} 个，待新建 ${toCreate.length} 个`);
console.log(`[catalog] 状态目录 ${stateDir}｜模式 ${apply ? 'APPLY' : 'DRY-RUN'}`);

if (toCreate.length > 0) {
  const sample = toCreate.slice(0, 8).map((i) => `${i.market}.${i.code} ${i.name}`).join(' / ');
  console.log(`[catalog] 示例：${sample}`);
}

if (apply) {
  handle.db.exec('BEGIN IMMEDIATE;');
  let created = 0;
  try {
    for (const item of toCreate) {
      saveInstrument(handle, {
        code: item.code, name: item.name, type: 'INDEX', market: item.market,
        secid: item.secid, tag: '指数（目录导入）',
      });
      created += 1;
    }
    handle.db.exec('COMMIT;');
  } catch (error) {
    handle.db.exec('ROLLBACK;');
    console.error(`[catalog] 失败并回滚：${error.message}`);
    process.exit(1);
  }
  console.log(`[catalog] 已新建 ${created} 个标的（未写任何行情 / 估值）`);
} else {
  console.log('[catalog] dry-run 结束；加 --apply 落库');
}

if (process.env.CATALOG_JSON) {
  fs.writeFileSync(process.env.CATALOG_JSON, JSON.stringify(unique, null, 1));
  console.log(`[catalog] 清单已存 ${process.env.CATALOG_JSON}`);
}
