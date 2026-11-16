/**
 * JSON 全量备份恢复（PRD §4.8）：先校验 / 预览，再在单事务内替换账本。
 * 恢复前自动备份当前 invest.db；任何一步失败整批回滚，绝不留下半套数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_VERSION } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { newId, nowIso } from '../ids.ts';

const ARRAY_FIELDS = [
  'accounts', 'instruments', 'transactions', 'categories', 'categoryLinks',
  'marketData', 'valuationMetrics', 'goals', 'cashFlows', 'aiRecords',
  'deletedPositions', 'strategyTemplates', 'strategyVersions',
] as const;

export interface RestorePreview {
  ok: boolean;
  kind: string | null;
  schemaVersion: number | null;
  exportedAt: string | null;
  counts: Record<string, number>;
  warnings: string[];
  errors: string[];
}

function asArray(payload: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') as Record<string, unknown>[] : [];
}

export function previewRestore(payload: unknown): RestorePreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, kind: null, schemaVersion: null, exportedAt: null, counts: {}, warnings, errors: ['不是合法的 JSON 备份对象'] };
  }
  const data = payload as Record<string, unknown>;
  const kind = typeof data.kind === 'string' ? data.kind : null;
  if (kind !== 'plug-funds-backup') errors.push(`备份标识不匹配：${kind ?? '（缺失）'}`);
  const schemaVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : null;
  if (schemaVersion === null) errors.push('缺少 schemaVersion');
  else if (schemaVersion > SCHEMA_VERSION) errors.push(`备份由更新版本写入（schema ${schemaVersion} > 插件 ${SCHEMA_VERSION}），请先升级插件`);
  else if (schemaVersion < SCHEMA_VERSION) warnings.push(`备份来自 schema v${schemaVersion}，当前 v${SCHEMA_VERSION}；缺失的新表将为空`);
  for (const key of ARRAY_FIELDS) {
    if (data[key] === undefined) warnings.push(`备份缺少 ${key}（按空数据处理）`);
    else if (!Array.isArray(data[key])) errors.push(`${key} 不是数组`);
  }
  const counts: Record<string, number> = {};
  for (const key of ARRAY_FIELDS) counts[key] = asArray(data, key).length;
  return {
    ok: errors.length === 0,
    kind, schemaVersion,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    counts, warnings, errors,
  };
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function backupCurrentDb(ctx: ServiceContext): string | null {
  const file = path.join(ctx.dirs.data, 'invest.db');
  if (!fs.existsSync(file)) return null;
  const backupDir = path.join(ctx.dirs.data, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const target = path.join(backupDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  fs.copyFileSync(file, target);
  return target;
}

export function restoreBackup(ctx: ServiceContext, payload: unknown): {
  restored: Record<string, number>;
  backupPath: string | null;
  note: string;
} {
  const preview = previewRestore(payload);
  if (!preview.ok) throw new ValidationError(`备份校验失败：${preview.errors.join('；')}`);
  const data = payload as Record<string, unknown>;
  const handle = ctx.handle;
  const backupPath = backupCurrentDb(ctx);
  const restored: Record<string, number> = {};

  handle.db.exec('BEGIN;');
  try {
    // 先清子表，再清父表（外键开启）
    for (const table of [
      'instrument_category_links', 'transactions', 'market_data', 'valuation_metrics',
      'portfolio_goal_events', 'portfolio_cash_flows', 'ai_analysis_records',
      'deleted_positions', 'strategy_versions', 'holding_snapshots',
      'categories', 'instruments', 'accounts', 'portfolio_goals',
      'strategy_templates', 'portfolio_snapshots', 'data_source_runs',
    ]) {
      handle.db.prepare(`DELETE FROM ${table}`).run();
    }

    const insert = (sql: string, rows: Record<string, unknown>[], key: string, mapper: (row: Record<string, unknown>) => unknown[]): void => {
      const stmt = handle.db.prepare(sql);
      for (const row of rows) stmt.run(...mapper(row));
      restored[key] = rows.length;
    };

    insert(`INSERT INTO accounts (id,name,platform,currency,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      asArray(data, 'accounts'), 'accounts',
      (r) => [str(r.id) || newId(), str(r.name), str(r.platform), str(r.currency, 'CNY'), str(r.status, 'ACTIVE'), str(r.note), str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]);

    insert(`INSERT INTO instruments (id,code,name,type,market,currency,benchmark_index,secid,fund_code,tag,founded_date,scale_info,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asArray(data, 'instruments'), 'instruments',
      (r) => [str(r.id) || newId(), str(r.code), str(r.name), str(r.type, 'STOCK'), str(r.market, 'SH'), str(r.currency, 'CNY'),
        typeof r.benchmarkIndex === 'string' ? r.benchmarkIndex : null,
        typeof r.secid === 'string' ? r.secid : null,
        typeof r.fundCode === 'string' ? r.fundCode : null,
        str(r.tag), typeof r.foundedDate === 'string' ? r.foundedDate : null,
        typeof r.scaleInfo === 'string' ? r.scaleInfo : null,
        r.active === false ? 0 : 1, str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]);

    insert(`INSERT INTO categories (id,name,color,sort_order,created_at) VALUES (?,?,?,?,?)`,
      asArray(data, 'categories'), 'categories',
      (r) => [str(r.id) || newId(), str(r.name), str(r.color, '#3d6ef2'), num(r.sortOrder), str(r.createdAt, nowIso())]);

    insert(`INSERT INTO instrument_category_links (instrument_id,category_id) VALUES (?,?)`,
      asArray(data, 'categoryLinks'), 'categoryLinks',
      (r) => [str(r.instrumentId), str(r.categoryId)]);

    insert(`INSERT INTO transactions (id,account_id,instrument_id,type,status,trade_date,seq,quantity,price,amount,fee,tax,note,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asArray(data, 'transactions'), 'transactions',
      (r) => [str(r.id) || newId(), str(r.accountId), str(r.instrumentId), str(r.type), str(r.status, 'CONFIRMED'), str(r.tradeDate),
        num(r.seq), r.quantity ?? null, r.price ?? null, r.amount ?? null, r.fee ?? null, r.tax ?? null, str(r.note),
        typeof r.requestId === 'string' ? r.requestId : null, str(r.createdAt, nowIso())]);

    insert(`INSERT INTO market_data (id,instrument_id,price_type,value,trading_date,observed_at,provider,quality) VALUES (?,?,?,?,?,?,?,?)`,
      asArray(data, 'marketData'), 'marketData',
      (r) => [newId(), str(r.instrumentId), str(r.priceType), str(r.value), str(r.tradingDate), str(r.observedAt, nowIso()), str(r.provider, 'restore'), str(r.quality, 'STALE')]);

    insert(`INSERT INTO valuation_metrics (id,instrument_id,metric_key,value,as_of_date,provider,quality) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, 'valuationMetrics'), 'valuationMetrics',
      (r) => [newId(), str(r.instrumentId), str(r.metricKey), typeof r.value === 'string' ? r.value : null, str(r.asOfDate), str(r.provider, 'restore'), str(r.quality, 'STALE')]);

    insert(`INSERT INTO portfolio_goals (id,name,target_amount,currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, 'goals'), 'goals',
      (r) => [str(r.id) || newId(), str(r.name), str(r.targetAmount, '0'), str(r.currency, 'CNY'), r.enabled === true ? 1 : 0, str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]);

    insert(`INSERT INTO portfolio_cash_flows (id,flow_type,flow_date,amount,note,created_at) VALUES (?,?,?,?,?,?)`,
      asArray(data, 'cashFlows'), 'cashFlows',
      (r) => [str(r.id) || newId(), str(r.flowType, 'CONTRIBUTION'), str(r.flowDate), str(r.amount, '0'), str(r.note), str(r.createdAt, nowIso())]);

    insert(`INSERT INTO ai_analysis_records (id,instrument_id,model,source,prompt_scope,result,created_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, 'aiRecords'), 'aiRecords',
      (r) => [newId(), str(r.instrumentId), str(r.model), str(r.source, 'REAL'), str(r.promptScope), str(r.result), str(r.createdAt, nowIso())]);

    insert(`INSERT INTO deleted_positions (account_id,instrument_id,deleted_at) VALUES (?,?,?)`,
      asArray(data, 'deletedPositions'), 'deletedPositions',
      (r) => [str(r.accountId), str(r.instrumentId), str(r.deletedAt, nowIso())]);

    insert(`INSERT INTO strategy_templates (id,name,scope,origin,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, 'strategyTemplates'), 'strategyTemplates',
      (r) => [str(r.id) || newId(), str(r.name), str(r.scope), str(r.origin, 'custom'), num(r.currentVersion, 1), str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]);

    insert(`INSERT INTO strategy_versions (id,template_id,version,rules_json,note,created_at) VALUES (?,?,?,?,?,?)`,
      asArray(data, 'strategyVersions'), 'strategyVersions',
      (r) => [str(r.id) || newId(), str(r.templateId), num(r.version, 1), str(r.rulesJson, '[]'), str(r.note), str(r.createdAt, nowIso())]);

    // 外键与回放一致性校验（不完整备份会在此回滚）
    const orphan = handle.db.prepare(
      'SELECT COUNT(*) AS n FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN instruments i ON i.id=t.instrument_id WHERE a.id IS NULL OR i.id IS NULL',
    ).get() as { n: number };
    if (orphan.n > 0) throw new ValidationError(`备份不完整：${orphan.n} 条流水缺少账户或标的`);
    handle.db.exec('COMMIT;');
  } catch (error) {
    handle.db.exec('ROLLBACK;');
    throw error;
  }
  return {
    restored,
    backupPath,
    note: '恢复为替换式（当前账本已被备份后替换）；事务失败时自动回滚，未改动任何数据。',
  };
}
