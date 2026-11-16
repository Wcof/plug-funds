/**
 * 持仓视图服务：回放投影 + 有效价格 + 展示字段。
 * 分类 / 置顶 / 删除屏蔽全部在这里落成最终行。
 */
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, mulToScale, parseFixed } from '../../../core/src/money.ts';
import { replayPositions, unrealizedRaw } from '../../../core/src/ledger.ts';
import { categoryChipsFor } from '../../../core/src/categories.ts';
import type { Category, Instrument, Txn } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { allTransactions, listDeletedPositions } from '../repo/transactions.ts';
import { listAccounts } from '../repo/accounts.ts';
import { listInstruments } from '../repo/instruments.ts';
import { listCategories, listLinks } from '../repo/categories.ts';
import { effectivePrice } from '../repo/market.ts';
import { getSetting, setSetting } from '../repo/settings.ts';

export interface HoldingRow {
  positionId: string;
  accountId: string;
  accountName: string;
  instrumentId: string;
  code: string;
  name: string;
  type: Instrument['type'];
  tag: string;
  qty: string;
  unitCost: string;
  price: string | null;
  priceType: string | null;
  quality: string | null;
  priceDate: string | null;
  observedAt: string | null;
  /** 定点字符串（scale=2）；价格缺失为 null（市值不完整）。 */
  marketValue: string | null;
  costTotal: string;
  pnl: string | null;
  pnlRate: string | null;
  realized: string;
  dividends: string;
  weight: number | null;
  categories: { names: string[]; colors: string[]; more: number };
  pinned: boolean;
  firstHeldDate: string | null;
}

export interface HoldingsResult {
  rows: HoldingRow[];
  totalMarketValue: string;
  totalCost: string;
  totalPnl: string | null;
  incomplete: string[];
}

const PINNED_KEY = 'pinned_positions';

function pinnedSet(handle: ServiceContext['handle']): Set<string> {
  const raw = getSetting(handle, PINNED_KEY);
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}

export function setPinned(handle: ServiceContext['handle'], positionId: string, pinned: boolean): void {
  const current = pinnedSet(handle);
  if (pinned) current.add(positionId);
  else current.delete(positionId);
  setSetting(handle, PINNED_KEY, [...current]);
}

function firstHeldDate(txns: Txn[], accountId: string, instrumentId: string): string | null {
  const dates = txns
    .filter((t) => t.accountId === accountId && t.instrumentId === instrumentId && t.status === 'CONFIRMED')
    .map((t) => t.tradeDate)
    .sort();
  return dates[0] ?? null;
}

export function listHoldings(
  ctx: ServiceContext,
  filter: { type?: string; accountId?: string; pnl?: 'gain' | 'loss' } = {},
): HoldingsResult {
  const { handle } = ctx;
  const txns = allTransactions(handle);
  const positions = replayPositions(txns);
  const deleted = new Set(listDeletedPositions(handle).map((d) => `${d.accountId}:${d.instrumentId}`));
  const accounts = new Map(listAccounts(handle).map((a) => [a.id, a]));
  const instruments = new Map(listInstruments(handle, { active: true }).map((i) => [i.id, i]));
  const links = listLinks(handle);
  const categories: Category[] = listCategories(handle);
  const pinned = pinnedSet(handle);

  const rows: HoldingRow[] = [];
  const incomplete: string[] = [];
  let totalMvRaw = 0;
  let totalCostRaw = 0;
  let totalPnlKnown = true;

  for (const [key, pos] of positions) {
    if (deleted.has(key)) continue;
    if (pos.qtyRaw === 0 && pos.realizedRaw === 0 && pos.dividendsRaw === 0) continue;
    const instrument = instruments.get(pos.instrumentId);
    const account = accounts.get(pos.accountId);
    if (!instrument || !account) continue;
    if (filter.type && instrument.type !== filter.type) continue;
    if (filter.accountId && pos.accountId !== filter.accountId) continue;

    const price = effectivePrice(handle, instrument, ctx.today);
    let mvRaw: number | null = null;
    let pnlRaw: number | null = null;
    let pnlRate: number | null = null;
    if (price) {
      const priceRaw = parseFixed(price.value, SCALE_QTY);
      mvRaw = pos.qtyRaw > 0 ? mulToScale(priceRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) : 0;
      pnlRaw = unrealizedRaw(pos, priceRaw);
      pnlRate = pos.costTotalRaw > 0 ? pnlRaw / pos.costTotalRaw : null;
    } else if (pos.qtyRaw > 0) {
      incomplete.push(`${instrument.name}（${instrument.code}）`);
      totalPnlKnown = false;
    }
    if (mvRaw !== null) totalMvRaw += mvRaw;
    totalCostRaw += pos.costTotalRaw;

    rows.push({
      positionId: key,
      accountId: pos.accountId,
      accountName: account.name,
      instrumentId: pos.instrumentId,
      code: instrument.code,
      name: instrument.name,
      type: instrument.type,
      tag: instrument.tag,
      qty: formatFixed(pos.qtyRaw, SCALE_QTY),
      unitCost: formatFixed(pos.unitCostRaw, SCALE_QTY),
      price: price?.value ?? null,
      priceType: price?.priceType ?? null,
      quality: price?.quality ?? null,
      priceDate: price?.tradingDate ?? null,
      observedAt: price?.observedAt ?? null,
      marketValue: mvRaw === null ? null : formatFixed(mvRaw, SCALE_AMOUNT),
      costTotal: formatFixed(pos.costTotalRaw, SCALE_AMOUNT),
      pnl: pnlRaw === null ? null : formatFixed(pnlRaw, SCALE_AMOUNT),
      pnlRate: pnlRate === null ? null : `${pnlRate >= 0 ? '+' : ''}${(pnlRate * 100).toFixed(2)}%`,
      realized: formatFixed(pos.realizedRaw, SCALE_AMOUNT),
      dividends: formatFixed(pos.dividendsRaw, SCALE_AMOUNT),
      weight: null,
      categories: categoryChipsFor(links, categories, pos.instrumentId),
      pinned: pinned.has(key),
      firstHeldDate: firstHeldDate(txns, pos.accountId, pos.instrumentId),
    });
  }

  for (const row of rows) {
    if (row.marketValue !== null && totalMvRaw > 0) {
      row.weight = parseFixed(row.marketValue, SCALE_AMOUNT) / totalMvRaw;
    }
  }
  let finalRows = rows;
  if (filter.pnl === 'gain') finalRows = finalRows.filter((r) => r.pnl !== null && r.pnl.startsWith('+'));
  if (filter.pnl === 'loss') finalRows = finalRows.filter((r) => r.pnl !== null && r.pnl.startsWith('-'));

  finalRows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const av = a.marketValue ? -parseFixed(a.marketValue, SCALE_AMOUNT) : Number.NEGATIVE_INFINITY;
    const bv = b.marketValue ? -parseFixed(b.marketValue, SCALE_AMOUNT) : Number.NEGATIVE_INFINITY;
    return av - bv;
  });

  return {
    rows: finalRows,
    totalMarketValue: formatFixed(totalMvRaw, SCALE_AMOUNT),
    totalCost: formatFixed(totalCostRaw, SCALE_AMOUNT),
    totalPnl: totalPnlKnown ? formatFixed(totalMvRaw - totalCostRaw, SCALE_AMOUNT) : null,
    incomplete: [...new Set(incomplete)],
  };
}
