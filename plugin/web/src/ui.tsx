/**
 * SPA 共享 UI：格式化、环形图、折线图、徽标、弹窗、分段控件。
 * 图表全部自绘 SVG（不引入外部图表库，保持产物自包含）。
 */
import React, { useEffect, useRef, useState } from 'react';

/* ---------------- 格式化 ---------------- */

export function fmt(n: number, d = 2): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** 服务端定点字符串 → 千分位显示。 */
export function moneyText(text: string | null | undefined): string {
  if (text === null || text === undefined) return '—';
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return `¥${fmt(n)}`;
}

export function signMoneyText(text: string | null | undefined): string {
  if (text === null || text === undefined) return '—';
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return `${n > 0 ? '+' : ''}${fmt(n)}`;
}

export function signCls(text: string | null | undefined): string {
  if (text === null || text === undefined) return 'flat';
  const n = Number(text);
  if (!Number.isFinite(n)) return 'flat';
  return n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
}

/* ---------------- 环形图 ---------------- */

export interface DonutSegment {
  key: string;
  label: string;
  fraction: number;
  color?: string;
  gray?: boolean;
}

const FALLBACK_COLORS = ['#4c6ef5', '#9a6bf2', '#ee9d3f', '#0e9f6e', '#38bdf8', '#f472b6'];

export function Donut(props: {
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
  centerSub?: string;
  activeKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  const size = 180;
  const stroke = 26;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const cy = size / 2;
  const gap = props.segments.length > 1 ? c * 0.012 : 0;
  let acc = 0;
  const circles = props.segments.map((segment, i) => {
    const start = acc;
    acc += segment.fraction;
    const dash = Math.max(segment.fraction * c - gap, 0.6);
    const off = -(start * c + gap / 2);
    const color = segment.gray ? '#cfd6df' : (segment.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]);
    const dim = props.activeKey && segment.key !== props.activeKey;
    return (
      <circle
        key={segment.key}
        className={`seg${dim ? ' seg-dim' : ''}`}
        data-key={segment.key}
        cx={cx} cy={cy} r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={`${dash} ${c}`}
        strokeDashoffset={off}
      >
        <title>{`${segment.label} ${segment.fraction >= 0 ? (segment.fraction * 100).toFixed(2) : '0.00'}%`}</title>
      </circle>
    );
  });
  return (
    <div className="donut-wrap">
      <svg
        className="donut-svg" viewBox={`0 0 ${size} ${size}`} width={size} height={size}
        onClick={(e) => {
          const target = (e.target as SVGElement).closest('.seg') as SVGElement | null;
          if (target && props.onSelect) props.onSelect(target.getAttribute('data-key') ?? '');
        }}
      >
        <g transform={`rotate(-90 ${cx} ${cy})`}>{circles}</g>
      </svg>
      <div className="donut-center">
        <div className="c-label">{props.centerLabel}</div>
        <div className="c-value num">{props.centerValue}</div>
        {props.centerSub ? <div className="c-sub num">{props.centerSub}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- 折线图 ---------------- */

export interface LineSeries {
  name: string;
  color: string;
  pts: number[];
  dash?: boolean;
}

export function LineChart(props: {
  dates: string[];
  series: LineSeries[];
  costLine?: { v: number; label: string } | null;
  markers?: { i: number; type: 'buy' | 'sell'; label: string }[];
  yFmt: (v: number) => string;
  height?: number;
}) {
  const W = 780;
  const H = props.height ?? 240;
  const pl = 52;
  const pr = 16;
  const pt = 14;
  const pb = 26;
  const all = props.series.flatMap((s) => s.pts);
  if (props.costLine) all.push(props.costLine.v);
  if (all.length === 0) return <div className="empty">暂无可绘制数据</div>;
  let min = Math.min(...all);
  let max = Math.max(...all);
  const span = max - min || 1;
  min -= span * 0.08;
  max += span * 0.08;
  const n = props.dates.length;
  const x = (i: number): number => pl + (W - pl - pr) * (n === 1 ? 0 : i / (n - 1));
  const y = (v: number): number => pt + (H - pt - pb) * (1 - (v - min) / (max - min));
  const shortDate = (d: string): string => d.slice(5).replace('-', '/');
  const grid = [0, 1, 2, 3].map((k) => {
    const v = min + (max - min) * (k / 3);
    return (
      <g key={k}>
        <line x1={pl} x2={W - pr} y1={y(v)} y2={y(v)} stroke="var(--border2)" />
        <text x={pl - 8} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--text3)">{props.yFmt(v)}</text>
      </g>
    );
  });
  const xLabels = [0, 1, 2, 3, 4].map((k) => {
    const i = Math.round((n - 1) * (k / 4));
    return <text key={k} x={x(i)} y={H - 7} textAnchor="middle" fontSize="10" fill="var(--text3)">{shortDate(props.dates[i])}</text>;
  });
  const paths = props.series.map((s) => (
    <polyline
      key={s.name}
      fill="none"
      stroke={s.color}
      strokeWidth={s.dash ? 1.6 : 2}
      strokeDasharray={s.dash ? '5 4' : undefined}
      points={s.pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
    />
  ));
  const cost = props.costLine ? (
    <g>
      <line x1={pl} x2={W - pr} y1={y(props.costLine.v)} y2={y(props.costLine.v)} stroke="var(--text3)" strokeDasharray="6 4" />
      <text x={W - pr - 4} y={y(props.costLine.v) - 5} textAnchor="end" fontSize="10" fill="var(--text3)">
        {`${props.costLine.label} ${props.yFmt(props.costLine.v)}`}
      </text>
    </g>
  ) : null;
  const markers = (props.markers ?? []).filter((m) => m.i >= 0 && m.i < n).map((marker, idx) => (
    <circle key={idx} cx={x(marker.i)} cy={y(props.series[0].pts[marker.i])} r={4.5}
      fill={marker.type === 'buy' ? '#e0343c' : '#0e9f6e'} stroke="#fff" strokeWidth={1.5}>
      <title>{marker.label}</title>
    </circle>
  ));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {grid}
      {paths}
      {cost}
      {markers}
      {xLabels}
    </svg>
  );
}

/* ---------------- 徽标 ---------------- */

export function PriceBadge(props: { type: string | null }) {
  if (!props.type) return null;
  const map: Record<string, [string, string]> = {
    REALTIME_PRICE: ['t-real', '实时'],
    CLOSE_PRICE: ['t-close', '收盘'],
    OFFICIAL_NAV: ['t-nav', '正式净值'],
    ESTIMATED_NAV: ['t-est', '估算'],
    IOPV: ['t-est', 'IOPV'],
    MANUAL_PRICE: ['t-manual', '手动'],
  };
  const [cls, label] = map[props.type] ?? ['t-close', props.type];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function LevelBadge(props: { level: string }) {
  const map: Record<string, string> = {
    优先研究: 'l-a', 持续观察: 'l-b', 中性观察: 'l-c', 暂缓新增关注: 'l-d', 数据不足: 'l-x',
  };
  return <span className={`badge ${map[props.level] ?? 'l-x'}`}>{props.level}</span>;
}

/* ---------------- 分段控件 ---------------- */

export function Seg(props: {
  options: { key: string; label: string; disabled?: boolean }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="seg">
      {props.options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={option.key === props.value ? 'active' : ''}
          disabled={option.disabled}
          onClick={() => !option.disabled && props.onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- 弹窗 ---------------- */

export function Modal(props: {
  title: string;
  desc?: string;
  width?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div
      className="modal-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="modal" style={props.width ? { width: props.width } : undefined}>
        <h3>{props.title}</h3>
        {props.desc ? <div className="m-desc">{props.desc}</div> : null}
        {props.children}
      </div>
    </div>
  );
}

/* ---------------- toast ---------------- */

export function useToast(): [string | null, (msg: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const show = (msg: string): void => {
    setMessage(msg);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(null), 2400);
  };
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  const node = message ? <div className="toast show">{message}</div> : null;
  return [node, show];
}

/* ---------------- 其他 ---------------- */

export function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{props.label}</label>
      {props.children}
    </div>
  );
}

export function shortDate(date: string): string {
  return date.slice(5).replace('-', '/');
}

export function pctText(fraction: number | null | undefined, digits = 2): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function signedPctText(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`;
}

export function signedNumText(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${fmt(value, digits)}`;
}
