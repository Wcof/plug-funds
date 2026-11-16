/**
 * 现金 / 流动性资产仓库（schema v3）。
 *
 * 为什么单独建表而不复用交易流水：
 * 现金余额是「时点状态」而非「交易事件」，且不需要行情刷新；
 * 混进流水会污染成本与 XIRR 口径，因此保持两套语义、互不推导。
 */
import { formatFixed, parseFixed, SCALE_AMOUNT } from '../../../core/src/money.ts';
import type { CashAccount } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import { ValidationError } from '../errors.ts';

interface CashRow {
  id: string;
  name: string;
  currency: string;
  balance: string;
  note: string;
  active: number;
  updated_at: string;
}

function toCash(row: CashRow): CashAccount {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    balance: row.balance,
    note: row.note,
    active: row.active === 1,
    updatedAt: row.updated_at,
  };
}

export function listCashAccounts(handle: DbHandle, options: { activeOnly?: boolean } = {}): CashAccount[] {
  const sql = options.activeOnly
    ? 'SELECT * FROM cash_accounts WHERE active = 1 ORDER BY updated_at DESC'
    : 'SELECT * FROM cash_accounts ORDER BY active DESC, updated_at DESC';
  return (handle.db.prepare(sql).all() as CashRow[]).map(toCash);
}

export interface CashInput {
  id?: string;
  name: string;
  balance: string;
  currency?: string;
  note?: string;
  active?: boolean;
}

export function saveCashAccount(handle: DbHandle, input: CashInput): CashAccount {
  const name = input.name.trim();
  if (name === '') throw new ValidationError('现金账户名称不能为空');
  const amount = Number(input.balance);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('现金余额必须是不小于 0 的数字');
  }
  const formatted = formatFixed(parseFixed(input.balance, SCALE_AMOUNT), SCALE_AMOUNT);
  const now = nowIso();

  if (input.id) {
    const existing = handle.db.prepare('SELECT id FROM cash_accounts WHERE id = ?').get(input.id) as { id: string } | undefined;
    if (!existing) throw new ValidationError(`现金账户不存在：${input.id}`);
    handle.db.prepare(
      'UPDATE cash_accounts SET name = ?, currency = ?, balance = ?, note = ?, active = ?, updated_at = ? WHERE id = ?',
    ).run(
      name, input.currency ?? 'CNY', formatted, input.note ?? '',
      input.active === false ? 0 : 1, now, input.id,
    );
    return toCash(handle.db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(input.id) as CashRow);
  }

  const id = newId();
  handle.db.prepare(
    'INSERT INTO cash_accounts (id,name,currency,balance,note,active,updated_at) VALUES (?,?,?,?,?,?,?)',
  ).run(id, name, input.currency ?? 'CNY', formatted, input.note ?? '', input.active === false ? 0 : 1, now);
  return toCash(handle.db.prepare('SELECT * FROM cash_accounts WHERE id = ?').get(id) as CashRow);
}

export function deleteCashAccount(handle: DbHandle, id: string): boolean {
  const result = handle.db.prepare('DELETE FROM cash_accounts WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}

/** 现金合计（定点字符串 scale=2），只统计启用中的账户。 */
export function cashTotal(handle: DbHandle): string {
  const rows = listCashAccounts(handle, { activeOnly: true });
  const total = rows.reduce((sum, row) => sum + parseFixed(row.balance, SCALE_AMOUNT), 0);
  return formatFixed(total, SCALE_AMOUNT);
}
