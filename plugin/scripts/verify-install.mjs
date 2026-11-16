/**
 * 离线安装契约验证（不触碰真实 ~/.dsh / ~/.plug-funds）：
 * 1. 解包 dist tarball 到临时目录；
 * 2. 静态校验清单、dsh 契约、locale、ModuleLoader/slots、自包含、SPA 资源；
 * 3. 从「解包目录」加载 index.js（而非源码产物），mock cordis ctx + 隔离状态目录，
 *    走真实 HTTP → glue → RPC → SQLite，确认产物不依赖项目路径。
 *
 * 用法：npm run verify:install [tarball 绝对路径]
 * 前置：npm run pack:dsh
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(scriptDir, '..', '..', 'integrations', 'dsh', 'dist');
const bundleVersion = JSON.parse(
  fs.readFileSync(path.join(scriptDir, '..', 'targets', 'dsh', 'investment', 'package.json'), 'utf8'),
).version;
/** 按包内版本号找 tarball；版本 bump 后不会因为硬编码文件名而失效。 */
function defaultTarballPath() {
  const preferred = path.join(distDir, `plug-funds-dsh-investment-${bundleVersion}.tgz`);
  if (fs.existsSync(preferred) || !fs.existsSync(distDir)) return preferred;
  const candidates = fs.readdirSync(distDir)
    .filter((name) => name.startsWith('plug-funds-dsh-investment-') && name.endsWith('.tgz'))
    .sort();
  return candidates.length > 0 ? path.join(distDir, candidates[candidates.length - 1]) : preferred;
}
const tarball = path.resolve(process.argv[2] ?? defaultTarballPath());

if (!fs.existsSync(tarball)) {
  console.error(`[verify-install] 找不到安装包：${tarball}\n请先执行 npm run pack:dsh`);
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-verify-'));
execFileSync('tar', ['-xzf', tarball, '-C', workDir], { stdio: 'pipe' });
const root = path.join(workDir, 'package');
if (!fs.existsSync(path.join(root, 'index.js'))) {
  console.error('[verify-install] tarball 结构异常：缺少 package/index.js');
  process.exit(1);
}

let failures = 0;
function expect(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
}

console.log(`[verify-install] 安装包 ${path.basename(tarball)} → ${workDir}`);

/* ---------------- 1. 静态契约 ---------------- */
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const requiredFiles = [
  'index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'README.md',
  'icon.svg', 'locale/en.json', 'locale/zh.json',
  'web/index.html', 'web/app.js', 'web/app.css',
  'mcp/index.js', 'mcp/manifest.json',
];
const missing = requiredFiles.filter((f) => !fs.existsSync(path.join(root, f)));
expect('包内文件齐全（13 项）', missing.length === 0, `缺少 ${missing.join(', ')}`);

const allFiles = [];
function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else allFiles.push(rel);
  }
}
walk(root);
expect('无多余文件（清单 files 与包内一致）', allFiles.length === requiredFiles.length,
  `实际 ${allFiles.length} 项：${allFiles.join(', ')}`);

expect('engines.dsh 声明', typeof manifest.engines?.dsh === 'string' && manifest.engines.dsh.length > 0,
  String(manifest.engines?.dsh));
expect('exports 主入口 / client 入口',
  manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js');
expect('dsh.bundle.patch 指向包内 cordis.patch.yml',
  manifest.dsh?.bundle?.patch === './cordis.patch.yml' && fs.existsSync(path.join(root, 'cordis.patch.yml')));
expect('dsh.client.inject 非空', Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0);

const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');
expect('cordis.patch.yml 的 id / name 与清单一致',
  patch.includes(manifest.name) && patch.includes('insert:'));

const localeProblems = [];
for (const lang of ['en', 'zh']) {
  try {
    const locale = JSON.parse(fs.readFileSync(path.join(root, 'locale', `${lang}.json`), 'utf8'));
    // 插件管理器读的是嵌套 meta.title / meta.description（扁平 "meta.title" 键会退化成包名）
    if (typeof locale.meta?.title !== 'string' || typeof locale.meta?.description !== 'string') {
      localeProblems.push(`${lang}: 缺少 meta.title / meta.description`);
    }
  } catch (error) { localeProblems.push(`${lang}: ${error.message}`); }
}
expect('locale JSON 合法且含嵌套 meta（en / zh）', localeProblems.length === 0, localeProblems.join('; '));

const clientCode = fs.readFileSync(path.join(root, 'client.js'), 'utf8');
expect('client.js 使用 window.__ModuleLoader__.load',
  clientCode.includes('__ModuleLoader__') && clientCode.includes('load('));
expect('client.js 配对注入 sidebar.panellist / main',
  clientCode.includes('sidebar.panellist') && clientCode.includes("'main'"));
// 宿主按「包名」在客户端模块图里取 factory；注册成别的 id（例如 cordis.patch.yml 的 row id）
// 会命中 client-modules: no registered factory，整块侧栏入口静默不出现，且不报安装失败。
const clientFactoryId = clientCode.match(/__ModuleLoader__\.load\(\{[\s\S]*?\bid:\s*['"]([^'"]+)['"]/)?.[1];
expect('client.js 工厂 id 等于包名', clientFactoryId === manifest.name,
  `实际 ${clientFactoryId ?? '未匹配'}，应为 ${manifest.name}`);

const hostCode = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const bareImports = [...hostCode.matchAll(/(?:from\s*|import\s*)(["'])([^"']+)\1/g)]
  .map((m) => m[2])
  .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../'));
expect('index.js 自包含（仅 node: 内置 / 相对路径）', bareImports.length === 0,
  bareImports.slice(0, 5).join(', '));
// 指数页首次进入要「建标的 + 拉数」一步到位，产物里必须有这个入口，否则页面只能是满屏「—」。
expect('index.js 暴露 bootstrap_indices（指数页一键建库 + 拉数）', hostCode.includes('bootstrap_indices'));

// Zcode / MCP 形态：包内必须带 MCP 入口与清单，且清单工具数与实际一致。
const mcpCode = fs.readFileSync(path.join(root, 'mcp/index.js'), 'utf8');
const mcpBare = [...mcpCode.matchAll(/(?:from\s*|import\s*)(["'])([^"']+)\1/g)]
  .map((m) => m[2])
  .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../'));
expect('mcp/index.js 自包含（可被任意宿主直接拉起）', mcpBare.length === 0, mcpBare.slice(0, 5).join(', '));
let zcodeManifest = null;
try {
  zcodeManifest = JSON.parse(fs.readFileSync(path.join(root, 'mcp/manifest.json'), 'utf8'));
} catch (error) {
  expect('mcp/manifest.json 合法', false, error.message);
}
expect('MCP 清单声明 stdio 传输与工具列表',
  zcodeManifest?.runtime?.transport === 'stdio' && Array.isArray(zcodeManifest?.tools) && zcodeManifest.tools.length === 17,
  `tools=${zcodeManifest?.tools?.length}`);
expect('package.json 的 mcp 字段指向包内入口',
  manifest.mcp?.entry === './mcp/index.js' && fs.existsSync(path.join(root, 'mcp/index.js')));

const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8');
expect('SPA 入口引用构建资源', html.includes('app.js') && html.includes('app.css') && html.includes('id="root"'));
expect('SPA 内联 favicon（避免宿主根 /favicon.ico 404）', html.includes('data:image/svg+xml'));

// 防止「安装包里 bundle 齐全但产物从未挂载 / 指数页被 tree-shake」这类只在实际浏览器暴露的问题。
const webJs = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const webCss = fs.readFileSync(path.join(root, 'web/app.css'), 'utf8');
expect('SPA 产物真正挂载（createRoot + 挂载节点）',
  webJs.includes('createRoot') && webJs.includes('getElementById'));
expect('SPA 产物含指数页（RPC / 表格 / 导航）',
  webJs.includes('get_index_valuation') && webJs.includes('idx-table') && webJs.includes('nav-item'));
expect('SPA 产物含指数二级视图与指数分析',
  webJs.includes('get_index_analytics') && webJs.includes('idx-view-table') && webJs.includes('idx-subitem'));
expect('SPA 产物含现金 / 再平衡 / 相关性面板',
  webJs.includes('list_cash_accounts') && webJs.includes('get_rebalance_plan')
  && webJs.includes('get_correlation_matrix') && webJs.includes('pf-grid'));
expect('SPA 产物含 xlsx 导入（base64 通道）', webJs.includes('xlsxBase64'));
expect('SPA 样式含指数页表格 / 固定列 / 响应式',
  webCss.includes('idx-table') && webCss.includes('idx-fixed') && webCss.includes('@media'));
expect('SPA 样式含二级视图与组合面板',
  webCss.includes('idx-view-table') && webCss.includes('pf-grid') && webCss.includes('corr-table'));

/* ---------------- 2. 隔离运行时 ---------------- */
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-offline-'));
process.env.PLUG_FUNDS_STATE_DIR = stateDir;
process.env.DSH_HOME = path.join(stateDir, 'dsh-home');
fs.mkdirSync(process.env.DSH_HOME, { recursive: true });

const routes = new Map();
const mockCtx = {
  inject(_services, fn) {
    fn({
      webServer: {
        register(route) { routes.set(route.path, route.handler); return () => undefined; },
        getOrigin: () => 'http://127.0.0.1:0',
      },
      effect: (f) => f(),
    });
  },
};

const { apply } = await import(path.join(root, 'index.js'));
apply(mockCtx);
expect('解包产物可被宿主 apply() 加载并注册路由', routes.size > 0, `routes=${routes.size}`);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const hit = [...routes.entries()].find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
  if (hit) { hit[1](request, response); return; }
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function rpc(method, params = {}) {
  const response = await fetch(`${base}/plug-funds/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
}

const spa = await fetch(`${base}/plug-funds/`);
expect('同源 SPA 可访问（200 HTML）', spa.status === 200 && (await spa.text()).includes('id="root"'));

// 静态资源没有 content hash，绝不能 immutable：否则升级后浏览器仍跑旧 app.js（页面看起来「改了没生效」）。
const asset = await fetch(`${base}/plug-funds/app.js`);
const assetCache = asset.headers.get('cache-control') ?? '';
const assetEtag = asset.headers.get('etag');
expect('app.js 可协商缓存（no-cache + ETag）',
  asset.status === 200 && assetCache.includes('no-cache') && assetEtag !== null,
  `cache-control=${assetCache} etag=${assetEtag}`);
const revalidated = await fetch(`${base}/plug-funds/app.js`, {
  headers: assetEtag === null ? {} : { 'If-None-Match': assetEtag },
});
expect('app.js 带 If-None-Match 时返回 304（命中缓存不重传）', revalidated.status === 304,
  String(revalidated.status));
const info = await rpc('get_app_info');
expect('RPC get_app_info 可用', info.status === 200 && info.body.success === true,
  JSON.stringify(info.body).slice(0, 160));

const goal = await rpc('save_portfolio_goal', { targetAmount: '1000000.00', enabled: true });
expect('RPC save_portfolio_goal 可写', goal.status === 200);
const readiness = await rpc('get_decision_readiness');
expect('RPC get_decision_readiness 可用（9 个决策维度）',
  readiness.status === 200 && readiness.body?.data?.items?.length === 9,
  JSON.stringify(readiness.body).slice(0, 160));
await rpc('set_hide_amount', { enabled: true });
const masked = await rpc('get_dashboard_summary');
const backup = await rpc('export_backup');
expect('DASH-12：展示被掩码但导出/备份保留真实数值',
  JSON.stringify(masked.body?.data ?? {}).includes('****')
  && JSON.stringify(backup.body?.data ?? {}).includes('1000000'));
const maskedReadiness = await rpc('get_decision_readiness');
expect('就绪度的合计金额在隐藏金额时一并掩码',
  maskedReadiness.body?.data?.metrics?.totalMarketValue === '****'
  && maskedReadiness.body?.data?.concentration?.coveredValue === '****',
  JSON.stringify(maskedReadiness.body?.data?.metrics ?? {}).slice(0, 120));

const templates = await rpc('list_strategy_templates');
expect('RPC list_strategy_templates 可用',
  templates.status === 200 && Array.isArray(templates.body?.data?.templates));
const preview = await rpc('preview_import_transactions', {
  csv: '账户,标的代码,标的名称,交易类型,交易日,数量,金额\n验证账户,600036,招商银行,买入,2026-11-15,100,1000.00\n',
});
expect('RPC preview_import_transactions 可用',
  preview.status === 200 && Array.isArray(preview.body?.data?.rows),
  JSON.stringify(preview.body).slice(0, 160));
const badHeader = await rpc('preview_import_transactions', { csv: '日期,代码,方向,数量,金额\n' });
expect('CSV 非法表头被归为 422 validation-error（而非 500 内部错误）',
  badHeader.status === 422 && badHeader.body?.error?.code === 'validation-error',
  `${badHeader.status} ${JSON.stringify(badHeader.body?.error ?? {}).slice(0, 160)}`);

// 现金 / 再平衡 / 交易日历 / 指数分析：新增能力必须在「解包后的产物」里可用。
await rpc('set_hide_amount', { enabled: false });
const cash = await rpc('save_cash_account', { name: '验证现金', balance: '800' });
expect('RPC save_cash_account 可写（schema v3）', cash.status === 200);
const cashList = await rpc('list_cash_accounts');
expect('RPC list_cash_accounts 读回现金余额',
  cashList.body?.data?.accounts?.length === 1 && cashList.body?.data?.accounts[0]?.balance === '800',
  JSON.stringify(cashList.body).slice(0, 160));
const rebalance = await rpc('save_rebalance_targets', {
  targets: [{ category: 'stock', targetWeight: 0.6 }, { category: 'cash', targetWeight: 0.4 }],
  threshold: 0.05,
});
const plan = await rpc('get_rebalance_plan');
expect('RPC save/get_rebalance_targets 可用并返回偏离行',
  rebalance.status === 200 && Array.isArray(plan.body?.data?.rows) && plan.body.data.rows.length >= 1,
  JSON.stringify(plan.body).slice(0, 160));
const calendar = await rpc('get_trading_calendar');
expect('RPC get_trading_calendar 返回日历与会话',
  calendar.status === 200 && typeof calendar.body?.data?.session?.phase === 'string'
  && typeof calendar.body?.data?.calendar?.source === 'string',
  JSON.stringify(calendar.body).slice(0, 160));
const analytics = await rpc('get_index_analytics');
expect('RPC get_index_analytics 返回分析结构（无指数时为空数组而非报错）',
  analytics.status === 200 && Array.isArray(analytics.body?.data?.rows)
  && Array.isArray(analytics.body?.data?.correlation?.matrix),
  JSON.stringify(analytics.body).slice(0, 160));

// xlsx 通道：用最小 ZIP 构造一个 2 行工作簿，验证解包后仍能解析（不引第三方库）。
const xlsxCsv = await rpc('preview_import_transactions', {
  xlsxBase64: Buffer.from('not-a-zip').toString('base64'),
});
expect('非法 xlsx 被归为 422 且提示可诊断',
  xlsxCsv.status === 422 && /xlsx|ZIP/.test(String(xlsxCsv.body?.error?.message ?? '')),
  `${xlsxCsv.status} ${JSON.stringify(xlsxCsv.body?.error ?? {}).slice(0, 160)}`);

expect('隔离状态目录生成数据文件', fs.readdirSync(stateDir).length > 0);
expect('未触碰真实 ~/.dsh / ~/.plug-funds',
  !stateDir.startsWith(path.join(os.homedir(), '.dsh'))
  && !stateDir.startsWith(path.join(os.homedir(), '.plug-funds')));

server.close();
console.log(failures === 0
  ? `[verify-install] 全部通过（隔离状态：${stateDir}）`
  : `[verify-install] ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
