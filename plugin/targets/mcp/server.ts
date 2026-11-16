/**
 * MCP（Model Context Protocol）适配层：把插件的 RPC 能力暴露成一个 stdio MCP 服务器。
 *
 * 目的：同一套 server 层既能挂在 DSH 插槽里渲染 SPA，也能被 Zcode / 任何 MCP 宿主
 * 以工具形式调用，不必为每个宿主重写业务逻辑。
 *
 * 传输：stdio + 换行分隔的 JSON-RPC 2.0（MCP stdio 传输规定消息不得内含换行）。
 * 约束：与 DSH 产物一样自包含，只依赖 node: 内置模块 + 本仓库源码。
 */
import { createInterface } from 'node:readline';
import { openState, resolveStateDirs, type DbHandle } from '../../server/src/db.ts';
import { dispatch } from '../../server/src/api.ts';
import { createDefaultRegistry } from '../../server/src/market/provider.ts';
import { todayLocal } from '../../server/src/ids.ts';
import type { ServiceContext } from '../../server/src/context.ts';

const SERVER_NAME = 'plug-funds';
const SERVER_VERSION = '0.1.3';
const PROTOCOL_VERSION = '2024-11-05';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** RPC 方法名，默认与工具名一致。 */
  rpc?: string;
  /** 不传参数时为 true（用于没有必填项的方法）。 */
  readOnly: boolean;
}

const str = (description: string): unknown => ({ type: 'string', description });
const num = (description: string): unknown => ({ type: 'number', description });

const TOOLS: ToolDef[] = [
  {
    name: 'get_dashboard_summary',
    description: '组合总览：持仓市值、现金、总资产、当日/累计盈亏、数据日期与不完整持仓提示。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'list_positions',
    description: '持仓明细列表：每只标的的数量、成本、现价、市值、盈亏、权重与价格来源。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'get_position_detail',
    description: '单个持仓的完整详情（基础信息九项 + 交易流水）。',
    inputSchema: { type: 'object', properties: { positionId: str('持仓 ID，来自 list_positions') }, required: ['positionId'] },
    readOnly: true,
  },
  {
    name: 'get_holdings_valuation',
    description: '持仓估值截面：PE / PB / 股息率 / ROE 与策略评分。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'get_decision_readiness',
    description: '决策就绪度：9 个维度打分（0–100）、缺口清单与集中度指标，用于判断数据是否足以支撑资产决策。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'get_portfolio_risk',
    description: '组合风险画像：年化波动率、Beta、与基准相关性、跟踪误差、股债性价比（ERP）。',
    inputSchema: { type: 'object', properties: { range: str('区间：1m / 3m / 1y / all') } },
    readOnly: true,
  },
  {
    name: 'get_correlation_matrix',
    description: '持仓相关性矩阵（按市值取前 N 只，共同交易日不足 20 的位置为空）。',
    inputSchema: { type: 'object', properties: { limit: num('最多几只，默认 12') } },
    readOnly: true,
  },
  {
    name: 'get_rebalance_plan',
    description: '再平衡计划：类别目标权重 vs 实际权重、偏离与建议调整金额（仅建议，不下单）。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'list_cash_accounts',
    description: '现金 / 流动性账户列表与合计。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'get_index_valuation',
    description: '指数估值一览：点位、今年收益、PE/PB/PS 的当前值 / 分位 / 均值 / 极值、ROE。',
    inputSchema: {
      type: 'object',
      properties: {
        market: str('市场：全部 / 上证 / 深证 / 中证 / 港股指数 …'),
        category: str('类别：全部 / 宽基 / 行业 / 主题 / 策略'),
        stat: str('聚合口径标注：加权平均值 / 等权平均值 / 算数平均值 / 中位数'),
        years: num('回看年数：0=所有，20 / 10 / 5 / 3'),
      },
    },
    readOnly: true,
  },
  {
    name: 'get_index_analytics',
    description: '指数分析：阶段收益、波动率、最大回撤、新高新低、RPS、相关性矩阵、定投回测、格雷厄姆指数。',
    inputSchema: { type: 'object', properties: { limit: num('最多几个指数，默认 30') } },
    readOnly: true,
  },
  {
    name: 'get_trading_calendar',
    description: '交易日历：数据来源（真实指数日线 / 工作日推断）、交易日数、推导出的休市日、当前会话状态。',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
  },
  {
    name: 'refresh_market_data',
    description: '刷新行情：多源（腾讯优先、东财兜底）拉取报价 / 历史 / 估值，返回每个标的的成功与否与多源分歧。',
    inputSchema: { type: 'object', properties: { instrumentIds: { type: 'array', items: { type: 'string' }, description: '可选，只刷新指定标的' } } },
    readOnly: false,
  },
  {
    name: 'record_transaction',
    description: '记一笔交易流水（买入 / 卖出 / 分红 / 期初等）；create-only，写入后持仓按流水回放重算。',
    inputSchema: {
      type: 'object',
      properties: {
        accountId: str('账户 ID'),
        instrumentId: str('标的 ID'),
        type: str('交易类型：BUY / SELL / OPENING / DIVIDEND_CASH / DIVIDEND_REINVEST / FEE / SPLIT / CORRECTION'),
        tradeDate: str('交易日 YYYY-MM-DD'),
        quantity: str('数量 / 份额'),
        price: str('价格'),
        amount: str('金额'),
        fee: str('手续费'),
        tax: str('税费'),
        note: str('备注'),
        requestId: str('幂等键（重复提交不会重复写入）'),
      },
      required: ['accountId', 'instrumentId', 'type', 'tradeDate'],
    },
    readOnly: false,
  },
  {
    name: 'save_manual_price',
    description: '录入手工价格（MANUAL_PRICE，优先级高于实时与收盘价）。',
    inputSchema: {
      type: 'object',
      properties: {
        instrumentId: str('标的 ID'),
        value: str('价格'),
        tradingDate: str('日期 YYYY-MM-DD，默认今天'),
      },
      required: ['instrumentId', 'value'],
    },
    readOnly: false,
  },
  {
    name: 'save_cash_account',
    description: '新增或更新现金账户（时点余额，计入总资产与再平衡分母）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('账户 ID（传入表示更新）'),
        name: str('账户名称'),
        balance: str('余额'),
        currency: str('币种，默认 CNY'),
        note: str('备注'),
      },
      required: ['name'],
    },
    readOnly: false,
  },
  {
    name: 'save_rebalance_targets',
    description: '保存再平衡目标权重（0–1 小数，合计 ≤ 1）与触发阈值。',
    inputSchema: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          description: '目标权重数组，如 [{"category":"stock","targetWeight":0.6}]',
          items: {
            type: 'object',
            properties: { category: str('stock / etf / fund / cash'), targetWeight: num('0–1') },
            required: ['category', 'targetWeight'],
          },
        },
        threshold: num('偏离阈值，默认 0.05'),
      },
      required: ['targets'],
    },
    readOnly: false,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ---------------- 状态与上下文 ---------------- */

let handle: DbHandle | null = null;
let handleError: string | null = null;

function ensureHandle(): DbHandle | null {
  if (handle) return handle;
  if (handleError) return null;
  try {
    handle = openState(resolveStateDirs());
    return handle;
  } catch (error) {
    handleError = (error as Error).message;
    return null;
  }
}

function makeContext(db: DbHandle): ServiceContext {
  return {
    handle: db,
    dirs: resolveStateDirs(),
    registry: createDefaultRegistry(),
    today: todayLocal(),
    hideAmount: false,
  };
}

/* ---------------- JSON-RPC ---------------- */

type JsonRpcId = string | number | null;

function reply(id: JsonRpcId, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: JsonRpcId, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  const db = ensureHandle();
  if (!db) throw new Error(`状态库打开失败：${handleError ?? '未知原因'}`);
  const result = await dispatch(makeContext(db), tool.rpc ?? tool.name, args);
  if (result.status !== 200) {
    throw new Error(`[${result.envelope.error?.code ?? 'error'}] ${result.envelope.error?.message ?? '调用失败'}`);
  }
  return result.envelope.data;
}

async function handleMessage(message: Record<string, unknown>): Promise<void> {
  const id = (message.id ?? null) as JsonRpcId;
  const method = String(message.method ?? '');
  const params = (message.params ?? {}) as Record<string, unknown>;

  // 通知（无 id）不需要响应
  if (message.id === undefined) {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
    return;
  }

  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: '个人投资工作站本地数据：持仓、现金、指数估值、风险与决策就绪度。数据来自本机 SQLite，不上传云端。',
      });
      return;
    case 'ping':
      reply(id, {});
      return;
    case 'tools/list':
      reply(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: `${tool.description}${tool.readOnly ? '' : '（写入本机数据库）'}`,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case 'tools/call': {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const data = await callTool(name, args);
        reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false });
      } catch (error) {
        reply(id, { content: [{ type: 'text', text: (error as Error).message }], isError: true });
      }
      return;
    }
    case 'shutdown':
      reply(id, { ok: true });
      process.exit(0);
      return;
    default:
      replyError(id, -32601, `未实现的方法：${method}`);
  }
}

const reader = createInterface({ input: process.stdin, terminal: false });
reader.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    replyError(null, -32700, 'JSON 解析失败');
    return;
  }
  void handleMessage(message).catch((error: unknown) => {
    replyError((message.id ?? null) as JsonRpcId, -32603, (error as Error).message);
  });
});
reader.on('close', () => {
  if (handle) {
    try { handle.db.close(); } catch { /* 已关闭 */ }
  }
  process.exit(0);
});

// 启动横幅走 stderr，避免污染 stdout 的 JSON-RPC 流。
console.error(`[${SERVER_NAME}] MCP server ready · ${TOOLS.length} tools · state=${resolveStateDirs().data}`);
