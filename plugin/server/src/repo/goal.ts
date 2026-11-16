import type { CashFlow, CashFlowType, GoalEvent, PortfolioGoal } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import { formatFixed, parseFixed, SCALE_AMOUNT } from '../../../core/src/money.ts';

interface GoalRow {
  id: string;
  name: string;
  target_amount: string;
  currency: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function toGoal(row: GoalRow): PortfolioGoal {
  return {
    id: row.id,
    name: row.name,
    targetAmount: row.target_amount,
    currency: row.currency as PortfolioGoal['currency'],
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listGoals(handle: DbHandle): PortfolioGoal[] {
  const rows = handle.db.prepare('SELECT * FROM portfolio_goals ORDER BY created_at').all() as GoalRow[];
  return rows.map(toGoal);
}

/** 启用中的主目标（v1.1 仅允许一个）。 */
export function getEnabledGoal(handle: DbHandle): PortfolioGoal | null {
  const row = handle.db.prepare('SELECT * FROM portfolio_goals WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1').get() as GoalRow | undefined;
  return row ? toGoal(row) : null;
}

export interface GoalInput {
  id?: string;
  name: string;
  targetAmount: string;
  enabled: boolean;
  note?: string;
}

/**
 * 保存目标：金额变化记录变更事件（PRD §4.1.4 / §7.2）；
 * 启用一个目标时自动停用其余（单主目标约束）。
 * 金额非法（≤0 / 超精度）在解析处抛错，不落库。
 */
export function saveGoal(handle: DbHandle, input: GoalInput): { goal: PortfolioGoal; event: GoalEvent | null } {
  const amountRaw = parseFixed(input.targetAmount, SCALE_AMOUNT);
  if (amountRaw <= 0) throw new Error('目标金额必须大于 0');
  const amount = formatFixed(amountRaw, SCALE_AMOUNT);
  const now = nowIso();
  let goalId: string;
  let oldAmount: string | null = null;
  if (input.id) {
    const existingRow = handle.db.prepare('SELECT * FROM portfolio_goals WHERE id = ?').get(input.id) as GoalRow | undefined;
    if (!existingRow) throw new Error(`goal not found: ${input.id}`);
    const existing = toGoal(existingRow);
    oldAmount = existing.targetAmount;
    goalId = existing.id;
    handle.db.prepare('UPDATE portfolio_goals SET name = ?, target_amount = ?, enabled = ?, updated_at = ? WHERE id = ?')
      .run(input.name.trim(), amount, input.enabled ? 1 : 0, now, existing.id);
  } else {
    goalId = newId();
    handle.db.prepare('INSERT INTO portfolio_goals (id, name, target_amount, currency, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(goalId, input.name.trim(), amount, 'CNY', input.enabled ? 1 : 0, now, now);
  }
  if (input.enabled) {
    handle.db.prepare('UPDATE portfolio_goals SET enabled = 0, updated_at = ? WHERE enabled = 1 AND id != ?')
      .run(now, goalId);
  }
  let event: GoalEvent | null = null;
  if (!input.id || oldAmount !== amount) {
    event = {
      id: newId(),
      goalId,
      oldAmount: input.id ? oldAmount : null,
      newAmount: amount,
      changedAt: now,
      note: input.note ?? '',
    };
    handle.db.prepare('INSERT INTO portfolio_goal_events (id, goal_id, old_amount, new_amount, changed_at, note) VALUES (?,?,?,?,?,?)')
      .run(event.id, goalId, event.oldAmount, event.newAmount, event.changedAt, event.note);
  }
  const goal = toGoal(handle.db.prepare('SELECT * FROM portfolio_goals WHERE id = ?').get(goalId) as GoalRow);
  return { goal, event };
}

/* ---------------- 组合外部现金流（PRD §4.4.5） ---------------- */

interface FlowRow {
  id: string;
  flow_type: string;
  flow_date: string;
  amount: string;
  note: string;
  created_at: string;
}

function toFlow(row: FlowRow): CashFlow {
  return {
    id: row.id,
    flowType: row.flow_type as CashFlowType,
    flowDate: row.flow_date,
    amount: row.amount,
    note: row.note,
  };
}

export function listCashFlows(handle: DbHandle, range?: { begin?: string; end?: string }): CashFlow[] {
  const clauses: string[] = [];
  const args: string[] = [];
  if (range?.begin) { clauses.push('flow_date >= ?'); args.push(range.begin); }
  if (range?.end) { clauses.push('flow_date <= ?'); args.push(range.end); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = handle.db.prepare(`SELECT * FROM portfolio_cash_flows ${where} ORDER BY flow_date DESC`).all(...args) as FlowRow[];
  return rows.map(toFlow);
}

export function saveCashFlow(handle: DbHandle, input: { flowType: CashFlowType; flowDate: string; amount: string; note?: string }): CashFlow {
  const amountRaw = parseFixed(input.amount, SCALE_AMOUNT);
  if (amountRaw <= 0) throw new Error('现金流金额必须大于 0');
  const id = newId();
  handle.db.prepare('INSERT INTO portfolio_cash_flows (id, flow_type, flow_date, amount, note, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, input.flowType, input.flowDate, formatFixed(amountRaw, SCALE_AMOUNT), input.note ?? '', nowIso());
  return toFlow(handle.db.prepare('SELECT * FROM portfolio_cash_flows WHERE id = ?').get(id) as FlowRow);
}

export function deleteCashFlow(handle: DbHandle, id: string): boolean {
  const result = handle.db.prepare('DELETE FROM portfolio_cash_flows WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0;
}
