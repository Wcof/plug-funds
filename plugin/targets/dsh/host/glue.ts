/**
 * DeepSeek Harness 适配器 · Host 侧（DSH 专属知识全在这里）。
 *
 * 职责（ADR-0048 / plugbox 模式）：
 * 1. 打开本地状态库（~/.plug-funds/，env PLUG_FUNDS_STATE_DIR 可隔离）；
 * 2. 把随包 web/（SPA 构建产物）挂在同源前缀 /plug-funds/ 上，供 Client iframe 打开；
 * 3. 在同源下提供 POST /plug-funds/api/rpc（方法表见 server/api.ts，响应 PRD §8.4 封套）；
 * 4. 托管行情自动刷新的生命周期（交易时段按配置间隔触发，可关闭，见 repo/refresh-settings.ts）。
 *
 * 不做：不自建 webview、不反代其他产品、不剥离 XFO/CSP、不产生 .app / 端口 / 第二数据权威。
 * 打包：esbuild 将 core + server + 本文件打成单文件 index.js（自包含，仅依赖 node: 内置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openState, closeState, resolveStateDirs, type DbHandle } from '../../../server/src/db.ts';
import { createDefaultRegistry } from '../../../server/src/market/provider.ts';
import { dispatch } from '../../../server/src/api.ts';
import { getRefreshSettings } from '../../../server/src/repo/refresh-settings.ts';
import { migrateSecretsToKeychain } from '../../../server/src/repo/settings.ts';
import { isMarketOpen } from '../../../server/src/services/calendar.ts';
import { todayLocal } from '../../../server/src/ids.ts';
import type { ServiceContext } from '../../../server/src/context.ts';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(ROOT, 'web');
const ROUTE = '/plug-funds';
const ROUTE_PREFIX = `${ROUTE}/`;
const API_ROUTE = `${ROUTE}/api/rpc`;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

function sendText(response: import('node:http').ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function sendJson(response: import('node:http').ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function cacheControlFor(file: string): string {
  return file.endsWith('.html') || file.endsWith('.json')
    ? 'no-store'
    : 'public, max-age=31536000, immutable';
}

function resolveWebTarget(pathname: string): { kind: 'bad' | 'denied' | 'file'; file: string } {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice(ROUTE_PREFIX.length));
  } catch {
    return { kind: 'bad', file: '' };
  }
  if (relative.includes('\0')) return { kind: 'bad', file: '' };
  const file = path.resolve(WEB_ROOT, relative === '' ? 'index.html' : relative);
  if (file !== WEB_ROOT && !file.startsWith(`${WEB_ROOT}${path.sep}`)) return { kind: 'denied', file: '' };
  return { kind: 'file', file };
}

async function serveFile(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, file: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  response.writeHead(200, {
    'content-type': MIME.get(path.extname(file).toLowerCase()) ?? 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': cacheControlFor(file),
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  await new Promise<void>((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', () => { response.destroy(); resolve(); });
    stream.on('end', resolve);
    stream.pipe(response);
  });
  return true;
}

/** 只接受同源调用（跨站页面不能借 RPC 改数据）。 */
function sameOrigin(request: import('node:http').IncomingMessage): boolean {
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function readBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body-too-large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw === '' ? {} : JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    request.on('error', reject);
  });
}

interface DshWebServer {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void }): unknown;
  getOrigin?: () => string | undefined;
}

interface DshContext {
  inject(services: string[], fn: (scoped: { webServer: DshWebServer; effect(fn: () => unknown, label: string): void }) => void): void;
}

export function apply(ctx: DshContext): void {
  ctx.inject(['webServer'], (scoped) => {
    let handle: DbHandle | null = null;
    try {
      const dirs = resolveStateDirs();
      handle = openState(dirs);
      // 启动时把老库里的明文 API Key 搬进系统钥匙串（失败不影响启动，下次再试）。
      try {
        const migration = migrateSecretsToKeychain(handle);
        if (migration.migrated) console.log('[plug-funds] AI Key 已迁移到系统钥匙串');
      } catch (error) {
        console.error('[plug-funds] 密钥迁移失败：', (error as Error).message);
      }
    } catch (error) {
      // schema-too-new 等：入口页会通过 RPC/静态 409 提示；Host 不崩溃。
      console.error('[plug-funds] 状态库打开失败：', (error as Error).message);
    }

    // 多源：腾讯优先（A 股 / ETF / 指数 / 港股 / 美股 / 场外基金），东财补历史净值，任一源不可达可兜底。
    const registry = createDefaultRegistry();

    const handler = (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse): void => {
      void (async () => {
        let pathname = '/';
        try {
          pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        } catch {
          sendText(response, 400, 'Bad Request');
          return;
        }

        if (pathname === API_ROUTE) {
          if (request.method !== 'POST') {
            sendJson(response, 405, { success: false, error: { code: 'method-not-allowed', message: '只接受 POST' } });
            return;
          }
          if (!sameOrigin(request)) {
            sendJson(response, 403, { success: false, error: { code: 'cross-origin', message: '只允许同源调用' } });
            return;
          }
          if (!handle) {
            sendJson(response, 409, { success: false, error: { code: 'storage-unavailable', message: '状态库未打开：请查看宿主日志（可能需要升级插件）' } });
            return;
          }
          let body: Record<string, unknown>;
          try {
            body = await readBody(request);
          } catch (error) {
            sendJson(response, 400, { success: false, error: { code: String((error as Error).message), message: '请求体不合法' } });
            return;
          }
          const serviceCtx: ServiceContext = {
            handle, dirs: resolveStateDirs(), registry,
            today: todayLocal(), hideAmount: false,
          };
          const result = await dispatch(serviceCtx, String(body.method ?? ''), (body.params ?? {}) as Record<string, unknown>);
          sendJson(response, result.status, result.envelope);
          return;
        }

        const method = request.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(response, 405, 'Method Not Allowed');
          return;
        }
        if (pathname === ROUTE) {
          response.writeHead(308, { location: ROUTE_PREFIX, 'cache-control': 'no-store' });
          response.end();
          return;
        }
        if (!pathname.startsWith(ROUTE_PREFIX)) {
          sendText(response, 404, 'Not Found');
          return;
        }
        const target = resolveWebTarget(pathname);
        if (target.kind === 'bad') { sendText(response, 400, 'Bad Request'); return; }
        if (target.kind === 'denied') { sendText(response, 403, 'Forbidden'); return; }
        if (await serveFile(request, response, target.file)) return;
        const entry = path.join(WEB_ROOT, 'index.html');
        if (!fs.existsSync(entry)) {
          sendText(response, 503,
            '投资工作站前端未构建：包内缺少 web/index.html。\n请在本仓库运行 npm run build 后重启宿主窗口。\n');
          return;
        }
        // 无扩展名路径回落入口页（SPA 路由预留）。
        if (!path.extname(target.file) && (await serveFile(request, response, entry))) return;
        sendText(response, 404, 'Not Found');
      })().catch((error) => {
        if (!response.headersSent) sendText(response, 500, 'Internal Server Error');
        else response.destroy();
        console.error('[plug-funds] 路由处理失败：', error);
      });
    };

    scoped.effect(
      () =>
        scoped.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler,
        }),
      'plugfunds:web-route',
    );
    // DB 生命周期跟随插件：宿主卸载 / 停用时关闭（effect 返回清理函数由宿主接管）。
    scoped.effect(
      () => {
        if (!handle) return undefined;
        const closed = handle;
        return (): void => {
          try { closeState(closed); } catch { /* 已关闭 */ }
        };
      },
      'plugfunds:db-lifecycle',
    );

    // 行情自动刷新（PRD §4.5.2）：每秒检查配置与交易时段，按配置间隔触发。
    // 配置改动即时生效；in-flight 保护避免慢网络堆积；unref 保证不阻塞宿主退出。
    scoped.effect(
      () => {
        if (!handle) return undefined;
        const dbHandle = handle;
        let inFlight = false;
        let lastRunAt = Date.now();
        const calendarCtx = (): ServiceContext => ({
          handle: dbHandle, dirs: resolveStateDirs(), registry,
          today: todayLocal(), hideAmount: false,
        });
        const timer = setInterval(() => {
          void (async () => {
            if (inFlight) return;
            let settings;
            try {
              settings = getRefreshSettings(dbHandle);
            } catch {
              return; // 库已关闭 / 设置暂不可读
            }
            // 交易日历判定：用本机指数日线反推的交易日，节假日不再触发无效刷新。
            if (!settings.enabled) return;
            if (settings.tradingHoursOnly) {
              let open = false;
              try {
                open = isMarketOpen(calendarCtx());
              } catch {
                return;
              }
              if (!open) return;
            }
            const now = Date.now();
            if (now - lastRunAt < settings.intervalSec * 1000) return;
            inFlight = true;
            lastRunAt = now;
            try {
              await dispatch(calendarCtx(), 'refresh_market_data', {});
            } catch (error) {
              console.error('[plug-funds] 定时行情刷新失败：', (error as Error).message);
            } finally {
              inFlight = false;
            }
          })();
        }, 1000);
        timer.unref();
        return (): void => { clearInterval(timer); };
      },
      'plugfunds:market-refresh-timer',
    );
  });
}
