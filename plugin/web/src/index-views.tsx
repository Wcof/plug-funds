/**
 * 指数页的二级视图（对应参考页 #/6 左侧两行菜单）。
 *
 * 原则：只有能靠本机数据算出来的才画表，算不出来的显式说明「数据源不覆盖」，
 * 绝不填 0 或先造假数据再标注——那会让「—」失去意义。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  rpc,
  type IndexAnalytics, type IndexAnalyticsRow, type IndexDcaRow, type IndexGrahamRow,
} from './api.ts';
import { Donut, LineChart, fmt, pctText } from './ui.tsx';

/* ---------------- 通用格式化 ---------------- */

function pctSigned(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

function tone(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'idx-na';
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

function numOr(value: number | null, digits = 2): string {
  return value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);
}

function ViewEmpty(props: { title: string; hint: string }) {
  return (
    <div className="idx-view-empty">
      <div className="ive-title">{props.title}</div>
      <div className="ive-hint">{props.hint}</div>
    </div>
  );
}

/* ---------------- 历史涨跌幅 ---------------- */

export function ReturnsView(props: { data: IndexAnalytics | null }) {
  const rows = props.data?.rows ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无指数日线数据" hint="先在「指数列表」导入常用指数并刷新数据，阶段收益才会出现。阶段收益按自然月回退取最近交易日，不插值。" />;
  }
  const cols: { key: keyof IndexAnalyticsRow['returns']; label: string }[] = [
    { key: 'w1', label: '近 1 周' }, { key: 'm1', label: '近 1 月' }, { key: 'm3', label: '近 3 月' },
    { key: 'm6', label: '近 6 月' }, { key: 'ytd', label: '今年' }, { key: 'y1', label: '近 1 年' },
    { key: 'y3', label: '近 3 年' }, { key: 'y5', label: '近 5 年' },
  ];
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">最新点位</th>
            {cols.map((c) => <th key={c.key} className="num">{c.label}</th>)}
            <th>数据日期</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className="num">{numOr(row.close)}</td>
              {cols.map((c) => (
                <td key={c.key} className={`num ${tone(row.returns[c.key])}`}>{pctSigned(row.returns[c.key])}</td>
              ))}
              <td className="idx-na">{row.lastDate ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">共 {rows.length} 个指数 · {props.data?.window.tradingDays ?? 0} 个交易日样本 · 区间 {props.data?.window.begin ?? '—'} → {props.data?.window.end ?? '—'}</div>
    </div>
  );
}

/* ---------------- 波动率与回撤 ---------------- */

export function VolatilityView(props: { data: IndexAnalytics | null }) {
  const rows = props.data?.rows ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无波动率数据" hint="波动率需要至少 20 个交易日的日收益率；导入指数并刷新后自动计算。" />;
  }
  const maxVol = Math.max(...rows.map((r) => r.volatility ?? 0), 0.0001);
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">年化波动率</th><th>相对水平</th>
            <th className="num">最大回撤</th><th className="num">样本</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className="num"><b>{row.volatility === null ? '—' : `${(row.volatility * 100).toFixed(2)}%`}</b></td>
              <td>
                <span className="idx-bar"><i style={{ width: `${((row.volatility ?? 0) / maxVol) * 100}%` }} /></span>
              </td>
              <td className="num down">{row.maxDrawdown === null ? '—' : `${(row.maxDrawdown * 100).toFixed(2)}%`}</td>
              <td className="num idx-na">{row.samples}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">波动率 = 近 252 个交易日日收益率标准差 × √252；最大回撤取近 252 个交易日。样本 &lt; 20 天不产生数值。</div>
    </div>
  );
}

/* ---------------- 新高 / 新低 ---------------- */

export function HighLowView(props: { data: IndexAnalytics | null; mode: 'high' | 'low' }) {
  const rows = props.data?.rows ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无新高新低数据" hint="需要至少 2 个交易日的历史；导入指数并刷新后自动计算。" />;
  }
  const isHigh = props.mode === 'high';
  const sorted = [...rows].sort((a, b) => {
    const av = isHigh ? (a.high.distance ?? 0) : (b.low.distance ?? 0);
    const bv = isHigh ? (b.high.distance ?? 0) : (a.low.distance ?? 0);
    return bv - av;
  });
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">最新点位</th>
            <th className="num">{isHigh ? '距窗口最高' : '距窗口最低'}</th>
            <th>状态</th><th className="num">窗口</th><th>数据日期</th></tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const hit = isHigh ? row.high : row.low;
            return (
              <tr key={row.id}>
                <td className="idx-code">{row.code}</td>
                <td className="idx-name">{row.name}</td>
                <td className="num">{numOr(row.close)}</td>
                <td className={`num ${tone(hit.distance)}`}>{pctSigned(hit.distance)}</td>
                <td>
                  {isHigh
                    ? (row.high.isNewHigh ? <span className="idx-tag hot">正在新高</span> : <span className="idx-tag">未创新高</span>)
                    : (row.low.isNewLow ? <span className="idx-tag cold">正在新低</span> : <span className="idx-tag">未创新低</span>)}
                </td>
                <td className="num idx-na">{hit.window} 日</td>
                <td className="idx-na">{row.lastDate ?? '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="idx-view-foot">「正在新高」= 最新点位 ≥ 近 {rows[0]?.high.window ?? 60} 个交易日最高点。这是价格位置描述，不构成买卖建议。</div>
    </div>
  );
}

/* ---------------- RPS & 换手 ---------------- */

export function RpsView(props: { data: IndexAnalytics | null }) {
  const rows = [...(props.data?.rows ?? [])].sort((a, b) => (b.rps ?? -1) - (a.rps ?? -1));
  if (rows.length === 0) {
    return <ViewEmpty title="暂无 RPS 数据" hint="RPS 需要至少 2 个指数与 1 年以上日线；单只指数无法排名。" />;
  }
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th className="num">RPS</th><th>代码</th><th>指数名称</th><th className="num">近 1 年</th>
            <th>强度条</th><th className="num">换手率</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="num"><b>{row.rps === null ? '—' : row.rps.toFixed(1)}</b></td>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className={`num ${tone(row.returns.y1)}`}>{pctSigned(row.returns.y1)}</td>
              <td><span className="idx-bar"><i style={{ width: `${row.rps ?? 0}%` }} /></span></td>
              <td className="num idx-na">{row.turnover === null ? '—' : pctText(row.turnover, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">RPS = 按近 1 年收益在同组内的百分位（100 = 最强）。换手率需要成分股成交额，本机数据源不含，恒为「—」。</div>
    </div>
  );
}

/* ---------------- 相关性 ---------------- */

function corrStyle(value: number | null): React.CSSProperties {
  if (value === null) return { color: 'var(--text3)' };
  if (value >= 0.999) return { background: 'var(--gray-bg)', color: 'var(--text3)' };
  const alpha = 0.08 + Math.min(Math.abs(value), 1) * 0.4;
  return {
    background: value >= 0 ? `rgba(76,110,245,${alpha.toFixed(3)})` : `rgba(14,159,110,${alpha.toFixed(3)})`,
    color: 'var(--text)',
  };
}

export function CorrelationView(props: { data: IndexAnalytics | null }) {
  const corr = props.data?.correlation;
  if (!corr || corr.codes.length < 2) {
    return <ViewEmpty title="无法计算相关性" hint="至少需要 2 个有日线的指数，且两两共同交易日 ≥ 20 天。样本不足时格子留空，不用 0 冒充「不相关」。" />;
  }
  return (
    <div className="idx-view-table">
      <div className="corr-scroll">
        <table className="corr-table">
          <thead>
            <tr><th className="corr-corner">指数</th>
              {corr.codes.map((code, j) => <th key={code} className="num" title={corr.names[j]}>{code}</th>)}
            </tr>
          </thead>
          <tbody>
            {corr.matrix.map((row, i) => (
              <tr key={corr.codes[i]}>
                <th className="corr-row-head" title={corr.codes[i]}>{corr.names[i]}</th>
                {row.map((value, j) => (
                  <td key={`${i}-${j}`} className="num corr-cell" style={corrStyle(value)}
                    title={`${corr.names[i]} × ${corr.names[j]}：${value === null ? '样本不足' : value.toFixed(3)}`}>
                    {value === null ? '—' : value.toFixed(2)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="idx-view-foot">皮尔逊相关系数（日收益率）；对角线恒为 1。共同交易日 {corr.samples} 天。相关性高不等于同涨同跌的因果，只是同期波动同步。</div>
    </div>
  );
}

/* ---------------- 定投回测 ---------------- */

export function DcaView(props: { data: IndexAnalytics | null }) {
  const rows: IndexDcaRow[] = props.data?.dca ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无可回测的指数" hint="定投回测需要至少 20 个交易日；导入指数并刷新后按「每月首个交易日买入 1000 元」回测。" />;
  }
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">期数</th><th className="num">累计投入</th>
            <th className="num">期末价值</th><th className="num">盈亏</th><th className="num">累计收益率</th><th className="num">年化（XIRR）</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.code}>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className="num">{row.months}</td>
              <td className="num">{fmt(row.invested, 0)}</td>
              <td className="num"><b>{fmt(row.value, 0)}</b></td>
              <td className={`num ${tone(row.profit)}`}>{row.profit > 0 ? '+' : ''}{fmt(row.profit, 0)}</td>
              <td className={`num ${tone(row.profitRate)}`}>{pctSigned(row.profitRate)}</td>
              <td className={`num ${tone(row.xirr)}`}>{row.xirr === null ? '—' : pctSigned(row.xirr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">
        规则：每月首个交易日定额买入 1000 元，最后一期不买（避免刚买就算收益）；年化用 XIRR（按实际现金流日期折现）。
        这是历史回测，不是未来收益承诺，也未计费用与跟踪误差。
        <b> 注意：</b>年化是把实际持有期折算成一年，样本不足 1 年时会被显著放大（例如两个月的 +2.5% 会显示成两位数年化），
        请与「累计收益率」一起看，不要单看年化。
      </div>
    </div>
  );
}

/* ---------------- 格雷厄姆 / 股债收益率 ---------------- */

export function GrahamView(props: { data: IndexAnalytics | null; mode: 'graham' | 'erp' }) {
  const rows: IndexGrahamRow[] = props.data?.graham ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无估值数据" hint="需要指数的 PE 截面（valuation_metrics）。导入指数并刷新行情后，PE 会自动写入。" />;
  }
  const isGraham = props.mode === 'graham';
  const maxAbs = Math.max(...rows.map((r) => Math.abs((isGraham ? r.grahamIndex : r.erp) ?? 0)), 0.0001);
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">PE-TTM</th><th className="num">盈利收益率</th>
            <th className="num">{isGraham ? '格雷厄姆指数' : '股债性价比（ERP）'}</th><th>相对水平</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const value = isGraham ? row.grahamIndex : row.erp;
            return (
              <tr key={row.code}>
                <td className="idx-code">{row.code}</td>
                <td className="idx-name">{row.name}</td>
                <td className="num">{numOr(row.pe)}</td>
                <td className="num">{row.earningsYield === null ? '—' : `${(row.earningsYield * 100).toFixed(2)}%`}</td>
                <td className={`num ${tone(value)}`}>
                  <b>{value === null ? '—' : isGraham ? value.toFixed(2) : `${(value * 100).toFixed(2)}%`}</b>
                </td>
                <td><span className="idx-bar"><i style={{ width: `${(Math.abs(value ?? 0) / maxAbs) * 100}%` }} /></span></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="idx-view-foot">
        {isGraham
          ? '格雷厄姆指数 = 盈利收益率（1/PE）÷ 无风险利率；> 1 表示盈利收益率高于无风险利率。无风险利率在「总览 → 风险参数」设置。'
          : 'ERP = 1/PE − 无风险利率。数值越高代表股票相对债券越「便宜」；这是相对估值参考，不是买卖信号。'}
        {' '}PE 缺失的指数不产生数值，也不按 0 计入。
      </div>
    </div>
  );
}

/* ---------------- ETF 列表 ---------------- */

export function EtfView(props: { data: IndexAnalytics | null; onOpenInstDetail?: (id: string) => void }) {
  const rows = props.data?.etf ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="尚无 ETF 标的" hint="在「持仓 → 新增持仓」里录入 type=ETF 的标的并刷新行情，这里会按同一套有效价格口径列出。" />;
  }
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>ETF 名称</th><th className="num">最新价</th><th className="num">今年</th>
            <th className="num">近 1 年</th><th className="num">PE</th><th>数据日期</th><th /></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className="num">{numOr(row.close, 3)}</td>
              <td className={`num ${tone(row.ytd)}`}>{pctSigned(row.ytd)}</td>
              <td className={`num ${tone(row.y1)}`}>{pctSigned(row.y1)}</td>
              <td className="num">{numOr(row.pe)}</td>
              <td className="idx-na">{row.lastDate ?? '—'}</td>
              <td>{props.onOpenInstDetail ? <button className="link" onClick={() => props.onOpenInstDetail?.(row.id)}>详情</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">ETF 与指数同源（场内标的），但看的是可交易工具本身：价格取自有效价格口径，PE 取自估值截面，缺数据留「—」。</div>
    </div>
  );
}

/* ---------------- 图形对比 ---------------- */

const SERIES_COLORS = ['#4c6ef5', '#ee9d3f', '#0e9f6e'];

export function CompareView(props: { data: IndexAnalytics | null }) {
  const rows = props.data?.rows ?? [];
  const [picked, setPicked] = useState<string[]>([]);
  const [series, setSeries] = useState<Record<string, { date: string; value: string }[]>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (rows.length > 0 && picked.length === 0) setPicked(rows.slice(0, Math.min(2, rows.length)).map((r) => r.id));
  }, [rows, picked.length]);

  const load = useCallback(async (ids: string[]) => {
    setBusy(true);
    try {
      const result: Record<string, { date: string; value: string }[]> = {};
      for (const id of ids) {
        const payload = await rpc<{ series: { date: string; value: string }[] }>('get_instrument_chart_series', {
          instrumentId: id, tab: 'perf', period: '1y',
        });
        result[id] = payload.series;
      }
      setSeries(result);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { if (picked.length > 0) void load(picked); }, [picked, load]);

  if (rows.length === 0) {
    return <ViewEmpty title="暂无指数可对比" hint="导入指数并刷新数据后，可任选最多 3 个指数做归一化走势对比。" />;
  }

  // 以各自首日为 100 归一，避免量纲不同（3000 点 vs 12000 点）导致小值被压平。
  const dates = [...new Set(picked.flatMap((id) => (series[id] ?? []).map((p) => p.date)))].sort();
  const normalized = picked.map((id, index) => {
    const points = series[id] ?? [];
    const byDate = new Map(points.map((p) => [p.date, Number(p.value)]));
    const base = points.length > 0 ? Number(points[0].value) : 0;
    const pts = dates.map((date) => {
      const value = byDate.get(date);
      return value === undefined || base <= 0 ? Number.NaN : (value / base) * 100;
    });
    // 缺值按前值填充（指数日线通常对齐，这里只防御性处理）
    for (let i = 1; i < pts.length; i += 1) if (Number.isNaN(pts[i])) pts[i] = pts[i - 1];
    return {
      name: rows.find((r) => r.id === id)?.name ?? id,
      color: SERIES_COLORS[index % SERIES_COLORS.length],
      pts: pts.filter((v) => Number.isFinite(v)),
    };
  }).filter((s) => s.pts.length > 1);

  return (
    <div className="idx-view-table">
      <div className="idx-compare-pick">
        {rows.map((row) => {
          const active = picked.includes(row.id);
          return (
            <button key={row.id} type="button" className={`vchip${active ? ' active' : ''}`}
              onClick={() => setPicked((prev) => {
                if (prev.includes(row.id)) return prev.length === 1 ? prev : prev.filter((id) => id !== row.id);
                return prev.length >= 3 ? [...prev.slice(1), row.id] : [...prev, row.id];
              })}>
              {row.name}
            </button>
          );
        })}
        <span className="idx-compare-hint">最多选 3 个 · 归一化到 100</span>
      </div>
      {busy ? <div className="idx-loading">读取日线…</div> : null}
      {normalized.length > 1 ? (
        <>
          <div className="chart-mount">
            <LineChart
              dates={dates}
              series={normalized.map((s) => ({ name: s.name, color: s.color, pts: s.pts }))}
              yFmt={(v) => v.toFixed(0)}
              height={260}
            />
          </div>
          <div className="legend-line">
            {normalized.map((s) => (
              <span key={s.name} className="ll"><i style={{ background: s.color }} />{s.name}</span>
            ))}
          </div>
        </>
      ) : <div className="empty">{busy ? '加载中…' : '选择至少 2 个指数开始对比'}</div>}
      <div className="idx-view-foot">两条线都以各自区间首日 = 100 归一，只比较相对涨跌幅，不比较绝对点位。</div>
    </div>
  );
}

/* ---------------- 数据源未覆盖的视图（诚实空态） ---------------- */

export function UnavailableView(props: { title: string; reason: string; needs: string[] }) {
  return (
    <div className="idx-view-empty">
      <div className="ive-title">{props.title}</div>
      <div className="ive-hint">{props.reason}</div>
      <ul className="ive-needs">
        {props.needs.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

/* ---------------- 指标口径说明（财务对比视图） ---------------- */

export function MetricsView(props: { data: IndexAnalytics | null }) {
  const rows = props.data?.rows ?? [];
  if (rows.length === 0) {
    return <ViewEmpty title="暂无估值截面" hint="财务指标（PE/PB/股息率）来自本机 valuation_metrics；导入指数并刷新行情后写入。" />;
  }
  return (
    <div className="idx-view-table">
      <table>
        <thead>
          <tr><th>代码</th><th>指数名称</th><th className="num">PE-TTM</th><th className="num">PB</th>
            <th className="num">股息率</th><th className="num">盈利收益率</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="idx-code">{row.code}</td>
              <td className="idx-name">{row.name}</td>
              <td className="num">{numOr(row.pe)}</td>
              <td className="num">{numOr(row.pb)}</td>
              <td className="num">{row.dividendYield === null ? '—' : `${(row.dividendYield * 100).toFixed(2)}%`}</td>
              <td className="num">{row.pe !== null && row.pe > 0 ? `${((1 / row.pe) * 100).toFixed(2)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="idx-view-foot">只做横向对比：不同指数的成分股与会计口径不同，PE 不能直接当「谁更便宜」的结论。</div>
    </div>
  );
}

/* ---------------- 组合占比（自定义指标视图的辅助图表） ---------------- */

export function CoverageDonut(props: { total: number; used: number; label: string }) {
  const fraction = props.total > 0 ? props.used / props.total : 0;
  return (
    <Donut
      segments={[
        { key: 'used', label: props.label, fraction, color: '#4c6ef5' },
        { key: 'rest', label: '其余', fraction: Math.max(0, 1 - fraction), gray: true },
      ]}
      centerLabel={props.label}
      centerValue={pctText(fraction, 0)}
      centerSub={`${props.used} / ${props.total}`}
    />
  );
}
