/**
 * 端到端冒烟（隔离环境，无 DSH 依赖）：
 * 以 mock cordis ctx 加载构建产物 index.js，启动真实 HTTP 服务，
 * 走完整账本闭环（HTTP → glue 路由 → RPC → SQLite）。
 * 状态库指向临时目录；行情刷新不在冒烟中触发（fixture 已在单元测试覆盖）。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '../core/src/types.ts';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, '..');
const indexJs = path.join(pluginDir, 'targets', 'dsh', 'investment', 'index.js');
const webIndex = path.join(pluginDir, 'targets', 'dsh', 'investment', 'web', 'index.html');

if (!fs.existsSync(indexJs) || !fs.existsSync(webIndex)) {
  console.error('[smoke] 产物缺失：请先 npm run build');
  process.exit(1);
}

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-smoke-'));
process.env.PLUG_FUNDS_STATE_DIR = stateDir;

const routes = new Map();
const mockCtx = {
  inject(services, fn) {
    fn({
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => undefined;
        },
        getOrigin: () => 'http://127.0.0.1:0',
      },
      effect: (fn) => fn(),
    });
  },
};

const { apply } = await import(indexJs);
apply(mockCtx);

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const handler = [...routes.entries()].find(([routePath]) => pathname === routePath || pathname.startsWith(`${routePath}/`));
  if (handler) {
    handler[1](request, response);
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function rpcJson(method, params = {}) {
  const response = await fetch(`${base}/plug-funds/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  return { status: response.status, body: await response.json() };
}

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL  ${label} ${detail}`);
  }
}

const htmlResponse = await fetch(`${base}/plug-funds/`);
expect('GET /plug-funds/ → 200 HTML', htmlResponse.status === 200 && (await htmlResponse.text()).includes('id="root"'));
const jsResponse = await fetch(`${base}/plug-funds/app.js`);
expect('GET /plug-funds/app.js → 200 JS', jsResponse.status === 200 && (await jsResponse.text()).length > 10000);
const cssResponse = await fetch(`${base}/plug-funds/app.css`);
expect('GET /plug-funds/app.css → 200 CSS', cssResponse.status === 200);

const info = await rpcJson('get_app_info');
expect('RPC get_app_info', info.status === 200 && info.body.success && info.body.data.schemaVersion === SCHEMA_VERSION);

const unknown = await rpcJson('no_such_method');
expect('RPC 未知方法 → 404', unknown.status === 404);

const account = await rpcJson('save_account', { name: '冒烟账户' });
expect('save_account', account.status === 200);
const accountId = account.body.data.id;

const instrument = await rpcJson('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036', tag: '银行红利' });
expect('save_instrument', instrument.status === 200);
const instrumentId = instrument.body.data.id;

const opening = await rpcJson('record_transaction', { accountId, instrumentId, type: 'OPENING', tradeDate: '2026-10-20', quantity: '300', amount: '11550.00' });
expect('record OPENING', opening.status === 200);

const oversell = await rpcJson('record_transaction', { accountId, instrumentId, type: 'SELL', tradeDate: '2026-11-12', quantity: '400', price: '41.25' });
expect('超卖拒绝 → 422 oversell', oversell.status === 422 && oversell.body.error?.code === 'oversell');

const positions = await rpcJson('list_positions', {});
expect('list_positions（无行情 → 市值不完整显式）', positions.status === 200 && positions.body.data.rows[0].marketValue === null);

const manual = await rpcJson('save_manual_price', { instrumentId, value: '41.25', tradingDate: '2026-11-13' });
expect('save_manual_price（手工兜底）', manual.status === 200);
const positionsWithPrice = await rpcJson('list_positions', {});
expect('手工价格参与计价', Number(positionsWithPrice.body.data.rows[0].marketValue) === 12375);

const hide = await rpcJson('set_hide_amount', { enabled: true });
const masked = await rpcJson('list_positions', {});
expect('DASH-12 隐藏金额 → 掩码', hide.status === 200 && masked.body.data.rows[0].marketValue === '****' && masked.body.data.rows[0].qty !== '****');
await rpcJson('set_hide_amount', { enabled: false });

const goal = await rpcJson('save_portfolio_goal', { name: '目标', targetAmount: '1000000', enabled: true });
expect('save_portfolio_goal', goal.status === 200);
const allocation = await rpcJson('get_dashboard_allocation', { mode: 'goal' });
expect('目标模式灰色待达成', allocation.body.data.segments.some((s) => s.gray === true));

const assign = await rpcJson('set_instrument_categories', { instrumentId, categoryIds: [] });
const category = await rpcJson('save_category', { name: '长期核心', color: '#3d6ef2' });
await rpcJson('set_instrument_categories', { instrumentId, categoryIds: [category.body.data.id] });
const categories = await rpcJson('list_categories', {});
expect('分类计数（括号口径）', categories.body.data.categories[0].count === 1);

const detail = await rpcJson('get_position_detail', { positionId: `${accountId}:${instrumentId}` });
expect('持仓详情九项（已持天数）', detail.status === 200 && detail.body.data.basics.heldDays >= 0);

const valuation = await rpcJson('get_holdings_valuation', {});
expect('估值视图（不含收益列，口径说明）', valuation.status === 200 && valuation.body.data.rows.length === 1);

const backup = await rpcJson('export_backup', {});
expect('JSON 全量导出', backup.body.data.transactions.length === 1);

await rpcJson('delete_position', { positionId: `${accountId}:${instrumentId}` });
const afterDelete = await rpcJson('list_positions', {});
expect('删除持仓 → 视图屏蔽', afterDelete.body.data.rows.length === 0);
const txnsAfter = await rpcJson('list_transactions', {});
expect('流水保留（审计）', txnsAfter.body.data.length === 1);

server.close();
fs.rmSync(stateDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`[smoke] ${failures} 项失败`);
  process.exit(1);
}
console.log('[smoke] 全部通过（HTTP → glue 路由 → RPC → SQLite 全链路）');
