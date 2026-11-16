/**
 * 交易回放引擎（PRD §4.4 / 旧 fund ledger.rs 语义）。
 *
 * - 交易流水是唯一事实源；持仓为确定性回放投影，可随时重建。
 * - 加权平均成本法：买入总成本 = 数量×成交价 + 手续费 + 税费。
 * - 卖出按卖出前单位成本结转，超卖（数量超出可用）直接拒绝。
 * - 待确认（PENDING_CONFIRMATION）不改变持仓。
 * - 同日多笔按 seq 稳定排序，回放可复现。
 */
import { SCALE_AMOUNT, SCALE_QTY, addFixed, divToScale, mulToScale, parseFixed, subFixed, truncDiv } from './money.ts';
import type { Position, Txn } from './types.ts';

export class LedgerError extends Error {
  override name = 'LedgerError';
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const Q = (text: string | null): number => (text == null ? 0 : parseFixed(text, SCALE_QTY));
const A = (text: string | null): number => (text == null ? 0 : parseFixed(text, SCALE_AMOUNT));

function keyOf(accountId: string, instrumentId: string): string {
  return `${accountId}:${instrumentId}`;
}

function emptyPosition(accountId: string, instrumentId: string): Position {
  return {
    accountId,
    instrumentId,
    qtyRaw: 0,
    costTotalRaw: 0,
    unitCostRaw: 0,
    realizedRaw: 0,
    dividendsRaw: 0,
    adjustmentRaw: 0,
    lastEventDate: null,
  };
}

/** 同日多笔交易按写入顺序回放，跨日按 tradeDate 升序。 */
function sortTxns(txns: Txn[]): Txn[] {
  return [...txns]
    .filter((t) => t.status === 'CONFIRMED')
    .sort((a, b) => (a.tradeDate === b.tradeDate ? a.seq - b.seq : a.tradeDate < b.tradeDate ? -1 : 1));
}

/**
 * 回放全部已确认交易 → `(accountId, instrumentId) → Position`。
 * 抛出 LedgerError（code='oversell' 等）而不是静默修正。
 */
export function replayPositions(txns: Txn[]): Map<string, Position> {
  const out = new Map<string, Position>();
  for (const t of sortTxns(txns)) {
    const key = keyOf(t.accountId, t.instrumentId);
    const pos = out.get(key) ?? emptyPosition(t.accountId, t.instrumentId);
    applyTxn(pos, t);
    out.set(key, pos);
  }
  return out;
}

function applyTxn(pos: Position, t: Txn): void {
  const at = (text: string): never => {
    throw new LedgerError('invalid-txn', `${text}（交易 ${t.id}）`, { txnId: t.id, type: t.type });
  };
  pos.lastEventDate = t.tradeDate;
  switch (t.type) {
    case 'OPENING': {
      const qty = Q(t.quantity);
      const cost = A(t.amount);
      if (qty <= 0 || cost < 0) at('期初建账需要正数量与非负总成本');
      pos.qtyRaw = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = addFixed(pos.costTotalRaw, cost, SCALE_AMOUNT);
      if (pos.qtyRaw > 0) {
        pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      }
      break;
    }
    case 'BUY': {
      const qty = Q(t.quantity);
      const price = Q(t.price);
      const fee = A(t.fee);
      const tax = A(t.tax);
      if (qty <= 0 || price < 0 || fee < 0 || tax < 0) at('买入需要正数量与非负价格/费用');
      const buyCost = addFixed(addFixed(mulToScale(price, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY), fee, SCALE_AMOUNT), tax, SCALE_AMOUNT);
      // 新单位成本 = (原总成本 + 本次总成本) ÷ (原数量 + 本次数量)
      const newQty = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      const newCost = addFixed(pos.costTotalRaw, buyCost, SCALE_AMOUNT);
      pos.qtyRaw = newQty;
      pos.costTotalRaw = newCost;
      pos.unitCostRaw = newQty === 0 ? 0 : divToScale(newCost, SCALE_AMOUNT, newQty, SCALE_QTY, SCALE_QTY);
      break;
    }
    case 'SELL': {
      const qty = Q(t.quantity);
      const price = Q(t.price);
      const fee = A(t.fee);
      const tax = A(t.tax);
      if (qty <= 0 || price < 0) at('卖出需要正数量与非负价格');
      if (qty > pos.qtyRaw) {
        throw new LedgerError('oversell', '卖出数量超过可用持仓，已拒绝', {
          txnId: t.id,
          requested: qty,
          available: pos.qtyRaw,
        });
      }
      // 卖出净收入 = 数量×价格 − 手续费 − 税费；结转成本 = 数量 × 卖出前单位成本
      const gross = mulToScale(price, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
      const net = subFixed(subFixed(gross, fee, SCALE_AMOUNT), tax, SCALE_AMOUNT);
      const costBasis = mulToScale(pos.unitCostRaw, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
      pos.realizedRaw = addFixed(pos.realizedRaw, net - costBasis, SCALE_AMOUNT);
      pos.qtyRaw = subFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = subFixed(pos.costTotalRaw, costBasis, SCALE_AMOUNT);
      if (pos.qtyRaw === 0) pos.unitCostRaw = 0;
      break;
    }
    case 'DIVIDEND_CASH': {
      const amount = A(t.amount);
      if (amount <= 0) at('现金分红需要正金额');
      pos.dividendsRaw = addFixed(pos.dividendsRaw, amount, SCALE_AMOUNT);
      break;
    }
    case 'DIVIDEND_REINVEST': {
      const qty = Q(t.quantity);
      const amount = A(t.amount);
      if (qty <= 0 || amount <= 0) at('红利再投需要正份额与正金额');
      pos.qtyRaw = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = addFixed(pos.costTotalRaw, amount, SCALE_AMOUNT);
      pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    case 'FEE': {
      // 单独费用修正：默认计入持仓成本（可负冲回）。
      const fee = A(t.amount);
      pos.adjustmentRaw = addFixed(pos.adjustmentRaw, fee, SCALE_AMOUNT);
      if (pos.qtyRaw > 0) {
        pos.costTotalRaw = addFixed(pos.costTotalRaw, fee, SCALE_AMOUNT);
        pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      }
      break;
    }
    case 'SPLIT': {
      // 份额折算系数（1.0000 = 无变化）；总成本不变，单位成本随之重算。
      const factor = Q(t.quantity);
      if (factor <= 0) at('拆分系数必须为正');
      pos.qtyRaw = truncDiv(pos.qtyRaw * factor, 10000);
      pos.unitCostRaw = pos.qtyRaw === 0 ? 0 : divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    case 'CORRECTION': {
      // 经用户确认的修正：显式数量增量 + 成本增量，保留审计记录。
      const qtyDelta = Q(t.quantity);
      const costDelta = A(t.amount);
      const newQty = addFixed(pos.qtyRaw, qtyDelta, SCALE_QTY);
      if (newQty < 0) at('修正后持仓为负');
      pos.qtyRaw = newQty;
      pos.costTotalRaw = addFixed(pos.costTotalRaw, costDelta, SCALE_AMOUNT);
      if (pos.qtyRaw === 0) pos.unitCostRaw = 0;
      else pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    default:
      at('未知交易类型');
  }
  if (pos.costTotalRaw < 0) {
    throw new LedgerError('negative-cost', '持仓总成本为负，已拒绝', { txnId: t.id, costTotalRaw: pos.costTotalRaw });
  }
}

/** 未实现盈亏 = 市值 − 持仓成本（raw s2）。 */
export function unrealizedRaw(pos: Position, priceRaw: number): number {
  if (pos.qtyRaw === 0) return 0;
  const mv = mulToScale(priceRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
  return mv - pos.costTotalRaw;
}

/** 持仓收益率 = 未实现盈亏 ÷ 持仓成本；成本为零返回 null（显示 “—”）。 */
export function holdingReturnRate(pos: Position, priceRaw: number): number | null {
  if (pos.costTotalRaw === 0) return null;
  return unrealizedRaw(pos, priceRaw) / pos.costTotalRaw;
}
