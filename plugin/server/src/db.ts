/**
 * 存储层：node:sqlite（DSH Host Node 22.x 内置）+ 版本化 migration。
 *
 * 纪律（PRD §7.4 / 旧 fund migration 纪律）：
 * - WAL + 外键开启；
 * - schema 版本记录在 meta 表；数据版本高于运行时 → 拒绝打开（先升插件，不降级写）；
 * - 迁移前先备份 db 文件，失败恢复备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION } from '../../core/src/types.ts';

export interface StateDirs {
  root: string;
  data: string;
  cache: string;
  logs: string;
}

export interface DbHandle {
  db: DatabaseSync;
  dirs: StateDirs;
  engine: 'sqlite';
  schemaVersion: number;
  isNew: boolean;
}

export class SchemaError extends Error {
  override name = 'SchemaError';
  code: string;
  detail: Record<string, unknown>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export function resolveStateDirs(env: NodeJS.ProcessEnv = process.env): StateDirs {
  const root = env.PLUG_FUNDS_STATE_DIR
    ?? path.join(env.HOME ?? '', '.plug-funds');
  return {
    root,
    data: path.join(root, 'data'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
  };
}

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT '',
        currency TEXT NOT NULL DEFAULT 'CNY',
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE instruments (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        market TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CNY',
        benchmark_index TEXT,
        secid TEXT,
        fund_code TEXT,
        tag TEXT NOT NULL DEFAULT '',
        founded_date TEXT,
        scale_info TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (code, type, market)
      );
      CREATE TABLE categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE instrument_category_links (
        instrument_id TEXT NOT NULL REFERENCES instruments(id),
        category_id TEXT NOT NULL REFERENCES categories(id),
        PRIMARY KEY (instrument_id, category_id)
      );
      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        instrument_id TEXT NOT NULL REFERENCES instruments(id),
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CONFIRMED',
        trade_date TEXT NOT NULL,
        seq INTEGER NOT NULL,
        quantity TEXT,
        price TEXT,
        amount TEXT,
        fee TEXT,
        tax TEXT,
        note TEXT NOT NULL DEFAULT '',
        request_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_txn_lookup ON transactions (account_id, instrument_id, trade_date);
      CREATE UNIQUE INDEX idx_txn_request ON transactions (request_id) WHERE request_id IS NOT NULL;
      CREATE TABLE market_data (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL REFERENCES instruments(id),
        price_type TEXT NOT NULL,
        value TEXT NOT NULL,
        trading_date TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        quality TEXT NOT NULL,
        UNIQUE (instrument_id, price_type, trading_date, provider)
      );
      CREATE INDEX idx_market_lookup ON market_data (instrument_id, price_type, trading_date);
      CREATE TABLE valuation_metrics (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL REFERENCES instruments(id),
        metric_key TEXT NOT NULL,
        value TEXT,
        as_of_date TEXT NOT NULL,
        provider TEXT NOT NULL,
        quality TEXT NOT NULL,
        UNIQUE (instrument_id, metric_key, as_of_date)
      );
      CREATE TABLE portfolio_goals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_amount TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CNY',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE portfolio_goal_events (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES portfolio_goals(id),
        old_amount TEXT,
        new_amount TEXT NOT NULL,
        changed_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE portfolio_cash_flows (
        id TEXT PRIMARY KEY,
        flow_type TEXT NOT NULL,
        flow_date TEXT NOT NULL,
        amount TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ai_analysis_records (
        id TEXT PRIMARY KEY,
        instrument_id TEXT NOT NULL,
        model TEXT NOT NULL,
        source TEXT NOT NULL,
        prompt_scope TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE deleted_positions (
        account_id TEXT NOT NULL,
        instrument_id TEXT NOT NULL,
        deleted_at TEXT NOT NULL,
        PRIMARY KEY (account_id, instrument_id)
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE strategy_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        origin TEXT NOT NULL DEFAULT 'custom',
        current_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE strategy_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES strategy_templates(id),
        version INTEGER NOT NULL,
        rules_json TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (template_id, version)
      );
      CREATE TABLE portfolio_snapshots (
        id TEXT PRIMARY KEY,
        snapshot_date TEXT NOT NULL UNIQUE,
        total_market_value TEXT NOT NULL,
        total_cost TEXT NOT NULL,
        realized TEXT NOT NULL DEFAULT '0',
        dividends TEXT NOT NULL DEFAULT '0',
        positions INTEGER NOT NULL DEFAULT 0,
        coverage REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE holding_snapshots (
        id TEXT PRIMARY KEY,
        snapshot_date TEXT NOT NULL,
        account_id TEXT NOT NULL,
        instrument_id TEXT NOT NULL,
        qty TEXT NOT NULL,
        cost_total TEXT NOT NULL,
        market_value TEXT,
        price TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (snapshot_date, account_id, instrument_id)
      );
      CREATE INDEX idx_holding_snapshot_date ON holding_snapshots (snapshot_date);
      CREATE TABLE data_source_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        instruments INTEGER NOT NULL DEFAULT 0,
        ok INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT ''
      );
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE cash_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'CNY',
        balance TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_cash_active ON cash_accounts (active);
      CREATE TABLE rebalance_targets (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL UNIQUE,
        target_weight REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];

function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    return row ? Number(row.value) : null;
  } catch {
    return null;
  }
}

function backupFile(file: string, dirs: StateDirs): string {
  const backupDir = path.join(dirs.data, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDir, `pre-migration-${stamp}.db`);
  fs.copyFileSync(file, target);
  return target;
}

/**
 * 打开（并按需初始化 / 迁移）状态库。
 * 数据 schema 高于运行时 → SchemaError('schema-too-new')，不打开不写入。
 */
export function openState(dirs: StateDirs = resolveStateDirs(), opts: { inMemory?: boolean } = {}): DbHandle {
  fs.mkdirSync(dirs.data, { recursive: true });
  fs.mkdirSync(dirs.cache, { recursive: true });
  fs.mkdirSync(dirs.logs, { recursive: true });
  const file = path.join(dirs.data, 'invest.db');
  const existed = opts.inMemory ? false : fs.existsSync(file);
  const db = new DatabaseSync(opts.inMemory ? ':memory:' : file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

  const recorded = readSchemaVersion(db);
  if (recorded !== null && recorded > SCHEMA_VERSION) {
    db.close();
    throw new SchemaError(
      'schema-too-new',
      `数据由更新版本写入（schema ${recorded} > 插件 ${SCHEMA_VERSION}）；请先升级插件`,
      { recorded, runtime: SCHEMA_VERSION },
    );
  }

  let applied = 0;
  if (recorded === null) {
    db.exec('INSERT INTO meta (key, value) VALUES (\'schema_version\', \'0\');');
  }
  const current = recorded ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (!opts.inMemory && existed) backupFile(file, dirs);
    db.exec('BEGIN;');
    try {
      db.exec(migration.sql);
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(migration.version));
      db.exec('COMMIT;');
      applied += 1;
    } catch (error) {
      db.exec('ROLLBACK;');
      db.close();
      throw new SchemaError('migration-failed', `migration v${migration.version} 失败: ${String(error)}`);
    }
  }
  return { db, dirs, engine: 'sqlite', schemaVersion: SCHEMA_VERSION, isNew: recorded === null && applied > 0 };
}

export function closeState(handle: DbHandle): void {
  handle.db.close();
}
