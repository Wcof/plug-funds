/** SPA 页面：总览 / 持仓 / 估值 / 设置 / 持仓详情 / 标的详情。 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  rpc, type AllocationResult, type AppInfo, type CashFlow, type ChartSeriesResult, type DashboardSummary,
  type Goal, type HoldingRow, type HoldingsResult, type Instrument, type PerformanceMetrics,
  type PositionDetail, type Segment, type Txn, type ValuationRow, type StrategyScore, type AiStatus,
  type RefreshSettingsState, type DecisionReadiness, type ReadinessItem, type RiskProfile,
  type CashAccount, type CorrelationMatrix, type RebalancePlan,
} from './api.ts';
import {
  Donut, Field, LevelBadge, LineChart, Modal, PriceBadge, Seg, fmt, moneyText, pctText,
  signCls, signMoneyText, signedPctText, signedNumText, shortDate,
} from './ui.tsx';
import {
  CashFlowCard, EditPosModal, ImportModal, RefreshButton, RestoreModal, StrategyTemplatePanel,
} from './features.tsx';
import { CashCard, CorrelationCard, RebalanceCard } from './portfolio.tsx';

export const CAT_META: Record<string, { label: string; color: string }> = {
  stock: { label: '股票', color: '#4c6ef5' },
  fund: { label: '场外基金', color: '#9a6bf2' },
  etf: { label: 'ETF', color: '#ee9d3f' },
};

const RANGES = [
  { key: '1m', label: '近 1 月' }, { key: '3m', label: '近 3 月' },
  { key: '1y', label: '近 1 年' }, { key: 'all', label: '全部' }, { key: 'custom', label: '自定义' },
];

/* ================= 总览 ================= */

const READINESS_STATUS: Record<ReadinessItem['status'], { text: string; tone: 'ok' | 'mid' | 'low' }> = {
  OK: { text: '就绪', tone: 'ok' },
  PARTIAL: { text: '部分', tone: 'mid' },
  MISSING: { text: '缺失', tone: 'low' },
};

const READINESS_ORDER: Record<ReadinessItem['status'], number> = { MISSING: 0, PARTIAL: 1, OK: 2 };

/** 决策就绪度：把「数据够不够做决策」摊平成可执行清单，而不是给一个笼统结论。 */
function ReadinessCard(props: { data: DecisionReadiness | null }) {
  if (!props.data) return null;
  const data = props.data;
  const tone = data.verdict === 'READY' ? 'ok' : data.verdict === 'PARTIAL' ? 'mid' : 'low';
  const items = [...data.items].sort((a, b) => READINESS_ORDER[a.status] - READINESS_ORDER[b.status]);
  return (
    <div className={`card readiness tone-${tone}`}>
      <div className="readiness-head">
        <h2>决策就绪度</h2>
        <span className="readiness-verdict">{data.verdictText}</span>
        <div className="spacer" />
        <span className="readiness-score num">{data.score}<small>/100</small></span>
      </div>
      <div className="readiness-bar"><i style={{ width: `${Math.max(2, data.score)}%` }} /></div>
      <div className="readiness-grid">
        {items.map((item) => {
          const meta = READINESS_STATUS[item.status];
          return (
            <div key={item.key} className={`readiness-item st-${meta.tone}`}>
              <div className="ri-top">
                <span className="ri-label">{item.label}</span>
                <span className={`ri-badge ${meta.tone}`}>{meta.text}</span>
              </div>
              <div className="ri-q">{item.question}</div>
              <div className="ri-detail">{item.detail}</div>
              {item.status !== 'OK' ? <div className="ri-action">补齐：{item.action}</div> : null}
            </div>
          );
        })}
      </div>
      {data.concentration.top1 ? (
        <div className="readiness-conc">
          集中度 · 单一持仓 <b className="num">{pctText(data.concentration.top1.weight)}</b>
          <span className="sep">·</span>前三大 <b className="num">{pctText(data.concentration.top3Weight ?? 0)}</b>
          <span className="sep">·</span>有效持仓数 <b className="num">{fmt(data.concentration.effectiveHoldings ?? 0)}</b>
          {data.concentration.flags.filter((f) => f.level === 'HIGH').map((f) => (
            <span key={f.code} className="ri-flag">{f.message}</span>
          ))}
        </div>
      ) : null}
      <div className="readiness-foot">{data.note}</div>
    </div>
  );
}

export function DashboardPage(props: {
  onOpenPosDetail: (positionId: string) => void;
  onOpenInstDetail: (instrumentId: string) => void;
  onOpenGoalModal: (goal: Goal | null) => void;
  onOpenAi: (positionId: string) => void;
  onOpenPk: (instrumentId: string) => void;
  onToast: (message: string) => void;
  reloadKey: number;
}) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [allocationFull, setAllocationFull] = useState<AllocationResult | null>(null);
  const [mode, setMode] = useState<'full' | 'goal'>('full');
  const [positions, setPositions] = useState<HoldingsResult | null>(null);
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null);
  const [range, setRange] = useState('1y');
  const [goal, setGoal] = useState<Goal | null>(null);
  const [selCat, setSelCat] = useState<string | null>(null);
  const [selSub, setSelSub] = useState<string | null>(null);
  const [valuation, setValuation] = useState<ValuationRow[] | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [readiness, setReadiness] = useState<DecisionReadiness | null>(null);
  const [risk, setRisk] = useState<RiskProfile | null>(null);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [rebalance, setRebalance] = useState<RebalancePlan | null>(null);
  const [correlation, setCorrelation] = useState<CorrelationMatrix | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [
        summaryResult, positionsResult, valuationResult, appInfo, goalResult,
        readinessResult, riskResult, cashResult, rebalanceResult, correlationResult,
      ] = await Promise.all([
        rpc<DashboardSummary>('get_dashboard_summary'),
        rpc<HoldingsResult>('list_positions'),
        rpc<{ rows: ValuationRow[] }>('get_holdings_valuation'),
        rpc<AppInfo>('get_app_info'),
        rpc<{ enabled: Goal | null }>('get_portfolio_goal'),
        rpc<DecisionReadiness>('get_decision_readiness'),
        rpc<RiskProfile>('get_portfolio_risk', { range }),
        rpc<{ accounts: CashAccount[] }>('list_cash_accounts'),
        rpc<RebalancePlan>('get_rebalance_plan'),
        rpc<CorrelationMatrix>('get_correlation_matrix', { limit: 12 }),
      ]);
      setSummary(summaryResult);
      setPositions(positionsResult);
      setValuation(valuationResult.rows);
      setInfo(appInfo);
      setGoal(goalResult.enabled);
      setReadiness(readinessResult);
      setRisk(riskResult);
      setCashAccounts(cashResult.accounts);
      setRebalance(rebalanceResult);
      setCorrelation(correlationResult);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [range]);

  useEffect(() => { void load(); }, [load, props.reloadKey]);
  useEffect(() => {
    void rpc<{ mode: string; segments: Segment[]; progressRatio: number | null; totalMarketValue: string; effectiveGoalAmount: string | null; remainingAmount: string | null; overAmount: string | null; note: string | null }>(
      'get_dashboard_allocation', { mode },
    ).then((result) => setAllocationFull(result));
  }, [mode, props.reloadKey]);
  useEffect(() => {
    void rpc<PerformanceMetrics>('get_portfolio_performance_metrics', { range }).then(setMetrics);
  }, [range, props.reloadKey]);

  /* 二级构成：在选中类别内按 tag 分组（分母 = 类别市值，客户端聚合） */
  const secondary = useMemo(() => {
    if (!positions || !selCat) return null;
    const typeKey = selCat;
    const rows = positions.rows.filter((r) => CAT_META[r.type]?.key === undefined ? r.type.toLowerCase() === typeKey : ({ stock: 'stock', fund: 'fund', etf: 'etf' } as Record<string, string>)[r.type] === typeKey);
    const tagMap = new Map<string, number>();
    for (const row of rows) {
      const tag = row.tag && row.tag !== '' ? row.tag : '未分类';
      const value = row.marketValue ? Number(row.marketValue) : 0;
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + value);
    }
    const sum = [...tagMap.values()].reduce((a, b) => a + b, 0);
    const palette = ['#4c6ef5', '#6d8bfa', '#93a9fb', '#b8c8fd', '#9aa4b2'];
    const segments = [...tagMap.entries()].sort((a, b) => b[1] - a[1]).map(([tag, value], i) => ({
      key: tag, label: tag, value, fraction: sum > 0 ? value / sum : 0, color: tag === '未分类' ? '#9aa4b2' : palette[i % palette.length],
    }));
    return { sum, segments };
  }, [positions, selCat]);

  const filteredRows = useMemo(() => {
    if (!positions) return [];
    return positions.rows.filter((row) => {
      if (!selCat) return true;
      const key = ({ stock: 'stock', fund: 'fund', etf: 'etf' } as Record<string, string>)[row.type];
      if (key !== selCat) return false;
      if (selSub) {
        const tag = row.tag && row.tag !== '' ? row.tag : '未分类';
        if (tag !== selSub) return false;
      }
      return true;
    });
  }, [positions, selCat, selSub]);

  const opportunities = useMemo(() => {
    if (!valuation) return [];
    const items: { name: string; code: string; strategy: StrategyScore; instrumentId: string }[] = [];
    for (const row of valuation) {
      for (const strategy of row.strategies) {
        if (strategy.total !== null) items.push({ name: row.name, code: row.code, strategy, instrumentId: row.instrumentId });
      }
    }
    return items.sort((a, b) => (b.strategy.total ?? 0) - (a.strategy.total ?? 0)).slice(0, 3);
  }, [valuation]);

  if (error) return <div className="empty">{error}</div>;
  if (!summary || !positions) return <div className="empty">加载中…</div>;

  const goalEnabled = mode === 'goal' && allocationFull?.mode === 'goal';
  const inLegendMode = allocationFull?.mode === 'goal' ? '占目标' : '占持仓';
  const filteredMv = filteredRows.reduce((acc, r) => acc + (r.marketValue ? Number(r.marketValue) : 0), 0);
  const filteredCost = filteredRows.reduce((acc, r) => acc + Number(r.costTotal), 0);
  const filteredPnl = filteredRows.reduce((acc, r) => acc + (r.pnl ? Number(r.pnl) : 0), 0);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>总览</h1>
          <div className="update-line">
            行情更新 {summary.updatedAt ? summary.updatedAt.replace('T', ' ').slice(0, 19) : '—'}
            {summary.dataDate ? <span className="badge t-close">数据日 {summary.dataDate}</span> : null}
            {summary.incomplete.length > 0 ? <span className="badge t-wait">{summary.incomplete.length} 只标的等待价格</span> : null}
            {info ? <span className="badge t-manual">v{info.version} · schema {info.schemaVersion}</span> : null}
          </div>
        </div>
        <div className="head-actions">
          <div className="quick-row">
            <Seg options={RANGES} value={range} onChange={setRange} />
          </div>
        </div>
      </header>

      <div className="card hero">
        <div className="hero-total">
          <div className="label">持仓市值（股票 + ETF + 场外基金）</div>
          <div className="value num">{moneyText(summary.totalMarketValue)}<small>CNY</small></div>
          <div className="hero-total-sub">
            总资产（含现金）<b className="num">{moneyText(summary.totalAssets)}</b>
            <span className="sep">·</span>现金 <b className="num">{moneyText(summary.cashTotal)}</b>
            <span className="sep">·</span>占比 <b className="num">{pctText(summary.cashWeight, 1)}</b>
          </div>
          <div className="hero-chips">
            {summary.byCategory.map((c) => (
              <span key={c.key} className="chip">
                <i className="dot" style={{ background: CAT_META[c.key]?.color ?? '#9aa4b2' }} />
                {c.label} <b className="num">{moneyText(c.value)} · {pctText(c.weight)}</b>
              </span>
            ))}
          </div>
        </div>
        <div className="hero-stats">
          <Stat label="当日盈亏" value={summary.dayPnl === null ? '—' : signMoneyText(summary.dayPnl)} cls={signCls(summary.dayPnl)} sub={summary.dayPnlNote ?? '按上一交易日可比价'} />
          <Stat label="累计收益" value={signMoneyText(summary.cumulative)} cls={signCls(summary.cumulative)} sub="已实现 + 未实现 + 分红" />
          <Stat label="未实现盈亏" value={signMoneyText(summary.unrealized)} cls={signCls(summary.unrealized)} sub="按最近正式净值 / 收盘价" />
          <Stat label="已实现盈亏" value={signMoneyText(summary.realized)} cls={signCls(summary.realized)} sub="卖出结转" />
          <Stat label="现金分红" value={signMoneyText(summary.dividends)} cls={signCls(summary.dividends)} sub="不含红利再投" />
          <Stat label="市值不完整" value={summary.incomplete.length > 0 ? `${summary.incomplete.length} 只` : '无'} cls="flat" sub={summary.incomplete.length > 0 ? '缺价持仓未按 0 计入' : '全部持仓有有效价格'} />
        </div>
        <div className="hero-note">口径：累计收益 = 已实现盈亏 + 未实现盈亏 + 现金分红；成本采用加权平均成本法；基金按最近正式净值计价，估算净值不参与。</div>
      </div>

      <ReadinessCard data={readiness} />

      <div className="metric-title-row">
        <h2 style={{ fontSize: 14.5 }}>投资表现</h2>
        <span className="scope">本人实际持仓组合 · 非策略回测 · {RANGES.find((r) => r.key === range)?.label}</span>
      </div>
      <div className="metric-row">
        <MetricCard
          label="年化收益率（XIRR）" info="口径：组合 XIRR —— 按「外部投入 / 取出现金流 + 期末市值」计算。"
          value={metrics?.xirr !== null && metrics?.xirr !== undefined ? signedPctText(metrics.xirr) : null}
          na={metrics?.xirr === null ? (metrics.xirrNote ?? '样本不足') : null}
          foot={metrics ? `${metrics.range.begin} → ${metrics.range.end}` : ''}
        />
        <MetricCard
          label="最大回撤" info="口径：区间内组合单位净值从峰值到谷值的最大跌幅；已按资金投入归一，剔除追加资金影响。"
          value={metrics?.maxDrawdown !== null && metrics?.maxDrawdown !== undefined ? `-${(metrics.maxDrawdown * 100).toFixed(2)}%` : null}
          na={metrics?.maxDrawdown === null ? '样本不足' : null}
          foot={metrics ? `${metrics.seriesPoints} 个交易日 · 覆盖 ${(metrics.coverage * 100).toFixed(0)}%` : ''}
        />
        <MetricCard
          label="夏普比率" info="口径：年化平均超额收益 ÷ 年化收益标准差；无风险利率 1.5%，按 252 交易日年化。"
          value={metrics?.sharpe !== null && metrics?.sharpe !== undefined ? fmt(metrics.sharpe) : null}
          na={metrics?.sharpe === null ? '样本不足 / 不可计算' : null}
          foot={metrics ? `无风险利率 1.5% · ${metrics.seriesPoints} 日` : ''}
        />
        <MetricCard
          label="组合 PE" info="按持仓市值加权的穿透 PE；缺失成分不按 0 处理，覆盖率低于 80% 不产生数值。估值截面不随收益区间变化。"
          value={metrics?.portfolioPe !== null && metrics?.portfolioPe !== undefined ? fmt(metrics.portfolioPe) : null}
          na={metrics?.portfolioPe === null ? (metrics.valuationNote ?? '估值截面不足') : null}
          foot={metrics?.portfolioPe !== null && metrics?.portfolioPe !== undefined ? `覆盖 ${((metrics.valuationCoverage ?? 0) * 100).toFixed(0)}%` : ''}
        />
        <MetricCard
          label="组合 PB" info="按持仓市值加权的穿透 PB；缺失成分不按 0 处理，覆盖率低于 80% 不产生数值。"
          value={metrics?.portfolioPb !== null && metrics?.portfolioPb !== undefined ? fmt(metrics.portfolioPb) : null}
          na={metrics?.portfolioPb === null ? (metrics.valuationNote ?? '估值截面不足') : null}
          foot={metrics?.portfolioPb !== null && metrics?.portfolioPb !== undefined ? `覆盖 ${((metrics.valuationCoverage ?? 0) * 100).toFixed(0)}%` : ''}
        />
      </div>

      {risk ? (
        <div className="metric-row metric-row-4">
          <MetricCard
            label="年化波动率" info="口径：组合单位净值日收益率的标准差 × √252；与基准的共同交易日不足 20 个时不产生数值。"
            value={risk.volatility !== null ? `${(risk.volatility * 100).toFixed(2)}%` : null}
            na={risk.volatility === null ? '样本不足' : null}
            foot={`${risk.samples} 个共同交易日`}
          />
          <MetricCard
            label="Beta（对基准）" info="口径：组合日收益与基准日收益的协方差 ÷ 基准方差；基准缺失或样本不足不产生数值。"
            value={risk.beta !== null ? fmt(risk.beta) : null}
            na={risk.beta === null ? '无基准 / 样本不足' : null}
            foot={risk.benchmark.name ? `基准 ${risk.benchmark.name}` : '未导入基准指数'}
          />
          <MetricCard
            label="与基准相关性" info="口径：组合与基准日收益的皮尔逊相关系数；-1 至 1，样本不足不产生数值。"
            value={risk.correlation !== null ? fmt(risk.correlation) : null}
            na={risk.correlation === null ? '样本不足' : null}
            foot="越接近 1 越同步"
          />
          <MetricCard
            label="股债性价比（ERP）" info="口径：组合 PE 的倒数（盈利收益率）减去无风险利率；PE 缺失不产生数值。这是相对估值参考，不是买卖信号。"
            value={risk.erp !== null ? `${(risk.erp * 100).toFixed(2)}%` : null}
            na={risk.erp === null ? '缺组合 PE' : null}
            foot={`无风险利率 ${(risk.riskFreeRate * 100).toFixed(2)}%`}
          />
        </div>
      ) : null}

      <div className="card">
        <div className="dist-head">
          <h2>资产分布</h2>
          <Seg options={[{ key: 'full', label: '全量分布' }, { key: 'goal', label: '目标达成' }]} value={mode} onChange={setMode} />
          <div className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={() => props.onOpenGoalModal(goal)}>{goal?.enabled ? '编辑目标' : '设置目标'}</button>
        </div>
        <div className="dist-body">
          <div>
            <div className="donut-title">
              资产类型
              <span className="denom">分母：{allocationFull?.mode === 'goal' ? `目标金额 ${moneyText(allocationFull.effectiveGoalAmount)}` : `持仓总市值 ${moneyText(allocationFull?.totalMarketValue ?? summary.totalMarketValue)}`}</span>
            </div>
            {allocationFull ? (
              <Donut
                segments={allocationFull.segments.map((s) => ({ key: s.key, label: s.label, fraction: s.fraction, gray: s.gray, color: s.color }))}
                centerLabel={allocationFull.mode === 'goal' ? '目标完成率' : '持仓总市值'}
                centerValue={allocationFull.mode === 'goal' && allocationFull.progressRatio !== null ? `${(allocationFull.progressRatio * 100).toFixed(2)}%` : moneyText(summary.totalMarketValue)}
                centerSub={allocationFull.mode === 'goal' ? `${moneyText(summary.totalMarketValue)} / ${moneyText(allocationFull.effectiveGoalAmount ?? '0')}` : '点击扇区或图例联动'}
                activeKey={selCat}
                onSelect={(key) => { setSelCat((prev) => (prev === key ? null : key)); setSelSub(null); }}
              />
            ) : <div className="donut-empty">加载中…</div>}
            <div className="legend">
              {(allocationFull?.segments ?? []).map((s) => (
                <div key={s.key} className={`lg-row${selCat === s.key && !s.gray ? ' selected' : ''}`} onClick={() => { if (!s.gray) { setSelCat((prev) => (prev === s.key ? null : s.key)); setSelSub(null); } }}>
                  <i className="dot" style={{ background: s.gray ? '#cfd6df' : (s.color ?? '#9aa4b2') }} />
                  <span className="lg-name">{s.label}</span>
                  <span className="lg-val num">{moneyText(s.value)}</span>
                  <span className="lg-pct num">{pctText(s.fraction)}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="donut-title">
              {selCat ? `${CAT_META[selCat]?.label ?? selCat}内部构成` : '内部构成'}
              <span className="denom">{selCat && secondary ? `分母：${CAT_META[selCat]?.label ?? selCat}市值 ${moneyText(String(secondary.sum))}（不随目标模式变化）` : '等待选择'}</span>
            </div>
            {selCat && secondary ? (
              <>
                <Donut
                  segments={secondary.segments}
                  centerLabel={`${CAT_META[selCat]?.label ?? selCat}构成`}
                  centerValue="100%"
                  centerSub={`合计 ${moneyText(String(secondary.sum))}`}
                  activeKey={selSub}
                  onSelect={(key) => setSelSub((prev) => (prev === key ? null : key))}
                />
                <div className="legend">
                  {secondary.segments.map((s) => (
                    <div key={s.key} className={`lg-row${selSub === s.key ? ' selected' : ''}`} onClick={() => setSelSub((prev) => (prev === s.key ? null : s.key))}>
                      <i className="dot" style={{ background: s.color }} />
                      <span className="lg-name">{s.label}</span>
                      <span className="lg-val num">{moneyText(String(s.value))}</span>
                      <span className="lg-pct num">内部 {pctText(s.fraction)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="donut-empty">点击左侧<b>股票、场外基金或 ETF</b>，<br />查看该类资产的内部构成</div>
            )}
            {!selCat ? <div className="legend"><div className="lg-row" style={{ cursor: 'default' }}><span className="lg-name" style={{ color: 'var(--text3)' }}>不同类别的二级口径不同（行业 / 主题 / 跟踪指数），不做混合汇总</span></div></div> : null}
          </div>
          <div className="goal-panel">
            {goal?.enabled ? (
              <>
                <div className="goal-name">投资目标 · <b>{goal.name}</b><button className="link" onClick={() => props.onOpenGoalModal(goal)}>编辑</button></div>
                <div className="goal-rate num">{allocationFull?.mode === 'goal' && allocationFull.progressRatio !== null ? `${(allocationFull.progressRatio * 100).toFixed(2)}%` : `${((Number(summary.totalMarketValue) / Number(goal.targetAmount)) * 100).toFixed(2)}%`}<small>目标完成率（非收益率）</small></div>
                <div className="goal-bar"><i style={{ width: `${Math.min(Number(summary.totalMarketValue) / Number(goal.targetAmount), 1) * 100}%` }} /></div>
                <div className="goal-rows">
                  <div className="gr"><span>目标金额</span><b className="num">{moneyText(goal.targetAmount)}</b></div>
                  <div className="gr"><span>当前持仓市值</span><b className="num">{moneyText(summary.totalMarketValue)}</b></div>
                  <div className="gr"><span>待达成金额</span><b className="num">{allocationFull?.remainingAmount ? moneyText(allocationFull.remainingAmount) : '—'}（灰色扇区）</b></div>
                </div>
                <div className="goal-note">灰色「待达成」仅为与目标的金额差额，不代表亏损、现金缺口或应立即投入的资金。</div>
              </>
            ) : (
              <>
                <div className="goal-name">投资目标 · <b>未启用</b></div>
                <div className="goal-empty" style={{ fontSize: 12.5 }}>设置一个主投资资产目标，切换到「目标达成」模式。<br />目标只是资产规模进度，不是收益率。</div>
                <button className="btn btn-primary btn-sm" onClick={() => props.onOpenGoalModal(goal)}>设置目标</button>
              </>
            )}
          </div>
        </div>
        <div className="dist-note">
          {allocationFull?.mode === 'goal'
            ? '口径提示：一级图彩色扇区为「各类资产市值 ÷ 目标金额」的目标贡献率；二级图分母始终为所选类别的实际市值，两个口径独立标注、不混用。'
            : '口径提示：全量分布下所有类别占比之和为 100%，分母为纳入统计的持仓总市值；基金按最近正式净值计价，估算净值不参与。'}
        </div>
      </div>

      <div className="pf-grid">
        <CashCard
          accounts={cashAccounts}
          cashTotal={summary.cashTotal}
          totalAssets={summary.totalAssets}
          cashWeight={summary.cashWeight}
          onChanged={() => { void load(); }}
          onToast={props.onToast}
        />
        <CorrelationCard
          data={correlation}
          riskFreeRate={risk?.riskFreeRate ?? 0.015}
          riskFreeNote={`无风险利率同时决定夏普比率的超额收益与股债性价比（ERP = 1/组合PE − 无风险利率）。当前基准：${risk?.benchmark.name ?? '未导入'} · ${risk?.samples ?? 0} 个共同交易日。`}
          onChanged={() => { void load(); }}
          onToast={props.onToast}
        />
      </div>

      <RebalanceCard plan={rebalance} onChanged={() => { void load(); }} onToast={props.onToast} />

      <div className="card">
        <div className="table-head">
          <h2>持仓配置总览</h2>
          {selCat || selSub ? (
            <span className="filter-badge">
              已筛选：{selCat ? CAT_META[selCat]?.label : ''}{selSub ? ` / ${selSub}` : ''}
              <span className="clear" onClick={() => { setSelCat(null); setSelSub(null); }}>✕</span>
            </span>
          ) : null}
          <div className="spacer" />
          {selCat || selSub ? <button className="link" onClick={() => { setSelCat(null); setSelSub(null); }}>查看全部</button> : null}
        </div>
        <table>
          <thead>
            <tr>
              <th>类别</th><th>标的</th><th>账户</th><th>数量</th>
              <th className="num">市值</th><th className="num">占当前持仓</th>
              {goal?.enabled ? <th className="num">占目标金额</th> : null}
              <th className="num">持有盈亏</th><th className="num">收益率</th><th>数据日期</th><th />
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr key={row.positionId}>
                <td><span className="cat-dot"><i className="dot" style={{ background: CAT_META[row.type]?.color ?? '#9aa4b2' }} />{CAT_META[row.type]?.label ?? row.type}</span></td>
                <td><span className="inst-name">{row.name}</span><span className="inst-code">{row.code}</span></td>
                <td style={{ color: 'var(--text2)' }}>{row.accountName}</td>
                <td className="num">{row.qty}</td>
                <td className="num"><b>{moneyText(row.marketValue)}</b></td>
                <td className="num">{pctText(row.weight)}</td>
                {goal?.enabled ? <td className="num">{goal.enabled && Number(goal.targetAmount) > 0 ? pctText(Number(row.marketValue ?? 0) / Number(goal.targetAmount)) : '—'}</td> : null}
                <td className={`num ${signCls(row.pnl)}`}>{signMoneyText(row.pnl)}</td>
                <td className={`num ${signCls(row.pnl)}`}>{row.pnlRate ?? '—'}</td>
                <td><div className="date-cell"><span>{row.priceDate ?? '—'}</span><span style={{ fontSize: 10 }}><PriceBadge type={row.priceType} /></span></div></td>
                <td>
                  <button className="btn btn-sm" onClick={() => props.onOpenInstDetail(row.instrumentId)}>详情</button>
                </td>
              </tr>
            ))}
            {filteredRows.length === 0 ? <tr><td colSpan={12}><div className="empty">暂无持仓（新增持仓后展示）</div></td></tr> : null}
          </tbody>
          <tfoot>
            <tr className="t-foot">
              <td>合计（{filteredRows.length}）</td><td colSpan={3} />
              <td className="num">{moneyText(String(filteredMv))}</td>
              <td className="num">{pctText(1)}</td>
              {goal?.enabled ? <td className="num">{goal.enabled ? pctText(filteredMv / Number(goal.targetAmount)) : null}</td> : null}
              <td className={`num ${signCls(String(filteredPnl))}`}>{signMoneyText(String(filteredPnl))}</td>
              <td className="num">{filteredCost > 0 ? `${signMoneyText(String(filteredPnl / filteredCost * 100))}%` : '—'}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="card">
        <h2>策略机会摘要</h2>
        <div className="opp-strip">
          {opportunities.map((item) => (
            <div key={`${item.code}:${item.strategy.templateId}`} className="opp-item">
              <i className="o-dot" style={{ background: (item.strategy.total ?? 0) >= 80 ? '#0e9f6e' : (item.strategy.total ?? 0) >= 65 ? '#3d6ef2' : '#c0392b' }} />
              <div>
                <div className="o-title">
                  {item.name} · {item.strategy.templateName}
                  <LevelBadge level={item.strategy.level} />
                </div>
                <div className="o-reason">{item.strategy.reason ?? `规则匹配分 ${fmt(item.strategy.total ?? 0, 1)} / 100 · 覆盖率 ${pctText(item.strategy.coverage, 0)}`} · <button className="link" onClick={() => props.onOpenPk(item.instrumentId)}>PK</button></div>
              </div>
            </div>
          ))}
          {opportunities.length === 0 ? <div style={{ color: 'var(--text3)', fontSize: 12 }}>暂无达到评分条件的标的（刷新行情并积累估值截面后出现）</div> : null}
        </div>
        <div className="disclaimer" style={{ marginTop: 10 }}>
          评分为用户规则匹配结果（0–100），不构成投资建议。数据可能延迟或存在错误；本工作站不连接券商，不执行自动交易。
        </div>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: string; cls: string; sub: string }) {
  return (
    <div className="stat">
      <div className="s-label">{props.label}</div>
      <div className={`s-value num ${props.cls}`}>{props.value}</div>
      <div className="s-sub">{props.sub}</div>
    </div>
  );
}

function MetricCard(props: { label: string; info: string; value: string | null; na: string | null; foot: string }) {
  return (
    <div className="metric-card">
      <div className="m-label">{props.label}<span className="info" title={props.info}>i</span></div>
      {props.value !== null ? <div className="m-value num">{props.value}</div> : <div className="m-value na">{props.na}</div>}
      <div className="m-foot">{props.foot}</div>
    </div>
  );
}

/* ================= 持仓 ================= */

type PnlFilter = 'all' | 'gain' | 'loss';

export function HoldingsPage(props: {
  reloadKey: number;
  onOpenPosDetail: (positionId: string) => void;
  onOpenInstDetail: (instrumentId: string) => void;
  onOpenAi: (positionId: string) => void;
  onOpenPk: (instrumentId: string) => void;
  onOpenAssign: (instrumentId: string, instrumentName: string) => void;
  onOpenAddPos: () => void;
  onOpenTxn: () => void;
  onReload: () => void;
  onToast: (message: string) => void;
}) {
  const [sub, setSub] = useState<'positions' | 'ledger' | 'valuation'>('positions');
  const [typeTab, setTypeTab] = useState('all');
  const [account, setAccount] = useState('all');
  const [pnl, setPnl] = useState<PnlFilter>('all');
  const [holdings, setHoldings] = useState<HoldingsResult | null>(null);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [flows, setFlows] = useState<CashFlow[]>([]);
  const [valuationRows, setValuationRows] = useState<ValuationRow[] | null>(null);
  const [valType, setValType] = useState('all');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editFor, setEditFor] = useState<HoldingRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [holdingsResult, accountList, txnList, flowList, valuationResult] = await Promise.all([
        rpc<HoldingsResult>('list_positions', { type: typeTab, accountId: account, pnl }),
        rpc<{ id: string; name: string }[]>('list_accounts'),
        rpc<Txn[]>('list_transactions'),
        rpc<CashFlow[]>('get_portfolio_goal').then((g) => (g as unknown as { cashFlows: CashFlow[] }).cashFlows),
        rpc<{ rows: ValuationRow[] }>('get_holdings_valuation', { type: valType === 'all' ? undefined : valType }),
      ]);
      setHoldings(holdingsResult);
      setAccounts(accountList);
      setTxns(txnList);
      setFlows(flowList);
      setValuationRows(valuationResult.rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [typeTab, account, pnl, valType]);

  useEffect(() => { void load(); }, [load, props.reloadKey]);
  useEffect(() => {
    const close = (): void => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, []);

  const rowOp = async (op: string, row: HoldingRow): Promise<void> => {
    setMenuFor(null);
    if (op === 'pin') {
      await rpc('pin_position', { positionId: row.positionId, pinned: !row.pinned });
      void load();
      props.onReload();
    } else if (op === 'edit') {
      setEditFor(row);
    } else if (op === 'assign') {
      props.onOpenAssign(row.instrumentId, row.name);
    } else if (op === 'pk') {
      props.onOpenPk(row.instrumentId);
    } else if (op === 'del') {
      if (window.confirm(`确定删除「${row.name} ${row.code}」的持仓视图吗？\n交易流水将保留（审计），可在重新建仓后恢复。`)) {
        await rpc('delete_position', { positionId: row.positionId });
        void load();
        props.onReload();
      }
    }
  };

  const filtered = (holdings?.rows ?? []).filter((row) => {
    if (typeTab !== 'all' && row.type !== typeTab) return false;
    if (account !== 'all' && row.accountId !== account) return false;
    if (pnl === 'gain' && !(row.pnl ?? '').startsWith('+')) return false;
    if (pnl === 'loss' && !(row.pnl ?? '').startsWith('-')) return false;
    return true;
  });

  const valuationFiltered = (valuationRows ?? []).filter((row) => valType === 'all' || row.type === valType);

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>持仓</h1>
          <div className="update-line">{holdings ? `${holdings.rows.length} 个持仓 · 成本口径：加权平均成本法 ｜ 单击标的详情 · 双击持仓详情` : ''}</div>
        </div>
        <div className="head-actions">
          <div className="quick-row">
            <button className="btn btn-sm" onClick={props.onOpenAddPos}>＋ 新增持仓</button>
            <button className="btn btn-sm btn-primary" onClick={props.onOpenTxn}>✎ 记一笔</button>
            <button className="btn btn-sm" onClick={() => setImportOpen(true)}>⇪ 导入流水</button>
          </div>
        </div>
      </header>

      <div className="sub-tabs">
        {([['positions', '当前持仓'], ['ledger', '交易流水'], ['valuation', '持仓估值']] as const).map(([key, label]) => (
          <div key={key} className={`sub-tab${sub === key ? ' active' : ''}`} onClick={() => setSub(key)}>{label}</div>
        ))}
      </div>

      {error ? <div className="empty">{error}</div> : null}

      {sub === 'positions' ? (
        <>
          <div className="filter-row">
            <div className="type-tabs">
              {([['all', '全部'], ['stock', '股票'], ['etf', 'ETF'], ['fund', '场外基金']] as const).map(([key, label]) => (
                <button key={key} className={typeTab === key ? 'active' : ''} onClick={() => setTypeTab(key)}>{label}</button>
              ))}
            </div>
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="all">全部账户</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select value={pnl} onChange={(e) => setPnl(e.target.value as PnlFilter)}>
              <option value="all">全部盈亏状态</option>
              <option value="gain">盈利</option>
              <option value="loss">亏损</option>
            </select>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>共 {filtered.length} 条</span>
          </div>
          <div className="card" style={{ paddingTop: 6 }}>
            <table>
              <thead>
                <tr>
                  <th>类别</th><th>标的</th><th>分类</th><th>账户</th><th className="num">数量</th>
                  <th className="num">成本价</th><th className="num">现价 / 净值</th><th className="num">市值</th>
                  <th className="num">持仓盈亏</th><th className="num">收益率</th><th>数据日期</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.positionId} className="rowlink"
                    onClick={(e) => {
                      const target = e.target as HTMLElement;
                      if (target.closest('.ops-cell')) return;
                      props.onOpenInstDetail(row.instrumentId);
                    }}
                    onDoubleClick={(e) => {
                      if ((e.target as HTMLElement).closest('.ops-cell')) return;
                      props.onOpenPosDetail(row.positionId);
                    }}
                  >
                    <td><span className="cat-dot"><i className="dot" style={{ background: CAT_META[row.type]?.color ?? '#9aa4b2' }} />{CAT_META[row.type]?.label ?? row.type}</span></td>
                    <td><span className="inst-name">{row.name}</span><span className="inst-code">{row.code}</span>{row.pinned ? <span className="pin-badge">置顶</span> : null}</td>
                    <td>
                      {row.categories.names.length === 0
                        ? <span style={{ color: 'var(--text3)', fontSize: 11 }}>未分类</span>
                        : row.categories.names.map((name, i) => (
                          <span key={name} className="chip-cat"><i style={{ background: row.categories.colors[i] }} />{name}</span>
                        ))}
                      {row.categories.more > 0 ? <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>+{row.categories.more}</span> : null}
                    </td>
                    <td style={{ color: 'var(--text2)' }}>{row.accountName}</td>
                    <td className="num">{row.qty}</td>
                    <td className="num">{row.unitCost}</td>
                    <td className="num">{row.price ?? '—'} <PriceBadge type={row.priceType} /></td>
                    <td className="num"><b>{moneyText(row.marketValue)}</b></td>
                    <td className={`num ${signCls(row.pnl)}`}>{signMoneyText(row.pnl)}</td>
                    <td className={`num ${signCls(row.pnl)}`}>{row.pnlRate ?? '—'}</td>
                    <td><div className="date-cell"><span>{row.priceDate ?? '—'}</span><span style={{ fontSize: 10 }}>{row.quality === 'MANUAL' ? '手工价格' : row.priceType === 'OFFICIAL_NAV' ? '正式净值' : row.priceType === 'ESTIMATED_NAV' ? '估算（不计入收益）' : row.priceType === 'REALTIME_PRICE' ? '实时价' : '收盘价'}</span></div></td>
                    <td className="ops-cell">
                      <div className="ops-wrap" onClick={(e) => e.stopPropagation()}>
                        <button className="btn btn-sm" onClick={() => props.onOpenAi(row.positionId)}>AI 分析</button>
                        <div className="ops-menu-wrap">
                          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === row.positionId ? null : row.positionId); }}>⋯</button>
                          {menuFor === row.positionId ? (
                            <div className="ops-menu" onClick={(e) => e.stopPropagation()}>
                              <button className="mi" onClick={() => void rowOp('pin', row)}>{row.pinned ? '取消置顶' : '置顶'}</button>
                              <button className="mi" onClick={() => void rowOp('edit', row)}>修改持仓</button>
                              <button className="mi" onClick={() => void rowOp('assign', row)}>修改分组</button>
                              <button className="mi" onClick={() => void rowOp('pk', row)}>PK 对比</button>
                              <button className="mi mi-danger" onClick={() => void rowOp('del', row)}>删除</button>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? <tr><td colSpan={12}><div className="empty">暂无持仓</div></td></tr> : null}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {sub === 'ledger' ? (
        <>
          <div className="card" style={{ paddingTop: 6 }}>
            <table>
              <thead>
                <tr><th>交易日</th><th>类型</th><th>标的</th><th className="num">数量</th><th className="num">价格</th><th className="num">金额</th><th className="num">费用</th><th>状态</th><th>备注</th></tr>
              </thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td className="num">{t.tradeDate}</td>
                    <td><span className={`txn-chip tx-${t.type}`}>{({ OPENING: '期初建账', BUY: '买入', SELL: '卖出', DIVIDEND_CASH: '现金分红', DIVIDEND_REINVEST: '红利再投', FEE: '费用', SPLIT: '拆分', CORRECTION: '修正' } as Record<string, string>)[t.type] ?? t.type}</span></td>
                    <td><span className="inst-name">{t.instrumentId}</span></td>
                    <td className="num">{t.quantity ?? '—'}</td>
                    <td className="num">{t.price ?? '—'}</td>
                    <td className="num">{t.amount ?? '—'}</td>
                    <td className="num" style={{ color: 'var(--text3)' }}>{t.fee ?? '—'}</td>
                    <td>{t.status === 'PENDING_CONFIRMATION' ? <span className="badge t-est">待确认</span> : <span className="badge t-nav">已确认</span>}</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11.5, whiteSpace: 'normal' }}>{t.note || '—'}</td>
                  </tr>
                ))}
                {txns.length === 0 ? <tr><td colSpan={9}><div className="empty">暂无流水</div></td></tr> : null}
              </tbody>
            </table>
          </div>
          <CashFlowCard flows={flows} onChanged={() => { void load(); props.onReload(); }} onToast={props.onToast} />
        </>
      ) : null}

      {sub === 'valuation' ? (
        <>
          <div className="filter-row">
            <div className="type-tabs">
              {([['all', '全部'], ['stock', '股票'], ['etf', 'ETF'], ['fund', '场外基金']] as const).map(([key, label]) => (
                <button key={key} className={valType === key ? 'active' : ''} onClick={() => setValType(key)}>{label}</button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>估值截面 · 不随收益区间变化</span>
          </div>
          <div className="card" style={{ paddingTop: 6 }}>
            <table>
              <thead>
                <tr><th>标的</th><th>类别</th><th>策略结论</th><th className="num">PE</th><th className="num">PB</th><th className="num">股息率</th><th className="num">ROE</th><th className="num">夏普</th><th className="num">波动率</th><th className="num">最大回撤</th><th>估值口径</th></tr>
              </thead>
              <tbody>
                {valuationFiltered.map((row) => (
                  <tr key={row.instrumentId}>
                    <td><span className="inst-name">{row.name}</span><span className="inst-code">{row.code}</span></td>
                    <td><span className="cat-dot"><i className="dot" style={{ background: CAT_META[row.type]?.color ?? '#9aa4b2' }} />{CAT_META[row.type]?.label ?? row.type}</span></td>
                    <td>{row.strategies.length > 0 ? <LevelBadge level={row.strategies[0].level} /> : '—'}</td>
                    <td className="num">{row.pe === null ? <span style={{ color: 'var(--text3)' }}>—</span> : <span><b>{row.pe}</b><span className="date-cell">{row.pePercentile === null ? <i style={{ fontSize: 10, fontStyle: 'normal' }}>分位 样本不足</i> : <i style={{ fontSize: 10, fontStyle: 'normal', color: row.pePercentile <= 20 ? 'var(--down)' : row.pePercentile > 60 ? 'var(--up)' : 'var(--text3)' }}>分位 {row.pePercentile.toFixed(1)}%</i>}</span></span>}</td>
                    <td className="num">{row.pb === null ? <span style={{ color: 'var(--text3)' }}>—</span> : <span><b>{row.pb}</b><span className="date-cell">{row.pbPercentile === null ? <i style={{ fontSize: 10, fontStyle: 'normal' }}>分位 样本不足</i> : <i style={{ fontSize: 10, fontStyle: 'normal', color: row.pbPercentile <= 20 ? 'var(--down)' : row.pbPercentile > 60 ? 'var(--up)' : 'var(--text3)' }}>分位 {row.pbPercentile.toFixed(1)}%</i>}</span></span>}</td>
                    <td className="num">{row.dividendYield ?? '—'}</td>
                    <td className="num">{row.type === 'STOCK' ? (row.roe ?? '—') : '—'}</td>
                    <td className="num">{row.sharpe === null ? '—' : fmt(row.sharpe)}</td>
                    <td className="num">{row.volatilityPct === null ? '—' : `${row.volatilityPct.toFixed(1)}%`}</td>
                    <td className="num down">{row.maxDrawdownPct === null ? '—' : `${row.maxDrawdownPct.toFixed(1)}%`}</td>
                    <td style={{ color: 'var(--text3)', fontSize: 11, whiteSpace: 'normal', maxWidth: 230 }}>{row.caliber}</td>
                  </tr>
                ))}
                {valuationFiltered.length === 0 ? <tr><td colSpan={11}><div className="empty">暂无持仓</div></td></tr> : null}
              </tbody>
            </table>
            <div className="list-cap">口径：基金 / ETF 的 PE、PB 为跟踪指数穿透估值（标注估值日期）；主动基金持仓披露滞后，不提供实时穿透估值（显示「—」）；股票为 PE-TTM / PB（最近披露）。分位为近 3 年历史分位（绿色 ≤20% 相对有利、红色 60% 以上相对不利）。本视图不显示收益，仅供估值观察，不构成投资建议。</div>
          </div>
        </>
      ) : null}

      {editFor ? (
        <EditPosModal
          row={editFor}
          onClose={() => setEditFor(null)}
          onSaved={() => { setEditFor(null); void load(); props.onReload(); props.onToast('持仓已修正，流水留痕并重算'); }}
        />
      ) : null}
      {importOpen ? (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onSaved={() => { void load(); props.onReload(); }}
          onToast={props.onToast}
        />
      ) : null}
    </div>
  );
}

/* ================= 估值页 ================= */

export function ValuationPage(props: { reloadKey: number; instrumentId: string | null; onToast: (message: string) => void }) {
  const [rows, setRows] = useState<ValuationRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [typeFilter, setTypeFilter] = useState('全部');
  const [heldOnly, setHeldOnly] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);

  const load = useCallback(async () => {
    const [valuation, templateResult] = await Promise.all([
      // scope=all：估值页列全部在库标的（含指数 / 无持仓的观察标的），
      // 没有持仓也能看到；缺指标的行显示「数据不足」，不会从列表里消失。
      rpc<{ rows: ValuationRow[]; total: number }>('get_holdings_valuation', { scope: 'all' }),
      rpc<{ templates: { id: string; name: string }[] }>('list_strategy_templates'),
    ]);
    setRows(valuation.rows);
    setTotal(typeof valuation.total === 'number' ? valuation.total : valuation.rows.length);
    setTemplates(templateResult.templates);
    // 依赖必须只含真实存在的变量：曾误写成 [range]（range 只存在于 DashboardPage 作用域），
    // 渲染期求值依赖数组会抛 ReferenceError，整棵 React 树卸载 → 页面整站白屏。
  }, []);

  useEffect(() => { void load(); }, [load, props.reloadKey]);

  const source = rows ?? [];
  const TYPE_GROUPS: { key: string; label: string }[] = [
    { key: '全部', label: '全部' },
    { key: 'STOCK', label: '股票' },
    { key: 'ETF', label: 'ETF' },
    { key: 'OPEN_END_FUND', label: '场外基金' },
    { key: 'INDEX', label: '指数' },
  ];
  const countOf = (key: string): number => (key === '全部' ? source.length : source.filter((row) => row.type === key).length);
  const filtered = source.filter((row) => (typeFilter === '全部' || row.type === typeFilter) && (!heldOnly || row.held));
  const scored = filtered.filter((row) => row.strategies.some((strategy) => strategy.total !== null)).length;
  // 缺口聚合：全是「数据不足」时告诉用户缺的到底是什么、怎么补，而不是让人以为页面没修好。
  const gaps = (() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const row of filtered) {
      for (const strategy of row.strategies) {
        for (const metric of strategy.metrics) {
          if (metric.status !== 'missing') continue;
          const hit = map.get(metric.key) ?? { label: metric.label, count: 0 };
          hit.count += 1;
          map.set(metric.key, hit);
        }
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 3);
  })();

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>估值</h1>
          <div className="update-line">策略评分 = 规则匹配度 0–100，不代表涨跌概率或收益预测；模板可编辑、按版本留痕；缺失指标显示「数据不足」，可手工补录（MANUAL）</div>
          <div className="update-line">
            全部标的 <b className="num">{total}</b> 只 · 当前筛选 <b className="num">{filtered.length}</b> 只 · 可评分 <b className="num">{scored}</b> 只
            <span className="sep">·</span>策略模板 <b className="num">{templates.length}</b> 个
            <span className="badge t-real" style={{ marginLeft: 6 }}>含非持仓标的</span>
          </div>
        </div>
      </header>
      <div className="val-layout">
        <div>
          <StrategyTemplatePanel onChanged={() => void load()} onToast={props.onToast} />
        </div>
        <div>
          <div className="val-head-row" style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div className="val-chips">
              {TYPE_GROUPS.map((group) => (
                <button
                  key={group.key}
                  className={`vchip${typeFilter === group.key ? ' active' : ''}`}
                  onClick={() => setTypeFilter(group.key)}
                >
                  {group.label}<span style={{ opacity: 0.6, marginLeft: 4 }}>{countOf(group.key)}</span>
                </button>
              ))}
            </div>
            <label className="val-held-toggle">
              <input type="checkbox" checked={heldOnly} onChange={(e) => setHeldOnly(e.target.checked)} />
              仅持仓
            </label>
          </div>
          {filtered.length > 0 && scored === 0 && gaps.length > 0 ? (
            <div className="val-gap">
              当前筛选下 {filtered.length} 只标的都还没达到评分条件。主要缺口：
              {gaps.map((gap, i) => (
                <React.Fragment key={gap.label}>{i > 0 ? ' · ' : ''}<b>{gap.label} ×{gap.count}</b></React.Fragment>
              ))}
              。分位类指标要同时满足「≥20 个历史截面」和「跨度 ≥180 天」才会计算，插件按日累积即可补齐；也可在标的详情页手工补录（标注 MANUAL）。
            </div>
          ) : null}
          <div className="card" style={{ paddingTop: 6 }}>
            <table className="opp-table">
              <thead>
                <tr><th /><th>标的</th><th>策略</th><th className="num">综合评分</th><th>结论</th><th className="num">覆盖率</th></tr>
              </thead>
              <tbody>
                {filtered.map((row) => row.strategies.map((strategy, si) => {
                  const key = `${row.instrumentId}:${strategy.templateId}`;
                  const expandedNow = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr
                        className={expandedNow ? 'expanded' : ''}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpanded(expandedNow ? null : key)}
                      >
                        <td>
                          <button className="caret">
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 9l6 6 6-6" /></svg>
                          </button>
                        </td>
                        <td>
                          <span className="inst-name">{row.name}</span>
                          <span className="inst-code">{row.code}</span>
                          {row.held ? <span className="badge t-nav" style={{ marginLeft: 5 }}>持仓</span> : null}
                        </td>
                        <td style={{ color: 'var(--text2)' }}>{strategy.templateName}</td>
                        <td className="num">
                          {strategy.total === null
                            ? <span className="score-na">数据不足</span>
                            : <span><b style={{ fontSize: 15 }} className="num">{strategy.total}</b><span style={{ color: 'var(--text3)', fontSize: 10.5 }}> /100</span></span>}
                        </td>
                        <td><LevelBadge level={strategy.level} /></td>
                        <td className="num">{pctText(strategy.coverage, 0)}</td>
                      </tr>
                      {expandedNow ? (
                        <tr><td colSpan={6} className="expand-cell">
                          <table className="kr-table">
                            <thead><tr><th>指标</th><th className="num">当前值</th><th>状态</th><th className="num">权重</th><th className="num">得分</th></tr></thead>
                            <tbody>
                              {strategy.metrics.map((metric) => (
                                <tr key={metric.key}>
                                  <td>{metric.label}</td>
                                  <td className="num">{metric.value === null ? '—' : fmt(metric.value)}</td>
                                  <td className={metric.status === 'favorable' ? 'kr-ok' : metric.status === 'adverse' ? 'kr-bad' : metric.status === 'missing' ? '' : 'kr-mid'}>
                                    {metric.status === 'favorable' ? '✓ 优先区间' : metric.status === 'adverse' ? '✗ 不利区间' : metric.status === 'missing' ? '缺失' : '中性'}
                                  </td>
                                  <td className="num">{metric.weight}%</td>
                                  <td className="num">{metric.score === null ? '—' : fmt(metric.score, 1)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {strategy.reason ? <div className="kr-explain">· {strategy.reason}</div> : null}
                          <div className="kr-meta">评分为规则匹配结果，不构成投资建议；指标缺失显示「缺失」，不计入权重覆盖。</div>
                        </td></tr>
                      ) : null}
                    </React.Fragment>
                  );
                }))}
                {filtered.length === 0 ? (
                  <tr><td colSpan={6}><div className="empty">
                    {heldOnly
                      ? '开启「仅持仓」后没有标的：取消勾选即可看到全部标的。'
                      : source.length === 0
                        ? '还没有任何标的。到「指数」页导入常用指数，或在持仓页新增持仓后，这里会自动出现全部标的。'
                        : '当前类别下没有标的：切换到「全部」查看。'}
                  </div></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="disclaimer">评分只表达「当前指标与模板规则的匹配程度」；结论分档可由用户调整，不构成买入卖出指令。</div>
    </div>
  );
}

/* ================= 设置 ================= */

export function SettingsPage(props: { reloadKey: number; onReload: () => void; onToast: (msg: string) => void }) {
  const [tab, setTab] = useState<'general' | 'cats' | 'ai'>('general');
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [cats, setCats] = useState<{ id: string; name: string; color: string; count: number }[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#3d6ef2');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiKey, setAiKey] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiBusy, setAiBusy] = useState<'save' | 'test' | null>(null);
  const aiPending = useRef(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [refresh, setRefresh] = useState<RefreshSettingsState | null>(null);
  const [refreshInterval, setRefreshInterval] = useState('60');

  const load = useCallback(async () => {
    const [infoResult, aiResult, categoryResult, refreshResult] = await Promise.all([
      rpc<AppInfo>('get_app_info'),
      rpc<AiStatus>('get_ai_settings'),
      rpc<{ categories: { id: string; name: string; color: string; count: number }[] }>('list_categories'),
      rpc<RefreshSettingsState>('get_refresh_settings'),
    ]);
    setInfo(infoResult);
    setAi(aiResult);
    setCats(categoryResult.categories);
    setAiBaseUrl(aiResult.masked.baseUrl);
    setAiModel(aiResult.masked.model);
    setAiKey(aiResult.masked.apiKey);
    setRefresh(refreshResult);
    setRefreshInterval(String(refreshResult.settings.intervalSec));
  }, []);

  useEffect(() => { void load().catch((error) => props.onToast((error as Error).message)); }, [load, props.reloadKey]);

  const saveAi = async (testConnection: boolean) => {
    if (aiPending.current) return;
    aiPending.current = true;
    setAiBusy(testConnection ? 'test' : 'save');
    try {
      const saved = await rpc<AiStatus>('save_ai_settings', { baseUrl: aiBaseUrl, apiKey: aiKey === ai?.masked.apiKey ? undefined : aiKey, model: aiModel });
      setAi(saved);
      setAiBaseUrl(saved.masked.baseUrl);
      setAiModel(saved.masked.model);
      setAiKey(saved.masked.apiKey);
      if (testConnection) {
        const result = await rpc<{ ok: boolean; message: string }>('test_ai_connection');
        setAi(await rpc<AiStatus>('get_ai_settings'));
        props.onToast(result.message);
      } else props.onToast('AI 配置已保存；配置变更后需重新测试连接');
    } catch (error) {
      props.onToast((error as Error).message);
    } finally {
      aiPending.current = false;
      setAiBusy(null);
    }
  };

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>设置</h1>
          <div className="update-line">所有配置保存在本机（{info?.dataDir ?? '…'}），不上传云端</div>
        </div>
      </header>
      <div className="sub-tabs">
        {([['general', '常规'], ['cats', '分类管理'], ['ai', 'AI 配置']] as const).map(([key, label]) => (
          <div key={key} className={`sub-tab${tab === key ? ' active' : ''}`} onClick={() => setTab(key)}>{label}</div>
        ))}
      </div>

      {tab === 'general' ? (
        <div className="set-grid">
          <div className="card">
            <h2>行情数据源</h2>
            <div className="set-item"><span className="si-label">Eastmoney / 天天基金（主数据源）</span><span className="si-value"><i className="status-dot sd-green" />Adapter 已装载</span></div>
            <div className="set-item"><span className="si-label">手工价格 / 净值</span><span className="si-value"><i className="status-dot sd-green" />兜底 · 标的详情中录入</span></div>
            <div className="set-item"><span className="si-label">正式净值与估算</span><span className="si-value">严格分离 · 估算不参与计价</span></div>
            <div className="set-item"><span className="si-label">刷新</span><span className="si-value">
              <RefreshButton onToast={props.onToast} onDone={props.onReload} />
              <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 8 }}>低频拉取 · 磁盘缓存 · 失败显式</span>
            </span></div>
          </div>
          <div className="card">
            <h2>行情自动刷新</h2>
            <div className="set-item"><span className="si-label">自动刷新</span><span className="si-value">
              <button className="btn btn-sm" onClick={async () => {
                try {
                  await rpc('save_refresh_settings', { enabled: !refresh?.settings.enabled });
                  void load();
                  props.onToast(!refresh?.settings.enabled ? '已开启自动刷新' : '已关闭自动刷新');
                } catch (err) { props.onToast((err as Error).message); }
              }}>{refresh?.settings.enabled ? '已开启 · 点击关闭' : '已关闭 · 点击开启'}</button>
            </span></div>
            <div className="set-item"><span className="si-label">刷新间隔</span><span className="si-value">
              <input type="number" min={refresh?.limits.minSec ?? 15} max={refresh?.limits.maxSec ?? 3600}
                value={refreshInterval} style={{ width: 90 }} onChange={(e) => setRefreshInterval(e.target.value)} />
              <span style={{ marginLeft: 6 }}>秒</span>
              <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={async () => {
                try {
                  await rpc('save_refresh_settings', { intervalSec: Number(refreshInterval) });
                  void load();
                  props.onToast('刷新间隔已保存');
                } catch (err) { props.onToast((err as Error).message); }
              }}>保存</button>
            </span></div>
            <div className="set-item"><span className="si-label">仅交易时段刷新</span><span className="si-value">
              <button className="btn btn-sm" onClick={async () => {
                try {
                  await rpc('save_refresh_settings', { tradingHoursOnly: !refresh?.settings.tradingHoursOnly });
                  void load();
                  props.onToast('刷新时段设置已保存');
                } catch (err) { props.onToast((err as Error).message); }
              }}>{refresh?.settings.tradingHoursOnly ? '是 · 点击改为全天' : '否 · 点击改为仅交易时段'}</button>
            </span></div>
            <div className="set-item"><span className="si-label">当前时段</span><span className="si-value">
              {refresh?.session ? (
                <>
                  <span className={`badge ${refresh.session.open ? 't-nav' : 't-close'}`}>{refresh.session.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 6 }}>
                    {refresh.session.date} {refresh.session.time}（UTC+8）
                  </span>
                </>
              ) : (refresh?.inTradingHours ? '交易时段内' : '非交易时段')}
            </span></div>
            <div className="set-item"><span className="si-label">交易日历</span><span className="si-value" style={{ fontWeight: 400, fontSize: 12 }}>
              {refresh?.calendar?.source === 'market'
                ? <>取自指数日线 · {refresh.calendar.dayCount} 个交易日 · 推导休市 {refresh.calendar.holidays} 天</>
                : '尚无足够指数日线 · 按周一至周五推断（节假日可能误判）'}
            </span></div>
            <div className="set-hint" style={{ marginBottom: 0 }}>
              {refresh?.note ?? '…'} 配置改动即时生效；也可在「行情数据源」中手动刷新。关闭后插件不会自动请求行情接口。
            </div>
          </div>
          <div className="card">
            <h2>备份与恢复</h2>
            <div className="set-item"><span className="si-label">JSON 全量导出</span><span className="si-value"><button className="btn btn-sm" onClick={async () => {
              const payload = await rpc<Record<string, unknown>>('export_backup');
              downloadFile(`plug-funds-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json');
              props.onToast('JSON 备份已导出');
            }}>导出 JSON</button></span></div>
            <div className="set-item"><span className="si-label">持仓 CSV 导出</span><span className="si-value"><button className="btn btn-sm" onClick={async () => {
              const result = await rpc<{ csv: string }>('export_holdings_csv');
              downloadFile(`plug-funds-holdings-${new Date().toISOString().slice(0, 10)}.csv`, result.csv, 'text/csv');
              props.onToast('持仓 CSV 已导出');
            }}>导出 CSV</button></span></div>
            <div className="set-item"><span className="si-label">从备份恢复</span><span className="si-value"><button className="btn btn-sm" onClick={() => setRestoreOpen(true)}>选择 JSON 备份</button></span></div>
            <div className="set-hint" style={{ marginBottom: 0 }}>导出始终含真实数值（隐藏金额不影响备份）；恢复为替换式，先校验预览、自动备份当前库、单事务写入，失败自动回滚。</div>
          </div>
          <div className="card">
            <h2>隐私与展示</h2>
            <div className="set-item"><span className="si-label">隐藏金额</span><span className="si-value">
              <button className="btn btn-sm" onClick={async () => {
                const appInfo = await rpc<{ hideAmount: boolean }>('get_app_info');
                await rpc('set_hide_amount', { enabled: !appInfo.hideAmount });
                props.onToast(!appInfo.hideAmount ? '已隐藏金额 · 百分比与价格 / 净值保持可见' : '已显示金额');
                props.onReload();
              }}>{info?.hideAmount ? '当前隐藏 · 点击显示' : '当前显示 · 点击隐藏'}</button>
            </span></div>
            <div className="set-item"><span className="si-label">数据位置</span><span className="si-value num" style={{ fontSize: 11 }}>{info?.dataDir ?? '—'}</span></div>
            <div className="set-item"><span className="si-label">遥测</span><span className="si-value"><i className="status-dot sd-green" />无 · 不上传任何数据</span></div>
            <div className="set-item"><span className="si-label">版本</span><span className="si-value">v{info?.version ?? '—'} · schema {info?.schemaVersion ?? '—'}</span></div>
          </div>
          <div className="card">
            <h2>计算口径</h2>
            <div className="set-item"><span className="si-label">成本算法</span><span className="si-value">加权平均成本法（i64 定点）</span></div>
            <div className="set-item"><span className="si-label">精度</span><span className="si-value">金额 2 位 / 份额净值 4 位 · ROUND_DOWN</span></div>
            <div className="set-item"><span className="si-label">币种</span><span className="si-value">CNY（首版固定）</span></div>
            <div className="set-item"><span className="si-label">涨跌颜色</span><span className="si-value"><span className="up">红涨</span> / <span className="down">绿跌</span>（含 +/−）</span></div>
          </div>
        </div>
      ) : null}

      {tab === 'cats' ? (
        <div className="card">
          <h2>自定义分类</h2>
          <div className="set-hint">分类仅包含「名称」与「颜色」两个字段，作为可选标签：创建基金、股票等资产时可勾选，<b>默认不勾选、非必填</b>。删除分类只解除关联，不影响资产与流水。名称可直接在下方修改。</div>
          {cats.map((category) => (
            <div key={category.id} className="cat-row">
              <input type="color" value={category.color} onChange={async (e) => {
                await rpc('save_category', { id: category.id, name: category.name, color: e.target.value });
                void load();
              }} />
              <input type="text" value={category.name} onChange={(e) => {
                setCats((prev) => prev.map((c) => (c.id === category.id ? { ...c, name: e.target.value } : c)));
              }} onBlur={async (e) => {
                const name = e.target.value.trim();
                if (!name || name === category.name) { void load(); return; }
                try {
                  await rpc('save_category', { id: category.id, name, color: category.color });
                  props.onToast('分类名称已更新'); props.onReload();
                } catch (err) { props.onToast((err as Error).message); void load(); }
              }} />
              <span className="cat-count num">（{category.count} 个资产）</span>
              <button className="btn btn-sm" onClick={async () => {
                if (!window.confirm(`删除分类「${category.name}」？${category.count > 0 ? `\n其下 ${category.count} 个资产将变为未分类（资产不受影响）。` : ''}`)) return;
                await rpc('delete_category', { id: category.id });
                void load(); props.onReload();
              }}>删除</button>
            </div>
          ))}
          <div className="cat-add">
            <input type="color" value={newColor} onChange={(e) => setNewColor(e.target.value)} />
            <input type="text" value={newName} placeholder="新分类名称，如「养老仓」" onChange={(e) => setNewName(e.target.value)} />
            <button className="btn btn-primary btn-sm" onClick={async () => {
              if (!newName.trim()) { props.onToast('请先输入分类名称'); return; }
              try {
                await rpc('save_category', { name: newName.trim(), color: newColor });
                setNewName(''); void load(); props.onToast('分类已添加');
              } catch (err) { props.onToast((err as Error).message); }
            }}>＋ 添加分类</button>
          </div>
        </div>
      ) : null}

      {tab === 'ai' ? (
        <>
          <div className="card">
            <h2>AI 配置</h2>
            <div className="set-hint">兼容 OpenAI 接口格式（Base URL 后追加 /chat/completions）。API Key 存于{ai?.secretBackend === 'keychain' ? '系统钥匙串' : '本机 SQLite（系统钥匙串不可用，已如实降级）'}（不写入日志、不随备份导出）；AI 分析仅在点击「AI 分析」时<b>手动触发</b>。测试连接只发送固定连通探针。当前状态：{ai?.configured ? <span className={`badge ${ai.connectionTested ? 't-nav' : 't-wait'}`}>{ai.connectionTested ? '已配置，连接已验证' : '已配置，待测试'}</span> : <span className="badge t-wait">未配置</span>}</div>
            <div className="form-grid">
              <Field label="Base URL">
                <input type="text" disabled={aiBusy !== null} value={aiBaseUrl} placeholder="https://api.deepseek.com/v1" onChange={(e) => setAiBaseUrl(e.target.value)} />
              </Field>
              <Field label="模型">
                <input type="text" disabled={aiBusy !== null} value={aiModel} placeholder="deepseek-chat" onChange={(e) => setAiModel(e.target.value)} />
              </Field>
            </div>
            <Field label="API Key">
              <input type="password" autoComplete="new-password" disabled={aiBusy !== null} value={aiKey} placeholder={ai?.masked.apiKey || 'sk-…（输入新值即覆盖）'} onChange={(e) => setAiKey(e.target.value)} />
            </Field>
            <div style={{ display: 'flex', gap: 9, marginTop: 6 }}>
              <button className="btn" disabled={aiBusy !== null} onClick={() => void saveAi(true)}>{aiBusy === 'test' ? '正在测试…' : '测试连接'}</button>
              <button className="btn btn-primary" disabled={aiBusy !== null} onClick={() => void saveAi(false)}>{aiBusy === 'save' ? '正在保存…' : '保存配置'}</button>
            </div>
          </div>
          <div className="card">
            <h2>AI 分析数据范围</h2>
            <div className="set-hint" style={{ marginBottom: 0 }}>{ai?.scope ?? '…'}</div>
          </div>
        </>
      ) : null}

      {restoreOpen ? (
        <RestoreModal
          onClose={() => setRestoreOpen(false)}
          onSaved={() => { void load(); props.onReload(); }}
          onToast={props.onToast}
        />
      ) : null}
    </div>
  );
}

async function fetchCurrentHide(): Promise<boolean> {
  return rpc<{ hideAmount: boolean }>('get_app_info').then((info) => info.hideAmount).catch(() => false);
}
void fetchCurrentHide;

function downloadFile(name: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/* ================= 持仓详情 ================= */

export function PosDetailPage(props: {
  positionId: string;
  onBack: () => void;
  onOpenInstDetail: (instrumentId: string) => void;
  onOpenAi: (positionId: string) => void;
  onOpenPk: (instrumentId: string) => void;
  onOpenAssign: (instrumentId: string, instrumentName: string) => void;
  onToast: (msg: string) => void;
  onReload: () => void;
  reloadKey: number;
}) {
  const [detail, setDetail] = useState<PositionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'sector' | 'perf' | 'mine'>('perf');
  const [period, setPeriod] = useState('1y');
  const [compare, setCompare] = useState('沪深300');
  const [chart, setChart] = useState<ChartSeriesResult | null>(null);

  const load = useCallback(async () => {
    try {
      const detailResult = await rpc<PositionDetail>('get_position_detail', { positionId: props.positionId });
      setDetail(detailResult);
      const chartResult = await rpc<ChartSeriesResult>('get_instrument_chart_series', {
        instrumentId: detailResult.instrument.id, tab, period, compare: tab === 'perf' && compare !== '仅看本标的' ? compare : 'none',
      });
      setChart(chartResult);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [props.positionId, tab, period, compare]);

  useEffect(() => { void load(); }, [load, props.reloadKey]);

  if (error) return <div className="empty">{error}<br /><button className="btn btn-sm" style={{ marginTop: 8 }} onClick={props.onBack}>返回</button></div>;
  if (!detail) return <div className="empty">加载中…</div>;
  const { holding, instrument, basics } = detail;
  const pinned = holding.pinned;

  return (
    <div>
      <div className="back-row">
        <button className="back-btn" onClick={props.onBack}>← 返回持仓列表</button>
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>双击列表项进入本页 · 单击进入标的详情</span>
      </div>
      <header className="page-head">
        <div>
          <h1>{instrument.name} <span className="inst-code">{instrument.code}</span> <PriceBadge type={holding.priceType} />{pinned ? <span className="pin-badge">置顶</span> : null}</h1>
          <div className="update-line">{CAT_META[instrument.type]?.label ?? instrument.type} · {holding.accountName} · 数据日期 {holding.priceDate ?? '—'}</div>
        </div>
        <div className="head-actions">
          <div className="op-btns">
            <button className="btn btn-sm" onClick={async () => {
              await rpc('pin_position', { positionId: props.positionId, pinned: !pinned });
              props.onToast(!pinned ? '已置顶' : '已取消置顶');
              void load(); props.onReload();
            }}>{pinned ? '取消置顶' : '置顶'}</button>
            <button className="btn btn-sm" onClick={() => props.onToast('原型演示：修改持仓表单（正式版本触发重算留痕）')}>修改持仓</button>
            <button className="btn btn-sm" onClick={() => props.onOpenAssign(instrument.id, instrument.name)}>修改分组</button>
            <button className="btn btn-sm" onClick={() => props.onOpenPk(instrument.id)}>PK 对比</button>
            <button className="btn btn-sm" style={{ color: '#e0343c' }} onClick={async () => {
              if (!window.confirm(`确定删除「${instrument.name} ${instrument.code}」的持仓视图吗？\n交易流水将保留（审计）。`)) return;
              await rpc('delete_position', { positionId: props.positionId });
              props.onToast('持仓已删除 · 交易流水保留');
              props.onReload(); props.onBack();
            }}>删除</button>
            <button className="btn btn-sm btn-primary" onClick={() => props.onOpenAi(props.positionId)}>AI 分析</button>
          </div>
        </div>
      </header>

      <div className="card">
        <div className="detail-grid">
          <Dg label="持有金额" value={moneyText(basics.marketValue)} />
          <Dg label="持有份额" value={basics.qty} />
          <Dg label="持仓占比" value={pctText(basics.weight)} sub="占组合总市值" />
          <Dg label="持有收益" value={<span className={signCls(holding.pnl)}>{signMoneyText(holding.pnl)}</span>} />
          <Dg label="持有收益率" value={<span className={signCls(holding.pnl)}>{holding.pnlRate ?? '—'}</span>} sub="收益 ÷ 持仓成本" />
          <Dg label="持仓成本" value={moneyText(basics.costTotal)} sub={`单位成本 ${basics.unitCost}`} />
          <Dg label="当日收益" value={<span className={signCls(basics.dayPnl)}>{signMoneyText(basics.dayPnl)}</span>} sub={basics.dayPnlNote ?? ''} />
          <Dg label="昨日收益" value={<span className={signCls(basics.ydayPnl)}>{signMoneyText(basics.ydayPnl)}</span>} />
          <Dg label="已持天数" value={basics.heldDays !== null ? `${basics.heldDays} 天` : '—'} sub={`自 ${basics.firstHeldDate ?? '—'} 起`} />
        </div>
      </div>

      <ChartCard
        instrumentId={instrument.id}
        instrumentType={instrument.type}
        instrumentName={instrument.name}
        tab={tab} setTab={setTab}
        period={period} setPeriod={setPeriod}
        compare={compare} setCompare={setCompare}
        chart={chart}
        reloadKey={props.reloadKey}
      />

      <div className="card">
        <h2 style={{ marginBottom: 6 }}>交易流水</h2>
        <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 6 }}>{detail.transactionsNote}</div>
        <table>
          <thead><tr><th>交易日</th><th>类型</th><th className="num">数量</th><th className="num">价格</th><th className="num">金额</th><th>状态</th><th>备注</th></tr></thead>
          <tbody>
            {detail.transactions.map((t) => (
              <tr key={t.id}>
                <td className="num">{t.tradeDate}</td>
                <td><span className={`txn-chip tx-${t.type}`}>{({ OPENING: '期初建账', BUY: '买入', SELL: '卖出', DIVIDEND_CASH: '现金分红', DIVIDEND_REINVEST: '红利再投', FEE: '费用', SPLIT: '拆分', CORRECTION: '修正' } as Record<string, string>)[t.type] ?? t.type}</span></td>
                <td className="num">{t.quantity ?? '—'}</td>
                <td className="num">{t.price ?? '—'}</td>
                <td className="num">{t.amount ?? '—'}</td>
                <td>{t.status === 'PENDING_CONFIRMATION' ? <span className="badge t-est">待确认</span> : <span className="badge t-nav">已确认</span>}</td>
                <td style={{ color: 'var(--text3)', fontSize: 11.5 }}>{t.note || '—'}</td>
              </tr>
            ))}
            {detail.transactions.length === 0 ? <tr><td colSpan={7}><div className="empty">暂无流水</div></td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Dg(props: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="dg-item">
      <div className="dg-label">{props.label}</div>
      <div className="dg-value num">{props.value}</div>
      {props.sub ? <div className="dg-sub">{props.sub}</div> : null}
    </div>
  );
}

/* ================= 标的详情 ================= */

export function InstDetailPage(props: {
  instrumentId: string;
  onBack: () => void;
  onOpenPosDetail: (positionId: string) => void;
  onOpenAi: (positionId: string) => void;
  onToast: (msg: string) => void;
  reloadKey: number;
}) {
  const [detail, setDetail] = useState<{ instrument: Instrument; stageReturns: Record<string, number | null>; series: { date: string; value: string }[] } | null>(null);
  const [holding, setHolding] = useState<HoldingsResult | null>(null);
  const [tab, setTab] = useState<'perf' | 'mine'>('perf');
  const [period, setPeriod] = useState('1y');
  const [chart, setChart] = useState<ChartSeriesResult | null>(null);
  const [manualPrice, setManualPrice] = useState('');
  const [detailTxns, setDetailTxns] = useState<Txn[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const detailResult = await rpc<{ instrument: Instrument; stageReturns: Record<string, number | null>; series: { date: string; value: string }[] }>('get_instrument_detail', { instrumentId: props.instrumentId });
      setDetail(detailResult);
      const [holdingsResult, txnResult] = await Promise.all([
        rpc<HoldingsResult>('list_positions', {}),
        rpc<Txn[]>('list_transactions', { instrumentId: props.instrumentId }),
      ]);
      setHolding(holdingsResult);
      setDetailTxns(txnResult);
      const chartResult = await rpc<ChartSeriesResult>('get_instrument_chart_series', {
        instrumentId: props.instrumentId, tab, period, compare: 'none',
      });
      setChart(chartResult);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [props.instrumentId, tab, period]);

  useEffect(() => { void load(); }, [load, props.reloadKey]);

  if (error) return <div className="empty">{error}<br /><button className="btn btn-sm" style={{ marginTop: 8 }} onClick={props.onBack}>返回</button></div>;
  if (!detail) return <div className="empty">加载中…</div>;
  const instrument = detail.instrument;
  const isStock = instrument.type === 'STOCK';
  const holdingRow = holding?.rows.find((r) => r.instrumentId === instrument.id) ?? null;

  return (
    <div>
      <div className="back-row">
        <button className="back-btn" onClick={props.onBack}>← 返回持仓列表</button>
        <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>单击列表项进入本页（{isStock ? '股票详情' : '基金详情'}）· 双击进入持仓详情</span>
      </div>
      <header className="page-head">
        <div>
          <h1>{instrument.name} <span className="inst-code">{instrument.code}</span></h1>
          <div className="update-line">{isStock ? 'A 股个股' : instrument.type === 'ETF' ? '场内 ETF' : '场外公募基金'}{instrument.tag ? ` · ${instrument.tag}` : ''}{instrument.benchmarkIndex ? ` · 跟踪 ${instrument.benchmarkIndex}` : ''}</div>
        </div>
        <div className="head-actions">
          <div className="op-btns">
            {holdingRow ? <button className="btn btn-sm btn-primary" onClick={() => props.onOpenAi(holdingRow.positionId)}>AI 分析</button> : null}
            {holdingRow ? <button className="btn btn-sm" onClick={() => props.onOpenPosDetail(holdingRow.positionId)}>进入持仓详情</button> : null}
          </div>
        </div>
      </header>

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>基础信息</h2>
        <div className="info-grid">
          <Ig label="类型" value={isStock ? 'A 股个股' : instrument.type === 'ETF' ? '场内 ETF' : '场外公募基金'} />
          <Ig label="代码 / 市场" value={`${instrument.code} · ${instrument.market}`} />
          <Ig label={isStock ? '上市日期' : '成立日期'} value={instrument.foundedDate ?? '—'} />
          <Ig label={isStock ? '总市值' : '规模'} value={instrument.scaleInfo ?? '—'} />
          {holdingRow ? (
            <>
              <Ig label="最新价 / 净值" value={<span className="num">{holdingRow.price ?? '—'} <PriceBadge type={holdingRow.priceType} /></span>} />
              <Ig label="持有收益率" value={<span className={signCls(holdingRow.pnl)}>{holdingRow.pnlRate ?? '—'}</span>} />
            </>
          ) : (
            <>
              <Ig label="最新价 / 净值" value={holdingRow ? holdingRow.price ?? '—' : <span style={{ color: 'var(--text3)' }}>未持有（刷新行情后展示）</span>} />
              <Ig label="我的持仓" value="未持有" />
            </>
          )}
          <Ig label="估值口径" value={chart?.note ?? '刷新行情后展示'} />
        </div>
        {holdingRow === null ? (
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="text" className="btn btn-sm" style={{ width: 120, padding: '3px 8px' }} placeholder="手工价格" value={manualPrice} onChange={(e) => setManualPrice(e.target.value)} />
            <button className="btn btn-sm" onClick={async () => {
              if (!manualPrice.trim()) { props.onToast('请输入价格 / 净值'); return; }
              await rpc('save_manual_price', { instrumentId: instrument.id, value: manualPrice.trim() });
              setManualPrice('');
              props.onToast('手工价格已录入（MANUAL_PRICE）');
              void load();
            }}>录入手工价格</button>
            <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>MANUAL_PRICE 优先于其他来源，用于无适配器覆盖的标的</span>
          </div>
        ) : null}
      </div>

      {holdingRow ? (
        <div className="card">
          <h2 style={{ marginBottom: 8 }}>我的持仓</h2>
          <div className="mini-grid">
            <Dg label="持有金额" value={moneyText(holdingRow.marketValue)} />
            <Dg label="持有份额" value={holdingRow.qty} />
            <Dg label="持仓成本" value={moneyText(holdingRow.costTotal)} />
            <Dg label="持有收益" value={<span className={signCls(holdingRow.pnl)}>{signMoneyText(holdingRow.pnl)}（{holdingRow.pnlRate ?? '—'}）</span>} />
          </div>
        </div>
      ) : null}

      <ChartCard
        instrumentId={instrument.id}
        instrumentType={instrument.type}
        instrumentName={instrument.name}
        tab={tab} setTab={setTab}
        period={period} setPeriod={setPeriod}
        compare="none" setCompare={() => undefined}
        chart={chart}
        reloadKey={props.reloadKey}
        hideSector
      />

      <div className="card">
        <h2 style={{ marginBottom: 8 }}>阶段涨幅（基于近 1 年本地行情缓存）</h2>
        <div className="hero-chips">
          {Object.entries(detail.stageReturns).map(([label, value]) => (
            <span key={label} className="chip">{label} <b className={`num ${signCls(value === null ? null : String(value))}`}>{signedPctText(value)}</b></span>
          ))}
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 6 }}>交易流水（本标的）</h2>
        <table>
          <thead><tr><th>交易日</th><th>类型</th><th className="num">数量</th><th className="num">价格</th><th className="num">金额</th><th>状态</th></tr></thead>
          <tbody>
            {detailTxns.map((t) => (
              <tr key={t.id}>
                <td className="num">{t.tradeDate}</td>
                <td>{t.type}</td>
                <td className="num">{t.quantity ?? '—'}</td>
                <td className="num">{t.price ?? '—'}</td>
                <td className="num">{t.amount ?? '—'}</td>
                <td>{t.status === 'PENDING_CONFIRMATION' ? <span className="badge t-est">待确认</span> : <span className="badge t-nav">已确认</span>}</td>
              </tr>
            ))}
            {detailTxns.length === 0 ? <tr><td colSpan={6}><div className="empty">该标的暂无交易流水</div></td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Ig(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="ig-item">
      <div className="ig-label">{props.label}</div>
      <div className="ig-value">{props.value}</div>
    </div>
  );
}

/* ================= 图表卡（三个 Tab 共用） ================= */

export function ChartCard(props: {
  instrumentId: string;
  instrumentType: string;
  instrumentName: string;
  tab: 'sector' | 'perf' | 'mine';
  setTab: (tab: 'sector' | 'perf' | 'mine') => void;
  period: string;
  setPeriod: (period: string) => void;
  compare: string;
  setCompare: (compare: string) => void;
  chart: ChartSeriesResult | null;
  reloadKey: number;
  hideSector?: boolean;
}) {
  const tabs: ('sector' | 'perf' | 'mine')[] = props.hideSector ? ['perf', 'mine'] : ['sector', 'perf', 'mine'];
  const labels: Record<string, string> = { sector: '关联板块', perf: '业绩走势', mine: '我的收益' };
  if (!props.chart) return <div className="card"><div className="empty">图表加载中…</div></div>;
  const chart = props.chart;
  const dates = chart.series.map((p) => p.date);
  const values = chart.series.map((p) => Number(p.value));
  const first = values[0] ?? 0;
  const isMine = props.tab === 'mine';
  const isSector = props.tab === 'sector';
  const normalize = props.tab === 'perf' && first > 0;
  const unitCostNum = chart.unitCost ? Number(chart.unitCost) : null;
  const costPct = normalize && unitCostNum !== null && first > 0 ? (unitCostNum / first - 1) * 100 : null;

  const series = chart.series.length === 0 ? [] : [
    {
      name: chart.instrument.name,
      color: '#3d6ef2',
      pts: normalize ? values.map((v) => (first > 0 ? (v / first - 1) * 100 : 0)) : values,
    },
    ...(chart.compare && !isMine ? [{
      name: chart.compare.name,
      color: '#ee9d3f',
      pts: (() => {
        const cmp = chart.compare.series.map((p) => Number(p.value));
        const base = cmp[0] ?? 1;
        return normalize ? cmp.map((v) => (base > 0 ? (v / base - 1) * 100 : 0)) : cmp;
      })(),
    }] : []),
  ];
  const markers = (props.tab === 'perf' ? chart.markers : []).map((marker) => ({
    ...marker,
    i: dates.indexOf(marker.date),
  }));
  const yFmt = isMine
    ? (v: number): string => `¥${fmt(v, 0)}`
    : normalize
      ? (v: number): string => `${v.toFixed(0)}%`
      : (v: number): string => fmt(v, chart.instrument.type === 'STOCK' ? 1 : 3);

  return (
    <div className="card">
      <div className="chart-head">
        <div className="tabs-line">
          {tabs.map((key) => (
            <div key={key} className={`tl${props.tab === key ? ' active' : ''}`} onClick={() => props.setTab(key)}>{labels[key]}</div>
          ))}
        </div>
        <div className="chart-ctrl">
          {props.tab === 'perf' ? (
            <select value={props.compare} onChange={(e) => props.setCompare(e.target.value)}>
              {(['仅看本标的', '沪深300', '创业板指', '上证指数', '中证500'] as const).map((option) => (
                <option key={option} value={option}>{option === '仅看本标的' ? option : `对比：${option}`}</option>
              ))}
            </select>
          ) : null}
          <Seg options={RANGES} value={props.period} onChange={props.setPeriod} />
        </div>
      </div>
      <div className="legend-line">
        {series.length > 0 ? <span className="ll"><i style={{ background: '#3d6ef2' }} />{chart.instrument.name}{normalize ? '（区间起点 = 0%）' : ''}</span> : null}
        {chart.compare && !isMine ? <span className="ll"><i style={{ background: '#ee9d3f' }} />{chart.compare.name}</span> : null}
        {props.tab === 'perf' && chart.costLine ? <span className="ll"><i style={{ background: 'repeating-linear-gradient(90deg,var(--text3) 0 4px,transparent 4px 8px)' }} />成本线（按同一基准换算）</span> : null}
        {isMine ? <span className="ll"><i style={{ background: 'repeating-linear-gradient(90deg,var(--text3) 0 4px,transparent 4px 8px)' }} />保本线（成本 = 0 收益）</span> : null}
        {props.tab === 'perf' ? <span className="ll"><i style={{ background: '#e0343c', width: 8, height: 8, borderRadius: '50%' }} />买入</span> : null}
        {props.tab === 'perf' ? <span className="ll"><i style={{ background: '#0e9f6e', width: 8, height: 8, borderRadius: '50%' }} />卖出</span> : null}
      </div>
      <div className="chart-mount">
        {series.length > 0 ? (
          <LineChart
            dates={dates}
            series={series}
            costLine={props.tab === 'perf' && costPct !== null ? { v: costPct, label: '成本线' } : isMine ? { v: 0, label: '保本线' } : null}
            markers={markers}
            yFmt={yFmt}
          />
        ) : <div className="empty">{chart.note ?? '暂无数据'}</div>}
      </div>
      <div className="scroll-list">
        <table>
          <thead>
            {isMine ? <tr><th>日期</th><th className="num">当日收益变动</th><th className="num">累计收益</th></tr>
              : <tr><th>日期</th><th className="num">{chart.instrument.type === 'STOCK' ? '收盘价' : '单位净值'}</th><th className="num">日涨幅</th></tr>}
          </thead>
          <tbody>
            {[...chart.list].reverse().map((row) => (
              <tr key={row.date}>
                <td className="num">{row.date}</td>
                <td className="num">{row.value}</td>
                {isMine
                  ? <td className="num">{row.extra ?? '0.00'}</td>
                  : <td className={`num ${row.change === null ? '' : row.change.startsWith('+') ? 'up' : row.change.startsWith('-') ? 'down' : ''}`}>{row.change ?? '—'}</td>}
              </tr>
            ))}
            {chart.list.length === 0 ? <tr><td colSpan={3}><div className="empty">区间内没有数据</div></td></tr> : null}
          </tbody>
        </table>
      </div>
      <div className="list-cap">
        {chart.note ?? `区间 ${chart.span.begin} 至 ${chart.span.end} · 共 ${chart.series.length} 个交易日 · 基于本地行情缓存的真实历史价格 / 净值`}
      </div>
    </div>
  );
}

void shortDate; void signedNumText; void signedPctText;
