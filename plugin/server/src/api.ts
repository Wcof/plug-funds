/**
 * RPC 分发层：方法表 → 服务层；响应封套 `{success, data, error, traceId}`（PRD §8.4）。
 *
 * - 隐藏金额（DASH-12）在 API 出口按方法白名单字段统一掩码；
 * - 服务层错误（LedgerError / SchemaError / ValidationError / NotFoundError）映射为可读错误码；
 * - 不持有 HTTP 细节（返回 status + envelope），便于脱离 DSH 测试与未来适配 MCP / Zcode。
 */
import { randomUUID } from 'node:crypto';
import { fail, ok, type RpcEnvelope } from '../../core/src/rpc.ts';
import { LedgerError, replayPositions } from '../../core/src/ledger.ts';
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, mulToScale, parseFixed } from '../../core/src/money.ts';
import { periodReturn } from '../../core/src/valuation.ts';
import type { Instrument } from '../../core/src/types.ts';
import type { ServiceContext } from './context.ts';
import { NotFoundError, ValidationError } from './errors.ts';
import { SchemaError } from './db.ts';
import { listAccounts, saveAccount, archiveAccount } from './repo/accounts.ts';
import { getInstrument, saveInstrument, searchInstruments } from './repo/instruments.ts';
import { allTransactions, listTransactions, saveTransaction, deletePosition, getTransaction } from './repo/transactions.ts';
import { listCategories, saveCategory, deleteCategory, listLinks, setInstrumentCategories } from './repo/categories.ts';
import { getEnabledGoal, listGoals, saveGoal, listCashFlows, saveCashFlow, deleteCashFlow } from './repo/goal.ts';
import { getSetting, setSetting } from './repo/settings.ts';
import { currentSecretBackend } from './secrets.ts';
import {
  getRefreshSettings, saveRefreshSettings,
  MIN_REFRESH_INTERVAL_SEC, MAX_REFRESH_INTERVAL_SEC,
} from './repo/refresh-settings.ts';
import { getTradingCalendarInfo } from './services/calendar.ts';
import { getIndexAnalytics } from './services/index-analytics.ts';
import { effectiveHistoryPoints, latestValuationMetrics, saveMarketPoints, saveValuationMetric } from './repo/market.ts';
import { listTemplates, saveTemplate, listVersions, restoreVersion } from './repo/strategies.ts';
import { previewImport, commitImport } from './services/import.ts';
import { xlsxBase64ToCsv } from './xlsx.ts';
import { previewRestore, restoreBackup } from './services/restore.ts';
import { listHoldings, setPinned } from './services/holdings.ts';
import { getDashboardSummary, getDashboardAllocation, getPerformance, type RangeKey } from './services/dashboard.ts';
import { getInstrumentChartSeries, type ChartPeriod, type ChartTab } from './services/charts.ts';
import { getHoldingsValuation } from './services/valuation-view.ts';
import { analyzeHolding, getAiStatus, testAiConnection, updateAiSettings } from './services/ai.ts';
import { exportBackup, exportHoldingsCsv } from './services/backup.ts';
import { refreshMarketData } from './services/refresh.ts';
import { getIndexValuation } from './services/index-valuation.ts';
import { getDecisionReadiness } from './services/decision-readiness.ts';
import { bootstrapIndices, seedCommonIndices } from './services/indices.ts';
import { getPortfolioRisk, getCorrelationMatrix, saveRiskFreeRate } from './services/risk.ts';
import { listCashAccounts, saveCashAccount, deleteCashAccount } from './repo/cash.ts';
import { getRebalancePlan, saveRebalanceTargets, listRebalanceTargets } from './services/rebalance.ts';

const APP_VERSION = '0.1.2';

/* ---------------- DASH-12 金额掩码 ---------------- */

const MASKED_KEYS = new Set([
  'totalMarketValue', 'marketValue', 'pnl', 'costTotal', 'realized', 'dividends',
  'cumulative', 'dayPnl', 'unrealized', 'totalCost', 'totalPnl',
  'remainingAmount', 'overAmount', 'effectiveGoalAmount', 'targetAmount', 'amount', 'daily',
  // 集中度 / 就绪度里的合计金额属于展示口径，隐藏金额时必须一起掩码。
  'coveredValue',
  // 现金与再平衡同样是金额展示口径：漏掉就会在隐藏金额时把余额暴露出来。
  'cashTotal', 'totalAssets', 'investableAssets', 'currentValue', 'balance',
]);

/**
 * 展示掩码的豁免方法：数据出口（导出 / 备份）、配置与 AI 结果不是「页面展示」。
 * 特别是 export_backup：若在隐藏金额状态下把金额写成 ****，备份将永久失去真实数值。
 */
const MASK_EXEMPT = new Set([
  'export_backup', 'export_holdings_csv', 'get_app_info',
  'get_ai_settings', 'save_ai_settings', 'test_ai_connection', 'analyze_holding_with_ai',
  'preview_import_transactions', 'commit_import_transactions',
  'preview_restore_backup', 'restore_backup',
]);

function maskDeep(data: unknown): unknown {
  if (Array.isArray(data)) return data.map((item) => maskDeep(item));
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      out[key] = typeof value === 'string' && MASKED_KEYS.has(key) && value !== '' && value !== '-'
        ? '****'
        : maskDeep(value);
    }
    return out;
  }
  return data;
}

/* ---------------- 持仓详情（PRD §4.12.2 九项基础信息） ---------------- */

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function getPositionDetail(ctx: ServiceContext, positionId: string) {
  const [accountId] = positionId.split(':');
  const holdings = listHoldings(ctx, { accountId });
  const holding = holdings.rows.find((r) => `${r.accountId}:${r.instrumentId}` === positionId);
  if (!holding) throw new NotFoundError(`position not found: ${positionId}`);
  const instrument = getInstrument(ctx.handle, holding.instrumentId);
  if (!instrument) throw new NotFoundError(`instrument not found: ${holding.instrumentId}`);

  // 当日 / 昨日收益：与 effectivePrice 同口径的有效价格序列（PRD §6.2）
  const points = effectiveHistoryPoints(ctx.handle, holding.instrumentId, instrument.type);
  const qtyRaw = parseFixed(holding.qty, SCALE_QTY);
  const current = points.length > 0 ? parseFixed(points[points.length - 1].value, SCALE_QTY) : null;
  const prev = points.length >= 2 ? parseFixed(points[points.length - 2].value, SCALE_QTY) : null;
  const prev2 = points.length >= 3 ? parseFixed(points[points.length - 3].value, SCALE_QTY) : null;
  const dayPnlAmount = current !== null && prev !== null
    ? mulToScale(current - prev, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2)
    : null;
  const ydayPnlAmount = prev !== null && prev2 !== null
    ? mulToScale(prev - prev2, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2)
    : null;

  const flows = listTransactions(ctx.handle, { instrumentId: holding.instrumentId, accountId });
  return {
    holding,
    instrument,
    basics: {
      marketValue: holding.marketValue,
      qty: holding.qty,
      weight: holding.weight,
      pnl: holding.pnl,
      pnlRate: holding.pnlRate,
      costTotal: holding.costTotal,
      unitCost: holding.unitCost,
      dayPnl: dayPnlAmount === null ? null : formatFixed(dayPnlAmount, SCALE_AMOUNT),
      ydayPnl: ydayPnlAmount === null ? null : formatFixed(ydayPnlAmount, SCALE_AMOUNT),
      heldDays: holding.firstHeldDate ? daysBetween(holding.firstHeldDate, ctx.today) : null,
      firstHeldDate: holding.firstHeldDate,
      dayPnlNote: dayPnlAmount === null ? '缺少可比价格，暂无可比当日收益' : null,
    },
    transactions: flows,
    transactionsNote: '删除持仓不删除交易流水（审计保留）',
  };
}

/* ---------------- PK 对比（PRD §4.12.4） ---------------- */

async function compareInstruments(
  ctx: ServiceContext,
  input: { aInstrumentId: string; bInstrumentId: string; period?: RangeKey },
) {
  const a = getInstrument(ctx.handle, input.aInstrumentId);
  const b = getInstrument(ctx.handle, input.bInstrumentId);
  if (!a || !b) throw new NotFoundError('instrument not found');
  if ((a.type === 'STOCK') !== (b.type === 'STOCK')) {
    throw new ValidationError('PK 仅支持同类型对比（基金 / ETF 或股票）');
  }
  const range: RangeKey = input.period ?? '1y';
  const rowFor = async (instrument: Instrument) => {
    const chart = await getInstrumentChartSeries(ctx, { instrumentId: instrument.id, tab: 'perf', period: range, compare: 'none' });
    const values = chart.series.map((p) => parseFixed(p.value, SCALE_QTY));
    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const metricValue = (key: string): string | null => metrics.find((m) => m.metricKey === key)?.value ?? null;
    return {
      name: instrument.name,
      code: instrument.code,
      periodReturn: periodReturn(values),
      foundedDate: instrument.foundedDate,
      scaleInfo: instrument.scaleInfo,
      pe: metricValue('pe'),
      pb: metricValue('pb'),
      dividendYield: metricValue('dividend_yield'),
      roe: metricValue('roe'),
      series: chart.series,
      seriesPoints: chart.series.length,
    };
  };
  const rowA = await rowFor(a);
  const rowB = await rowFor(b);
  return {
    period: range,
    a: rowA,
    b: rowB,
    note: '收益率为区间累计涨跌幅；规模 / 成立日期来自标的档案；指标缺失显示「—」，不默认 0。对比结果仅供研究参考，不构成投资建议。',
  };
}

/* ---------------- 分发 ---------------- */

export interface ApiResult {
  status: number;
  envelope: RpcEnvelope;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 导入文本：优先 .xlsx（base64），否则用 CSV 文本；两者都空则交给导入层报错。 */
function importText(params: Record<string, unknown>): string {
  const xlsx = str(params.xlsxBase64);
  if (xlsx !== '') return xlsxBase64ToCsv(xlsx).csv;
  return str(params.csv);
}

const HANDLERS: Record<string, (ctx: ServiceContext, params: Record<string, unknown>) => unknown | Promise<unknown>> = {
  get_app_info: (ctx) => ({
    name: '个人投资工作站',
    version: APP_VERSION,
    schemaVersion: ctx.handle.schemaVersion,
    engine: ctx.handle.engine,
    dataDir: ctx.dirs.data,
    isNew: ctx.handle.isNew,
    hideAmount: getSetting(ctx.handle, 'hide_amount') === true,
    secretBackend: currentSecretBackend(),
  }),
  get_dashboard_summary: (ctx) => getDashboardSummary(ctx),
  get_dashboard_allocation: (ctx, params) => getDashboardAllocation(ctx, str(params.mode, 'full') === 'goal' ? 'goal' : 'full'),
  get_portfolio_goal: (ctx) => ({
    enabled: getEnabledGoal(ctx.handle),
    goals: listGoals(ctx.handle),
    cashFlows: listCashFlows(ctx.handle),
  }),
  save_portfolio_goal: (ctx, params) => saveGoal(ctx.handle, {
    id: typeof params.id === 'string' ? params.id : undefined,
    name: str(params.name, '我的投资资产目标'),
    targetAmount: str(params.targetAmount, '0'),
    enabled: params.enabled === true,
    note: str(params.note),
  }),
  get_portfolio_performance_metrics: (ctx, params) => getPerformance(
    ctx,
    str(params.range, '1y') as RangeKey,
    params.custom as { begin: string; end: string } | undefined,
  ),
  list_accounts: (ctx, params) => listAccounts(
    ctx.handle,
    params.status === 'ARCHIVED' ? 'ARCHIVED' : params.status === 'ACTIVE' ? 'ACTIVE' : undefined,
  ),
  save_account: (ctx, params) => saveAccount(ctx.handle, {
    id: typeof params.id === 'string' ? params.id : undefined,
    name: str(params.name),
    platform: str(params.platform),
    note: str(params.note),
  }),
  archive_account: (ctx, params) => archiveAccount(ctx.handle, str(params.id)),
  search_instruments: (ctx, params) => searchInstruments(ctx.handle, str(params.keyword)),
  save_instrument: (ctx, params) => saveInstrument(ctx.handle, {
    id: typeof params.id === 'string' ? params.id : undefined,
    code: str(params.code),
    name: str(params.name),
    type: str(params.type, 'STOCK') as Instrument['type'],
    market: str(params.market, 'SH') as Instrument['market'],
    benchmarkIndex: typeof params.benchmarkIndex === 'string' ? params.benchmarkIndex : null,
    secid: typeof params.secid === 'string' ? params.secid : null,
    fundCode: typeof params.fundCode === 'string' ? params.fundCode : null,
    tag: str(params.tag),
    foundedDate: typeof params.foundedDate === 'string' ? params.foundedDate : null,
    scaleInfo: typeof params.scaleInfo === 'string' ? params.scaleInfo : null,
  }),
  list_positions: (ctx, params) => listHoldings(ctx, {
    type: typeof params.type === 'string' && params.type !== 'all' ? params.type : undefined,
    accountId: typeof params.accountId === 'string' && params.accountId !== 'all' ? params.accountId : undefined,
    pnl: params.pnl === 'gain' || params.pnl === 'loss' ? params.pnl : undefined,
  }),
  get_position_detail: (ctx, params) => getPositionDetail(ctx, str(params.positionId)),
  record_transaction: (ctx, params) => {
    const saved = saveTransaction(ctx.handle, {
      accountId: str(params.accountId),
      instrumentId: str(params.instrumentId),
      type: str(params.type) as Parameters<typeof saveTransaction>[0]['type'],
      status: params.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'CONFIRMED',
      tradeDate: str(params.tradeDate),
      quantity: typeof params.quantity === 'string' ? params.quantity : null,
      price: typeof params.price === 'string' ? params.price : null,
      amount: typeof params.amount === 'string' ? params.amount : null,
      fee: typeof params.fee === 'string' ? params.fee : null,
      tax: typeof params.tax === 'string' ? params.tax : null,
      note: str(params.note),
      requestId: typeof params.requestId === 'string' ? params.requestId : null,
    });
    // 写后校验：回放失败（如超卖）→ 回滚本次写入并报错
    try {
      replayPositions(allTransactions(ctx.handle));
    } catch (error) {
      if (!saved.deduplicated) {
        ctx.handle.db.prepare('DELETE FROM transactions WHERE id = ?').run(saved.txn.id);
      }
      throw error;
    }
    return saved;
  },
  list_transactions: (ctx, params) => listTransactions(ctx.handle, {
    accountId: typeof params.accountId === 'string' ? params.accountId : undefined,
    instrumentId: typeof params.instrumentId === 'string' ? params.instrumentId : undefined,
    type: typeof params.type === 'string' ? (params.type as never) : undefined,
    status: typeof params.status === 'string' ? (params.status as never) : undefined,
  }),
  delete_position: (ctx, params) => {
    const positionId = str(params.positionId);
    const [accountId, instrumentId] = positionId.split(':');
    deletePosition(ctx.handle, accountId, instrumentId);
    return { ok: true, note: '交易流水保留（审计）' };
  },
  pin_position: (ctx, params) => {
    setPinned(ctx.handle, str(params.positionId), params.pinned === true);
    return { ok: true };
  },
  list_categories: (ctx) => {
    const categories = listCategories(ctx.handle);
    const links = listLinks(ctx.handle);
    return {
      categories: categories.map((c) => ({
        ...c,
        count: links.filter((l) => l.categoryId === c.id).length,
      })),
      links,
    };
  },
  save_category: (ctx, params) => saveCategory(ctx.handle, {
    id: typeof params.id === 'string' ? params.id : undefined,
    name: str(params.name),
    color: str(params.color, '#3d6ef2'),
  }),
  delete_category: (ctx, params) => ({ deleted: deleteCategory(ctx.handle, str(params.id)) }),
  set_instrument_categories: (ctx, params) => {
    setInstrumentCategories(
      ctx.handle,
      str(params.instrumentId),
      Array.isArray(params.categoryIds) ? params.categoryIds.map(String) : [],
    );
    return { ok: true };
  },
  get_instrument_chart_series: (ctx, params) => getInstrumentChartSeries(ctx, {
    instrumentId: str(params.instrumentId),
    tab: str(params.tab, 'perf') as ChartTab,
    period: str(params.period, '1y') as ChartPeriod,
    compare: typeof params.compare === 'string' ? params.compare : 'none',
    custom: params.custom as { begin: string; end: string } | undefined,
  }),
  get_instrument_detail: async (ctx, params) => {
    const instrument = getInstrument(ctx.handle, str(params.instrumentId));
    if (!instrument) throw new NotFoundError(`instrument not found: ${String(params.instrumentId)}`);
    const chart = await getInstrumentChartSeries(ctx, { instrumentId: instrument.id, tab: 'perf', period: '1y', compare: 'none' });
    const values = chart.series.map((p) => parseFixed(p.value, SCALE_QTY));
    return {
      instrument,
      stageReturns: {
        '近 1 月': periodReturn(values.slice(-21)),
        '近 3 月': periodReturn(values.slice(-64)),
        '近 1 年': periodReturn(values),
      },
      series: chart.series,
    };
  },
  get_holdings_valuation: (ctx, params) => getHoldingsValuation(ctx, {
    type: typeof params.type === 'string' && params.type !== 'all' ? params.type : undefined,
    // 估值页要「全部标的」；总览 / 持仓页保持只出持仓的原有口径。
    scope: params.scope === 'all' ? 'all' : 'holdings',
  }),
  analyze_holding_with_ai: async (ctx, params) => analyzeHolding(ctx, str(params.positionId)),
  get_ai_settings: (ctx) => getAiStatus(ctx),
  save_ai_settings: (ctx, params) => updateAiSettings(ctx, {
    baseUrl: typeof params.baseUrl === 'string' ? params.baseUrl : undefined,
    apiKey: typeof params.apiKey === 'string' ? params.apiKey : undefined,
    model: typeof params.model === 'string' ? params.model : undefined,
  }),
  test_ai_connection: (ctx) => testAiConnection(ctx),
  compare_instruments: (ctx, params) => compareInstruments(ctx, {
    aInstrumentId: str(params.aInstrumentId),
    bInstrumentId: str(params.bInstrumentId),
    period: typeof params.period === 'string' ? (params.period as RangeKey) : undefined,
  }),
  refresh_market_data: async (ctx, params) => refreshMarketData(ctx, {
    instrumentIds: Array.isArray(params.instrumentIds) ? params.instrumentIds.map(String) : undefined,
  }),
  get_refresh_settings: (ctx) => {
    const calendar = getTradingCalendarInfo(ctx);
    return {
      settings: getRefreshSettings(ctx.handle),
      // 用真实交易日历判定，而不是「周一到周五」：节假日不再触发无效刷新。
      inTradingHours: calendar.session.open,
      session: calendar.session,
      // 只回摘要，不回整段日期数组：几千个日期字符串对页面没有价值，还会撑大响应。
      calendar: {
        source: calendar.calendar.source,
        dayCount: calendar.tradingDayCount,
        from: calendar.calendar.from,
        to: calendar.calendar.to,
        holidays: calendar.holidayCount,
        recentHolidays: calendar.recentHolidays,
      },
      limits: { minSec: MIN_REFRESH_INTERVAL_SEC, maxSec: MAX_REFRESH_INTERVAL_SEC },
      note: calendar.calendar.source === 'market'
        ? '交易时段按 UTC+8 的 09:30–11:30 / 13:00–15:00 判断，交易日取自本机指数日线（已排除节假日）。'
        : '交易时段按 UTC+8 的 09:30–11:30 / 13:00–15:00 判断；尚无足够指数日线，节假日可能误判。',
    };
  },
  save_refresh_settings: (ctx, params) => ({
    settings: saveRefreshSettings(ctx.handle, {
      enabled: typeof params.enabled === 'boolean' ? params.enabled : undefined,
      intervalSec: params.intervalSec === undefined ? undefined : Number(params.intervalSec),
      tradingHoursOnly: typeof params.tradingHoursOnly === 'boolean' ? params.tradingHoursOnly : undefined,
    }),
  }),
  get_index_valuation: (ctx, params) => getIndexValuation(ctx, {
    market: typeof params.market === 'string' ? params.market : undefined,
    category: typeof params.category === 'string' ? params.category : undefined,
    stat: typeof params.stat === 'string' ? params.stat : undefined,
    years: params.years === undefined ? undefined : Number(params.years),
  }),
  get_decision_readiness: (ctx) => getDecisionReadiness(ctx),
  seed_common_indices: (ctx) => seedCommonIndices(ctx),
  bootstrap_indices: (ctx) => bootstrapIndices(ctx),
  get_portfolio_risk: (ctx, params) => getPortfolioRisk(ctx, str(params.range, '1y') as RangeKey),
  save_risk_settings: (ctx, params) => {
    const rate = Number(params.riskFreeRate);
    if (!Number.isFinite(rate)) throw new ValidationError('riskFreeRate 必须是 0–0.2 之间的小数');
    return { riskFreeRate: saveRiskFreeRate(ctx.handle, rate) };
  },
  get_correlation_matrix: (ctx, params) => getCorrelationMatrix(ctx, params.limit === undefined ? 12 : Number(params.limit)),
  list_cash_accounts: (ctx) => ({ accounts: listCashAccounts(ctx.handle) }),
  save_cash_account: (ctx, params) => saveCashAccount(ctx.handle, {
    id: typeof params.id === 'string' ? params.id : undefined,
    name: str(params.name),
    balance: str(params.balance, '0'),
    currency: typeof params.currency === 'string' ? params.currency : undefined,
    note: str(params.note),
    active: params.active === undefined ? undefined : params.active === true,
  }),
  delete_cash_account: (ctx, params) => ({ deleted: deleteCashAccount(ctx.handle, str(params.id)) }),
  get_rebalance_plan: (ctx) => getRebalancePlan(ctx),
  save_rebalance_targets: (ctx, params) => saveRebalanceTargets(
    ctx,
    Array.isArray(params.targets) ? (params.targets as { category: string; targetWeight: number }[]) : [],
    params.threshold === undefined ? undefined : Number(params.threshold),
  ),
  get_trading_calendar: (ctx, params) => {
    const info = getTradingCalendarInfo(
      ctx,
      typeof params.now === 'string' && params.now !== '' ? new Date(params.now) : new Date(),
    );
    return info;
  },
  get_index_analytics: (ctx, params) => getIndexAnalytics(ctx, {
    limit: params.limit === undefined ? undefined : Number(params.limit),
  }),
  export_backup: (ctx) => exportBackup(ctx),
  export_holdings_csv: (ctx) => ({ csv: exportHoldingsCsv(ctx) }),
  set_hide_amount: (ctx, params) => {
    setSetting(ctx.handle, 'hide_amount', params.enabled === true);
    return { enabled: params.enabled === true };
  },
  save_manual_price: (ctx, params) => {
    const instrument = getInstrument(ctx.handle, str(params.instrumentId));
    if (!instrument) throw new NotFoundError(`instrument not found: ${String(params.instrumentId)}`);
    const tradingDate = typeof params.tradingDate === 'string' && params.tradingDate !== '' ? params.tradingDate : ctx.today;
    saveMarketPoints(ctx.handle, [{
      instrumentId: instrument.id,
      priceType: 'MANUAL_PRICE',
      value: str(params.value),
      currency: 'CNY',
      tradingDate,
      observedAt: new Date().toISOString(),
      provider: 'manual',
      quality: 'MANUAL',
    }]);
    return { ok: true, note: '手工价格已录入（MANUAL_PRICE，优先于其他来源）' };
  },

  /* ---------------- 组合外部资金流水（XIRR / 单位净值的输入） ---------------- */
  save_portfolio_cash_flow: (ctx, params) => saveCashFlow(ctx.handle, {
    flowType: params.flowType === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'CONTRIBUTION',
    flowDate: str(params.flowDate, ctx.today),
    amount: str(params.amount),
    note: str(params.note),
  }),
  delete_portfolio_cash_flow: (ctx, params) => ({ deleted: deleteCashFlow(ctx.handle, str(params.id)) }),

  /* ---------------- CSV 导入 / 备份恢复 ---------------- */
  preview_import_transactions: (ctx, params) => previewImport(ctx, importText(params)),
  commit_import_transactions: (ctx, params) => commitImport(ctx, importText(params)),
  preview_restore_backup: (_ctx, params) => previewRestore(params.payload),
  restore_backup: (ctx, params) => restoreBackup(ctx, params.payload),

  /* ---------------- 策略模板可编辑 + 版本化 ---------------- */
  list_strategy_templates: (ctx) => ({ templates: listTemplates(ctx.handle) }),
  save_strategy_template: (ctx, params) => ({
    template: saveTemplate(ctx.handle, {
      id: typeof params.id === 'string' && params.id !== '' ? params.id : undefined,
      name: str(params.name),
      scope: str(params.scope),
      metrics: params.metrics,
      note: str(params.note),
    }),
  }),
  list_strategy_versions: (ctx, params) => ({ versions: listVersions(ctx.handle, str(params.templateId)) }),
  restore_strategy_version: (ctx, params) => ({
    template: restoreVersion(ctx.handle, str(params.templateId), Number(params.version)),
  }),

  /* ---------------- 手工补录估值指标（数据源缺失时诚实标注 MANUAL） ---------------- */
  save_manual_metric: (ctx, params) => {
    const allowed = new Set([
      'pe', 'pb', 'pe_percentile', 'pb_percentile', 'dividend_yield', 'roe',
      'sharpe', 'max_drawdown_pct', 'annual_volatility_pct',
    ]);
    const metricKey = str(params.metricKey);
    if (!allowed.has(metricKey)) throw new ValidationError(`不支持的估值指标：${metricKey}`);
    const value = str(params.value);
    if (value === '' || !Number.isFinite(Number(value))) throw new ValidationError('指标值必须是数字');
    const instrument = getInstrument(ctx.handle, str(params.instrumentId));
    if (!instrument) throw new NotFoundError('标的不存在');
    saveValuationMetric(ctx.handle, {
      instrumentId: instrument.id, metricKey, value,
      asOfDate: str(params.asOfDate, ctx.today), provider: 'manual', quality: 'MANUAL',
    });
    return { ok: true, note: '手工估值指标已录入（MANUAL，评分按来源标注，不冒充行情数据）' };
  },
};

export function listRpcMethods(): string[] {
  return Object.keys(HANDLERS);
}

export async function dispatch(
  ctx: ServiceContext,
  method: string,
  params: Record<string, unknown> = {},
): Promise<ApiResult> {
  const traceId = randomUUID();
  const handler = HANDLERS[method];
  if (!handler) {
    return { status: 404, envelope: fail(traceId, 'unknown-method', `未知方法: ${method}`) };
  }
  try {
    const data = await handler(ctx, params);
    let payload: unknown = data;
    // DASH-12：每次请求读设置，开关即时生效；导出 / 备份等数据出口不参与掩码
    if (!MASK_EXEMPT.has(method) && getSetting(ctx.handle, 'hide_amount') === true) {
      payload = maskDeep(payload);
    }
    return { status: 200, envelope: ok(traceId, payload) };
  } catch (error) {
    if (error instanceof LedgerError) {
      return { status: 422, envelope: fail(traceId, error.code, error.message, error.detail) };
    }
    if (error instanceof SchemaError) {
      return { status: 409, envelope: fail(traceId, error.code, error.message, error.detail) };
    }
    if (error instanceof ValidationError) {
      return { status: 422, envelope: fail(traceId, error.code, error.message) };
    }
    if (error instanceof NotFoundError) {
      return { status: 404, envelope: fail(traceId, error.code, error.message) };
    }
    const message = String((error as Error)?.message ?? error);
    const aiNotConfigured = message.startsWith('AI_NOT_CONFIGURED');
    return {
      status: aiNotConfigured ? 409 : 500,
      envelope: fail(traceId, aiNotConfigured ? 'ai-not-configured' : 'internal-error',
        aiNotConfigured ? message.replace(/^AI_NOT_CONFIGURED:\s*/, '') : message),
    };
  }
}
