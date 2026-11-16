/**
 * 备份 / 导出（PRD §4.8）：JSON 全量导出（结构化数据 + 策略版本 + 元数据）。
 * 导出始终包含真实数值，不受「隐藏金额」展示掩码影响；恢复流程见 services/restore.ts。
 */
import type { ServiceContext } from '../context.ts';
import { SCHEMA_VERSION } from '../../../core/src/types.ts';
import { allTransactions } from '../repo/transactions.ts';
import { listAccounts } from '../repo/accounts.ts';
import { listInstruments } from '../repo/instruments.ts';
import { listCategories, listLinks } from '../repo/categories.ts';
import { historyPoints, latestValuationMetrics } from '../repo/market.ts';
import { listGoals, listCashFlows } from '../repo/goal.ts';
import { listAiRecords } from '../repo/settings.ts';
import { listHoldings } from './holdings.ts';

export interface BackupPayload {
  kind: 'plug-funds-backup';
  schemaVersion: number;
  exportedAt: string;
  accounts: unknown[];
  instruments: unknown[];
  transactions: unknown[];
  categories: unknown[];
  categoryLinks: unknown[];
  marketData: unknown[];
  valuationMetrics: unknown[];
  goals: unknown[];
  cashFlows: unknown[];
  aiRecords: { instrumentId: string; model: string; source: string; promptScope: string; createdAt: string; result: string }[];
  deletedPositions: { accountId: string; instrumentId: string; deletedAt: string }[];
  strategyTemplates: unknown[];
  strategyVersions: unknown[];
  note: string;
}

interface TemplateRow {
  id: string; name: string; scope: string; origin: string;
  current_version: number; created_at: string; updated_at: string;
}

interface VersionRow {
  id: string; template_id: string; version: number;
  rules_json: string; note: string; created_at: string;
}

export function exportBackup(ctx: ServiceContext): BackupPayload {
  const handle = ctx.handle;
  const instruments = listInstruments(handle);
  const templates = handle.db.prepare('SELECT * FROM strategy_templates ORDER BY created_at').all() as TemplateRow[];
  const versions = handle.db.prepare('SELECT * FROM strategy_versions ORDER BY version').all() as VersionRow[];
  return {
    kind: 'plug-funds-backup',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    accounts: listAccounts(handle),
    instruments,
    transactions: allTransactions(handle),
    categories: listCategories(handle),
    categoryLinks: listLinks(handle),
    marketData: instruments.flatMap((i) =>
      historyPoints(handle, i.id, ['CLOSE_PRICE', 'OFFICIAL_NAV', 'REALTIME_PRICE', 'MANUAL_PRICE', 'ESTIMATED_NAV']),
    ),
    valuationMetrics: instruments.flatMap((i) => latestValuationMetrics(handle, i.id)),
    goals: listGoals(handle),
    cashFlows: listCashFlows(handle),
    aiRecords: listAiRecords(handle).map((r) => ({
      instrumentId: r.instrumentId, model: r.model, source: r.source,
      promptScope: r.promptScope, createdAt: r.createdAt, result: r.result,
    })),
    deletedPositions: (handle.db.prepare('SELECT account_id, instrument_id, deleted_at FROM deleted_positions').all() as
      { account_id: string; instrument_id: string; deleted_at: string }[])
      .map((r) => ({ accountId: r.account_id, instrumentId: r.instrument_id, deletedAt: r.deleted_at })),
    strategyTemplates: templates.map((r) => ({
      id: r.id, name: r.name, scope: r.scope, origin: r.origin,
      currentVersion: r.current_version, createdAt: r.created_at, updatedAt: r.updated_at,
    })),
    strategyVersions: versions.map((r) => ({
      id: r.id, templateId: r.template_id, version: r.version,
      rulesJson: r.rules_json, note: r.note, createdAt: r.created_at,
    })),
    note: 'JSON 全量备份（含策略版本与删除视图标记），可在「设置 → 备份与恢复」还原。不含 AI Key。',
  };
}

/** CSV 持仓导出（PRD §4.8：用户可随时导出，数据不锁死在应用内）。 */
export function exportHoldingsCsv(ctx: ServiceContext): string {
  const holdings = listHoldings(ctx);
  const header = ['类别', '标的名称', '代码', '账户', '数量', '单位成本', '现价/净值', '市值', '持仓盈亏', '收益率', '数据日期'];
  const lines = [header.join(',')];
  for (const row of holdings.rows) {
    lines.push([
      row.type,
      `"${row.name.replace(/"/g, '""')}"`,
      row.code,
      `"${row.accountName.replace(/"/g, '""')}"`,
      row.qty,
      row.unitCost,
      row.price ?? '',
      row.marketValue ?? '',
      row.pnl ?? '',
      row.pnlRate ?? '',
      row.priceDate ?? '',
    ].join(','));
  }
  return `\uFEFF${lines.join('\n')}`;
}
