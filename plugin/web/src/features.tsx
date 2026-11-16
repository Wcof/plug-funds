/**
 * 业务弹窗与面板：修改持仓、CSV 导入、备份恢复、组合资金流水、策略版本与指标补录。
 * 全部通过同源 RPC 走真实存储，不使用演示数据。
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  rpc,
  type CashFlow, type HoldingRow, type ImportCommitResult, type ImportPreview,
  type RestorePreview, type StrategyRule, type StrategyTemplateRow, type TemplateVersionRow,
} from './api.ts';
import { Field, Modal, moneyText } from './ui.tsx';

function download(name: string, content: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CSV_TEMPLATE = [
  '账户,标的代码,标的名称,资产类别,交易类型,交易日,数量,价格,金额,手续费,税费,状态,备注,幂等键',
  '华宝证券,600036,招商银行,股票,期初,2026-10-20,400,,11550.00,5.00,0,已确认,期初建账,',
  '华宝证券,600036,招商银行,股票,买入,2026-10-25,100,41.25,,5.00,0,已确认,加仓,',
].join('\n');

/* ================= 修改持仓（CORRECTION 留痕） ================= */

export function EditPosModal(props: { row: HoldingRow; onClose: () => void; onSaved: () => void }) {
  const [qty, setQty] = useState(props.row.qty);
  const [unitCost, setUnitCost] = useState(props.row.unitCost);
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('修改持仓（数量 / 成本，留痕）');
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    const toRaw = (text: string, scale: number): number => Math.trunc(Number(text) * 10 ** scale);
    const values = [qty, unitCost, props.row.qty, props.row.unitCost, props.row.costTotal].map(Number);
    if (values.some((v) => !Number.isFinite(v)) || Number(qty) < 0 || Number(unitCost) < 0) {
      setError('数量与单位成本必须是非负数'); return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) { setError('交易日格式应为 YYYY-MM-DD'); return; }
    const qtyRaw = toRaw(qty, 4);
    const priceRaw = toRaw(unitCost, 4);
    const curQtyRaw = toRaw(props.row.qty, 4);
    const curCostRaw = toRaw(props.row.costTotal, 2);
    const targetCostRaw = Math.trunc((qtyRaw * priceRaw) / 10 ** 6); // (s4 × s4) → s2
    const dq = qtyRaw - curQtyRaw;
    const dc = targetCostRaw - curCostRaw;
    if (dq === 0 && dc === 0) { props.onClose(); return; }
    try {
      await rpc('record_transaction', {
        accountId: props.row.accountId,
        instrumentId: props.row.instrumentId,
        type: 'CORRECTION', tradeDate,
        quantity: (dq / 1e4).toFixed(4),
        amount: (dc / 100).toFixed(2),
        note: `${note}｜原 ${props.row.qty} @ ${props.row.unitCost} → ${qty} @ ${unitCost}`,
      });
      props.onSaved();
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Modal title={`修改持仓 · ${props.row.name}`} desc="保存后以一条 CORRECTION 流水修正数量与成本，持仓按流水回放重算；原流水始终保留可审计。" onClose={props.onClose}>
      <div className="set-hint">当前：{props.row.qty} 份 · 单位成本 {props.row.unitCost} · 总成本 {moneyText(props.row.costTotal)}</div>
      <div className="form-grid">
        <Field label="目标数量"><input type="text" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="目标单位成本"><input type="text" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></Field>
      </div>
      <div className="form-grid">
        <Field label="修正交易日"><input type="text" value={tradeDate} onChange={(e) => setTradeDate(e.target.value)} /></Field>
        <Field label="备注"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      {error ? <div style={{ fontSize: 12, color: '#e0343c' }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={() => void save()}>保存并重算</button>
      </div>
    </Modal>
  );
}

/* ================= CSV / XLSX 流水导入 ================= */

/** 二进制 → base64：xlsx 必须原样上传，服务端用自包含 ZIP/XML 解析（不引第三方库）。 */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function ImportModal(props: { onClose: () => void; onSaved: () => void; onToast: (m: string) => void }) {
  const [text, setText] = useState('');
  const [xlsx, setXlsx] = useState<{ name: string; base64: string } | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportCommitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 统一入参：选了 xlsx 就走 base64，否则走 CSV 文本。 */
  const payload = (): Record<string, unknown> => (xlsx ? { xlsxBase64: xlsx.base64 } : { csv: text });

  const doPreview = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      setResult(null);
      setPreview(await rpc<ImportPreview>('preview_import_transactions', payload()));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const doCommit = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      const committed = await rpc<ImportCommitResult>('commit_import_transactions', payload());
      setResult(committed);
      props.onSaved();
      props.onToast(`导入完成：新增 ${committed.imported} 条，跳过 ${committed.skipped} 条`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setPreview(null); setResult(null); setError(null);
    if (/\.xlsx$/i.test(file.name)) {
      setXlsx({ name: file.name, base64: toBase64(await file.arrayBuffer()) });
      setText('');
      return;
    }
    if (/\.xls$/i.test(file.name)) {
      setXlsx(null);
      setError('不支持 .xls 老格式：请在 Excel / WPS 中「另存为 .xlsx」后再导入');
      return;
    }
    setXlsx(null);
    setText(await file.text());
  };

  const ready = xlsx !== null || text.trim() !== '';

  return (
    <Modal width={720} title="导入交易流水（CSV / XLSX）" desc="预览 → 显示错误行 → 单事务提交；重复幂等键不重复写入，回放校验失败整批回滚。" onClose={props.onClose}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void chooseFile(e.target.files?.[0])} />
        <button className="btn btn-sm" onClick={() => download('plug-funds-transactions-template.csv', `\uFEFF${CSV_TEMPLATE}`, 'text/csv')}>下载模板</button>
        <span style={{ fontSize: 11, color: 'var(--text3)' }}>表头：{CSV_TEMPLATE.split('\n')[0]}</span>
      </div>
      {xlsx ? (
        <div className="set-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>已选择 <b>{xlsx.name}</b>（{(xlsx.base64.length * 0.75 / 1024).toFixed(1)} KB）· 解析第一个工作表，日期按单元格格式转换</span>
          <button className="btn btn-sm" onClick={() => { setXlsx(null); setPreview(null); }}>移除</button>
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setPreview(null); setResult(null); }}
          placeholder="粘贴 CSV 内容，或选择 .csv / .xlsx 文件"
          style={{ width: '100%', minHeight: 110, fontFamily: 'monospace', fontSize: 12 }}
        />
      )}
      <div style={{ display: 'flex', gap: 8, margin: '10px 0' }}>
        <button className="btn" disabled={busy || !ready} onClick={() => void doPreview()}>预览</button>
        <button className="btn btn-primary" disabled={busy || !preview || preview.summary.valid === 0} onClick={() => void doCommit()}>确认导入</button>
      </div>
      {error ? <div className="empty" style={{ color: '#e0343c' }}>{error}</div> : null}
      {preview ? (
        <div className="card" style={{ padding: 10 }}>
          <div style={{ fontSize: 12.5 }}>共 {preview.summary.total} 行 · 有效 <b>{preview.summary.valid}</b> · 错误 <b>{preview.summary.invalid}</b></div>
          <div style={{ fontSize: 11.5, color: 'var(--text2)', marginTop: 4 }}>将新建账户：{preview.summary.newAccounts.join('、') || '无'}；将新建标的：{preview.summary.newInstruments.join('、') || '无'}</div>
          {preview.errors.length > 0 ? (
            <div style={{ marginTop: 8, maxHeight: 110, overflow: 'auto', fontSize: 11.5, color: '#e0343c' }}>
              {preview.errors.map((e) => <div key={e.line}>第 {e.line} 行：{e.message}</div>)}
            </div>
          ) : null}
          {preview.rows.length > 0 ? (
            <table style={{ marginTop: 8 }}>
              <thead><tr><th>行</th><th>日期</th><th>账户</th><th>标的</th><th>类型</th><th className="num">数量</th><th className="num">金额</th></tr></thead>
              <tbody>
                {preview.rows.slice(0, 8).map((r) => (
                  <tr key={r.line}>
                    <td className="num">{r.line}</td><td className="num">{r.tradeDate}</td><td>{r.accountName}</td>
                    <td>{r.instrumentName} {r.instrumentCode}</td><td>{r.txnType}</td>
                    <td className="num">{r.quantity ?? '—'}</td><td className="num">{r.amount ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {preview.rows.length > 8 ? <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>仅显示前 8 行，其余 {preview.rows.length - 8} 行同样参与导入。</div> : null}
        </div>
      ) : null}
      {result ? <div className="set-hint" style={{ marginTop: 8 }}>{result.note} 错误行 {result.errors.length} 条已跳过。</div> : null}
    </Modal>
  );
}

/* ================= JSON 备份恢复 ================= */

export function RestoreModal(props: { onClose: () => void; onSaved: () => void; onToast: (m: string) => void }) {
  const [payload, setPayload] = useState<unknown | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setError(null); setPreview(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      setPayload(parsed);
      setPreview(await rpc<RestorePreview>('preview_restore_backup', { payload: parsed }));
    } catch (e) { setError(`文件解析失败：${(e as Error).message}`); }
  };

  const commit = async (): Promise<void> => {
    if (!preview?.ok || payload === null) return;
    if (!window.confirm('恢复将替换当前全部账本数据（会先自动备份当前 invest.db）。确定继续？')) return;
    setBusy(true); setError(null);
    try {
      const result = await rpc<{ restored: Record<string, number>; backupPath: string | null; note: string }>('restore_backup', { payload });
      props.onSaved();
      props.onToast(`恢复完成：${Object.entries(result.restored).map(([k, v]) => `${k} ${v}`).join('、')}${result.backupPath ? '（原库已备份）' : ''}`);
      props.onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal width={620} title="从 JSON 备份恢复" desc="替换式恢复：校验 → 预览 → 单事务写入；恢复前自动备份当前数据库，失败整批回滚。" onClose={props.onClose}>
      <input type="file" accept=".json,application/json" onChange={(e) => void choose(e.target.files?.[0])} />
      {error ? <div className="empty" style={{ color: '#e0343c' }}>{error}</div> : null}
      {preview ? (
        <div className="card" style={{ padding: 10, marginTop: 10 }}>
          <div style={{ fontSize: 12.5 }}>schema v{preview.schemaVersion ?? '—'} · 导出于 {preview.exportedAt ?? '—'}</div>
          <div style={{ fontSize: 11.5, marginTop: 6 }}>
            {Object.entries(preview.counts).map(([k, v]) => <span key={k} className="chip" style={{ marginRight: 5 }}>{k} {v}</span>)}
          </div>
          {preview.errors.length > 0 ? <div style={{ color: '#e0343c', fontSize: 12, marginTop: 8 }}>{preview.errors.join('；')}</div> : null}
          {preview.warnings.length > 0 ? <div style={{ color: 'var(--text2)', fontSize: 11.5, marginTop: 6 }}>{preview.warnings.join('；')}</div> : null}
        </div>
      ) : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy || !preview?.ok} onClick={() => void commit()}>确认恢复</button>
      </div>
    </Modal>
  );
}

/* ================= 组合外部资金流水 ================= */

export function CashFlowCard(props: { flows: CashFlow[]; onChanged: () => void; onToast: (m: string) => void }) {
  const [flowType, setFlowType] = useState<'CONTRIBUTION' | 'WITHDRAWAL'>('CONTRIBUTION');
  const [flowDate, setFlowDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  return (
    <div className="card">
      <h2 style={{ marginBottom: 6 }}>组合外部资金流水</h2>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 8 }}>
        仅记录进入 / 离开组合的资金边界（CONTRIBUTION / WITHDRAWAL），与买入卖出分开，用于 XIRR 与单位净值口径（剔除追加资金影响）。
      </div>
      <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginBottom: 9 }}>
        <select value={flowType} onChange={(e) => setFlowType(e.target.value as 'CONTRIBUTION' | 'WITHDRAWAL')}>
          <option value="CONTRIBUTION">组合投入</option>
          <option value="WITHDRAWAL">组合取出</option>
        </select>
        <input type="text" style={{ width: 122 }} value={flowDate} placeholder="YYYY-MM-DD" onChange={(e) => setFlowDate(e.target.value)} />
        <input type="text" style={{ width: 118 }} value={amount} placeholder="金额（正数）" onChange={(e) => setAmount(e.target.value)} />
        <input type="text" style={{ width: 150 }} value={note} placeholder="备注（可选）" onChange={(e) => setNote(e.target.value)} />
        <button className="btn btn-primary btn-sm" onClick={async () => {
          try {
            await rpc('save_portfolio_cash_flow', { flowType, flowDate, amount, note });
            setAmount(''); setNote('');
            props.onToast('外部资金流水已记录（XIRR 与回撤口径已更新）');
            props.onChanged();
          } catch (e) { props.onToast((e as Error).message); }
        }}>＋ 记录</button>
      </div>
      <table>
        <thead><tr><th>日期</th><th>类型</th><th className="num">金额</th><th>备注</th><th /></tr></thead>
        <tbody>
          {props.flows.map((f) => (
            <tr key={f.id}>
              <td className="num">{f.flowDate}</td>
              <td><span className={`txn-chip tx-${f.flowType === 'CONTRIBUTION' ? 'BUY' : 'SELL'}`}>{f.flowType === 'CONTRIBUTION' ? '组合投入' : '组合取出'}</span></td>
              <td className="num">{moneyText(f.amount)}</td>
              <td style={{ color: 'var(--text3)', fontSize: 11.5 }}>{f.note || '—'}</td>
              <td><button className="btn btn-sm" onClick={async () => {
                await rpc('delete_portfolio_cash_flow', { id: f.id });
                props.onChanged(); props.onToast('已删除资金流水');
              }}>删除</button></td>
            </tr>
          ))}
          {props.flows.length === 0 ? <tr><td colSpan={5}><div className="empty">暂无外部资金流水；录入后 XIRR 才可计算</div></td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

/* ================= 策略模板 / 版本 / 指标补录 ================= */

const METRIC_OPTIONS: { key: string; label: string }[] = [
  { key: 'pe', label: 'PE-TTM' }, { key: 'pb', label: 'PB' },
  { key: 'pe_percentile', label: 'PE 历史分位（%）' }, { key: 'pb_percentile', label: 'PB 历史分位（%）' },
  { key: 'dividend_yield', label: '股息率（%）' }, { key: 'roe', label: 'ROE（%）' },
  { key: 'sharpe', label: '夏普比率' }, { key: 'max_drawdown_pct', label: '最大回撤（%）' },
  { key: 'annual_volatility_pct', label: '年化波动率（%）' },
];

export function StrategyTemplatePanel(props: { onChanged: () => void; onToast: (m: string) => void }) {
  const [templates, setTemplates] = useState<StrategyTemplateRow[]>([]);
  const [editing, setEditing] = useState<StrategyTemplateRow | null>(null);
  const [versionsFor, setVersionsFor] = useState<StrategyTemplateRow | null>(null);
  const [manualOpen, setManualOpen] = useState(false);

  const load = useCallback(async () => {
    const result = await rpc<{ templates: StrategyTemplateRow[] }>('list_strategy_templates');
    setTemplates(result.templates);
  }, []);
  // 只在挂载时加载；父级刷新通过 onSaved → load() 显式触发，避免回调引用变化造成循环
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div style={{ display: 'flex', gap: 7, marginBottom: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" onClick={() => {
          const base = templates[0];
          setEditing(base ? { ...base, id: '', name: '自定义策略', scope: '', origin: 'custom', version: 0, updatedAt: null } : null);
        }}>＋ 新建模板</button>
        <button className="btn btn-sm" onClick={() => setManualOpen(true)}>补录估值指标</button>
        <span style={{ fontSize: 11.5, color: 'var(--text3)', alignSelf: 'center' }}>模板可编辑并版本化；每次保存生成不可变版本，可回滚。</span>
      </div>
      {templates.map((template) => (
        <div key={template.id} className="tpl-card">
          <div className="tpl-head">
            <b>{template.name}</b>
            <span className="tpl-sys">{template.origin === 'custom' ? '自定义模板' : '系统模板'} · v{template.version}</span>
          </div>
          <div className="tpl-scope">适用：{template.scope || '全部标的'} · 权重合计 {template.metrics.reduce((a, r) => a + r.weight, 0)}%</div>
          <div className="w-bars">
            {template.metrics.map((rule) => (
              <div key={rule.key} className="w-bar">
                <span className="w-name">{rule.label}{rule.required ? ' *' : ''}</span>
                <span className="w-track"><i style={{ width: `${Math.min(rule.weight * 2.6, 100)}%` }} /></span>
                <span className="w-pct num">{rule.weight}%</span>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn btn-sm" onClick={() => setEditing({ ...template, metrics: template.metrics.map((r) => ({ ...r })) })}>编辑阈值 / 权重</button>
            <button className="btn btn-sm" onClick={() => setVersionsFor(template)}>版本历史</button>
          </div>
        </div>
      ))}
      {editing ? (
        <TemplateEditModal
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); props.onChanged(); props.onToast('策略模板已保存为新版本'); }}
        />
      ) : null}
      {versionsFor ? (
        <VersionModal template={versionsFor} onClose={() => setVersionsFor(null)} onRestored={async () => {
          setVersionsFor(null); await load(); props.onChanged(); props.onToast('已回滚到历史版本');
        }} />
      ) : null}
      {manualOpen ? <ManualMetricModal onClose={() => setManualOpen(false)} onSaved={() => { setManualOpen(false); props.onChanged(); props.onToast('估值指标已补录（MANUAL）'); }} /> : null}
    </>
  );
}

function TemplateEditModal(props: { template: StrategyTemplateRow; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(props.template.name);
  const [scope, setScope] = useState(props.template.scope);
  const [rules, setRules] = useState<StrategyRule[]>(props.template.metrics);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<StrategyRule>): void => {
    setRules((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  return (
    <Modal width={720} title={`${props.template.id ? '编辑' : '新建'}策略模板`} desc="权重合计必须为 100；至少一条必需指标。保存后生成新版本，历史版本可回滚。" onClose={props.onClose}>
      <div className="form-grid">
        <Field label="模板名称"><input type="text" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="适用范围"><input type="text" value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
      </div>
      <table style={{ marginTop: 8 }}>
        <thead><tr><th>指标</th><th className="num">权重</th><th className="num">优先线</th><th className="num">不利线</th><th>必需</th></tr></thead>
        <tbody>
          {rules.map((rule, i) => (
            <tr key={rule.key}>
              <td>{rule.label}<div style={{ fontSize: 10, color: 'var(--text3)' }}>{rule.direction === 'lower-better' ? '越低越好' : '越高越好'}</div></td>
              <td><input type="text" style={{ width: 62 }} value={rule.weight} onChange={(e) => update(i, { weight: Number(e.target.value) })} /></td>
              <td><input type="text" style={{ width: 72 }} value={rule.favorableAt} onChange={(e) => update(i, { favorableAt: Number(e.target.value) })} /></td>
              <td><input type="text" style={{ width: 72 }} value={rule.adverseAt} onChange={(e) => update(i, { adverseAt: Number(e.target.value) })} /></td>
              <td><input type="checkbox" checked={rule.required} onChange={(e) => update(i, { required: e.target.checked })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="版本说明"><input type="text" value={note} placeholder="如：下调股息率阈值" onChange={(e) => setNote(e.target.value)} /></Field>
      {error ? <div style={{ fontSize: 12, color: '#e0343c' }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          try {
            await rpc('save_strategy_template', {
              id: props.template.id || undefined, name, scope, metrics: rules, note,
            });
            props.onSaved();
          } catch (e) { setError((e as Error).message); }
        }}>保存为新版本</button>
      </div>
    </Modal>
  );
}

function VersionModal(props: { template: StrategyTemplateRow; onClose: () => void; onRestored: () => void }) {
  const [versions, setVersions] = useState<TemplateVersionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await rpc<{ versions: TemplateVersionRow[] }>('list_strategy_versions', { templateId: props.template.id });
    setVersions(result.versions);
  }, [props.template.id]);
  useEffect(() => { void load(); }, [load]);
  return (
    <Modal width={560} title={`版本历史 · ${props.template.name}`} desc="回滚不会删除历史，而是把选中版本的规则复制为一个新版本。" onClose={props.onClose}>
      {versions.length === 0 ? <div className="empty">尚无历史版本（首次保存后产生 v1）</div> : null}
      {versions.map((v) => (
        <div key={v.version} className="set-item">
          <span className="si-label">v{v.version} {v.current ? '· 当前' : ''} · {v.createdAt.slice(0, 19).replace('T', ' ')}</span>
          <span className="si-value">
            <span style={{ fontSize: 11, color: 'var(--text3)', marginRight: 8 }}>{v.note || `${v.rules.length} 条规则`}</span>
            {v.current ? null : <button className="btn btn-sm" onClick={async () => {
              try {
                await rpc('restore_strategy_version', { templateId: props.template.id, version: v.version });
                props.onRestored();
              } catch (e) { setError((e as Error).message); }
            }}>回滚</button>}
          </span>
        </div>
      ))}
      {error ? <div style={{ color: '#e0343c', fontSize: 12 }}>{error}</div> : null}
    </Modal>
  );
}

function ManualMetricModal(props: { onClose: () => void; onSaved: () => void }) {
  const [instruments, setInstruments] = useState<{ instrumentId: string; name: string; code: string }[]>([]);
  const [instrumentId, setInstrumentId] = useState('');
  const [metricKey, setMetricKey] = useState('dividend_yield');
  const [value, setValue] = useState('');
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void rpc<{ rows: { instrumentId: string; name: string; code: string }[] }>('get_holdings_valuation').then((result) => {
      setInstruments(result.rows);
      if (result.rows.length > 0) setInstrumentId(result.rows[0].instrumentId);
    });
  }, []);

  return (
    <Modal title="补录估值指标（MANUAL）" desc="数据源暂不覆盖的指标（如 ROE / 股息率）可手工补录，估值口径会标注 MANUAL，不冒充行情数据。" onClose={props.onClose}>
      <Field label="标的">
        <select value={instrumentId} onChange={(e) => setInstrumentId(e.target.value)}>
          {instruments.map((i) => <option key={i.instrumentId} value={i.instrumentId}>{i.name} {i.code}</option>)}
          {instruments.length === 0 ? <option value="">（先新增持仓）</option> : null}
        </select>
      </Field>
      <div className="form-grid">
        <Field label="指标">
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
            {METRIC_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="数值"><input type="text" value={value} placeholder="如 4.2" onChange={(e) => setValue(e.target.value)} /></Field>
      </div>
      <Field label="估值日期"><input type="text" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></Field>
      {error ? <div style={{ fontSize: 12, color: '#e0343c' }}>{error}</div> : null}
      <div className="modal-foot">
        <button className="btn" onClick={props.onClose}>取消</button>
        <button className="btn btn-primary" onClick={async () => {
          try {
            await rpc('save_manual_metric', { instrumentId, metricKey, value, asOfDate });
            props.onSaved();
          } catch (e) { setError((e as Error).message); }
        }}>保存</button>
      </div>
    </Modal>
  );
}

/* ================= 行情刷新 ================= */

export function RefreshButton(props: { onToast: (m: string) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button className="btn btn-sm" disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const result = await rpc<{ results: { ok: boolean; error: string | null }[] }>('refresh_market_data', {});
        const ok = result.results.filter((r) => r.ok).length;
        props.onToast(`刷新完成：${ok}/${result.results.length} 个标的成功`);
        props.onDone();
      } catch (e) { props.onToast((e as Error).message); }
      finally { setBusy(false); }
    }}>{busy ? '刷新中…' : '立即刷新行情'}</button>
  );
}
