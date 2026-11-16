/**
 * 内置策略模板与规则评分（PRD §4.6.3 / §4.6.5 的轻量首版）。
 *
 * - 0–100 规则匹配分：表达「当前指标与模板规则的匹配程度」，不是涨跌概率。
 * - 必需指标缺失 → 数据不足（不按 0 分或 100 分处理）。
 * - 结论分档：80–100 优先研究 / 65–79 持续观察 / 45–64 中性观察 / 0–44 暂缓新增关注。
 * - 模板为只读初始框架；用户自定义阈值与版本化属于后续检查点。
 */

export type MetricDirection = 'lower-better' | 'higher-better';

export interface StrategyMetricRule {
  /** 估值指标键（valuation_metrics.metric_key / 视图字段名）。 */
  key: string;
  label: string;
  weight: number;
  direction: MetricDirection;
  /** 相对有利阈值（低值更优 ≤ 优先线；高值更优 ≥ 优先线）。 */
  favorableAt: number;
  /** 相对不利阈值（低于/高于该值判不利）。 */
  adverseAt: number;
  required: boolean;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  scope: string;
  metrics: StrategyMetricRule[];
}

const m = (
  key: string, label: string, weight: number, direction: MetricDirection,
  favorableAt: number, adverseAt: number, required = false,
): StrategyMetricRule => ({ key, label, weight, direction, favorableAt, adverseAt, required });

export const BUILTIN_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'dividend-lowvol',
    name: '红利低波',
    scope: '红利 / 低波指数及相关 ETF、基金',
    metrics: [
      m('pe_percentile', 'PE 历史分位', 25, 'lower-better', 20, 60, true),
      m('pb_percentile', 'PB 历史分位', 20, 'lower-better', 20, 60),
      m('dividend_yield', '股息率（%）', 25, 'higher-better', 4, 2),
      m('sharpe', '夏普比率', 15, 'higher-better', 0.8, 0.2),
      m('max_drawdown_pct', '最大回撤（%，正值）', 15, 'lower-better', 15, 30),
    ],
  },
  {
    id: 'broad-index',
    name: '宽基指数',
    scope: '沪深 300 / 中证 500 / A500 及相关 ETF、基金',
    metrics: [
      m('pe_percentile', 'PE 历史分位', 35, 'lower-better', 20, 60, true),
      m('pb_percentile', 'PB 历史分位', 25, 'lower-better', 20, 60),
      m('dividend_yield', '股息率（%）', 20, 'higher-better', 2.5, 1.5),
      m('sharpe', '夏普比率', 10, 'higher-better', 0.8, 0.2),
      m('max_drawdown_pct', '最大回撤（%，正值）', 10, 'lower-better', 20, 35),
    ],
  },
  {
    id: 'growth-tech',
    name: '成长 / 科技',
    scope: '科创、创业板、半导体及相关产品',
    metrics: [
      m('pe_percentile', 'PE 历史分位', 25, 'lower-better', 30, 70, true),
      m('pb_percentile', 'PB 历史分位', 15, 'lower-better', 30, 70),
      m('sharpe', '夏普比率', 20, 'higher-better', 0.9, 0.2),
      m('max_drawdown_pct', '最大回撤（%，正值）', 20, 'lower-better', 25, 40),
      m('annual_volatility_pct', '年化波动率（%）', 20, 'lower-better', 22, 35),
    ],
  },
  {
    id: 'stock-value',
    name: '个股价值 / 质量',
    scope: 'A 股个股',
    metrics: [
      m('pe', 'PE-TTM', 20, 'lower-better', 12, 30, true),
      m('pb', 'PB', 15, 'lower-better', 1.5, 3),
      m('roe', 'ROE（%）', 20, 'higher-better', 14, 8),
      m('dividend_yield', '股息率（%）', 15, 'higher-better', 3, 1.5),
      m('max_drawdown_pct', '最大回撤（%，正值）', 10, 'lower-better', 25, 40),
      m('annual_volatility_pct', '年化波动率（%）', 20, 'lower-better', 30, 45),
    ],
  },
];

export interface MetricValue {
  key: string;
  value: number | null;
}

export interface ScoredMetric {
  key: string;
  label: string;
  value: number | null;
  weight: number;
  score: number | null;
  status: 'favorable' | 'neutral' | 'adverse' | 'missing';
}

export interface StrategyScore {
  templateId: string;
  templateName: string;
  total: number | null;
  level: '优先研究' | '持续观察' | '中性观察' | '暂缓新增关注' | '数据不足';
  coverage: number;
  metrics: ScoredMetric[];
  reason: string | null;
}

function scoreMetric(rule: StrategyMetricRule, value: number | null): { score: number | null; status: ScoredMetric['status'] } {
  if (value === null || !Number.isFinite(value)) {
    return { score: null, status: 'missing' };
  }
  if (rule.direction === 'lower-better') {
    if (value <= rule.favorableAt) return { score: rule.weight, status: 'favorable' };
    if (value >= rule.adverseAt) return { score: rule.weight * 0.1, status: 'adverse' };
    // 优先线与不利线之间线性衰减
    const span = rule.adverseAt - rule.favorableAt;
    const ratio = span > 0 ? (value - rule.favorableAt) / span : 1;
    return { score: rule.weight * (0.9 - 0.8 * Math.min(Math.max(ratio, 0), 1)), status: 'neutral' };
  }
  if (value >= rule.favorableAt) return { score: rule.weight, status: 'favorable' };
  if (value <= rule.adverseAt) return { score: rule.weight * 0.1, status: 'adverse' };
  const span = rule.favorableAt - rule.adverseAt;
  const ratio = span > 0 ? (rule.favorableAt - value) / span : 1;
  return { score: rule.weight * (0.9 - 0.8 * Math.min(Math.max(ratio, 0), 1)), status: 'neutral' };
}

export function levelOf(total: number | null): StrategyScore['level'] {
  if (total === null) return '数据不足';
  if (total >= 80) return '优先研究';
  if (total >= 65) return '持续观察';
  if (total >= 45) return '中性观察';
  return '暂缓新增关注';
}

/** 对单标的按模板评分；必需指标缺失 → 数据不足（total=null）。 */
export function scoreWithTemplate(template: StrategyTemplate, values: MetricValue[]): StrategyScore {
  const valueMap = new Map(values.map((v) => [v.key, v.value]));
  const scored: ScoredMetric[] = [];
  let total = 0;
  let weightCovered = 0;
  let missingRequired = false;
  for (const rule of template.metrics) {
    const { score, status } = scoreMetric(rule, valueMap.get(rule.key) ?? null);
    if (status === 'missing' && rule.required) missingRequired = true;
    if (score !== null) {
      total += score;
      weightCovered += rule.weight;
    }
    scored.push({ key: rule.key, label: rule.label, value: valueMap.get(rule.key) ?? null, weight: rule.weight, score, status });
  }
  if (missingRequired) {
    return {
      templateId: template.id,
      templateName: template.name,
      total: null,
      level: '数据不足',
      coverage: weightCovered / 100,
      metrics: scored,
      reason: '必需指标缺失，不产生评分',
    };
  }
  const coverage = weightCovered / 100;
  if (coverage < 0.8) {
    return {
      templateId: template.id,
      templateName: template.name,
      total: null,
      level: '数据不足',
      coverage,
      metrics: scored,
      reason: `数据覆盖率 ${(coverage * 100).toFixed(0)}% 低于 80%`,
    };
  }
  return {
    templateId: template.id,
    templateName: template.name,
    total: Math.round(total * 10) / 10,
    level: levelOf(total),
    coverage,
    metrics: scored,
    reason: null,
  };
}

/** 按标的类型挑模板：个股 → 个股价值；其余按 tag/名称启发 + 全部模板可展示。 */
export function pickTemplates(instrument: { type: string; name: string; tag: string }): StrategyTemplate[] {
  if (instrument.type === 'STOCK') {
    return BUILTIN_TEMPLATES.filter((t) => t.id === 'stock-value');
  }
  return BUILTIN_TEMPLATES.filter((t) => t.id !== 'stock-value');
}
