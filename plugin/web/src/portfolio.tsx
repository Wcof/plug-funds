/**
 * 组合层面板：现金账户（schema v3）、再平衡建议、持仓相关性矩阵、风险参数设置。
 *
 * 纪律：
 * - 现金是「时点余额」，与交易流水（事件）分开记账，不参与持仓回放；
 * - 再平衡只给描述性建议（BUY / SELL / HOLD + 金额），不生成订单、不猜价格；
 * - 相关性单元格为空表示「共同交易日不足」，不用 0 冒充「不相关」；
 * - 无风险利率同时影响夏普比率与股债性价比（ERP），改一处两处同步。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  rpc,
  type CashAccount, type CorrelationMatrix, type RebalancePlan,
} from './api.ts';
import { Field, Modal, fmt, moneyText, pctText } from './ui.tsx';

/* ================= 现金账户 ================= */

export function CashCard(props: {
  accounts: CashAccount[];
  cashTotal: string;
  totalAssets: string;
  cashWeight: number | null;
  onChanged: () => void;
  onToast: (m: string) => void;
}) {
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CashAccount | null>(null);

  const add = async (): Promise<void> => {
    if (name.trim() === '') { props.onToast('请填写现金账户名称（如「华宝证券现金」「余额宝」）'); return; }
    setBusy(true);
    try {
      await rpc('save_cash_account', { name: name.trim(), balance: balance.trim() === '' ? '0' : balance.trim() });
      setName(''); setBalance('');
      props.onToast('现金账户已保存（计入总资产与再平衡分母）');
      props.onChanged();
    } catch (e) { props.onToast((e as Error).message); }
    finally { setBusy(false); }
  };

  const remove = async (account: CashAccount): Promise<void> => {
    if (!window.confirm(`删除现金账户「${account.name}」（余额 ${moneyText(account.balance)}）？`)) return;
    try {
      await rpc('delete_cash_account', { id: account.id });
      props.onToast('现金账户已删除');
      props.onChanged();
    } catch (e) { props.onToast((e as Error).message); }
  };

  return (
    <div className="card">
      <div className="pf-head">
        <h2>现金与流动性</h2>
        <div className="spacer" />
        <span className="pf-total num">{moneyText(props.cashTotal)}</span>
      </div>
      <div className="pf-sub">
        占总资产 <b className="num">{pctText(props.cashWeight, 1)}</b>
        <span className="sep">·</span>总资产（持仓 + 现金）<b className="num">{moneyText(props.totalAssets)}</b>
      </div>
      <div className="pf-add-row">
        <input type="text" placeholder="账户名称，如 华宝证券现金" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="text" className="pf-amount" placeholder="余额" value={balance} onChange={(e) => setBalance(e.target.value)} />
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => void add()}>＋ 添加</button>
      </div>
      <table>
        <thead><tr><th>账户</th><th>币种</th><th className="num">余额</th><th className="num">占总资产</th><th>备注</th><th /></tr></thead>
        <tbody>
          {props.accounts.map((account) => (
            <tr key={account.id}>
              <td><span className="inst-name">{account.name}</span></td>
              <td style={{ color: 'var(--text3)' }}>{account.currency}</td>
              <td className="num"><b>{moneyText(account.balance)}</b></td>
              <td className="num">{props.cashWeight === null ? '—' : pctText(Number(account.balance) / Math.max(Number(props.totalAssets), 1e-9), 1)}</td>
              <td style={{ color: 'var(--text3)', fontSize: 11.5 }}>{account.note || '—'}</td>
              <td className="ops-cell">
                <span className="ops-wrap">
                  <button className="btn btn-sm" onClick={() => setEditing(account)}>编辑</button>
                  <button className="btn btn-sm" onClick={() => void remove(account)}>删除</button>
                </span>
              </td>
            </tr>
          ))}
          {props.accounts.length === 0 ? (
            <tr><td colSpan={6}><div className="empty">尚未录入现金账户。<br />余额宝 / 券商现金 / 活期存款都可以记在这里，它会计入总资产但不进入持仓盈亏。</div></td></tr>
          ) : null}
        </tbody>
      </table>
      <div className="pf-note">
        现金是时点余额，不写入交易流水：转账进出请直接改余额，不要用「买入 / 卖出」模拟。加入组合资金流水（CONTRIBUTION）是另一件事——那条记录用于 XIRR 的资金边界。
      </div>
      {editing ? (
        <CashEditModal
          account={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); props.onToast('现金账户已更新'); props.onChanged(); }}
        />
      ) : null}
    </div>
  );
}

function CashEditModal(props: { account: CashAccount; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(props.account.name);
  const [balance, setBalance] = useState(props.account.balance);
  const [currency, setCurrency] = useState(props.account.currency);
  const [note, setNote] = useState(props.account.note);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={`编辑现金账户 · ${props.account.name}`} desc="直接修改时点余额；保存后总资产、现金占比与再平衡分母同步更新。" onClose={props.onClose}>
      <Field label="账户名称"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form-grid">
        <Field label="余额"><input type="text" value={balance} onChange={(e) => setBalance(e.target.value)} /></Field>
        <Field label="币种"><input type="text" value={currency} onChange={(e) => setCurrency(e.target.value)} /></Field>
      </div>
      <Field label="备注"><input type="text" value={note} placeholder="如 券商理财 T+1" onChange={(e) => setNote(e.target.value)} /></Field>
      {error ? <div style={{ fontSize: 12, color: '#e0343c' }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          try {
            await rpc('save_cash_account', { id: props.account.id, name, balance, currency, note, active: true });
            props.onSaved();
          } catch (e) { setError((e as Error).message); }
        }}>保存</button>
      </div>
    </Modal>
  );
}

/* ================= 再平衡 ================= */

const REBALANCE_CATS = [
  { key: 'stock', label: '股票' },
  { key: 'etf', label: 'ETF' },
  { key: 'fund', label: '场外基金' },
  { key: 'cash', label: '现金' },
];

const ACTION_META: Record<string, { text: string; cls: string }> = {
  BUY: { text: '买入', cls: 'pf-buy' },
  SELL: { text: '卖出', cls: 'pf-sell' },
  HOLD: { text: '保持', cls: 'pf-hold' },
};

const THRESHOLDS = [
  { key: '0.03', label: '3%' },
  { key: '0.05', label: '5%' },
  { key: '0.1', label: '10%' },
];

export function RebalanceCard(props: {
  plan: RebalancePlan | null;
  onChanged: () => void;
  onToast: (m: string) => void;
}) {
  const plan = props.plan;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  // 仅在服务端目标权重真正变化时重置草稿，避免用户输入被父级刷新清空。
  const signature = useMemo(
    () => JSON.stringify((plan?.rows ?? []).map((r) => [r.category, r.targetWeight])),
    [plan],
  );
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of plan?.rows ?? []) {
      next[row.category] = row.targetWeight > 0 ? (row.targetWeight * 100).toFixed(1).replace(/\.0$/, '') : '';
    }
    setDraft(next);
    setDirty(false);
  }, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = plan?.rows ?? [];
  const ordered = [...rows].sort(
    (a, b) => REBALANCE_CATS.findIndex((c) => c.key === a.category) - REBALANCE_CATS.findIndex((c) => c.key === b.category),
  );

  const sum = Object.values(draft).reduce((acc, v) => acc + (v.trim() === '' ? 0 : Number(v) || 0), 0);

  const save = async (threshold?: number): Promise<void> => {
    const targets = REBALANCE_CATS
      .map((cat) => ({ category: cat.key, targetWeight: (draft[cat.key] ?? '').trim() === '' ? 0 : (Number(draft[cat.key]) || 0) / 100 }))
      .filter((t) => t.targetWeight > 0 || (draft[t.category] ?? '') !== '');
    if (targets.length === 0) { props.onToast('请先填写至少一个类别的目标百分比'); return; }
    if (targets.reduce((acc, t) => acc + t.targetWeight, 0) > 1.0001) { props.onToast('目标权重合计不能超过 100%'); return; }
    setBusy(true);
    try {
      await rpc('save_rebalance_targets', { targets, threshold });
      props.onToast('再平衡目标已保存');
      props.onChanged();
    } catch (e) { props.onToast((e as Error).message); }
    finally { setBusy(false); }
  };

  const fillCurrent = (): void => {
    const next: Record<string, string> = {};
    for (const row of rows) next[row.category] = (row.currentWeight * 100).toFixed(1).replace(/\.0$/, '');
    setDraft(next);
    setDirty(true);
  };

  return (
    <div className="card">
      <div className="pf-head">
        <h2>再平衡</h2>
        <div className="spacer" />
        {plan ? (
          <span className="pf-total num">{moneyText(plan.investableAssets)}</span>
        ) : null}
      </div>
      <div className="pf-sub">
        {plan ? (
          <>
            分母＝持仓市值 + 现金 <b className="num">{moneyText(plan.totalAssets)}</b>
            <span className="sep">·</span>触发阈值
            {THRESHOLDS.map((t) => (
              <button
                key={t.key}
                className={`pf-thr${Math.abs(plan.threshold - Number(t.key)) < 1e-9 ? ' active' : ''}`}
                disabled={busy}
                onClick={() => void save(Number(t.key))}
              >{t.label}</button>
            ))}
          </>
        ) : '加载中…'}
      </div>
      <table>
        <thead>
          <tr>
            <th>类别</th><th className="num">当前市值</th><th className="num">当前权重</th>
            <th className="num">目标权重 %</th><th className="num">偏离</th><th>建议</th><th className="num">建议金额</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((row) => {
            const meta = ACTION_META[row.action];
            return (
              <tr key={row.category}>
                <td><span className="inst-name">{row.label}</span></td>
                <td className="num">{moneyText(row.currentValue)}</td>
                <td className="num">{pctText(row.currentWeight, 1)}</td>
                <td className="num">
                  <input
                    type="text"
                    className="pf-w-input"
                    value={draft[row.category] ?? ''}
                    placeholder="—"
                    onChange={(e) => { setDraft((prev) => ({ ...prev, [row.category]: e.target.value })); setDirty(true); }}
                  />
                </td>
                <td className={`num ${row.drift > 0 ? 'up' : row.drift < 0 ? 'down' : 'flat'}`}>
                  {row.drift > 0 ? '+' : ''}{(row.drift * 100).toFixed(2)}%
                </td>
                <td><span className={`pf-chip ${meta.cls}`}>{meta.text}</span></td>
                <td className="num">{row.action === 'HOLD' ? '—' : moneyText(row.amount)}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="t-foot">
            <td>合计</td>
            <td className="num">{moneyText(plan?.totalAssets ?? '0')}</td>
            <td className="num">{pctText(1, 1)}</td>
            <td className={`num ${sum > 100.01 ? 'up' : ''}`}>{sum.toFixed(1)}%</td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>
      <div className="pf-actions">
        <button className="btn btn-sm" disabled={busy} onClick={fillCurrent}>按当前权重填充</button>
        <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => void save()}>保存目标权重</button>
        <span className="pf-hint">目标合计可小于 100%（剩余视为未分配，不强行摊派）。</span>
      </div>
      <div className="pf-note">{plan?.note ?? '加载中…'}</div>
    </div>
  );
}

/* ================= 相关性矩阵 + 风险参数 ================= */

function corrStyle(value: number | null): React.CSSProperties {
  if (value === null) return { color: 'var(--text3)' };
  if (value >= 0.999) return { background: 'var(--gray-bg)', color: 'var(--text3)' };
  const alpha = 0.08 + Math.min(Math.abs(value), 1) * 0.4;
  return {
    background: value >= 0 ? `rgba(76,110,245,${alpha.toFixed(3)})` : `rgba(14,159,110,${alpha.toFixed(3)})`,
    color: 'var(--text)',
  };
}

export function CorrelationCard(props: {
  data: CorrelationMatrix | null;
  riskFreeRate: number;
  riskFreeNote: string;
  onChanged: () => void;
  onToast: (m: string) => void;
}) {
  const [rate, setRate] = useState((props.riskFreeRate * 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setRate((props.riskFreeRate * 100).toFixed(2)); }, [props.riskFreeRate]);

  const data = props.data;
  const saveRate = async (): Promise<void> => {
    const pct = Number(rate);
    if (!Number.isFinite(pct) || pct < 0 || pct > 20) { props.onToast('无风险利率应在 0–20% 之间'); return; }
    setBusy(true);
    try {
      await rpc('save_risk_settings', { riskFreeRate: pct / 100 });
      props.onToast('无风险利率已更新（夏普比率与 ERP 同步重算）');
      props.onChanged();
    } catch (e) { props.onToast((e as Error).message); }
    finally { setBusy(false); }
  };

  const cell = (value: number | null): string => (value === null ? '—' : fmt(value, 2));

  return (
    <div className="card">
      <div className="pf-head">
        <h2>风险参数与持仓相关性</h2>
        <button className="link" onClick={() => setOpen((v) => !v)}>{open ? '收起矩阵' : '展开相关性矩阵'}</button>
        <div className="spacer" />
        <div className="pf-rate">
          <label>无风险利率</label>
          <input type="text" className="pf-w-input" value={rate} onChange={(e) => setRate(e.target.value)} />
          <span className="pf-rate-unit">%</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void saveRate()}>保存</button>
        </div>
      </div>
      <div className="pf-note" style={{ marginTop: 0, marginBottom: 10 }}>{props.riskFreeNote}</div>
      {open ? (
        data && data.codes.length >= 2 ? (
          <div className="corr-scroll">
            <table className="corr-table">
              <thead>
                <tr>
                  <th className="corr-corner">标的</th>
                  {data.codes.map((code, j) => <th key={code} className="num" title={data.names[j]}>{code}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.matrix.map((row, i) => (
                  <tr key={data.codes[i]}>
                    <th className="corr-row-head" title={data.codes[i]}>{data.names[i]}</th>
                    {row.map((value, j) => (
                      <td key={`${i}-${j}`} className="num corr-cell" style={corrStyle(value)} title={`${data.names[i]} × ${data.names[j]}：${cell(value)}`}>
                        {cell(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">{data?.note ?? '加载中…'}</div>
        )
      ) : (
        <div className="pf-note" style={{ marginTop: 0 }}>
          相关性与 Beta 只在「共同交易日 ≥ 20」时才给数值；少于 2 只持仓无法计算。矩阵按市值取前 12 只，避免把注意力埋进长尾。
        </div>
      )}
      {open && data ? <div className="pf-note">{data.note}</div> : null}
    </div>
  );
}
