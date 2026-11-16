/**
 * Web 产物验证：防止「bundle 存在但页面空白」以及「指数页样式 / 组件被 tree-shake」。
 *
 * 默认（静态层，零外部依赖、可在 CI 跑）：
 *   - index.html 挂载点、脚本 / 样式引用、内联 favicon
 *   - app.js 的 createRoot 挂载、指数页 RPC / class 锚点
 *   - app.css 的指数页布局、固定列、响应式断点
 *
 * --browser（动态层，需本机 Google Chrome）：
 *   mock DSH 宿主 + 真实 HTTP + CDP 打开产物，断言侧栏含「指数」、
 *   点击后双层表头 / 36 列 / sticky 固定列 / 零控制台错误。
 *
 * 用法：
 *   node plugin/scripts/verify-web.mjs                 # 仅静态
 *   node plugin/scripts/verify-web.mjs --browser      # 静态 + 真实浏览器
 *   node plugin/scripts/verify-web.mjs --browser --shot /tmp/idx.png
 *   node plugin/scripts/verify-web.mjs --root <解包目录/targets/dsh/investment/web>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, '..');
const defaultWebDir = path.join(pluginDir, 'targets', 'dsh', 'investment', 'web');

const args = process.argv.slice(2);
const withBrowser = args.includes('--browser');
const shotIndex = args.indexOf('--shot');
const shotPath = shotIndex >= 0 ? args[shotIndex + 1] : path.join(os.tmpdir(), 'plug-funds-index-page.png');
const rootIndex = args.indexOf('--root');
const webDir = rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : defaultWebDir;
const indexJs = path.join(pluginDir, 'targets', 'dsh', 'investment', 'index.js');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROUTE = '/plug-funds';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function expect(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function readOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

// ---------------------------------------------------------------- 静态层
function staticChecks() {
  console.log(`[static] 检查目录：${webDir}`);
  const html = readOrEmpty(path.join(webDir, 'index.html'));
  const js = readOrEmpty(path.join(webDir, 'app.js'));
  const css = readOrEmpty(path.join(webDir, 'app.css'));

  expect('web/index.html 存在', html.length > 0);
  expect('index.html 有 #root 挂载点', /id=["']root["']/.test(html));
  expect('index.html 引用 app.js', html.includes('app.js'));
  expect('index.html 引用 app.css', html.includes('app.css'));
  expect('index.html 内联 favicon（避免宿主根 /favicon.ico 404）',
    /rel=["']icon["']/.test(html) && html.includes('data:image/svg+xml'));

  expect('web/app.js 存在', js.length > 0);
  expect('app.js 调用 createRoot（SPA 真正挂载）', js.includes('createRoot'));
  expect('app.js 读取挂载节点', js.includes('getElementById'));
  expect('app.js 含指数页 RPC get_index_valuation', js.includes('get_index_valuation'));
  expect('app.js 含指数页表格 class idx-table', js.includes('idx-table'));
  expect('app.js 含二级菜单 class idx-subitem', js.includes('idx-subitem'));
  expect('app.js 含诚实边界 class idx-notice', js.includes('idx-notice'));
  expect('app.js 含导航 class nav-item', js.includes('nav-item'));
  expect('app.js 含决策就绪度 RPC', js.includes('get_decision_readiness'));
  expect('app.js 含决策就绪度卡片 class', js.includes('readiness-item') && js.includes('readiness-score'));
  expect('app.js 含现金面板 RPC', js.includes('list_cash_accounts') && js.includes('save_cash_account'));
  expect('app.js 含再平衡 RPC', js.includes('get_rebalance_plan') && js.includes('save_rebalance_targets'));
  expect('app.js 含相关性矩阵 RPC 与单元格', js.includes('get_correlation_matrix') && js.includes('corr-cell'));
  expect('app.js 含风险参数设置 RPC', js.includes('save_risk_settings'));
  expect('app.js 含组合面板布局 class', js.includes('pf-grid') && js.includes('pf-w-input'));
  // esbuild minify 把中文输出为 \uXXXX，用转义序列确认「指数」导航文案仍在产物里。
  expect('app.js 含「指数」文案（unicode 转义）', js.includes('\\u6307\\u6570'));

  expect('web/app.css 存在', css.length > 0);
  expect('app.css 含指数页布局 idx-page', css.includes('idx-page'));
  expect('app.css 含双层表格 idx-table', css.includes('idx-table'));
  expect('app.css 含固定列 idx-fixed', css.includes('idx-fixed'));
  expect('app.css 含分组表头 idx-group', css.includes('idx-group'));
  expect('app.css 含筛选工具条 idx-radios', css.includes('idx-radios'));
  expect('app.css 含组合面板样式', css.includes('pf-grid') && css.includes('pf-chip') && css.includes('corr-table'));
  expect('app.css 含响应式断点 @media', css.includes('@media'));
}

// ---------------------------------------------------------------- 动态层
async function browserChecks() {
  if (!fs.existsSync(CHROME)) {
    console.error(`[browser] 未找到 Chrome：${CHROME}，跳过动态层（静态层结果仍有效）`);
    return;
  }
  if (!fs.existsSync(indexJs)) throw new Error(`缺少 host bundle：${indexJs}`);

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugfunds-web-state-'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'plugfunds-web-cdp-'));
  process.env.PLUG_FUNDS_STATE_DIR = stateDir;
  process.env.DSH_HOME = stateDir;

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
  const { apply } = await import(indexJs);
  apply(mockCtx);

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const hit = [...routes.entries()].find(([p]) => pathname === p || pathname.startsWith(`${p}/`));
    if (hit) { hit[1](request, response); return; }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}${ROUTE}/`;

  /** 通过真实 RPC 播种最小可验证数据（现金面板 / 再平衡需要有数据才不是空表）。 */
  const rpcPost = async (method, params = {}) => {
    const res = await fetch(`${base}api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!body.success) throw new Error(`seed ${method} 失败：${JSON.stringify(body.error)}`);
    return body.data;
  };
  const account = await rpcPost('save_account', { name: '验证账户', platform: '本地' });
  const stock = await rpcPost('save_instrument', { code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', secid: '1.600036' });
  await rpcPost('record_transaction', {
    accountId: account.id, instrumentId: stock.id, type: 'OPENING',
    tradeDate: '2026-10-01', quantity: '100', amount: '1000.00',
  });
  await rpcPost('save_manual_price', { instrumentId: stock.id, value: '12.0000', tradingDate: '2026-11-13' });
  await rpcPost('save_cash_account', { name: '验证现金', balance: '800' });

  // 造一段指数日线，让「历史涨跌幅 / 波动率 / 定投」等二级视图有真实行可断言。
  const index = await rpcPost('save_instrument', { code: '000300', name: '沪深300', type: 'INDEX', market: 'SH', secid: '1.000300' });
  const weekdays = [];
  {
    const cursor = new Date('2026-08-03T00:00:00Z');
    while (weekdays.length < 45) {
      const day = cursor.getUTCDay();
      if (day !== 0 && day !== 6) weekdays.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }
  for (let i = 0; i < weekdays.length; i += 1) {
    await rpcPost('save_manual_price', {
      instrumentId: index.id,
      value: (4000 + i * 5 + (i % 3 === 0 ? 12 : -8)).toFixed(4),
      tradingDate: weekdays[i],
    });
  }
  await rpcPost('save_manual_metric', { instrumentId: index.id, metricKey: 'pe', value: '13.44', asOfDate: weekdays[weekdays.length - 1] });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  let seq = 0;
  const pending = new Map();
  const errors = [];
  const failedRequests = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时 ${method}`)); }, 30000);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };

  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    let port = 0;
    for (let i = 0; i < 80; i += 1) {
      if (fs.existsSync(portFile)) {
        port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0].trim());
        if (Number.isFinite(port) && port > 0) break;
      }
      await sleep(200);
    }
    if (!port) throw new Error('Chrome CDP 端口未就绪');

    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 CDP page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.method === 'Runtime.exceptionThrown') {
        errors.push('EXCEPTION: ' + JSON.stringify(m.params?.exceptionDetails?.text ?? m.params));
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        errors.push('CONSOLE: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        errors.push('LOG: ' + m.params.entry.text);
      }
      if (m.method === 'Network.responseReceived' && m.params?.response?.status >= 400) {
        failedRequests.push(`${m.params.response.status} ${m.params.response.url}`);
      }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');

    const asset = await fetch(`${base}app.js`);
    expect('HTTP /plug-funds/app.js 可访问', asset.status === 200, `status=${asset.status}`);

    await send('Page.navigate', { url: base });
    for (let i = 0; i < 40; i += 1) {
      await sleep(400);
      if (await evaluate('!!document.querySelector(".nav-item")')) break;
    }
    const navLabels = await evaluate('[...document.querySelectorAll(".nav-item")].map(e => e.innerText.trim())') ?? [];
    expect('SPA 已挂载（侧栏导航渲染）', navLabels.length >= 5, JSON.stringify(navLabels));
    expect('侧栏含「指数」入口', navLabels.includes('指数'), JSON.stringify(navLabels));

    // 总览页：决策就绪度卡片必须在真实浏览器里渲染出来（9 个维度 + 分数）。
    let readiness = null;
    for (let i = 0; i < 25; i += 1) {
      readiness = await evaluate(`(() => {
        const card = document.querySelector('.readiness');
        if (!card) return null;
        return {
          score: card.querySelector('.readiness-score')?.innerText.trim() ?? '',
          verdict: card.querySelector('.readiness-verdict')?.innerText.trim() ?? '',
          items: card.querySelectorAll('.readiness-item').length,
          width: card.querySelector('.readiness-bar i')?.style.width ?? '',
        };
      })()`);
      if (readiness) break;
      await sleep(300);
    }
    expect('总览渲染决策就绪度卡片', readiness !== null);
    if (readiness) {
      expect('就绪度含 9 个决策维度', readiness.items === 9, `items=${readiness.items}`);
      expect('就绪度显示分数', /\d+/.test(readiness.score), readiness.score);
      expect('就绪度给出明确结论', readiness.verdict.length > 0, readiness.verdict);
      expect('就绪度进度条有宽度', /%$/.test(readiness.width), readiness.width);
    }

    // 组合面板：现金 / 再平衡 / 风险参数必须在真实浏览器里渲染出来。
    const pf = await evaluate(`(() => {
      const grid = document.querySelector('.pf-grid');
      if (!grid) return null;
      const cards = grid.querySelectorAll(':scope > .card');
      const cashTable = grid.querySelector('.card table');
      const rb = [...document.querySelectorAll('.card')].find(c => c.querySelector('h2')?.innerText.trim() === '\\u518d\\u5e73\\u8861');
      return {
        cards: cards.length,
        cashRows: cashTable ? cashTable.querySelectorAll('tbody tr').length : 0,
        cashTotal: grid.querySelector('.pf-total')?.innerText.trim() ?? '',
        addInput: !!grid.querySelector('.pf-add-row input'),
        rateInput: !!grid.querySelector('.pf-rate input'),
        rbRows: rb ? rb.querySelectorAll('tbody tr').length : 0,
        rbText: rb ? rb.querySelector('tbody')?.innerText.replace(/\\s+/g, ' ') ?? '' : '',
        rbHold: rb ? rb.querySelectorAll('.pf-hold').length : 0,
      };
    })()`);
    expect('总览渲染现金与相关性面板', pf !== null);
    if (pf) {
      expect('组合面板为两栏布局', pf.cards === 2, `cards=${pf.cards}`);
      expect('现金面板显示账户行', pf.cashRows >= 1, `rows=${pf.cashRows}`);
      expect('现金合计显示金额', pf.cashTotal.includes('¥'), pf.cashTotal);
      expect('现金面板可新增账户', pf.addInput === true);
      expect('风险参数可设置无风险利率', pf.rateInput === true);
      expect('再平衡表列出资产类别', pf.rbRows >= 1, `rows=${pf.rbRows}`);
      expect('再平衡建议标签渲染', /\\u4fdd\\u6301|BUY|SELL/.test(pf.rbText) || pf.rbHold >= 1, pf.rbText);
    }

    const clicked = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.nav-item')].find(e => e.innerText.includes('\\u6307\\u6570'));
      if (!el) return false; el.click(); return true;
    })()`);
    expect('可点击「指数」导航', clicked === true);
    for (let i = 0; i < 30; i += 1) {
      await sleep(400);
      if (await evaluate('!!document.querySelector(".idx-table")')) break;
    }
    const info = await evaluate(`(() => {
      const t = document.querySelector('.idx-table');
      if (!t) return null;
      return {
        title: document.querySelector('.page-head h1')?.innerText.trim(),
        headerRows: t.querySelectorAll('thead tr').length,
        bodyRows: t.querySelectorAll('tbody tr').length,
        bodyCols: t.querySelectorAll('tbody tr:first-child td').length,
        groups: [...t.querySelectorAll('.idx-group')].map(e => e.innerText.trim()),
        sticky: getComputedStyle(t.querySelector('.idx-f2')).position,
        submenu: [...document.querySelectorAll('.idx-subitem')].length,
        ready: document.querySelector('.idx-ready')?.innerText.replace(/\\s+/g, ' ').slice(0, 100) ?? '',
      };
    })()`);
    expect('点击后渲染指数页表格', info !== null);
    if (info) {
      expect('页面标题为「指数」', info.title === '指数', String(info.title));
      expect('双层分组表头（2 行）', info.headerRows === 2, `rows=${info.headerRows}`);
      expect('表体 36 列高密度表格', info.bodyCols === 36, `cols=${info.bodyCols}`);
      expect('分组含 PE-TTM / PB / PS / ROE',
        ['PE-TTM', 'PB', 'PS', 'ROE'].every((g) => info.groups.includes(g)), JSON.stringify(info.groups));
      expect('左侧第二列 sticky 固定', info.sticky === 'sticky', String(info.sticky));
      expect('两行二级菜单已渲染', info.submenu >= 16, `count=${info.submenu}`);
      expect('结构预览行可见', info.bodyRows > 0, `rows=${info.bodyRows}`);
      expect('指数页显示数据就绪度摘要', info.ready.includes('真实数据') && info.ready.includes('结构预览'), info.ready);
    }

    // 二级菜单必须切出真实视图，而不是弹一句「暂未关注」。
    const openSub = async (label) => evaluate(`(() => {
      const el = [...document.querySelectorAll('.idx-subitem')].find(e => e.innerText.trim() === ${JSON.stringify(label)});
      if (!el) return false; el.click(); return true;
    })()`);
    const withShots = args.includes('--shots');
    const capture = async (tag) => {
      if (!withShots) return;
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = shotPath.replace(/\.png$/, `-${tag}.png`);
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(`  SHOT  ${file}`);
    };
    const viewProbe = async (label) => {
      await sleep(500);
      return evaluate(`(() => {
        const bar = document.querySelector('.idx-view-bar');
        const table = document.querySelector('.idx-view-table');
        const empty = document.querySelector('.idx-view-empty');
        return {
          title: bar?.querySelector('.ivb-title')?.innerText.trim() ?? '',
          rows: table ? table.querySelectorAll('tbody tr').length : 0,
          cols: table ? table.querySelectorAll('thead th').length : 0,
          empty: empty ? empty.innerText.replace(/\\s+/g, ' ').slice(0, 80) : '',
          needs: empty ? empty.querySelectorAll('.ive-needs li').length : 0,
        };
      })()`);
    };

    expect('可切换到「历史涨跌幅」', await openSub('历史涨跌幅') === true);
    const returns = await viewProbe();
    await capture('returns');
    expect('历史涨跌幅渲染视图标题', returns.title === '历史涨跌幅', returns.title);
    expect('历史涨跌幅有真实行', returns.rows >= 1, `rows=${returns.rows}`);
    expect('历史涨跌幅含 8 个阶段列', returns.cols >= 11, `cols=${returns.cols}`);

    expect('可切换到「波动率」', await openSub('波动率') === true);
    const vol = await viewProbe();
    await capture('volatility');
    expect('波动率视图有真实行', vol.rows >= 1, `rows=${vol.rows}`);

    expect('可切换到「指数定投策略」', await openSub('指数定投策略') === true);
    const dca = await viewProbe();
    await capture('dca');
    expect('定投回测视图有真实行', dca.rows >= 1, `rows=${dca.rows}`);

    expect('可切换到「指数相关性」', await openSub('指数相关性') === true);
    const corr = await viewProbe();
    await capture('correlation');
    expect('相关性视图在单只指数下给出原因', corr.empty.includes('无法计算相关性'), corr.empty);

    expect('可切换到「互联互通市场」', await openSub('互联互通市场') === true);
    const north = await viewProbe();
    expect('未覆盖的数据源显式说明而不是填 0',
      north.empty.includes('数据源未覆盖') && north.needs > 0, `${north.empty} · needs=${north.needs}`);

    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));
    console.log(`  SHOT  ${shotPath}`);

    expect('浏览器控制台零错误', errors.length === 0, errors.join(' | '));
    expect('无 4xx/5xx 资源请求', failedRequests.length === 0, failedRequests.join(' | '));
  } finally {
    try { ws?.close(); } catch { /* ignore */ }
    chrome.kill('SIGTERM');
    server.close();
  }
}

console.log('[verify-web] 开始');
staticChecks();
if (withBrowser) {
  console.log('[browser] 真实 Chrome 渲染验证');
  try {
    await browserChecks();
  } catch (error) {
    fail += 1;
    console.error(`  FAIL  动态层异常 — ${error.message}`);
  }
}
console.log(`[verify-web] 结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
