/**
 * 行情 Provider Adapter 接口（PRD §5.1）。
 *
 * 业务层只依赖本接口；东财 / 手工等具体实现可替换。
 * 所有实现必须：有界超时、低频、缓存、失败显式（不冒充实时）。
 */
import type { Instrument, MarketPoint } from '../../../core/src/types.ts';
import { createEastmoneyProvider } from './eastmoney.ts';
import { createTencentProvider } from './tencent.ts';

export interface HistoryRequest {
  begin: string;
  end: string;
}

export interface MarketProvider {
  readonly id: string;
  /** 是否能覆盖该标的。 */
  supports(instrument: Instrument): boolean;
  /** 最新报价（实时 / 收盘 / 正式净值 / 估算净值，按标的类型决定）。 */
  fetchQuote(instrument: Instrument): Promise<MarketPoint | null>;
  /** 日频历史（K 线或净值序列）。 */
  fetchHistory(instrument: Instrument, range: HistoryRequest): Promise<MarketPoint[]>;
  /** 估值指标（PE / PB / 股息率 / ROE 等；不支持返回空）。 */
  fetchMetrics?(instrument: Instrument): Promise<{ metricKey: string; value: string | null; asOfDate: string; quality: MarketPoint['quality'] }[]>;
  /** 盘中估算净值（仅展示；绝不参与正式计价，PRD §4.5.1）。 */
  fetchEstimate?(instrument: Instrument): Promise<MarketPoint | null>;
}

export interface ProviderRegistry {
  /** 按标的挑出第一个支持的 Provider（主源）。 */
  resolve(instrument: Instrument): MarketProvider | null;
  /** 所有支持该标的的 Provider，按注册顺序（用于多源兜底与交叉校验）。 */
  resolveAll(instrument: Instrument): MarketProvider[];
  all(): MarketProvider[];
}

export function createRegistry(providers: MarketProvider[]): ProviderRegistry {
  return {
    resolve(instrument) {
      return providers.find((p) => p.supports(instrument)) ?? null;
    },
    resolveAll(instrument) {
      return providers.filter((p) => p.supports(instrument));
    },
    all: () => [...providers],
  };
}

/**
 * 默认多源注册：腾讯优先（覆盖 A 股 / ETF / 指数 / 港股 / 美股 / 场外基金最新净值），
 * 东财补历史净值与估值明细。任一源不可达时由另一源兜底，不产生伪造数据。
 */
export function createDefaultRegistry(): ProviderRegistry {
  return createRegistry([createTencentProvider(), createEastmoneyProvider()]);
}
