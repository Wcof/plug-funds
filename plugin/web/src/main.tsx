/**
 * SPA 根：导航 + 弹窗编排（目标 / 修改分组 / 新增持仓 / 记一笔 / AI / PK）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { rpc, type AiAnalysis, type AiStatus, type CategoryRow, type CompareResult, type Goal, type Instrument } from './api.ts';
import { DashboardPage, HoldingsPage, InstDetailPage, PosDetailPage, SettingsPage, ValuationPage } from './pages.tsx';
import { IndexPage } from './index-page.tsx';
import { Field, LevelBadge, LineChart, Modal, useToast } from './ui.tsx';

type Page = 'dashboard' | 'holdings' | 'valuation' | 'index' | 'settings' | 'pos-detail' | 'inst-detail';

interface Nav {
  page: Page;
  positionId?: string;
  instrumentId?: string;
}

const NAV_ITEMS: { key: Page; label: string; icon: React.ReactNode }[] = [
  {
    key: 'dashboard', label: '总览',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    key: 'holdings', label: '持仓',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 12h18" />
      </svg>
    ),
  },
  {
    key: 'valuation', label: '估值',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'index', label: '指数',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17.5l5.5-6.5 4 3 5.5-8 3 4" /><path d="M3 21h18" />
      </svg>
    ),
  },
  {
    key: 'settings', label: '设置',
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="7" cy="17" r="2" />
      </svg>
    ),
  },
];

export function App() {
  const [nav, setNav] = useState<Nav>({ page: 'dashboard' });
  const [reloadKey, setReloadKey] = useState(0);
  const [toastNode, showToast] = useToast();

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /* 弹窗状态 */
  const [goalModal, setGoalModal] = useState<Goal | null | 'open'>(null);
  const [assignFor, setAssignFor] = useState<{ instrumentId: string; name: string } | null>(null);
  const [aiFor, setAiFor] = useState<string | null>(null);
  const [pkFor, setPkFor] = useState<string | null>(null);
  const [addPosOpen, setAddPosOpen] = useState(false);
  const [txnOpen, setTxnOpen] = useState(false);

  const go = (page: Page): void => {
    setNav({ page });
    document.querySelector('main')?.scrollTo(0, 0);
  };

  const navIdFor = (page: Page): string => ({ dashboard: 'dashboard', holdings: 'holdings', valuation: 'valuation', index: 'index', settings: 'settings' }[page] ?? 'holdings');

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-mark">投</div>
          <div>
            <div className="logo-name">投资工作站</div>
            <div className="logo-sub">本地优先 · DSH 插件</div>
          </div>
        </div>
        {NAV_ITEMS.map((item) => (
          <button key={item.key} className={`nav-item${navIdFor(nav.page) === item.key ? ' active' : ''}`} onClick={() => go(item.key)}>
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
        <div className="sidebar-foot">
          数据保存在本机 ~/.plug-funds/，不上传云端。<br />估值评分不构成投资建议。
        </div>
      </aside>
      <main>
        <div className="page">
          <PageBoundary pageKey={nav.page} onReset={() => go('dashboard')}>
            {nav.page === 'dashboard' ? (
              <DashboardPage
                reloadKey={reloadKey}
                onOpenPosDetail={(positionId) => setNav({ page: 'pos-detail', positionId })}
                onOpenInstDetail={(instrumentId) => setNav({ page: 'inst-detail', instrumentId })}
                onOpenGoalModal={(goal) => setGoalModal(goal ?? 'open')}
                onOpenAi={setAiFor}
                onOpenPk={setPkFor}
                onToast={showToast}
              />
            ) : null}
            {nav.page === 'holdings' ? (
              <HoldingsPage
                reloadKey={reloadKey}
                onOpenPosDetail={(positionId) => setNav({ page: 'pos-detail', positionId })}
                onOpenInstDetail={(instrumentId) => setNav({ page: 'inst-detail', instrumentId })}
                onOpenAi={setAiFor}
                onOpenPk={setPkFor}
                onOpenAssign={(instrumentId, name) => setAssignFor({ instrumentId, name })}
                onOpenAddPos={() => setAddPosOpen(true)}
                onOpenTxn={() => setTxnOpen(true)}
                onReload={reload}
                onToast={showToast}
              />
            ) : null}
            {nav.page === 'valuation' ? <ValuationPage reloadKey={reloadKey} instrumentId={null} onToast={showToast} /> : null}
            {nav.page === 'index' ? (
              <IndexPage
                onToast={showToast}
                onOpenInstDetail={(instrumentId) => setNav({ page: 'inst-detail', instrumentId })}
              />
            ) : null}
            {nav.page === 'settings' ? <SettingsPage reloadKey={reloadKey} onReload={reload} onToast={showToast} /> : null}
            {nav.page === 'pos-detail' && nav.positionId ? (
              <PosDetailPage
                positionId={nav.positionId}
                reloadKey={reloadKey}
                onBack={() => go('holdings')}
                onOpenInstDetail={(instrumentId) => setNav({ page: 'inst-detail', instrumentId })}
                onOpenAi={setAiFor}
                onOpenPk={setPkFor}
                onOpenAssign={(instrumentId, name) => setAssignFor({ instrumentId, name })}
                onToast={showToast}
                onReload={reload}
              />
            ) : null}
            {nav.page === 'inst-detail' && nav.instrumentId ? (
              <InstDetailPage
                instrumentId={nav.instrumentId}
                reloadKey={reloadKey}
                onBack={() => go('holdings')}
                onOpenPosDetail={(positionId) => setNav({ page: 'pos-detail', positionId })}
                onOpenAi={setAiFor}
                onToast={showToast}
              />
            ) : null}
          </PageBoundary>
        </div>
      </main>

      {goalModal !== null ? (
        <GoalModal
          goal={goalModal === 'open' ? null : goalModal}
          onClose={() => setGoalModal(null)}
          onSaved={() => { setGoalModal(null); reload(); showToast('目标已保存并即时生效'); }}
        />
      ) : null}
      {assignFor ? (
        <AssignModal
          instrumentId={assignFor.instrumentId}
          instrumentName={assignFor.name}
          onClose={() => setAssignFor(null)}
          onSaved={() => { setAssignFor(null); reload(); showToast('分组已更新'); }}
        />
      ) : null}
      {aiFor ? <AiModal positionId={aiFor} onClose={() => setAiFor(null)} onConfigure={() => { setAiFor(null); go('settings'); }} /> : null}
      {pkFor ? <PkModal instrumentId={pkFor} onClose={() => setPkFor(null)} /> : null}
      {addPosOpen ? (
        <AddPosModal
          onClose={() => setAddPosOpen(false)}
          onSaved={() => { setAddPosOpen(false); reload(); showToast('持仓已新增（已触发持仓重算）'); }}
        />
      ) : null}
      {txnOpen ? (
        <TxnModal
          onClose={() => setTxnOpen(false)}
          onSaved={() => { setTxnOpen(false); reload(); showToast('流水已记账（持仓已重算）'); }}
        />
      ) : null}

      {toastNode}
    </div>
  );
}

/* ---------------- 页面级错误边界 ---------------- */

/**
 * 任一页面在渲染期抛错时，React 18 会卸载整棵树 → 用户只看到一片空白，
 * 侧栏、返回入口全部消失，无法自救。这里把错误收敛到内容区并给出显式信息。
 * 切换页面时自动复位，避免一次崩溃永久卡住。
 */
class PageBoundary extends React.Component<
  { pageKey: string; onReset: () => void; children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidUpdate(previous: { pageKey: string }): void {
    if (previous.pageKey !== this.props.pageKey && this.state.error) this.setState({ error: null });
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page-error">
        <h1>页面渲染失败</h1>
        <div className="page-error-msg">{this.state.error.message || String(this.state.error)}</div>
        <div className="page-error-hint">数据仍保存在本机，本次只影响当前页面的显示。</div>
        <div className="page-error-actions">
          <button className="btn" onClick={() => this.setState({ error: null })}>重试</button>
          <button className="btn btn-primary" onClick={this.props.onReset}>返回总览</button>
        </div>
      </div>
    );
  }
}

/* ---------------- 目标设置弹窗 ---------------- */

function GoalModal(props: { goal: Goal | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(props.goal?.name ?? '我的投资资产目标');
  const [amount, setAmount] = useState(props.goal?.targetAmount ?? '1000000');
  const [enabled, setEnabled] = useState(props.goal?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="投资目标设置" desc="设置一个主投资资产目标，用于「目标达成」模式。目标只是资产规模进度，不是收益率，也不会改变交易流水、持仓成本或收益。" onClose={props.onClose}>
      <Field label="目标名称">
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="目标金额（CNY）">
        <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <div className="quick-amts">
          {['500000', '1000000', '2000000', '5000000'].map((v) => (
            <button key={v} type="button" onClick={() => setAmount(v)}>{Number(v) / 10000} 万</button>
          ))}
        </div>
        {error ? <div style={{ fontSize: 12, color: '#e0343c', marginTop: 5 }}>{error}</div> : null}
      </Field>
      <div className="m-range-note">统计范围（v1 固定）：账本内股票、ETF、场外基金市值。不含未记录的银行存款、房产等账外资产。</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label style={{ fontSize: 12.5, color: 'var(--text2)' }}>启用目标</label>
        <label style={{ cursor: 'pointer' }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          const amountNumber = Number(amount.replace(/,/g, ''));
          if (!Number.isFinite(amountNumber) || amountNumber <= 0) { setError('目标金额必须是大于 0 的数字'); return; }
          try {
            await rpc('save_portfolio_goal', { id: props.goal?.id, name, targetAmount: String(amountNumber), enabled });
            props.onSaved();
          } catch (e) { setError((e as Error).message); }
        }}>保存</button>
      </div>
    </Modal>
  );
}

/* ---------------- 修改分组弹窗 ---------------- */

function AssignModal(props: { instrumentId: string; instrumentName: string; onClose: () => void; onSaved: () => void }) {
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [links, setLinks] = useState<string[]>([]);
  useEffect(() => {
    void rpc<{ categories: CategoryRow[]; links: { instrumentId: string; categoryId: string }[] }>('list_categories')
      .then((categoryResult) => {
        setCategories(categoryResult.categories);
        setLinks(categoryResult.links.filter((l) => l.instrumentId === props.instrumentId).map((l) => l.categoryId));
      });
  }, [props.instrumentId]);

  return (
    <Modal title="修改分组" desc={`为 ${props.instrumentName} 选择所属分类（可多选；全部不选 = 未分类，非必填）。分类在「设置 → 分类管理」维护。`} onClose={props.onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 6 }}>
        {categories.map((category) => (
          <label key={category.id} className="assign-row">
            <input
              type="checkbox"
              checked={links.includes(category.id)}
              onChange={(e) => {
                setLinks((prev) => (e.target.checked ? [...prev, category.id] : prev.filter((id) => id !== category.id)));
              }}
            />
            <i style={{ width: 9, height: 9, borderRadius: 3, background: category.color, display: 'inline-block' }} />
            <span style={{ fontSize: 12.5 }}>{category.name}</span>
            <span style={{ flex: 1, textAlign: 'right', fontSize: 11, color: 'var(--text3)' }}>{category.count} 个资产</span>
          </label>
        ))}
        {categories.length === 0 ? <div className="empty">还没有分类，请在「设置 → 分类管理」先创建</div> : null}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          await rpc('set_instrument_categories', { instrumentId: props.instrumentId, categoryIds: links });
          props.onSaved();
        }}>保存</button>
      </div>
    </Modal>
  );
}

/* ---------------- AI 分析弹窗 ---------------- */

function AiModal(props: { positionId: string; onClose: () => void; onConfigure: () => void }) {
  const [state, setState] = useState<{ kind: 'loading' | 'confirm' } | { kind: 'error'; message: string; code?: string } | { kind: 'done'; result: AiAnalysis }>({ kind: 'loading' });
  const [settings, setSettings] = useState<AiStatus | null>(null);
  const generation = useRef(0);
  const pending = useRef(false);

  const analyze = useCallback(async (consent: boolean, current: number, consentToken?: string) => {
    if (pending.current) return;
    pending.current = true;
    setState({ kind: 'loading' });
    try {
      const result = await rpc<AiAnalysis>('analyze_holding_with_ai', { positionId: props.positionId, consent, consentToken });
      if (generation.current === current) setState({ kind: 'done', result });
    } catch (e) {
      if (generation.current === current) setState({ kind: 'error', message: (e as Error).message, code: (e as { code?: string }).code });
    } finally { if (generation.current === current) pending.current = false; }
  }, [props.positionId]);

  useEffect(() => {
    const current = ++generation.current;
    pending.current = false;
    setState({ kind: 'loading' });
    void rpc<AiStatus>('get_ai_settings').then((status) => {
      if (generation.current !== current) return;
      setSettings(status);
      if (!status.configured || !status.connectionTested) {
        setState({ kind: 'error', code: 'ai-not-tested', message: '请先保存 AI 配置并测试连接成功，再发起分析。' });
      } else if (status.consentRequired) setState({ kind: 'confirm' });
      else void analyze(false, current);
    }).catch((e) => {
      if (generation.current === current) setState({ kind: 'error', message: (e as Error).message });
    });
    return () => { generation.current += 1; };
  }, [analyze]);

  return (
    <Modal width={580} title={`AI 分析 · ${state.kind === 'done' ? `${state.result.name} ${state.result.code}` : '持仓'}`} onClose={props.onClose}>
      <div className="ai-head">
        {state.kind === 'done' ? <span className="ai-model-chip">模型：{state.result.model}</span> : null}
        {state.kind === 'done' ? <span className="badge t-nav">真实调用</span> : null}
        {settings && !settings.configured ? <span className="badge t-wait">未配置</span> : null}
      </div>
      {state.kind === 'loading' ? (
        <div className="ai-loading"><span className="spinner" />{pending.current ? '正在发送持仓摘要并等待 AI 分析…' : '正在检查 AI 配置与授权状态…'}</div>
      ) : null}
      {state.kind === 'confirm' && settings ? (
        <div>
          <p>首次使用前，请确认向 {settings.masked.baseUrl} 的 {settings.masked.model} 模型发送以下数据。</p>
          <p>{settings.scope}</p>
          <button className="btn btn-primary" onClick={() => void analyze(true, generation.current, settings.consentToken)}>确认发送并分析</button>
        </div>
      ) : null}
      {state.kind === 'error' ? (
        <div>
          <div className="empty" style={{ padding: '12px 0' }}>{state.message}</div>
          {['ai-not-configured', 'ai-not-tested'].includes(state.code ?? '') ? (
            <button className="btn btn-primary btn-sm" onClick={props.onConfigure}>前往 AI 配置</button>
          ) : null}
        </div>
      ) : null}
      {state.kind === 'done' ? (
        <div className="ai-block">
          {state.result.content.split('\n').filter((line) => line.trim() !== '').map((line, i) => {
            if (/^#{1,4}\s/.test(line)) return <h4 key={i}>{line.replace(/^#+\s/, '')}</h4>;
            if (/^[-*•]\s/.test(line)) return <li key={i}>{line.replace(/^[-*•]\s/, '')}</li>;
            if (/^\d+[.、]\s/.test(line)) return <li key={i}>{line.replace(/^\d+[.、]\s/, '')}</li>;
            return <p key={i}>{line}</p>;
          })}
          <div className="ai-note">以上内容由 AI 生成（{state.result.model}，真实调用记录 {state.result.recordId.slice(0, 8)}…），仅供研究参考，不构成投资建议或收益承诺。发送范围见「设置 → AI 配置」。</div>
        </div>
      ) : null}
    </Modal>
  );
}

/* ---------------- PK 弹窗 ---------------- */

function PkModal(props: { instrumentId: string; onClose: () => void }) {
  const [pool, setPool] = useState<Instrument[]>([]);
  const [aId, setAId] = useState<string | null>(props.instrumentId);
  const [bId, setBId] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([
      rpc<Instrument[]>('search_instruments', { keyword: '' }),
      rpc<{ instrument: Instrument }>('get_instrument_detail', { instrumentId: props.instrumentId }).then((d) => d.instrument),
    ]).then(([all, base]) => {
      const isStock = base.type === 'STOCK';
      const sameType = all.filter((instrument) => (instrument.type === 'STOCK') === isStock);
      setPool(sameType);
      setAId(base.id);
      setBId(sameType.find((instrument) => instrument.id !== base.id)?.id ?? null);
    });
  }, [props.instrumentId]);

  useEffect(() => {
    if (!aId || !bId || aId === bId) return;
    void rpc<CompareResult>('compare_instruments', { aInstrumentId: aId, bInstrumentId: bId, period: '1y' })
      .then((result) => { setResult(result); setError(null); })
      .catch((e) => setError((e as Error).message));
  }, [aId, bId]);

  return (
    <Modal width={780} title="标的 PK 对比" desc="仅支持同类型（基金 / ETF 或股票）两两对比" onClose={props.onClose}>
      <div className="pk-sel-row">
        <select value={aId ?? ''} onChange={(e) => setAId(e.target.value)}>
          {pool.map((instrument) => <option key={instrument.id} value={instrument.id}>{instrument.name} {instrument.code}</option>)}
        </select>
        <span className="pk-vs">PK</span>
        <select value={bId ?? ''} onChange={(e) => setBId(e.target.value)}>
          {pool.filter((instrument) => instrument.id !== aId).map((instrument) => <option key={instrument.id} value={instrument.id}>{instrument.name} {instrument.code}</option>)}
        </select>
      </div>
      {error ? <div className="empty">{error}</div> : null}
      {!result && !error ? <div className="empty">{aId && bId && aId !== bId ? '对比计算中…' : '同类标的不足 2 个，无法 PK（先持有两个同类型标的）'}</div> : null}
      {result ? (
        <>
          <div className="legend-line" style={{ marginBottom: 4 }}>
            <span className="ll"><i style={{ background: '#3d6ef2' }} />A：{result.a.name}（近 1 年累计涨幅）</span>
            <span className="ll"><i style={{ background: '#ee9d3f' }} />B：{result.b.name}</span>
          </div>
          <div className="chart-mount">
            <LineChart
              dates={result.a.series.map((p) => p.date)}
              series={[
                { name: 'A', color: '#3d6ef2', pts: normalize(result.a.series) },
                { name: 'B', color: '#ee9d3f', pts: normalize(result.b.series) },
              ]}
              yFmt={(v) => `${v.toFixed(0)}%`}
            />
          </div>
          <table style={{ marginTop: 10 }}>
            <thead><tr><th>对比维度</th><th style={{ textAlign: 'right' }}>A：{result.a.name}</th><th /><th style={{ textAlign: 'right' }}>B：{result.b.name}</th></tr></thead>
            <tbody>
              <PkRow label="近 1 年收益" a={result.a.periodReturn} b={result.b.periodReturn} format={(v) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(2)}%`} better="high" />
              <PkRow label="成立 / 上市日期" a={result.a.foundedDate ?? '—'} b={result.b.foundedDate ?? '—'} />
              <PkRow label="规模（基金份额 / 股票总市值）" a={result.a.scaleInfo ?? '—'} b={result.b.scaleInfo ?? '—'} />
              <PkRow label="PE" a={result.a.pe ?? '—'} b={result.b.pe ?? '—'} better="high" isNumber />
              <PkRow label="PB" a={result.a.pb ?? '—'} b={result.b.pb ?? '—'} better="low" isNumber />
              <PkRow label="股息率" a={result.a.dividendYield ?? '—'} b={result.b.dividendYield ?? '—'} better="high" isNumber />
              <PkRow label="ROE" a={result.a.roe ?? '—'} b={result.b.roe ?? '—'} better="high" isNumber />
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 8 }}>{result.note}</div>
        </>
      ) : null}
    </Modal>
  );
}

function normalize(series: { date: string; value: string }[]): number[] {
  const values = series.map((p) => Number(p.value));
  const first = values[0] ?? 1;
  return values.map((v) => (first > 0 ? (v / first - 1) * 100 : 0));
}

function PkRow(props: { label: string; a: string | number | null; b: string | number | null; format?: (v: number) => string; better?: 'high' | 'low'; isNumber?: boolean }) {
  const aIsNum = typeof props.a === 'number';
  const bIsNum = typeof props.b === 'number';
  const show = (v: string | number | null): string => {
    if (v === null || v === '—') return '—';
    if (typeof v === 'number') return props.format ? props.format(v) : String(v);
    return String(v);
  };
  let winA = '';
  let winB = '';
  if (props.better && aIsNum && bIsNum) {
    if (props.better === 'high') {
      if ((props.a as number) > (props.b as number)) winA = '▲';
      else if ((props.b as number) > (props.a as number)) winB = '▲';
    } else {
      if ((props.a as number) < (props.b as number)) winA = '▲';
      else if ((props.b as number) < (props.a as number)) winB = '▲';
    }
  }
  return (
    <tr>
      <td>{props.label}</td>
      <td className={`num${winA ? ' win' : ''}`}>{show(props.a)}{winA && <span className="win-mark">{winA}</span>}</td>
      <td />
      <td className={`num${winB ? ' win' : ''}`}>{show(props.b)}{winB && <span className="win-mark">{winB}</span>}</td>
    </tr>
  );
}

/* ---------------- 新增持仓弹窗 ---------------- */

function AddPosModal(props: { onClose: () => void; onSaved: () => void }) {
  const [type, setType] = useState('STOCK');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [qty, setQty] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().slice(0, 10));
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc<{ categories: CategoryRow[] }>('list_categories').then((result) => setCategories(result.categories));
    void rpc<{ id: string; name: string }[]>('list_accounts').then((accountList) => {
      setAccounts(accountList);
      if (accountList.length > 0) setAccountId(accountList[0].id);
    });
  }, []);

  const save = async (): Promise<void> => {
    if (!code.trim() || !name.trim() || !accountId || !qty || !unitCost) {
      setError('请填写代码、名称、账户、数量与成本');
      return;
    }
    try {
      const saved = await rpc<{ id: string }>('save_instrument', {
        code: code.trim(), name: name.trim(), type, market: type === 'STOCK' || type === 'ETF' ? (code.startsWith('6') || code.startsWith('5') ? 'SH' : 'SZ') : 'OTC',
      });
      await rpc('record_transaction', {
        accountId, instrumentId: saved.id, type: 'OPENING', tradeDate,
        quantity: qty, amount: unitCost,
        note: '新增持仓（期初建账）',
      });
      if (selected.length > 0) await rpc('set_instrument_categories', { instrumentId: saved.id, categoryIds: selected });
      props.onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title="新增持仓" desc="期初建账方式录入已有持仓；自定义分类为可选（默认不勾选、非必填）。">
      <Field label="资产类型">
        <div className="seg">
          {([['STOCK', '股票'], ['ETF', 'ETF'], ['OPEN_END_FUND', '场外基金']] as const).map(([key, label]) => (
            <button key={key} type="button" className={type === key ? 'active' : ''} onClick={() => setType(key)}>{label}</button>
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label="代码"><input type="text" value={code} placeholder="如 600036 / 007466" onChange={(e) => setCode(e.target.value)} /></Field>
        <Field label="名称"><input type="text" value={name} placeholder="标的名称" onChange={(e) => setName(e.target.value)} /></Field>
      </div>
      <Field label="账户">
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          {accounts.length === 0 ? <option value="">（请先在设置中创建账户）</option> : null}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="期初数量"><input type="text" value={qty} placeholder="如 400 / 18517.06" onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="期初总成本（¥）"><input type="text" value={unitCost} placeholder="如 11550.00" onChange={(e) => setUnitCost(e.target.value)} /></Field>
      </div>
      <Field label="自定义分类（可选，非必填）">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {categories.map((category) => (
            <button
              key={category.id}
              type="button"
              className={`vchip${selected.includes(category.id) ? ' active' : ''}`}
              onClick={() => setSelected((prev) => (prev.includes(category.id) ? prev.filter((id) => id !== category.id) : [...prev, category.id]))}
            >
              {category.name}
            </button>
          ))}
          {categories.length === 0 ? <span style={{ fontSize: 11.5, color: 'var(--text3)' }}>暂无分类（设置 → 分类管理 创建）</span> : null}
        </div>
      </Field>
      {error ? <div style={{ fontSize: 12, color: '#e0343c' }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => void save()}>保存</button>
      </div>
    </Modal>
  );
}

/* ---------------- 记一笔弹窗 ---------------- */

function TxnModal(props: { onClose: () => void; onSaved: () => void }) {
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [accountId, setAccountId] = useState('');
  const [instrumentId, setInstrumentId] = useState('');
  const [type, setType] = useState('BUY');
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().slice(0, 10));
  const [qty, setQty] = useState('');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [tax, setTax] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    void Promise.all([
      rpc<{ id: string; name: string }[]>('list_accounts'),
      rpc<Instrument[]>('list_positions').then((holdings) => rpc<Instrument[]>('search_instruments', { keyword: '' }).catch(() => [] as Instrument[])),
    ]).then(([accountList, instrumentList]) => {
      setAccounts(accountList);
      setInstruments(Array.isArray(instrumentList) ? instrumentList : []);
      if (accountList.length > 0) setAccountId(accountList[0].id);
      if (Array.isArray(instrumentList) && instrumentList.length > 0) setInstrumentId(instrumentList[0].id);
    });
  }, []);

  return (
    <Modal title="记一笔" desc="交易流水是持仓与成本的事实源；保存后自动重算该标的持仓。基金申购待确认份额不改变持仓。">
      <div className="form-grid">
        <Field label="账户">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label="标的">
          <select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
            {instruments.map((i) => <option key={i.id} value={i.id}>{i.name} {i.code}</option>)}
            {instruments.length === 0 ? <option value="">（先新增持仓或标的）</option> : null}
          </select>
        </Field>
      </div>
      <Field label="交易类型">
        <div className="seg">
          {([['BUY', '买入'], ['SELL', '卖出'], ['DIVIDEND_CASH', '现金分红'], ['DIVIDEND_REINVEST', '红利再投'], ['OPENING', '期初'], ['SPLIT', '拆分'], ['CORRECTION', '修正']] as const).map(([key, label]) => (
            <button key={key} type="button" className={type === key ? 'active' : ''} onClick={() => setType(key)}>{label}</button>
          ))}
        </div>
      </Field>
      <div className="form-grid">
        <Field label="交易日"><input type="text" value={tradeDate} placeholder="YYYY-MM-DD" onChange={(e) => setTradeDate(e.target.value)} /></Field>
        <Field label="数量 / 系数"><input type="text" value={qty} placeholder="如 100 / 1.5" onChange={(e) => setQty(e.target.value)} /></Field>
      </div>
      <div className="form-grid">
        <Field label="价格 / 单价"><input type="text" value={price} placeholder="如 41.25" onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="金额（分红 / 期初成本 / 修正成本）"><input type="text" value={amount} placeholder="如 325.60" onChange={(e) => setAmount(e.target.value)} /></Field>
      </div>
      <div className="form-grid">
        <Field label="手续费"><input type="text" value={fee} placeholder="如 5.00" onChange={(e) => setFee(e.target.value)} /></Field>
        <Field label="税费"><input type="text" value={tax} placeholder="如 0" onChange={(e) => setTax(e.target.value)} /></Field>
      </div>
      <Field label="备注"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text2)' }}>
        <input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} />
        基金申购待确认（PENDING_CONFIRMATION，确认份额前不改变持仓）
      </label>
      {error ? <div style={{ fontSize: 12, color: '#e0343c', marginTop: 8 }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          if (!accountId || !instrumentId) { setError('请选择账户与标的'); return; }
          try {
            await rpc('record_transaction', {
              accountId, instrumentId, type, tradeDate,
              quantity: qty || null, price: price || null, amount: amount || null,
              fee: fee || null, tax: tax || null, note,
              status: pending ? 'PENDING_CONFIRMATION' : 'CONFIRMED',
            });
            props.onSaved();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>保存</button>
      </div>
    </Modal>
  );
}

/* SPA 挂载入口：index.html 以 <script src="app.js"> 加载 IIFE，
   必须显式 createRoot().render()，否则 bundle 只定义组件、页面恒为空白。
   script 位于 #root 之后，DOM 此时已就绪。 */
const mountNode = document.getElementById('root');
if (mountNode) {
  createRoot(mountNode).render(<App />);
}
