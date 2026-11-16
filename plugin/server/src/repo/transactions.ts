import type { Txn, TxnStatus, TxnType } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

interface Row {
  id: string;
  account_id: string;
  instrument_id: string;
  type: string;
  status: string;
  trade_date: string;
  seq: number;
  quantity: string | null;
  price: string | null;
  amount: string | null;
  fee: string | null;
  tax: string | null;
  note: string;
  request_id: string | null;
  created_at: string;
}

function toTxn(row: Row): Txn {
  return {
    id: row.id,
    accountId: row.account_id,
    instrumentId: row.instrument_id,
    type: row.type as TxnType,
    status: row.status as TxnStatus,
    tradeDate: row.trade_date,
    seq: row.seq,
    quantity: row.quantity,
    price: row.price,
    amount: row.amount,
    fee: row.fee,
    tax: row.tax,
    note: row.note,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export function listTransactions(
  handle: DbHandle,
  filter: { accountId?: string; instrumentId?: string; type?: TxnType; status?: TxnStatus } = {},
): Txn[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filter.accountId) { clauses.push('account_id = ?'); args.push(filter.accountId); }
  if (filter.instrumentId) { clauses.push('instrument_id = ?'); args.push(filter.instrumentId); }
  if (filter.type) { clauses.push('type = ?'); args.push(filter.type); }
  if (filter.status) { clauses.push('status = ?'); args.push(filter.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = handle.db
    .prepare(`SELECT * FROM transactions ${where} ORDER BY trade_date DESC, seq DESC LIMIT 500`)
    .all(...args) as Row[];
  return rows.map(toTxn);
}

/** 回放用的全量流水（升序由 core 排序处理）。 */
export function allTransactions(handle: DbHandle): Txn[] {
  const rows = handle.db.prepare('SELECT * FROM transactions').all() as Row[];
  return rows.map(toTxn);
}

export function getTransaction(handle: DbHandle, id: string): Txn | null {
  const row = handle.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Row | undefined;
  return row ? toTxn(row) : null;
}

export interface TxnInput {
  id?: string;
  accountId: string;
  instrumentId: string;
  type: TxnType;
  status?: TxnStatus;
  tradeDate: string;
  quantity?: string | null;
  price?: string | null;
  amount?: string | null;
  fee?: string | null;
  tax?: string | null;
  note?: string;
  requestId?: string | null;
}

/** 写入流水；request_id 幂等（重复导入同键直接返回既有记录）。 */
export function saveTransaction(handle: DbHandle, input: TxnInput): { txn: Txn; deduplicated: boolean } {
  autoRestoreOnOpening(handle, input);
  if (input.requestId) {
    const existing = handle.db
      .prepare('SELECT * FROM transactions WHERE request_id = ?')
      .get(input.requestId) as Row | undefined;
    if (existing) return { txn: toTxn(existing), deduplicated: true };
  }
  if (input.id) {
    const existing = getTransaction(handle, input.id);
    if (!existing) throw new Error(`transaction not found: ${input.id}`);
    handle.db
      .prepare(`UPDATE transactions SET type = ?, status = ?, trade_date = ?, quantity = ?, price = ?, amount = ?, fee = ?, tax = ?, note = ? WHERE id = ?`)
      .run(input.type, input.status ?? existing.status, input.tradeDate, input.quantity ?? null,
        input.price ?? null, input.amount ?? null, input.fee ?? null, input.tax ?? null,
        input.note ?? existing.note, input.id);
    return { txn: getTransaction(handle, input.id)!, deduplicated: false };
  }
  const seqRow = handle.db
    .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transactions WHERE trade_date = ?')
    .get(input.tradeDate) as { next: number };
  const id = newId();
  handle.db
    .prepare(`INSERT INTO transactions (id, account_id, instrument_id, type, status, trade_date, seq, quantity, price, amount, fee, tax, note, request_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, input.accountId, input.instrumentId, input.type, input.status ?? 'CONFIRMED',
      input.tradeDate, seqRow.next, input.quantity ?? null, input.price ?? null, input.amount ?? null,
      input.fee ?? null, input.tax ?? null, input.note ?? '', input.requestId ?? null, nowIso());
  return { txn: getTransaction(handle, id)!, deduplicated: false };
}

/**
 * 「删除持仓」语义（PRD §4.12.1）：流水永远保留（可审计），仅在
 * deleted_positions 屏蔽表中标记该 (account, instrument) 不再进入持仓视图。
 * 之后重新录入该标的的 OPENING / 买入 → 自动恢复持仓视图。
 */
export function deletePosition(handle: DbHandle, accountId: string, instrumentId: string): void {
  handle.db
    .prepare(`INSERT INTO deleted_positions (account_id, instrument_id, deleted_at) VALUES (?,?,?)
              ON CONFLICT (account_id, instrument_id) DO UPDATE SET deleted_at = excluded.deleted_at`)
    .run(accountId, instrumentId, nowIso());
}

export function restorePosition(handle: DbHandle, accountId: string, instrumentId: string): void {
  handle.db
    .prepare('DELETE FROM deleted_positions WHERE account_id = ? AND instrument_id = ?')
    .run(accountId, instrumentId);
}

export function listDeletedPositions(handle: DbHandle): { accountId: string; instrumentId: string }[] {
  const rows = handle.db.prepare('SELECT account_id, instrument_id FROM deleted_positions').all() as
    { account_id: string; instrument_id: string }[];
  return rows.map((r) => ({ accountId: r.account_id, instrumentId: r.instrument_id }));
}

/** 新建仓时自动解除删除标记。 */
function autoRestoreOnOpening(handle: DbHandle, input: TxnInput): void {
  if (!input.id && (input.type === 'OPENING' || input.type === 'BUY')) {
    restorePosition(handle, input.accountId, input.instrumentId);
  }
}
