/**
 * 领域类型（宿主无关）。
 *
 * 数据权威与口径依据 plug-funds PRD v1.4 与旧项目 Natives-App-Fund 的
 * 领域硬规则：i64 定点（金额 scale=2、份额/净值/价格 scale=4）、
 * 交易流水是唯一事实源、positions 是回放投影。
 */

/** 当前数据 schema 版本；高于本版本的库拒绝打开（先升插件，再写数据）。 */
export const SCHEMA_VERSION = 4;

/* ---------------- 账户 ---------------- */

export type AccountStatus = 'ACTIVE' | 'ARCHIVED';

export interface Account {
  id: string;
  name: string;
  platform: string;
  currency: 'CNY';
  status: AccountStatus;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 标的 ---------------- */

export type InstrumentType = 'STOCK' | 'ETF' | 'OPEN_END_FUND' | 'INDEX';
export type Market = 'SH' | 'SZ' | 'OTC';

export interface Instrument {
  id: string;
  /** 6 位代码；唯一性 = code + type + market。 */
  code: string;
  name: string;
  type: InstrumentType;
  market: Market;
  currency: 'CNY';
  /** 关联指数 / 业绩基准（仅对照与穿透，不作为持仓）。 */
  benchmarkIndex: string | null;
  /** Eastmoney secid（如 `1.600036` / `0.000961` 的场内形式；场外基金为空）。 */
  secid: string | null;
  /** 场外基金代码（如 `007466`）。 */
  fundCode: string | null;
  /** 行业 / 主题 / 自定义标签的二级口径来源之一（展示用）。 */
  tag: string;
  /** 成立日期（基金）/ 上市日期（股票）；PK 与详情用。 */
  foundedDate: string | null;
  /** 规模描述（基金份额规模 / 股票总市值文本）。 */
  scaleInfo: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ---------------- 行情 ---------------- */

export type PriceType =
  | 'REALTIME_PRICE'
  | 'CLOSE_PRICE'
  | 'OFFICIAL_NAV'
  | 'ESTIMATED_NAV'
  | 'IOPV'
  | 'MANUAL_PRICE';

export type DataQuality =
  | 'FRESH'
  | 'DELAYED'
  | 'STALE'
  | 'MISSING'
  | 'ESTIMATED'
  | 'MANUAL'
  | 'CONFLICT';

export interface MarketPoint {
  instrumentId: string;
  priceType: PriceType;
  /** 定点字符串，scale=4。 */
  value: string;
  currency: 'CNY';
  tradingDate: string;
  observedAt: string;
  provider: string;
  quality: DataQuality;
}

/** 按标的取「计价用的有效价格 / 净值」的口径：PRD §6.1。 */
export interface EffectivePrice {
  value: string;
  priceType: PriceType;
  quality: DataQuality;
  tradingDate: string;
  observedAt: string;
}

/* ---------------- 交易 ---------------- */

export type TxnType =
  | 'OPENING'
  | 'BUY'
  | 'SELL'
  | 'DIVIDEND_CASH'
  | 'DIVIDEND_REINVEST'
  | 'FEE'
  | 'SPLIT'
  | 'CORRECTION';

export type TxnStatus = 'CONFIRMED' | 'PENDING_CONFIRMATION';

export interface Txn {
  id: string;
  accountId: string;
  instrumentId: string;
  type: TxnType;
  status: TxnStatus;
  /** YYYY-MM-DD */
  tradeDate: string;
  /** 同日多笔的稳定排序键（写入顺序）。 */
  seq: number;
  /** 定点字符串，scale=4；SPLIT 时为折算系数。 */
  quantity: string | null;
  /** 定点字符串，scale=4。 */
  price: string | null;
  /** 金额语义随类型：OPENING=期初总成本、DIVIDEND=金额、CORRECTION=成本增量；scale=2。 */
  amount: string | null;
  /** 定点字符串，scale=2。 */
  fee: string | null;
  /** 定点字符串，scale=2。 */
  tax: string | null;
  note: string;
  /** 手工录入幂等键（PRD §4.4.2 / 旧 fund 纪律）。 */
  requestId: string | null;
  createdAt: string;
}

/* ---------------- 自定义分类（PRD §4.10） ---------------- */

export interface Category {
  id: string;
  name: string;
  /** #RRGGBB */
  color: string;
  sortOrder: number;
  createdAt: string;
}

export interface CategoryLink {
  instrumentId: string;
  categoryId: string;
}

/* ---------------- 投资目标（PRD §4.1.4 / §6.1.1） ---------------- */

export interface PortfolioGoal {
  id: string;
  name: string;
  /** 定点字符串，scale=2，必须 > 0。 */
  targetAmount: string;
  currency: 'CNY';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEvent {
  id: string;
  goalId: string;
  oldAmount: string | null;
  newAmount: string;
  changedAt: string;
  note: string;
}

/* ---------------- 组合外部现金流（PRD §4.4.5，XIRR 依据） ---------------- */

export type CashFlowType = 'CONTRIBUTION' | 'WITHDRAWAL';

export interface CashFlow {
  id: string;
  flowType: CashFlowType;
  flowDate: string;
  /** 定点字符串，scale=2，恒为正数；方向由 flowType 表达。 */
  amount: string;
  note: string;
}

/* ---------------- AI 分析（PRD §4.11） ---------------- */

export interface AiSettings {
  baseUrl: string;
  /** 仅落盘（0600）与内存使用；任何 API 返回 / 日志中脱敏。 */
  apiKey: string;
  model: string;
  enabled: boolean;
}

export interface AiAnalysisRecord {
  id: string;
  instrumentId: string;
  model: string;
  source: 'MOCK' | 'REAL';
  promptScope: string;
  result: string;
  createdAt: string;
}

/* ---------------- 持仓投影 ---------------- */

export interface Position {
  accountId: string;
  instrumentId: string;
  /** raw ×10^4。 */
  qtyRaw: number;
  /** 持仓总成本 raw ×10^2。 */
  costTotalRaw: number;
  /** 单位成本 raw ×10^4。 */
  unitCostRaw: number;
  /** 已实现盈亏 raw ×10^2。 */
  realizedRaw: number;
  /** 累计现金分红 raw ×10^2。 */
  dividendsRaw: number;
  /** 已实现盈亏之外的调整累计（FEE / CORRECTION），raw ×10^2。 */
  adjustmentRaw: number;
  lastEventDate: string | null;
}

/** 现金 / 货币基金等流动性资产（余额由用户维护，不参与行情刷新）。 */
export interface CashAccount {
  id: string;
  name: string;
  currency: string;
  /** 定点字符串 scale=2。 */
  balance: string;
  note: string;
  active: boolean;
  updatedAt: string;
}
