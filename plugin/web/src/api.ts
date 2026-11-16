/** SPA ↔ Host RPC 客户端（同源 POST /plug-funds/api/rpc）。 */

export interface RpcError extends Error {
  code?: string;
  status?: number;
}

export async function rpc<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/plug-funds/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
    credentials: 'same-origin',
  });
  const payload = (await response.json().catch(() => null)) as {
    success: boolean; data?: T; error?: { code: string; message: string }; traceId?: string;
  } | null;
  if (!payload) {
    throw wrapError(`HTTP ${response.status}`, String(response.status));
  }
  if (!payload.success) {
    throw wrapError(payload.error?.message ?? '请求失败', payload.error?.code ?? 'error', response.status);
  }
  return payload.data as T;
}

function wrapError(message: string, code?: string, status?: number): RpcError {
  const error = new Error(message) as RpcError;
  error.code = code;
  error.status = status;
  return error;
}

/* ---------------- 领域类型（与服务端输出对齐的展示形态） ---------------- */

export interface AppInfo {
  name: string; version: string; schemaVersion: number; engine: string; dataDir: string; isNew: boolean; hideAmount: boolean;
}

export interface Account {
  id: string; name: string; platform: string; currency: string; status: string; note: string; createdAt: string; updatedAt: string;
}

export interface HoldingRow {
  positionId: string; accountId: string; accountName: string; instrumentId: string;
  code: string; name: string; type: string; tag: string;
  qty: string; unitCost: string; price: string | null; priceType: string | null; quality: string | null;
  priceDate: string | null; observedAt: string | null; marketValue: string | null; costTotal: string;
  pnl: string | null; pnlRate: string | null; realized: string; dividends: string;
  weight: number | null;
  categories: { names: string[]; colors: string[]; more: number };
  pinned: boolean; firstHeldDate: string | null;
}

export interface HoldingsResult {
  rows: HoldingRow[]; totalMarketValue: string; totalCost: string; totalPnl: string | null; incomplete: string[];
}

export interface DashboardSummary {
  totalMarketValue: string;
  /** 现金 / 流动性资产合计（schema v3）。 */
  cashTotal: string;
  /** 持仓市值 + 现金。 */
  totalAssets: string;
  /** 现金占总资产比例；总资产为 0 时为 null。 */
  cashWeight: number | null;
  byCategory: { key: string; label: string; value: string; weight: number }[];
  dayPnl: string | null; dayPnlNote: string | null;
  unrealized: string; realized: string; dividends: string; cumulative: string;
  incomplete: string[]; updatedAt: string | null; dataDate: string | null;
}

export interface Segment { key: string; label: string; value: string; fraction: number; denominator: string; gray?: boolean; color?: string }
export interface AllocationResult {
  mode: string; totalMarketValue: string; effectiveGoalAmount: string | null;
  segments: Segment[]; progressRatio: number | null; remainingAmount: string | null;
  overAmount: string | null; note: string | null; incomplete: string[];
}

export interface Goal { id: string; name: string; targetAmount: string; currency: string; enabled: boolean; createdAt: string; updatedAt: string }
export interface CashFlow { id: string; flowType: string; flowDate: string; amount: string; note: string }

export interface ChartPoint { date: string; value: string }
export interface ChartMarker { date: string; type: 'buy' | 'sell'; label: string }
export interface ChartSeriesResult {
  tab: string; period: string; span: { begin: string; end: string };
  instrument: { id: string; code: string; name: string; type: string };
  unitCost: string | null; series: ChartPoint[]; costLine: string | null; markers: ChartMarker[];
  compare: { name: string; series: ChartPoint[] } | null;
  list: { date: string; value: string; change: string | null; extra?: string | null }[];
  note: string | null;
}

export interface ScoredMetric { key: string; label: string; value: number | null; weight: number; score: number | null; status: string }
export interface StrategyScore {
  templateId: string; templateName: string; total: number | null;
  level: string; coverage: number; metrics: ScoredMetric[]; reason: string | null;
}
export interface ValuationRow {
  instrumentId: string; code: string; name: string; type: string;
  /** 是否在当前持仓中（估值页用它排序并打「持仓」标记，不作为筛选开关）。 */
  held: boolean;
  pe: string | null; pePercentile: number | null; pb: string | null; pbPercentile: number | null;
  dividendYield: string | null; roe: string | null;
  sharpe: number | null; volatilityPct: number | null; maxDrawdownPct: number | null;
  caliber: string; strategies: StrategyScore[];
}

export interface Txn {
  id: string; accountId: string; instrumentId: string; type: string; status: string;
  tradeDate: string; seq: number; quantity: string | null; price: string | null;
  amount: string | null; fee: string | null; tax: string | null; note: string; requestId: string | null; createdAt: string;
}

export interface Instrument {
  id: string; code: string; name: string; type: string; market: string; currency: string;
  benchmarkIndex: string | null; secid: string | null; fundCode: string | null; tag: string;
  foundedDate: string | null; scaleInfo: string | null; active: boolean; createdAt: string; updatedAt: string;
}

export interface CategoryRow { id: string; name: string; color: string; sortOrder: number; createdAt: string; count: number }
export interface CategoryLink { instrumentId: string; categoryId: string }

export interface AiStatus {
  configured: boolean;
  masked: { baseUrl: string; apiKey: string; model: string; enabled: boolean };
  secretBackend: 'keychain' | 'sqlite';
  scope: string;
}
export interface AiAnalysis {
  instrumentId: string; code: string; name: string; model: string; source: string; content: string; recordId: string;
}

export interface PositionDetail {
  holding: HoldingRow;
  instrument: Instrument;
  basics: {
    marketValue: string | null; qty: string; weight: number | null; pnl: string | null; pnlRate: string | null;
    costTotal: string; unitCost: string; dayPnl: string | null; ydayPnl: string | null;
    heldDays: number | null; firstHeldDate: string | null; dayPnlNote: string | null;
  };
  transactions: Txn[];
  transactionsNote: string;
}

export interface CompareResult {
  period: string;
  a: CompareRow; b: CompareRow; note: string;
}
export interface CompareRow {
  name: string; code: string; periodReturn: number | null; foundedDate: string | null;
  scaleInfo: string | null; pe: string | null; pb: string | null; dividendYield: string | null;
  roe: string | null; series: ChartPoint[]; seriesPoints: number;
}

export interface RefreshResult {
  results: { instrumentId: string; code: string; name: string; ok: boolean; provider: string | null; quotes: number; history: number; metrics: number; error: string | null }[];
  startedAt: string;
}

export const INDEX_OPTIONS = ['仅看本标的', '沪深300', '创业板指', '上证指数', '中证500'];

/* ---------------- 表现指标 / 策略 / 导入恢复（v0.2） ---------------- */

export interface PerformanceMetrics {
  range: { begin: string; end: string };
  xirr: number | null; xirrNote: string | null;
  maxDrawdown: number | null; sharpe: number | null;
  seriesPoints: number; coverage: number; note: string | null;
  series: { date: string; value: string; nav: string | null }[];
  portfolioPe: number | null; portfolioPb: number | null;
  valuationCoverage: number | null; valuationNote: string | null;
}

export interface StrategyRule {
  key: string; label: string; weight: number;
  direction: 'lower-better' | 'higher-better';
  favorableAt: number; adverseAt: number; required: boolean;
}
export interface StrategyTemplateRow {
  id: string; name: string; scope: string;
  metrics: StrategyRule[];
  origin: 'builtin' | 'custom'; version: number; updatedAt: string | null; editable: boolean;
}
export interface TemplateVersionRow {
  templateId: string; version: number; rules: StrategyRule[];
  note: string; createdAt: string; current: boolean;
}
export interface ImportRowPreview {
  line: number; accountName: string; instrumentCode: string; instrumentName: string;
  instrumentType: string; txnType: string; tradeDate: string;
  quantity: string | null; price: string | null; amount: string | null; note: string;
}
export interface ImportPreview {
  header: string[]; rows: ImportRowPreview[];
  errors: { line: number; message: string }[];
  summary: { total: number; valid: number; invalid: number; newAccounts: string[]; newInstruments: string[] };
}
export interface ImportCommitResult {
  imported: number; skipped: number; newAccounts: string[]; newInstruments: string[];
  errors: { line: number; message: string }[]; note: string;
}
export interface RestorePreview {
  ok: boolean; kind: string | null; schemaVersion: number | null; exportedAt: string | null;
  counts: Record<string, number>; warnings: string[]; errors: string[];
}
export interface RestoreResult { restored: Record<string, number>; backupPath: string | null; note: string }

/* ---------------- 行情自动刷新配置（PRD §4.5.2） ---------------- */

export interface RefreshSettings {
  enabled: boolean;
  intervalSec: number;
  tradingHoursOnly: boolean;
}
export interface RefreshSettingsState {
  settings: RefreshSettings;
  inTradingHours: boolean;
  session?: {
    phase: 'closed-day' | 'before' | 'morning' | 'lunch' | 'afternoon' | 'after';
    open: boolean;
    date: string;
    time: string;
    assumed: boolean;
    label: string;
  };
  calendar?: {
    source: 'market' | 'weekday';
    dayCount: number;
    from: string | null;
    to: string | null;
    holidays: number;
    recentHolidays: string[];
  };
  limits: { minSec: number; maxSec: number };
  note: string;
}

/* ---------------- 决策就绪度（数据是否足以支撑资产决策） ---------------- */

export type ReadinessStatus = 'OK' | 'PARTIAL' | 'MISSING';
export type ReadinessVerdict = 'READY' | 'PARTIAL' | 'INSUFFICIENT';

export interface ReadinessItem {
  key: string;
  question: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
  action: string;
  weight: number;
}

export interface ConcentrationResult {
  coveredValue: string;
  missingCount: number;
  countedCount: number;
  top1: { id: string; name: string; weight: number } | null;
  top3Weight: number | null;
  hhi: number | null;
  effectiveHoldings: number | null;
  byCategory: { category: string; weight: number }[];
  flags: { code: string; level: 'OK' | 'WATCH' | 'HIGH'; message: string }[];
}

export interface DecisionReadiness {
  score: number;
  verdict: ReadinessVerdict;
  verdictText: string;
  items: ReadinessItem[];
  blockers: string[];
  concentration: ConcentrationResult;
  metrics: {
    holdingCount: number;
    pricedCount: number;
    priceCoverage: number;
    totalMarketValue: string;
    valuationCoverage: number;
    cashFlowCount: number;
    goalEnabled: boolean;
    xirr: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
    portfolioPe: number | null;
    indexCount: number;
    indexWithMetrics: number;
    dataDate: string | null;
  };
  note: string;
}

/* ---------------- 风险画像（波动率 / Beta / 相关性 / ERP） ---------------- */

export interface RiskProfile {
  range: { begin: string; end: string };
  samples: number;
  volatility: number | null;
  beta: number | null;
  correlation: number | null;
  trackingError: number | null;
  benchmark: { instrumentId: string | null; code: string | null; name: string | null; samples: number };
  riskFreeRate: number;
  portfolioPe: number | null;
  erp: number | null;
  note: string;
}

export interface CorrelationMatrix {
  codes: string[];
  names: string[];
  matrix: (number | null)[][];
  samples: number;
  note: string;
}

/* ---------------- 现金账户与再平衡（schema v3） ---------------- */

export interface CashAccount {
  id: string;
  name: string;
  currency: string;
  balance: string;
  note: string;
  active: boolean;
  updatedAt: string;
}

export interface RebalanceTarget { category: string; targetWeight: number }

export interface RebalanceRow {
  category: string;
  label: string;
  currentValue: string;
  currentWeight: number;
  targetWeight: number;
  drift: number;
  action: 'BUY' | 'SELL' | 'HOLD';
  amount: string;
}

export interface RebalancePlan {
  totalAssets: string;
  investableAssets: string;
  cashTotal: string;
  rows: RebalanceRow[];
  targetsSum: number;
  threshold: number;
  missingValueCount: number;
  note: string;
}

/* ---------------- 指数分析（二级视图数据源） ---------------- */

export interface IndexReturnSet {
  w1: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  y3: number | null;
  y5: number | null;
  ytd: number | null;
}

export interface IndexAnalyticsRow {
  id: string;
  code: string;
  name: string;
  tag: string;
  close: number | null;
  lastDate: string | null;
  samples: number;
  returns: IndexReturnSet;
  volatility: number | null;
  maxDrawdown: number | null;
  high: { window: number; isNewHigh: boolean; distance: number | null };
  low: { window: number; isNewLow: boolean; distance: number | null };
  rps: number | null;
  turnover: number | null;
  pe: number | null;
  pb: number | null;
  dividendYield: number | null;
}

export interface IndexEtfRow {
  id: string;
  code: string;
  name: string;
  close: number | null;
  lastDate: string | null;
  samples: number;
  y1: number | null;
  ytd: number | null;
  pe: number | null;
}

export interface IndexDcaRow {
  code: string;
  name: string;
  months: number;
  invested: number;
  value: number;
  profit: number;
  profitRate: number | null;
  xirr: number | null;
}

export interface IndexGrahamRow {
  code: string;
  name: string;
  pe: number | null;
  earningsYield: number | null;
  riskFreeRate: number;
  grahamIndex: number | null;
  erp: number | null;
}

export interface IndexAnalytics {
  window: { begin: string | null; end: string | null; tradingDays: number };
  rows: IndexAnalyticsRow[];
  etf: IndexEtfRow[];
  correlation: { codes: string[]; names: string[]; matrix: (number | null)[][]; samples: number };
  dca: IndexDcaRow[];
  graham: IndexGrahamRow[];
  coverage: { indices: number; withHistory: number; withValuation: number; etf: number };
  note: string;
}
