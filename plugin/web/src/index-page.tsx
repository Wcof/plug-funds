/**
 * 指数估值一览（复刻参考页 https://www.touzid.com/indice/#/6 的结构、样式与交互）。
 *
 * 数据契约：走 RPC `get_index_valuation` / `get_index_analytics`，全部来自本机
 * valuation_metrics / market_points。不硬编码任何第三方行情数值；缺数据一律显示「—」。
 *
 * 二级菜单：参考页共 16 项。能靠本机数据算出来的（阶段收益、波动率、新高新低、RPS、
 * 相关性、定投、格雷厄姆、股债模型、ETF 列表、指标自定义、图形对比）都做成真实视图；
 * 换手率 / 两融 / 互联互通这类需要外部数据源的，显式标注「数据源未覆盖」并说明缺什么，
 * 不用假数据占位。
 *
 * 结构预览：仅在无真实 INDEX 标的时启用，只展示参考页公开可见的指数代码 / 名称，
 * 所有数值列为「—」，并在顶部醒目标注，避免把结构示例误认为真实行情。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rpc, type IndexAnalytics } from './api.ts';
import { Modal } from './ui.tsx';
import {
  CompareView, CorrelationView, DcaView, EtfView, GrahamView, HighLowView,
  MetricsView, ReturnsView, RpsView, UnavailableView, VolatilityView,
} from './index-views.tsx';
import './index-page.css';

/* ---------------- 数据契约 ---------------- */

interface MetricStats {
  current: number | null; percentile: number | null; avg: number | null;
  asOfDate: string | null; provider: string | null;
  percentileStatus: { state: 'VALID' | 'MISSING' | 'STALE' | 'CONFLICT' | 'SUSPECT'; reason: string | null };
  min: number | null; p20: number | null; p50: number | null; p80: number | null;
  max: number | null; samples: number;
}
interface IndexRow {
  id: string; code: string; name: string; tag: string; market: string;
  publishDate: string | null; close: number | null; ytdReturn: number | null;
  priceDate: string | null; priceType: string | null; priceQuality: string | null;
  fundOn: number | null; fundOff: number | null;
  pe: MetricStats; pb: MetricStats; ps: MetricStats;
  roe: [number | null, number | null, number | null];
  dividendYield: number | null; dividendAsOfDate: string | null; dividendProvider: string | null;
  marketValue: number | null; quality: string;
}
interface IndexResult {
  rows: IndexRow[]; count: number; note: string;
  caliber: { market: string; category: string; stat: string; years: number };
}
/** bootstrap_indices：建常用指数标的 + 立刻对它们拉一次真实行情（两步一次调用）。 */
interface BootstrapResult {
  seeded: { created: string[]; existing: string[]; total: number; note: string };
  refresh: { total: number; ok: number; failed: number; problems: { code: string; name: string; error: string }[] };
  note: string;
}
type DisplayRow = IndexRow & { preview?: boolean };

/* ---------------- 参考页列定义（bundle field[0] / field[1]） ---------------- */

const STAT_KEYS = ['current', 'percentile', 'avg', 'min', 'p20', 'p50', 'p80', 'max'] as const;
const STAT_LABELS = ['当前值', '分位点', '历史均值', '最小值', '20%值', '50%值', '80%值', '最大值'];
const METRIC_GROUPS = [
  { key: 'pe', title: 'PE-TTM' },
  { key: 'pb', title: 'PB' },
  { key: 'ps', title: 'PS' },
] as const;
const ROE_LABELS = ['前3年', '前2年', '前1年'];

/** 二级菜单：参考页两行共 16 项，这里的 key 决定渲染哪个视图。 */
type SubKey =
  | 'list' | 'columns' | 'etf' | 'metrics' | 'returns' | 'northbound' | 'margin'
  | 'correlation' | 'rps' | 'volatility' | 'high' | 'low' | 'compare'
  | 'dca' | 'graham' | 'erp';

const SUBVIEWS: { key: SubKey; label: string }[] = [
  { key: 'list', label: '指数列表' },
  { key: 'columns', label: '指数指标自定义' },
  { key: 'etf', label: 'ETF列表' },
  { key: 'metrics', label: '财务指标对比' },
  { key: 'returns', label: '历史涨跌幅' },
  { key: 'northbound', label: '互联互通市场' },
  { key: 'margin', label: '融资融券余额' },
  { key: 'correlation', label: '指数相关性' },
  { key: 'rps', label: 'RPS&换手榜单' },
  { key: 'volatility', label: '波动率' },
  { key: 'high', label: '正在新高' },
  { key: 'low', label: '正在新低' },
  { key: 'compare', label: '图形对比' },
  { key: 'dca', label: '指数定投策略' },
  { key: 'graham', label: '指数-格雷厄姆指数' },
  { key: 'erp', label: '指数-股债收益率模型' },
];

const MARKETS = ['全部', '国证', '深证', '上证', '中证', '投数网', '港股指数', '美股指数', '我的关注'];
const CATEGORIES = ['全部', '综合', '宽基', '行业', '主题', '策略'];
const STATS = ['加权平均值', '等权平均值', '算数平均值', '中位数'];
const YEARS: { label: string; value: number }[] = [
  { label: '所有', value: 0 }, { label: '20年', value: 20 }, { label: '10年', value: 10 },
  { label: '5年', value: 5 }, { label: '3年', value: 3 },
];

/** 指标定义：来自参考页「定义」弹窗的公开说明文本。 */
const HELP = [
  { name: 'PE-TTM', desc: '滚动市盈率：当前市值 / 过去 12 个月净利润。PE-TTM(扣非) 使用扣非净利润；PE-TTM(非扣非) 使用归属于母公司的净利润。' },
  { name: '当前值', desc: '当前指标的最新值。' },
  { name: '分位点', desc: '当前值在所选历史区间取样点中的百分位；样本数不足 20 或跨度不足 180 天时不产生数值。估值策略使用近 3 年窗口。' },
  { name: 'PB', desc: '市净率：当前市值 / 净资产。PB(不含商誉) 扣除商誉；PB(含商誉) 使用归属于母公司的净资产。' },
  { name: 'PS-TTM', desc: '滚动市销率：当前市值 / 过去 12 个月主营业务收入。' },
  { name: 'ROE 年度观测', desc: '按估值日期取前 3、2、1 个自然年各年的最后一次观测；缺年留空。现有来源没有财报年度字段，不能将观测年份当作财报年度，也不能确认扣非口径。' },
];

/** 结构预览：仅公开指数标识，无任何行情数值；真实数据接入后不显示。 */
const PREVIEW_NAMES: { code: string; name: string }[] = [
  { code: 'HSHYLV', name: '恒生港股通高股息低波动指数' },
  { code: 'HSMSI', name: '恒生综合中型股指数' },
  { code: 'HSSCNE', name: '恒生港股通新经济指数' },
  { code: 'HSHDYI', name: '恒生高股息率指数' },
  { code: 'HSAHP', name: '恒生沪深港AH股溢价指数' },
  { code: 'HSMP', name: '恒生综合中型股指数' },
  { code: 'HSCAT', name: '恒生A股行业龙头指数' },
  { code: 'HSMCHYI', name: '恒生中国内地企业高股息率指数' },
  { code: 'HSSI', name: '恒生综合小型股指数' },
  { code: 'HSCSCEI', name: '恒生港股通中国央企红利指数' },
  { code: 'HSCOY', name: '恒生中国企业指数' },
  { code: 'HSSCHKY', name: '恒生港股通高股息率指数' },
];

/* ---------------- 工具 ---------------- */

const EMPTY_STATS: MetricStats = {
  current: null, percentile: null, avg: null, min: null,
  asOfDate: null, provider: null,
  percentileStatus: { state: 'MISSING', reason: '结构预览，没有本机估值数据' },
  p20: null, p50: null, p80: null, max: null, samples: 0,
};

function previewRow(item: { code: string; name: string }): DisplayRow {
  return {
    id: `preview-${item.code}`, code: item.code, name: item.name, tag: '', market: '港股指数',
    publishDate: null, close: null, ytdReturn: null, fundOn: null, fundOff: null,
    priceDate: null, priceType: null, priceQuality: null,
    pe: EMPTY_STATS, pb: EMPTY_STATS, ps: EMPTY_STATS,
    dividendAsOfDate: null, dividendProvider: null,
    roe: [null, null, null], dividendYield: null, marketValue: null,
    quality: 'INSUFFICIENT', preview: true,
  };
}

function num(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
}
function pct(v: number | null, digits = 2): string {
  return v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`;
}
function priceDescription(row: DisplayRow): string {
  const type = ({ REALTIME_PRICE: '实时报价', CLOSE_PRICE: '收盘价', MANUAL_PRICE: '手工价格', OFFICIAL_NAV: '正式净值' } as Record<string, string>)[row.priceType ?? ''] ?? '类型待核实';
  const quality = ({ CONFLICT: '来源冲突', STALE: '已过期', DELAYED: '延迟', MANUAL: '手工录入' } as Record<string, string>)[row.priceQuality ?? ''];
  return [type, row.priceDate, quality].filter(Boolean).join(' · ');
}
/** 红涨绿跌（A 股口径）；分位点 >=80 高位红、<=20 低位绿。 */
function toneClass(v: number | null, kind: 'change' | 'temp'): string {
  if (v === null || !Number.isFinite(v)) return 'idx-na';
  if (kind === 'change') return v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  return v >= 80 ? 'up' : v <= 20 ? 'down' : '';
}
function valueAt(row: DisplayRow, key: string): number | string {
  if (key === 'code' || key === 'name' || key === 'publishDate') return (row[key] as string | null) ?? '';
  if (key === 'close' || key === 'ytdReturn' || key === 'dividendYield' || key === 'marketValue') {
    return (row[key] as number | null) ?? Number.NEGATIVE_INFINITY;
  }
  const [group, part] = key.split('.');
  if (group === 'pe' || group === 'pb' || group === 'ps') {
    const stats = row[group] as MetricStats;
    return (stats[part as keyof MetricStats] as number | null) ?? Number.NEGATIVE_INFINITY;
  }
  if (group === 'roe') return row.roe[Number(part)] ?? Number.NEGATIVE_INFINITY;
  return 0;
}

function downloadCsv(filename: string, lines: string[][]): void {
  const csv = `\ufeff${lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 组件 ---------------- */

export function IndexPage(props: {
  onToast: (msg: string) => void;
  onOpenInstDetail?: (instrumentId: string) => void;
}) {
  const [sub, setSub] = useState<SubKey>('list');
  const [market, setMarket] = useState('港股指数');
  const [category, setCategory] = useState('全部');
  const [stat, setStat] = useState('加权平均值');
  const [years, setYears] = useState(10);
  const [preview, setPreview] = useState(true);
  const [result, setResult] = useState<IndexResult | null>(null);
  const [analytics, setAnalytics] = useState<IndexAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'seed' | 'refresh'>('');
  const [selected, setSelected] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(false);
  // 指标列自定义：默认全开，保持与参考页一致的 36 列密度。
  const [groupKeys, setGroupKeys] = useState<string[]>(METRIC_GROUPS.map((g) => g.key));
  const [showRoe, setShowRoe] = useState(true);
  // 行分页：目录导入后单表可达 500+ 行，全量渲染（36 列 × N 行）会让页面明显卡顿。
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);

  // onToast 在父组件每次渲染都是新函数，用 ref 固定，避免 load / useEffect 反复触发。
  const toastRef = useRef(props.onToast);
  toastRef.current = props.onToast;
  /** 首屏自动引导（建标的 + 拉行情）是否已尝试过；失败也不自动重试，避免网络差时反复请求。 */
  const bootstrappedRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setResult(await rpc<IndexResult>('get_index_valuation', { market, category, stat, years }));
    } catch (error) {
      toastRef.current(`指数数据加载失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [market, category, stat, years]);
  useEffect(() => { void load(); }, [load]);

  /** 二级视图共用一个分析结果；只在第一次进入非列表视图时拉取。 */
  const loadAnalytics = useCallback(async () => {
    try {
      setAnalytics(await rpc<IndexAnalytics>('get_index_analytics'));
    } catch (error) {
      toastRef.current(`指数分析加载失败：${(error as Error).message}`);
    }
  }, []);
  useEffect(() => {
    if (sub === 'list' || sub === 'columns' || analytics !== null) return;
    void loadAnalytics();
  }, [sub, analytics, loadAnalytics]);

  const realRows = useMemo(() => result?.rows ?? [], [result]);
  const displayRows = useMemo<DisplayRow[]>(() => {
    const base: DisplayRow[] = realRows.length > 0 ? realRows : (preview ? PREVIEW_NAMES.map(previewRow) : []);
    const filtered = realRows.length === 0 ? base : base.filter((row) => {
      // 本机 instruments.market 只有 SH / SZ / OTC，参考页的系列维度无法一一对应；
      // 默认「港股指数」不过滤真实行，其余按有限映射过滤，口径以服务端返回为准。
      const marketOk = market === '全部' || market === '港股指数' || market === '美股指数'
        || market === '投数网' || market === '我的关注'
        || row.market === market
        || (market === '深证' && row.market === 'SZ')
        || (market === '上证' && row.market === 'SH');
      const categoryOk = category === '全部' || row.tag.includes(category);
      return marketOk && categoryOk;
    });
    if (!sortKey) return filtered;
    return [...filtered].sort((a, b) => {
      const av = valueAt(a, sortKey); const bv = valueAt(b, sortKey);
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av).localeCompare(String(bv), 'zh-CN')
        : (av as number) - (bv as number);
      return sortAsc ? cmp : -cmp;
    });
  }, [realRows, preview, market, category, sortKey, sortAsc]);

  const visibleGroups = METRIC_GROUPS.filter((g) => groupKeys.includes(g.key));

  const totalPages = Math.max(1, Math.ceil(displayRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => displayRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [displayRows, currentPage, pageSize],
  );
  // 筛选 / 排序 / 每页条数变化后回到第一页，避免停在空白页
  useEffect(() => { setPage(1); }, [market, category, sortKey, sortAsc, pageSize]);

  const toggleSort = (key: string): void => {
    if (sortKey === key) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(false); }
  };
  const sortMark = (key: string): string => (sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : '');

  /** 排序触发器放在 th 内部（不能在 th 中再嵌套 th）。 */
  const sortLabel = (key: string, label: string): React.ReactNode => (
    <span className="idx-sortable" onClick={(e) => { e.stopPropagation(); toggleSort(key); }} title={`按${label}排序`}>
      {label}{sortMark(key)}
    </span>
  );

  /**
   * 一键可用：建常用指数标的 + 立刻拉一次真实行情。
   *
   * 只建标的会留下满屏「—」（指数页看起来「没有数据」），所以这里把两步合并。
   * auto=true 时由首次进入的自动引导触发，同一挂载周期只跑一次，失败后不自动重试。
   */
  const bootstrap = useCallback(async (auto: boolean): Promise<void> => {
    if (auto && bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    setBusy('seed');
    try {
      const result = await rpc<BootstrapResult>('bootstrap_indices');
      const { seeded, refresh } = result;
      const parts = [`新建 ${seeded.created.length} 个常用指数`];
      parts.push(refresh.total === 0 ? '暂无可刷新的标的' : `行情 ${refresh.ok}/${refresh.total} 成功`);
      const firstProblem = refresh.problems[0];
      if (firstProblem) parts.push(`首个失败：${firstProblem.name}（${firstProblem.error}）`);
      toastRef.current(`${auto ? '指数页首次使用，已自动' : ''}${parts.join('，')}`);
      await load();
      setAnalytics(null);
    } catch (error) {
      toastRef.current(`导入常用指数失败：${(error as Error).message}`);
    } finally {
      setBusy('');
    }
  }, [load]);

  /** 空表 / 有标的但一个价格都没有 → 自动引导一次，让用户打开页面就能看到真实数值。 */
  useEffect(() => {
    if (loading || result === null) return;
    const noData = result.rows.length === 0 || result.rows.every((row) => row.close === null);
    if (!noData) return;
    void bootstrap(true);
  }, [loading, result, bootstrap]);

  const refreshData = async (): Promise<void> => {
    setBusy('refresh');
    try {
      const result = await rpc<{ results: { ok: boolean; name: string; conflict: unknown; error: string | null }[] }>('refresh_market_data');
      const ok = result.results.filter((r) => r.ok).length;
      const conflicts = result.results.filter((r) => r.conflict !== null).length;
      toastRef.current(`刷新完成：${ok}/${result.results.length} 成功${conflicts > 0 ? ` · ${conflicts} 个多源分歧（已标 CONFLICT）` : ''}`);
      await load();
      setAnalytics(null);
    } catch (error) {
      toastRef.current(`刷新失败：${(error as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  /** 底部只放首句概要，完整口径说明由「定义」弹窗承载，避免长文本挤成密集小字块。 */
  const briefNote = (() => {
    const note = result?.note ?? '';
    const first = note.split('。')[0];
    return first ? `${first}。` : note;
  })();

  const exportRows = (): void => {
    const header = [
      '代码', '指数名称', '发布时间', '最新点位', '价格日期', '价格类型', '价格质量', '今年收益率(%)', '场内|场外',
      ...visibleGroups.flatMap((g) => [...STAT_LABELS.map((l) => `${g.title}-${l}`), `${g.title}-日期`, `${g.title}-来源`, `${g.title}-分位状态`, `${g.title}-分位说明`]),
      ...(showRoe ? ROE_LABELS.map((l) => `ROE-${l}`) : []), '股息率(%)', '市值',
    ];
    const lines = [header, ...displayRows.map((row) => [
      row.code, row.name, row.publishDate ?? '', num(row.close), row.priceDate ?? '', row.priceType ?? '', row.priceQuality ?? '', num(row.ytdReturn),
      row.fundOn === null || row.fundOff === null ? '' : `${row.fundOn}|${row.fundOff}`,
      ...visibleGroups.flatMap((g) => [...STAT_KEYS.map((k) => {
        const v = (row[g.key] as MetricStats)[k];
        return k === 'percentile' ? pct(v) : num(v);
      }), row[g.key].asOfDate ?? '', row[g.key].provider ?? '', row[g.key].percentileStatus.state, row[g.key].percentileStatus.reason ?? '']),
      ...(showRoe ? row.roe.map((v) => pct(v)) : []), pct(row.dividendYield), num(row.marketValue),
    ])];
    const yearLabel = YEARS.find((y) => y.value === years)?.label ?? `${years}年`;
    downloadCsv(`指数列表-${stat}-${yearLabel}.csv`, lines);
    props.onToast('已导出当前视图，包含价格类型、估值来源、日期及分位状态说明；缺失值保留「—」');
  };

  const toggleFollow = (id: string, e: React.MouseEvent): void => {
    e.stopPropagation();
    setFollowed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    props.onToast(followed.has(id) ? '已取消关注（仅本页视图，未持久化）' : '已加入关注（仅本页视图，未持久化）');
  };

  const openName = (row: DisplayRow, e: React.MouseEvent): void => {
    e.stopPropagation();
    if (row.preview || !props.onOpenInstDetail) {
      props.onToast('结构预览行没有对应标的；接入指数数据后可打开标的详情');
      return;
    }
    props.onOpenInstDetail(row.id);
  };

  const isListLike = sub === 'list' || sub === 'columns';
  const activeLabel = SUBVIEWS.find((v) => v.key === sub)?.label ?? '指数列表';

  const renderView = (): React.ReactNode => {
    switch (sub) {
      case 'etf': return <EtfView data={analytics} onOpenInstDetail={props.onOpenInstDetail} />;
      case 'metrics': return <MetricsView data={analytics} />;
      case 'returns': return <ReturnsView data={analytics} />;
      case 'correlation': return <CorrelationView data={analytics} />;
      case 'rps': return <RpsView data={analytics} />;
      case 'volatility': return <VolatilityView data={analytics} />;
      case 'high': return <HighLowView data={analytics} mode="high" />;
      case 'low': return <HighLowView data={analytics} mode="low" />;
      case 'compare': return <CompareView data={analytics} />;
      case 'dca': return <DcaView data={analytics} />;
      case 'graham': return <GrahamView data={analytics} mode="graham" />;
      case 'erp': return <GrahamView data={analytics} mode="erp" />;
      case 'northbound':
        return (
          <UnavailableView
            title="互联互通市场：数据源未覆盖"
            reason="北向 / 南向资金流向需要交易所披露的每日额度与成交数据，本机现有的腾讯 / 东财行情接口不返回这类字段。"
            needs={['接入沪深港通每日资金流向接口（需授权）', '或手工按日录入净买入额（当前无此录入表单）']}
          />
        );
      case 'margin':
        return (
          <UnavailableView
            title="融资融券余额：数据源未覆盖"
            reason="两融余额与转融通数据来自交易所专项披露，本机行情接口不含该字段；填 0 会误导为「无杠杆」。"
            needs={['接入交易所融资融券汇总接口', '或手工按日录入两融余额']}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="idx-page">
      <header className="page-head">
        <div>
          <h1>指数</h1>
          <div className="update-line">
            A股 / 港股 / 美股指数估值一览 · 参考页 #/6（香港指数）结构复刻
            {isListLike ? null : <span className="badge t-real">视图：{activeLabel}</span>}
          </div>
        </div>
        <div className="head-actions">
          <div className="quick-row">
            {isListLike ? (
              <button className="btn btn-sm" onClick={() => setPreview((v) => !v)}>
                {preview ? '关闭结构预览' : '开启结构预览'}
              </button>
            ) : null}
            <button className="btn btn-sm" onClick={() => { void load(); if (!isListLike) { setAnalytics(null); void loadAnalytics(); } }}>刷新</button>
          </div>
        </div>
      </header>

      {/* 二级导航：16 项全部可切换；算不出来的显式说明缺什么 */}
      <nav className="idx-submenu">
        {SUBVIEWS.map((item) => (
          <button key={item.key} type="button"
            className={`idx-subitem${sub === item.key ? ' active' : ''}`}
            onClick={() => setSub(item.key)}>
            {item.label}
          </button>
        ))}
      </nav>

      {isListLike ? (
        <>
          {/* 筛选工具条：4 组单选 + 历史数据说明 + 导出 + 定义 */}
          <div className="idx-toolbar">
            <span className="idx-history" title="如需估值历史截面数据，请在筛选中心自定义范围与取数日期">历史数据 ⓘ</span>
            <div className="idx-radios">
              {MARKETS.map((m) => (
                <button key={m} type="button" className={market === m ? 'active' : ''} onClick={() => setMarket(m)}>{m}</button>
              ))}
            </div>
            <div className="idx-radios idx-radios-sub">
              {CATEGORIES.map((c) => (
                <button key={c} type="button" className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>
              ))}
            </div>
            <div className="idx-radios">
              {STATS.map((s) => (
                <button key={s} type="button" className={stat === s ? 'active' : ''} onClick={() => setStat(s)} title="成分股聚合口径；本项目数据源不含成分股，仅作口径标注">
                  {s} ⓘ
                </button>
              ))}
            </div>
            <div className="idx-radios">
              {YEARS.map((y) => (
                <button key={y.label} type="button" className={years === y.value ? 'active' : ''} onClick={() => setYears(y.value)}>{y.label}</button>
              ))}
            </div>
            <div className="idx-actions">
              {realRows.length === 0 || realRows.every((row) => row.close === null) ? (
                <button className="btn btn-sm btn-primary" disabled={busy !== ''} onClick={() => void bootstrap(false)}>
                  {busy === 'seed' ? '导入并拉取中…' : '导入常用指数并拉取行情'}
                </button>
              ) : null}
              <button className="btn btn-sm" disabled={busy !== ''} onClick={refreshData}>
                {busy === 'refresh' ? '刷新中…' : '刷新数据'}
              </button>
              <button className="btn btn-sm" onClick={exportRows}>导出</button>
              <button className="btn btn-sm idx-help-btn" onClick={() => setHelpOpen(true)}>定义</button>
            </div>
          </div>

          {/* 指标列自定义：默认全开，取消勾选即时生效（导出同步跟随） */}
          {sub === 'columns' ? (
            <div className="idx-colpick">
              <span className="idx-colpick-label">显示指标组</span>
              {METRIC_GROUPS.map((g) => (
                <label key={g.key} className="idx-colpick-item">
                  <input type="checkbox" checked={groupKeys.includes(g.key)}
                    onChange={(e) => setGroupKeys((prev) => (e.target.checked ? [...prev, g.key] : prev.filter((k) => k !== g.key)))} />
                  {g.title}
                </label>
              ))}
              <label className="idx-colpick-item">
                <input type="checkbox" checked={showRoe} onChange={(e) => setShowRoe(e.target.checked)} />
                ROE
              </label>
              <span className="idx-colpick-hint">
                当前 {visibleGroups.length * 8 + (showRoe ? 3 : 0) + 8} 列；自定义只影响展示与导出，不改变数据口径。
              </span>
            </div>
          ) : null}

          {/* 诚实边界提示：区分「没有标的」「有标的但没行情」「有真实数据」三种状态 */}
          <div className="idx-notice">
            <b>{realRows.length === 0 ? '结构预览' : realRows.some((row) => row.close !== null) ? '本机数据' : '待拉取行情'}</b>
            <span>{realRows.length > 0 && realRows.some((row) => row.close !== null)
              ? `已载入 ${realRows.length} 个 INDEX 标的，数值来自本机 valuation_metrics / market_points。`
              : realRows.length > 0
                ? `已建 ${realRows.length} 个 INDEX 标的，但还没有行情与估值：点「导入常用指数并拉取行情」或「刷新数据」从真实数据源取数。`
                : '本机还没有指数标的。打开本页会自动导入常用指数并拉取真实行情；下面是参考页的表格结构与交互，导入前数值列一律为「—」，不是真实行情。'}</span>
            <button className="link" onClick={() => setHelpOpen(true)}>查看口径</button>
          </div>

          {/* 数据就绪度：直接暴露「有多少行是真实的、有多少只是结构」 */}
          <div className="idx-ready">
            <span>真实数据 <b className="num">{realRows.length}</b> 行</span>
            <span>结构预览 <b className="num">{preview ? displayRows.length : 0}</b> 行</span>
            <span>PE 截面可用 <b className="num">{realRows.filter((r) => r.pe.current !== null).length}</b></span>
            <span>PE 分位可用 <b className="num">{realRows.filter((r) => r.pe.percentile !== null).length}</b></span>
            <div className="spacer" />
            <span className="idx-ready-note">「—」表示本机缺数据；分位要求样本 ≥20、跨度 ≥180 天。</span>
          </div>

          <div className="idx-table-wrap">
            <table className="idx-table">
              <thead>
                <tr className="idx-h1">
                  <th rowSpan={2} className="idx-fixed idx-f1">{sortLabel('code', '代码')}</th>
                  <th rowSpan={2} className="idx-fixed idx-f2">{sortLabel('name', `指数名称(${displayRows.length})`)}</th>
                  <th rowSpan={2}>{sortLabel('publishDate', '发布时间')}</th>
                  <th rowSpan={2}>{sortLabel('close', '最新点位')}</th>
                  <th rowSpan={2}>{sortLabel('ytdReturn', '今年收益率')}</th>
                  <th rowSpan={2}>场内|场外</th>
                  {visibleGroups.map((g) => <th key={g.key} colSpan={8} className="idx-group">{g.title}</th>)}
                  {showRoe ? <th colSpan={3} className="idx-group" title="按观测日期归年，不代表财报年度">ROE 年度观测</th> : null}
                  <th rowSpan={2}>{sortLabel('dividendYield', '股息率')}</th>
                  <th rowSpan={2}>{sortLabel('marketValue', '市值')}</th>
                  <th rowSpan={2}>关注</th>
                </tr>
                <tr className="idx-h2">
                  {visibleGroups.flatMap((g) => STAT_KEYS.map((k, i) => (
                    <th key={`${g.key}.${k}`}>{sortLabel(`${g.key}.${k}`, STAT_LABELS[i])}</th>
                  )))}
                  {showRoe ? ROE_LABELS.map((label, i) => <th key={`roe${i}`}>{sortLabel(`roe.${i}`, label)}</th>) : null}
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => (
                  <tr key={row.id} className={selected === row.id ? 'idx-selected' : ''} onClick={() => setSelected(row.id)}>
                    <td className="idx-fixed idx-f1 idx-code">{row.code}</td>
                    <td className="idx-fixed idx-f2 idx-name">
                      <button className="link" onClick={(e) => openName(row, e)}>{row.name}</button>
                    </td>
                    <td className="idx-na">{row.publishDate ?? '—'}</td>
                    <td className="num" title={row.close === null ? '暂无有效点位' : priceDescription(row)}>{num(row.close)}
                      {row.close !== null ? <div className="date-cell">{priceDescription(row)}</div> : null}
                    </td>
                    <td className={`num ${toneClass(row.ytdReturn, 'change')}`}>{pct(row.ytdReturn)}</td>
                    <td className="idx-na">{row.fundOn === null || row.fundOff === null ? '—' : `${row.fundOn}|${row.fundOff}`}</td>
                    {visibleGroups.flatMap((g) => STAT_KEYS.map((k) => {
                      const v = (row[g.key] as MetricStats)[k];
                      return (
                        <td key={`${g.key}.${k}`} className={`num ${k === 'percentile' ? toneClass(v, 'temp') : ''}`}
                          title={`估值日期：${row[g.key].asOfDate ?? '缺失'}；来源：${row[g.key].provider ?? '缺失'}；区间样本：${row[g.key].samples}；分位状态：${row[g.key].percentileStatus.state}${row[g.key].percentileStatus.reason ? `；${row[g.key].percentileStatus.reason}` : ''}`}>
                          {k === 'percentile' ? pct(v) : num(v)}
                        </td>
                      );
                    }))}
                    {showRoe ? row.roe.map((v, i) => <td key={`roe${i}`} className="num">{pct(v)}</td>) : null}
                    <td className="num" title={`股息率日期：${row.dividendAsOfDate ?? '缺失'}；来源：${row.dividendProvider === 'csindex-xls-calc-share' ? '中证 XLS（计算用股本）' : row.dividendProvider === 'csindex' ? '中证 JSON 快照' : row.dividendProvider ?? '缺失'}`}>{pct(row.dividendYield)}</td>
                    <td className="num">{num(row.marketValue)}</td>
                    <td>
                      <button type="button" className={`idx-star${followed.has(row.id) ? ' on' : ''}`}
                        onClick={(e) => toggleFollow(row.id, e)} title="关注（仅本页视图）">
                        {followed.has(row.id) ? '★' : '☆'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {displayRows.length === 0 ? (
              <div className="empty">
                当前筛选下没有指数标的。<br />
                点上方「导入常用指数并拉取行情」可一键建 8 个常用宽基指数并从真实数据源取数；<br />
                也可在「标的」里录入自己的 type=INDEX 指数。
              </div>
            ) : null}
            {loading ? <div className="idx-loading">读取本机指数数据…</div> : null}
          </div>

          <div className="idx-foot">
            <span>共 {displayRows.length} 行 · 口径：{stat} · 区间：{YEARS.find((y) => y.value === years)?.label}</span>
            {displayRows.length > pageSize ? (
              <span className="idx-pager">
                <button type="button" className="idx-page-btn" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
                <b className="num">{currentPage}</b> / {totalPages}
                <button type="button" className="idx-page-btn" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页</button>
                <select className="idx-page-size" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
                  {[50, 100, 200, 500].map((n) => <option key={n} value={n}>每页 {n}</option>)}
                </select>
              </span>
            ) : null}
            <span className="idx-foot-note">{briefNote}</span>
            <button type="button" className="idx-foot-more" onClick={() => setHelpOpen(true)}>完整口径 →</button>
          </div>
        </>
      ) : (
        <>
          <div className="idx-view-bar">
            <span className="ivb-title">{activeLabel}</span>
            {analytics ? (
              <>
                <span>指数 <b className="num">{analytics.coverage.indices}</b> 个</span>
                <span>有日线 <b className="num">{analytics.coverage.withHistory}</b></span>
                <span>有 PE <b className="num">{analytics.coverage.withValuation}</b></span>
                <span>ETF <b className="num">{analytics.coverage.etf}</b></span>
                <span className="ivb-window">{analytics.window.begin ?? '—'} → {analytics.window.end ?? '—'} · {analytics.window.tradingDays} 日</span>
              </>
            ) : <span>读取本机数据…</span>}
            <div className="spacer" />
            <button className="btn btn-sm" disabled={busy !== ''} onClick={refreshData}>
              {busy === 'refresh' ? '刷新中…' : '刷新数据'}
            </button>
          </div>
          {analytics === null ? <div className="idx-loading">计算中…</div> : renderView()}
          <div className="idx-view-note">{analytics?.note ?? ''}</div>
        </>
      )}

      {helpOpen ? (
        <Modal title="指标定义与数据口径" desc={result?.note ?? '数据来自本机 SQLite；缺数据显示「—」。'} width={620} onClose={() => setHelpOpen(false)}>
          <div className="idx-help-list">
            {HELP.map((h) => (
              <div key={h.name} className="idx-help-row"><b>{h.name}</b><span>{h.desc}</span></div>
            ))}
          </div>
          <div className="idx-help-note">
            复刻边界：参考页的「加权/等权/算数/中位数」为成分股聚合口径，本项目数据源不含成分股，
            该选择仅作口径标注；场内|场外基金数与指数总市值项目未存，恒为「—」。
            二级菜单中「互联互通市场」「融资融券余额」需要交易所专项数据，本机数据源不覆盖，已显式标注而不是填占位数值。
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
