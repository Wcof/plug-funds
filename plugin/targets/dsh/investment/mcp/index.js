/*
 * 个人投资工作站 · MCP 适配层（构建产物，勿手改）
 * 自包含 ESM：仅依赖 node: 内置模块；源码在 plugin/targets/mcp/server.ts。
 */

// plugin/targets/mcp/server.ts
import { createInterface } from "node:readline";

// plugin/server/src/db.ts
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// plugin/core/src/types.ts
var SCHEMA_VERSION = 3;

// plugin/server/src/db.ts
var SchemaError = class extends Error {
  name = "SchemaError";
  code;
  detail;
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
};
function resolveStateDirs(env = process.env) {
  const root = env.PLUG_FUNDS_STATE_DIR ?? path.join(env.HOME ?? "", ".plug-funds");
  return {
    root,
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    logs: path.join(root, "logs")
  };
}
var MIGRATIONS = [
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
    `
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
    `
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
    `
  }
];
function readSchemaVersion(db) {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    return row ? Number(row.value) : null;
  } catch {
    return null;
  }
}
function backupFile(file, dirs) {
  const backupDir = path.join(dirs.data, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const target = path.join(backupDir, `pre-migration-${stamp}.db`);
  fs.copyFileSync(file, target);
  return target;
}
function openState(dirs = resolveStateDirs(), opts = {}) {
  fs.mkdirSync(dirs.data, { recursive: true });
  fs.mkdirSync(dirs.cache, { recursive: true });
  fs.mkdirSync(dirs.logs, { recursive: true });
  const file = path.join(dirs.data, "invest.db");
  const existed = opts.inMemory ? false : fs.existsSync(file);
  const db = new DatabaseSync(opts.inMemory ? ":memory:" : file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const recorded = readSchemaVersion(db);
  if (recorded !== null && recorded > SCHEMA_VERSION) {
    db.close();
    throw new SchemaError(
      "schema-too-new",
      `\u6570\u636E\u7531\u66F4\u65B0\u7248\u672C\u5199\u5165\uFF08schema ${recorded} > \u63D2\u4EF6 ${SCHEMA_VERSION}\uFF09\uFF1B\u8BF7\u5148\u5347\u7EA7\u63D2\u4EF6`,
      { recorded, runtime: SCHEMA_VERSION }
    );
  }
  let applied = 0;
  if (recorded === null) {
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '0');");
  }
  const current = recorded ?? 0;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (!opts.inMemory && existed) backupFile(file, dirs);
    db.exec("BEGIN;");
    try {
      db.exec(migration.sql);
      db.prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`).run(String(migration.version));
      db.exec("COMMIT;");
      applied += 1;
    } catch (error) {
      db.exec("ROLLBACK;");
      db.close();
      throw new SchemaError("migration-failed", `migration v${migration.version} \u5931\u8D25: ${String(error)}`);
    }
  }
  return { db, dirs, engine: "sqlite", schemaVersion: SCHEMA_VERSION, isNew: recorded === null && applied > 0 };
}

// plugin/server/src/api.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// plugin/core/src/rpc.ts
function ok(traceId, data) {
  return { success: true, data, traceId };
}
function fail(traceId, code, message, extra) {
  return { success: false, error: { code, message, extra }, traceId };
}

// plugin/core/src/money.ts
var SCALE_AMOUNT = 2;
var SCALE_QTY = 4;
var POW10 = {
  0: 1,
  1: 10,
  2: 100,
  3: 1e3,
  4: 1e4,
  5: 1e5,
  6: 1e6,
  7: 1e7,
  8: 1e8,
  9: 1e9,
  10: 1e10,
  11: 1e11
};
function pow10(scale) {
  const p = POW10[scale];
  if (p === void 0) throw new RangeError(`unsupported scale: ${scale}`);
  return p;
}
var PrecisionError = class extends Error {
  name = "PrecisionError";
  constructor(message = "\u5C0F\u6570\u4F4D\u8D85\u51FA\u76EE\u6807\u7CBE\u5EA6\u4E14\u5B58\u5728\u975E\u96F6\u5C3E\u6570") {
    super(message);
  }
};
var FixedRangeError = class extends Error {
  name = "FixedRangeError";
  constructor(message = "\u6570\u503C\u8D85\u51FA\u5B89\u5168\u6574\u6570\u8303\u56F4") {
    super(message);
  }
};
function assertSafe(raw) {
  if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new FixedRangeError(`\u975E\u6574\u6570\u5B9A\u70B9\u503C: ${String(raw)}`);
  }
  if (Math.abs(raw) > Number.MAX_SAFE_INTEGER) {
    throw new FixedRangeError(`\u8D85\u51FA\u5B89\u5168\u6574\u6570\u8303\u56F4: ${String(raw)}`);
  }
  return raw;
}
function truncDiv(a, b) {
  assertSafe(a);
  assertSafe(b);
  if (b === 0) throw new RangeError("\u9664\u6570\u4E3A 0");
  const q = Math.trunc(a / b);
  const remainder = a - q * b;
  if (Math.abs(remainder) >= Math.abs(b)) {
    const sign = (a < 0 ? -1 : 1) * (b < 0 ? -1 : 1);
    return assertSafe(q + sign);
  }
  return assertSafe(q);
}
function parseFixed(text, scale) {
  const s = String(text).trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) {
    throw new PrecisionError(`\u975E\u6CD5\u5B9A\u70B9\u5B57\u7B26\u4E32: ${JSON.stringify(text)}`);
  }
  const negative = s.startsWith("-");
  const unsigned = s.replace(/^[+-]/, "");
  const [intPart, decPart = ""] = unsigned.split(".");
  let raw;
  if (decPart.length <= scale) {
    raw = Number(intPart) * pow10(scale) + Number(decPart.padEnd(scale, "0"));
  } else {
    if (/[^0]/.test(decPart.slice(scale))) {
      throw new PrecisionError(`\u8D85\u51FA ${scale} \u4F4D\u7CBE\u5EA6: ${text}`);
    }
    raw = Number(intPart) * pow10(scale) + Number(decPart.slice(0, scale));
  }
  return assertSafe(negative ? -raw : raw);
}
function formatFixed(raw, scale) {
  assertSafe(raw);
  const negative = raw < 0;
  const abs = Math.abs(raw);
  const p = pow10(scale);
  const int = Math.floor(abs / p);
  let dec = String(abs % p).padStart(scale, "0");
  dec = dec.replace(/0+$/, "");
  if (scale === 0) return negative ? String(-int) : String(int);
  return `${negative ? "-" : ""}${int}${dec ? `.${dec}` : ""}`;
}
function addFixed(aRaw, bRaw, scale) {
  assertSafe(aRaw + bRaw);
  return aRaw + bRaw;
}
function subFixed(aRaw, bRaw, scale) {
  return addFixed(aRaw, -bRaw, scale);
}
function mulToScale(aRaw, bRaw, outScale, inScales) {
  const prod = aRaw * bRaw;
  assertSafe(prod);
  return truncDiv(prod, pow10(inScales - outScale));
}
function divToScale(aRaw, aScale, bRaw, bScale, outScale) {
  if (bRaw === 0) throw new RangeError("\u9664\u6570\u4E3A 0");
  const scaleDiff = outScale + bScale - aScale;
  if (scaleDiff < 0) return truncDiv(aRaw, bRaw * pow10(-scaleDiff));
  return truncDiv(aRaw * pow10(scaleDiff), bRaw);
}

// plugin/core/src/ledger.ts
var LedgerError = class extends Error {
  name = "LedgerError";
  code;
  detail;
  constructor(code, message, detail = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
};
var Q = (text) => text == null ? 0 : parseFixed(text, SCALE_QTY);
var A = (text) => text == null ? 0 : parseFixed(text, SCALE_AMOUNT);
function keyOf(accountId, instrumentId) {
  return `${accountId}:${instrumentId}`;
}
function emptyPosition(accountId, instrumentId) {
  return {
    accountId,
    instrumentId,
    qtyRaw: 0,
    costTotalRaw: 0,
    unitCostRaw: 0,
    realizedRaw: 0,
    dividendsRaw: 0,
    adjustmentRaw: 0,
    lastEventDate: null
  };
}
function sortTxns(txns) {
  return [...txns].filter((t) => t.status === "CONFIRMED").sort((a, b) => a.tradeDate === b.tradeDate ? a.seq - b.seq : a.tradeDate < b.tradeDate ? -1 : 1);
}
function replayPositions(txns) {
  const out = /* @__PURE__ */ new Map();
  for (const t of sortTxns(txns)) {
    const key = keyOf(t.accountId, t.instrumentId);
    const pos = out.get(key) ?? emptyPosition(t.accountId, t.instrumentId);
    applyTxn(pos, t);
    out.set(key, pos);
  }
  return out;
}
function applyTxn(pos, t) {
  const at = (text) => {
    throw new LedgerError("invalid-txn", `${text}\uFF08\u4EA4\u6613 ${t.id}\uFF09`, { txnId: t.id, type: t.type });
  };
  pos.lastEventDate = t.tradeDate;
  switch (t.type) {
    case "OPENING": {
      const qty = Q(t.quantity);
      const cost = A(t.amount);
      if (qty <= 0 || cost < 0) at("\u671F\u521D\u5EFA\u8D26\u9700\u8981\u6B63\u6570\u91CF\u4E0E\u975E\u8D1F\u603B\u6210\u672C");
      pos.qtyRaw = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = addFixed(pos.costTotalRaw, cost, SCALE_AMOUNT);
      if (pos.qtyRaw > 0) {
        pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      }
      break;
    }
    case "BUY": {
      const qty = Q(t.quantity);
      const price = Q(t.price);
      const fee = A(t.fee);
      const tax = A(t.tax);
      if (qty <= 0 || price < 0 || fee < 0 || tax < 0) at("\u4E70\u5165\u9700\u8981\u6B63\u6570\u91CF\u4E0E\u975E\u8D1F\u4EF7\u683C/\u8D39\u7528");
      const buyCost = addFixed(addFixed(mulToScale(price, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY), fee, SCALE_AMOUNT), tax, SCALE_AMOUNT);
      const newQty = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      const newCost = addFixed(pos.costTotalRaw, buyCost, SCALE_AMOUNT);
      pos.qtyRaw = newQty;
      pos.costTotalRaw = newCost;
      pos.unitCostRaw = newQty === 0 ? 0 : divToScale(newCost, SCALE_AMOUNT, newQty, SCALE_QTY, SCALE_QTY);
      break;
    }
    case "SELL": {
      const qty = Q(t.quantity);
      const price = Q(t.price);
      const fee = A(t.fee);
      const tax = A(t.tax);
      if (qty <= 0 || price < 0) at("\u5356\u51FA\u9700\u8981\u6B63\u6570\u91CF\u4E0E\u975E\u8D1F\u4EF7\u683C");
      if (qty > pos.qtyRaw) {
        throw new LedgerError("oversell", "\u5356\u51FA\u6570\u91CF\u8D85\u8FC7\u53EF\u7528\u6301\u4ED3\uFF0C\u5DF2\u62D2\u7EDD", {
          txnId: t.id,
          requested: qty,
          available: pos.qtyRaw
        });
      }
      const gross = mulToScale(price, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
      const net = subFixed(subFixed(gross, fee, SCALE_AMOUNT), tax, SCALE_AMOUNT);
      const costBasis = mulToScale(pos.unitCostRaw, qty, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
      pos.realizedRaw = addFixed(pos.realizedRaw, net - costBasis, SCALE_AMOUNT);
      pos.qtyRaw = subFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = subFixed(pos.costTotalRaw, costBasis, SCALE_AMOUNT);
      if (pos.qtyRaw === 0) pos.unitCostRaw = 0;
      break;
    }
    case "DIVIDEND_CASH": {
      const amount = A(t.amount);
      if (amount <= 0) at("\u73B0\u91D1\u5206\u7EA2\u9700\u8981\u6B63\u91D1\u989D");
      pos.dividendsRaw = addFixed(pos.dividendsRaw, amount, SCALE_AMOUNT);
      break;
    }
    case "DIVIDEND_REINVEST": {
      const qty = Q(t.quantity);
      const amount = A(t.amount);
      if (qty <= 0 || amount <= 0) at("\u7EA2\u5229\u518D\u6295\u9700\u8981\u6B63\u4EFD\u989D\u4E0E\u6B63\u91D1\u989D");
      pos.qtyRaw = addFixed(pos.qtyRaw, qty, SCALE_QTY);
      pos.costTotalRaw = addFixed(pos.costTotalRaw, amount, SCALE_AMOUNT);
      pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    case "FEE": {
      const fee = A(t.amount);
      pos.adjustmentRaw = addFixed(pos.adjustmentRaw, fee, SCALE_AMOUNT);
      if (pos.qtyRaw > 0) {
        pos.costTotalRaw = addFixed(pos.costTotalRaw, fee, SCALE_AMOUNT);
        pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      }
      break;
    }
    case "SPLIT": {
      const factor = Q(t.quantity);
      if (factor <= 0) at("\u62C6\u5206\u7CFB\u6570\u5FC5\u987B\u4E3A\u6B63");
      pos.qtyRaw = truncDiv(pos.qtyRaw * factor, 1e4);
      pos.unitCostRaw = pos.qtyRaw === 0 ? 0 : divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    case "CORRECTION": {
      const qtyDelta = Q(t.quantity);
      const costDelta = A(t.amount);
      const newQty = addFixed(pos.qtyRaw, qtyDelta, SCALE_QTY);
      if (newQty < 0) at("\u4FEE\u6B63\u540E\u6301\u4ED3\u4E3A\u8D1F");
      pos.qtyRaw = newQty;
      pos.costTotalRaw = addFixed(pos.costTotalRaw, costDelta, SCALE_AMOUNT);
      if (pos.qtyRaw === 0) pos.unitCostRaw = 0;
      else pos.unitCostRaw = divToScale(pos.costTotalRaw, SCALE_AMOUNT, pos.qtyRaw, SCALE_QTY, SCALE_QTY);
      break;
    }
    default:
      at("\u672A\u77E5\u4EA4\u6613\u7C7B\u578B");
  }
  if (pos.costTotalRaw < 0) {
    throw new LedgerError("negative-cost", "\u6301\u4ED3\u603B\u6210\u672C\u4E3A\u8D1F\uFF0C\u5DF2\u62D2\u7EDD", { txnId: t.id, costTotalRaw: pos.costTotalRaw });
  }
}
function unrealizedRaw(pos, priceRaw) {
  if (pos.qtyRaw === 0) return 0;
  const mv = mulToScale(priceRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY + SCALE_QTY);
  return mv - pos.costTotalRaw;
}

// plugin/core/src/valuation.ts
function percentile(series, current) {
  const valid = series.filter((v) => Number.isFinite(v));
  if (valid.length === 0) return null;
  let count = 0;
  for (const v of valid) if (v <= current) count += 1;
  return 100 * count / valid.length;
}
function dailyReturns(nav) {
  const out = [];
  for (let i = 1; i < nav.length; i += 1) {
    const prev = nav[i - 1];
    if (prev > 0 && Number.isFinite(nav[i])) out.push(nav[i] / prev - 1);
  }
  return out;
}
function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function stdev(values) {
  if (values.length < 2) return null;
  const first = values[0];
  if (values.every((v) => v === first)) return 0;
  const m2 = mean(values);
  const ss = values.reduce((acc, v) => acc + (v - m2) * (v - m2), 0);
  return Math.sqrt(ss / (values.length - 1));
}
function sharpeRatio(dailyReturnsSeries, options = {}) {
  const { rfAnnual = 0.015, periodsPerYear = 252, minSamples = 30 } = options;
  if (dailyReturnsSeries.length < minSamples) return null;
  const sd = stdev(dailyReturnsSeries);
  if (sd === null || sd < 1e-12) return null;
  const rfDaily = rfAnnual / periodsPerYear;
  const excess = mean(dailyReturnsSeries) - rfDaily;
  return excess / sd * Math.sqrt(periodsPerYear);
}
function annualVolatility(dailyReturnsSeries, options = {}) {
  const { periodsPerYear = 252, minSamples = 30 } = options;
  if (dailyReturnsSeries.length < minSamples) return null;
  const sd = stdev(dailyReturnsSeries);
  if (sd === null) return null;
  return sd * Math.sqrt(periodsPerYear);
}
function maxDrawdown(navSeries) {
  if (navSeries.length < 2) return null;
  let peak = navSeries[0];
  let mdd = 0;
  for (const v of navSeries) {
    if (!Number.isFinite(v)) continue;
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}
function xirr(flows) {
  const sorted = flows.filter((f) => Number.isFinite(f.amount) && f.amount !== 0).map((f) => ({ t: Date.parse(`${f.date}T00:00:00Z`) / 864e5, cf: f.amount })).sort((a, b) => a.t - b.t);
  if (sorted.length < 2) return null;
  const t0 = sorted[0].t;
  const years = sorted.map((f) => ({ dt: (f.t - t0) / 365, cf: f.cf }));
  const npv = (rate) => years.reduce((acc, f) => acc + f.cf / Math.pow(1 + rate, f.dt), 0);
  const hasNegative = years.some((f) => f.cf < 0);
  const hasPositive = years.some((f) => f.cf > 0);
  if (!hasNegative || !hasPositive) return null;
  let low = -0.9999;
  let high = 10;
  let fLow = npv(low);
  let fHigh = npv(high);
  if (fLow === 0) return low;
  if (fHigh === 0) return high;
  if (fLow * fHigh > 0) return null;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const fMid = npv(mid);
    if (fMid === 0) return mid;
    if (fLow * fMid < 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return (low + high) / 2;
}
function periodReturn(navSeries) {
  const first = navSeries.find((v) => Number.isFinite(v) && v > 0);
  if (first === void 0) return null;
  const last = [...navSeries].reverse().find((v) => Number.isFinite(v) && v > 0);
  if (last === void 0 || last === first) return null;
  return last / first - 1;
}

// plugin/server/src/errors.ts
var ValidationError = class extends Error {
  code = "validation-error";
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
var NotFoundError = class extends Error {
  code = "not-found";
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
  }
};

// plugin/server/src/ids.ts
import { randomUUID } from "node:crypto";
function newId() {
  return randomUUID();
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function todayLocal() {
  const d = /* @__PURE__ */ new Date();
  const pad2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// plugin/server/src/repo/accounts.ts
function toAccount(row) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    currency: row.currency,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function listAccounts(handle2, status) {
  const rows = status ? handle2.db.prepare("SELECT * FROM accounts WHERE status = ? ORDER BY created_at").all(status) : handle2.db.prepare("SELECT * FROM accounts ORDER BY created_at").all();
  return rows.map(toAccount);
}
function getAccount(handle2, id) {
  const row = handle2.db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  return row ? toAccount(row) : null;
}
function saveAccount(handle2, input) {
  const now = nowIso();
  if (input.id) {
    const existing = getAccount(handle2, input.id);
    if (!existing) throw new Error(`account not found: ${input.id}`);
    handle2.db.prepare("UPDATE accounts SET name = ?, platform = ?, note = ?, status = ?, updated_at = ? WHERE id = ?").run(
      input.name.trim(),
      input.platform ?? existing.platform,
      input.note ?? existing.note,
      input.status ?? existing.status,
      now,
      input.id
    );
    return getAccount(handle2, input.id);
  }
  const id = newId();
  handle2.db.prepare("INSERT INTO accounts (id, name, platform, currency, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, input.name.trim(), input.platform ?? "", "CNY", input.status ?? "ACTIVE", input.note ?? "", now, now);
  return getAccount(handle2, id);
}
function archiveAccount(handle2, id) {
  const existing = getAccount(handle2, id);
  if (!existing) throw new Error(`account not found: ${id}`);
  handle2.db.prepare("UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?").run("ARCHIVED", nowIso(), id);
  return getAccount(handle2, id);
}

// plugin/server/src/repo/instruments.ts
function toInstrument(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    market: row.market,
    currency: row.currency,
    benchmarkIndex: row.benchmark_index,
    secid: row.secid,
    fundCode: row.fund_code,
    tag: row.tag,
    foundedDate: row.founded_date,
    scaleInfo: row.scale_info,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function listInstruments(handle2, opts = {}) {
  const clauses = [];
  const args = [];
  if (opts.active !== void 0) {
    clauses.push("active = ?");
    args.push(opts.active ? 1 : 0);
  }
  if (opts.type) {
    clauses.push("type = ?");
    args.push(opts.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = handle2.db.prepare(`SELECT * FROM instruments ${where} ORDER BY code`).all(...args);
  return rows.map(toInstrument);
}
function getInstrument(handle2, id) {
  const row = handle2.db.prepare("SELECT * FROM instruments WHERE id = ?").get(id);
  return row ? toInstrument(row) : null;
}
function findByCode(handle2, code, type, market) {
  const row = handle2.db.prepare("SELECT * FROM instruments WHERE code = ? AND type = ? AND market = ?").get(code, type, market);
  return row ? toInstrument(row) : null;
}
function searchInstruments(handle2, keyword) {
  const kw = `%${keyword.trim()}%`;
  const rows = handle2.db.prepare("SELECT * FROM instruments WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT 50").all(kw, kw);
  return rows.map(toInstrument);
}
function saveInstrument(handle2, input) {
  const now = nowIso();
  if (!/^\d{5,6}$/.test(input.code.trim())) {
    throw new Error(`invalid instrument code: ${input.code}`);
  }
  const code = input.code.trim();
  if (input.id) {
    const existing = getInstrument(handle2, input.id);
    if (!existing) throw new Error(`instrument not found: ${input.id}`);
    handle2.db.prepare(`UPDATE instruments SET name = ?, benchmark_index = ?, secid = ?, fund_code = ?, tag = ?, founded_date = ?, scale_info = ?, active = ?, updated_at = ? WHERE id = ?`).run(
      input.name.trim(),
      input.benchmarkIndex ?? existing.benchmarkIndex,
      input.secid ?? existing.secid,
      input.fundCode ?? existing.fundCode,
      input.tag ?? existing.tag,
      input.foundedDate ?? existing.foundedDate,
      input.scaleInfo ?? existing.scaleInfo,
      input.active ?? existing.active ? 1 : 0,
      now,
      input.id
    );
    return getInstrument(handle2, input.id);
  }
  const dup = findByCode(handle2, code, input.type, input.market);
  if (dup) return dup;
  const id = newId();
  handle2.db.prepare(`INSERT INTO instruments (id, code, name, type, market, currency, benchmark_index, secid, fund_code, tag, founded_date, scale_info, active, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    code,
    input.name.trim(),
    input.type,
    input.market,
    "CNY",
    input.benchmarkIndex ?? null,
    input.secid ?? null,
    input.fundCode ?? null,
    input.tag ?? "",
    input.foundedDate ?? null,
    input.scaleInfo ?? null,
    input.active ?? true ? 1 : 0,
    now,
    now
  );
  return getInstrument(handle2, id);
}

// plugin/server/src/repo/transactions.ts
function toTxn(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    instrumentId: row.instrument_id,
    type: row.type,
    status: row.status,
    tradeDate: row.trade_date,
    seq: row.seq,
    quantity: row.quantity,
    price: row.price,
    amount: row.amount,
    fee: row.fee,
    tax: row.tax,
    note: row.note,
    requestId: row.request_id,
    createdAt: row.created_at
  };
}
function listTransactions(handle2, filter = {}) {
  const clauses = [];
  const args = [];
  if (filter.accountId) {
    clauses.push("account_id = ?");
    args.push(filter.accountId);
  }
  if (filter.instrumentId) {
    clauses.push("instrument_id = ?");
    args.push(filter.instrumentId);
  }
  if (filter.type) {
    clauses.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    clauses.push("status = ?");
    args.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = handle2.db.prepare(`SELECT * FROM transactions ${where} ORDER BY trade_date DESC, seq DESC LIMIT 500`).all(...args);
  return rows.map(toTxn);
}
function allTransactions(handle2) {
  const rows = handle2.db.prepare("SELECT * FROM transactions").all();
  return rows.map(toTxn);
}
function getTransaction(handle2, id) {
  const row = handle2.db.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
  return row ? toTxn(row) : null;
}
function saveTransaction(handle2, input) {
  autoRestoreOnOpening(handle2, input);
  if (input.requestId) {
    const existing = handle2.db.prepare("SELECT * FROM transactions WHERE request_id = ?").get(input.requestId);
    if (existing) return { txn: toTxn(existing), deduplicated: true };
  }
  if (input.id) {
    const existing = getTransaction(handle2, input.id);
    if (!existing) throw new Error(`transaction not found: ${input.id}`);
    handle2.db.prepare(`UPDATE transactions SET type = ?, status = ?, trade_date = ?, quantity = ?, price = ?, amount = ?, fee = ?, tax = ?, note = ? WHERE id = ?`).run(
      input.type,
      input.status ?? existing.status,
      input.tradeDate,
      input.quantity ?? null,
      input.price ?? null,
      input.amount ?? null,
      input.fee ?? null,
      input.tax ?? null,
      input.note ?? existing.note,
      input.id
    );
    return { txn: getTransaction(handle2, input.id), deduplicated: false };
  }
  const seqRow = handle2.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM transactions WHERE trade_date = ?").get(input.tradeDate);
  const id = newId();
  handle2.db.prepare(`INSERT INTO transactions (id, account_id, instrument_id, type, status, trade_date, seq, quantity, price, amount, fee, tax, note, request_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    input.accountId,
    input.instrumentId,
    input.type,
    input.status ?? "CONFIRMED",
    input.tradeDate,
    seqRow.next,
    input.quantity ?? null,
    input.price ?? null,
    input.amount ?? null,
    input.fee ?? null,
    input.tax ?? null,
    input.note ?? "",
    input.requestId ?? null,
    nowIso()
  );
  return { txn: getTransaction(handle2, id), deduplicated: false };
}
function deletePosition(handle2, accountId, instrumentId) {
  handle2.db.prepare(`INSERT INTO deleted_positions (account_id, instrument_id, deleted_at) VALUES (?,?,?)
              ON CONFLICT (account_id, instrument_id) DO UPDATE SET deleted_at = excluded.deleted_at`).run(accountId, instrumentId, nowIso());
}
function restorePosition(handle2, accountId, instrumentId) {
  handle2.db.prepare("DELETE FROM deleted_positions WHERE account_id = ? AND instrument_id = ?").run(accountId, instrumentId);
}
function listDeletedPositions(handle2) {
  const rows = handle2.db.prepare("SELECT account_id, instrument_id FROM deleted_positions").all();
  return rows.map((r) => ({ accountId: r.account_id, instrumentId: r.instrument_id }));
}
function autoRestoreOnOpening(handle2, input) {
  if (!input.id && (input.type === "OPENING" || input.type === "BUY")) {
    restorePosition(handle2, input.accountId, input.instrumentId);
  }
}

// plugin/server/src/repo/categories.ts
function toCategory(row) {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order, createdAt: row.created_at };
}
function listCategories(handle2) {
  const rows = handle2.db.prepare("SELECT * FROM categories ORDER BY sort_order, created_at").all();
  return rows.map(toCategory);
}
function saveCategory(handle2, input) {
  if (input.id) {
    const existing = handle2.db.prepare("SELECT * FROM categories WHERE id = ?").get(input.id);
    if (!existing) throw new Error(`category not found: ${input.id}`);
    handle2.db.prepare("UPDATE categories SET name = ?, color = ? WHERE id = ?").run(input.name.trim(), input.color, input.id);
    return toCategory(handle2.db.prepare("SELECT * FROM categories WHERE id = ?").get(input.id));
  }
  const dup = handle2.db.prepare("SELECT id FROM categories WHERE name = ?").get(input.name.trim());
  if (dup) throw new Error("\u540C\u540D\u5206\u7C7B\u5DF2\u5B58\u5728");
  const id = newId();
  const maxRow = handle2.db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM categories").get();
  handle2.db.prepare("INSERT INTO categories (id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)").run(id, input.name.trim(), input.color, maxRow.next, nowIso());
  return toCategory(handle2.db.prepare("SELECT * FROM categories WHERE id = ?").get(id));
}
function deleteCategory(handle2, id) {
  handle2.db.prepare("DELETE FROM instrument_category_links WHERE category_id = ?").run(id);
  const result = handle2.db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  return Number(result.changes ?? 0) > 0;
}
function listLinks(handle2) {
  const rows = handle2.db.prepare("SELECT instrument_id, category_id FROM instrument_category_links").all();
  return rows.map((r) => ({ instrumentId: r.instrument_id, categoryId: r.category_id }));
}
function setInstrumentCategories(handle2, instrumentId, categoryIds) {
  const tx = handle2.db;
  tx.prepare("DELETE FROM instrument_category_links WHERE instrument_id = ?").run(instrumentId);
  const insert = tx.prepare("INSERT OR IGNORE INTO instrument_category_links (instrument_id, category_id) VALUES (?,?)");
  for (const categoryId of categoryIds) insert.run(instrumentId, categoryId);
}

// plugin/server/src/repo/goal.ts
function toGoal(row) {
  return {
    id: row.id,
    name: row.name,
    targetAmount: row.target_amount,
    currency: row.currency,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function listGoals(handle2) {
  const rows = handle2.db.prepare("SELECT * FROM portfolio_goals ORDER BY created_at").all();
  return rows.map(toGoal);
}
function getEnabledGoal(handle2) {
  const row = handle2.db.prepare("SELECT * FROM portfolio_goals WHERE enabled = 1 ORDER BY updated_at DESC LIMIT 1").get();
  return row ? toGoal(row) : null;
}
function saveGoal(handle2, input) {
  const amountRaw = parseFixed(input.targetAmount, SCALE_AMOUNT);
  if (amountRaw <= 0) throw new Error("\u76EE\u6807\u91D1\u989D\u5FC5\u987B\u5927\u4E8E 0");
  const amount = formatFixed(amountRaw, SCALE_AMOUNT);
  const now = nowIso();
  let goalId;
  let oldAmount = null;
  if (input.id) {
    const existingRow = handle2.db.prepare("SELECT * FROM portfolio_goals WHERE id = ?").get(input.id);
    if (!existingRow) throw new Error(`goal not found: ${input.id}`);
    const existing = toGoal(existingRow);
    oldAmount = existing.targetAmount;
    goalId = existing.id;
    handle2.db.prepare("UPDATE portfolio_goals SET name = ?, target_amount = ?, enabled = ?, updated_at = ? WHERE id = ?").run(input.name.trim(), amount, input.enabled ? 1 : 0, now, existing.id);
  } else {
    goalId = newId();
    handle2.db.prepare("INSERT INTO portfolio_goals (id, name, target_amount, currency, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(goalId, input.name.trim(), amount, "CNY", input.enabled ? 1 : 0, now, now);
  }
  if (input.enabled) {
    handle2.db.prepare("UPDATE portfolio_goals SET enabled = 0, updated_at = ? WHERE enabled = 1 AND id != ?").run(now, goalId);
  }
  let event = null;
  if (!input.id || oldAmount !== amount) {
    event = {
      id: newId(),
      goalId,
      oldAmount: input.id ? oldAmount : null,
      newAmount: amount,
      changedAt: now,
      note: input.note ?? ""
    };
    handle2.db.prepare("INSERT INTO portfolio_goal_events (id, goal_id, old_amount, new_amount, changed_at, note) VALUES (?,?,?,?,?,?)").run(event.id, goalId, event.oldAmount, event.newAmount, event.changedAt, event.note);
  }
  const goal = toGoal(handle2.db.prepare("SELECT * FROM portfolio_goals WHERE id = ?").get(goalId));
  return { goal, event };
}
function toFlow(row) {
  return {
    id: row.id,
    flowType: row.flow_type,
    flowDate: row.flow_date,
    amount: row.amount,
    note: row.note
  };
}
function listCashFlows(handle2, range) {
  const clauses = [];
  const args = [];
  if (range?.begin) {
    clauses.push("flow_date >= ?");
    args.push(range.begin);
  }
  if (range?.end) {
    clauses.push("flow_date <= ?");
    args.push(range.end);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = handle2.db.prepare(`SELECT * FROM portfolio_cash_flows ${where} ORDER BY flow_date DESC`).all(...args);
  return rows.map(toFlow);
}
function saveCashFlow(handle2, input) {
  const amountRaw = parseFixed(input.amount, SCALE_AMOUNT);
  if (amountRaw <= 0) throw new Error("\u73B0\u91D1\u6D41\u91D1\u989D\u5FC5\u987B\u5927\u4E8E 0");
  const id = newId();
  handle2.db.prepare("INSERT INTO portfolio_cash_flows (id, flow_type, flow_date, amount, note, created_at) VALUES (?,?,?,?,?,?)").run(id, input.flowType, input.flowDate, formatFixed(amountRaw, SCALE_AMOUNT), input.note ?? "", nowIso());
  return toFlow(handle2.db.prepare("SELECT * FROM portfolio_cash_flows WHERE id = ?").get(id));
}
function deleteCashFlow(handle2, id) {
  const result = handle2.db.prepare("DELETE FROM portfolio_cash_flows WHERE id = ?").run(id);
  return Number(result.changes ?? 0) > 0;
}

// plugin/server/src/secrets.ts
import { execFileSync } from "node:child_process";
var KEYCHAIN_MARKER = "__keychain__";
var SERVICE = "plug-funds";
var ACCOUNT = "ai-api-key";
var probe = null;
function disabledByEnv() {
  const flag = process.env.PLUG_FUNDS_DISABLE_KEYCHAIN;
  return flag === "1" || flag === "true";
}
function run(args, input) {
  try {
    return execFileSync(args[0], args.slice(1), {
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5e3
    }).trim();
  } catch {
    return null;
  }
}
function keychainAvailable() {
  if (disabledByEnv()) return false;
  if (probe !== null) return probe;
  if (process.platform === "darwin") {
    probe = run(["/usr/bin/security", "list-keychains"]) !== null;
  } else if (process.platform === "linux") {
    probe = run(["secret-tool", "--version"]) !== null;
  } else {
    probe = false;
  }
  return probe;
}
function currentSecretBackend() {
  return keychainAvailable() ? "keychain" : "sqlite";
}
function readKeychain() {
  if (!keychainAvailable()) return null;
  if (process.platform === "darwin") {
    const value2 = run(["/usr/bin/security", "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"]);
    return value2 === null || value2 === "" ? null : value2;
  }
  const value = run(["secret-tool", "lookup", "service", SERVICE, "account", ACCOUNT]);
  return value === null || value === "" ? null : value;
}
function writeKeychain(value) {
  if (!keychainAvailable()) return false;
  if (process.platform === "darwin") {
    return run(["/usr/bin/security", "add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w", value]) !== null;
  }
  if (process.platform === "linux") {
    return run(["secret-tool", "store", "--label", "plug-funds AI key", "service", SERVICE, "account", ACCOUNT], value) !== null;
  }
  return false;
}

// plugin/server/src/repo/settings.ts
function getSetting(handle2, key) {
  const row = handle2.db.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}
function setSetting(handle2, key, value) {
  handle2.db.prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?,?,?)
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`).run(key, JSON.stringify(value), nowIso());
}
var AI_KEY = "ai_settings";
var DEFAULT_AI = { baseUrl: "", apiKey: "", model: "", enabled: false };
function getAiSettings(handle2) {
  const stored = getSetting(handle2, AI_KEY);
  const merged = { ...DEFAULT_AI, ...stored ?? {} };
  if (merged.apiKey === KEYCHAIN_MARKER || merged.apiKey === "") {
    merged.apiKey = readKeychain() ?? "";
  }
  return merged;
}
function maskApiKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
}
function saveAiSettings(handle2, input) {
  const current = getAiSettings(handle2);
  const provided = input.apiKey !== void 0 && input.apiKey !== "" && !input.apiKey.includes("****");
  const baseUrl = (input.baseUrl ?? current.baseUrl).trim();
  const model = (input.model ?? current.model).trim();
  const apiKey = provided ? input.apiKey : current.apiKey;
  const next = {
    baseUrl,
    apiKey,
    model,
    enabled: input.enabled ?? (baseUrl !== "" && apiKey !== "" && model !== "")
  };
  let stored = apiKey;
  if (apiKey !== "" && keychainAvailable() && (readKeychain() === apiKey || writeKeychain(apiKey))) {
    stored = KEYCHAIN_MARKER;
  }
  setSetting(handle2, AI_KEY, { ...next, apiKey: stored });
  return next;
}
function toRecord(row) {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    model: row.model,
    source: row.source,
    promptScope: row.prompt_scope,
    result: row.result,
    createdAt: row.created_at
  };
}
function saveAiRecord(handle2, record) {
  const id = newId();
  handle2.db.prepare("INSERT INTO ai_analysis_records (id, instrument_id, model, source, prompt_scope, result, created_at) VALUES (?,?,?,?,?,?,?)").run(id, record.instrumentId, record.model, record.source, record.promptScope, record.result, nowIso());
  const row = handle2.db.prepare("SELECT * FROM ai_analysis_records WHERE id = ?").get(id);
  return toRecord(row);
}
function listAiRecords(handle2, instrumentId) {
  const rows = instrumentId ? handle2.db.prepare("SELECT * FROM ai_analysis_records WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 50").all(instrumentId) : handle2.db.prepare("SELECT * FROM ai_analysis_records ORDER BY created_at DESC LIMIT 50").all();
  return rows.map(toRecord);
}

// plugin/server/src/repo/refresh-settings.ts
var KEY = "refresh_settings";
var MIN_REFRESH_INTERVAL_SEC = 15;
var MAX_REFRESH_INTERVAL_SEC = 3600;
var DEFAULT_REFRESH_SETTINGS = {
  enabled: true,
  intervalSec: 60,
  tradingHoursOnly: true
};
function getRefreshSettings(handle2) {
  const stored = getSetting(handle2, KEY);
  if (!stored) return { ...DEFAULT_REFRESH_SETTINGS };
  const intervalSec = Number(stored.intervalSec);
  return {
    enabled: stored.enabled === true,
    intervalSec: Number.isFinite(intervalSec) && intervalSec >= MIN_REFRESH_INTERVAL_SEC && intervalSec <= MAX_REFRESH_INTERVAL_SEC ? Math.round(intervalSec) : DEFAULT_REFRESH_SETTINGS.intervalSec,
    tradingHoursOnly: stored.tradingHoursOnly !== false
  };
}
function saveRefreshSettings(handle2, input) {
  const current = getRefreshSettings(handle2);
  const raw = input.intervalSec === void 0 ? current.intervalSec : Number(input.intervalSec);
  if (!Number.isFinite(raw) || raw < MIN_REFRESH_INTERVAL_SEC || raw > MAX_REFRESH_INTERVAL_SEC) {
    throw new ValidationError(`\u5237\u65B0\u95F4\u9694\u5FC5\u987B\u662F ${MIN_REFRESH_INTERVAL_SEC}\u2013${MAX_REFRESH_INTERVAL_SEC} \u79D2\u4E4B\u95F4\u7684\u6574\u6570`);
  }
  const next = {
    enabled: input.enabled === void 0 ? current.enabled : input.enabled === true,
    intervalSec: Math.round(raw),
    tradingHoursOnly: input.tradingHoursOnly === void 0 ? current.tradingHoursOnly : input.tradingHoursOnly === true
  };
  setSetting(handle2, KEY, next);
  return next;
}

// plugin/server/src/repo/market.ts
function toPoint(row) {
  return {
    instrumentId: row.instrument_id,
    priceType: row.price_type,
    value: row.value,
    tradingDate: row.trading_date,
    observedAt: row.observed_at,
    provider: row.provider,
    quality: row.quality
  };
}
var UPSERT = `INSERT INTO market_data (id, instrument_id, price_type, value, trading_date, observed_at, provider, quality)
                VALUES (?,?,?,?,?,?,?,?)
                ON CONFLICT (instrument_id, price_type, trading_date, provider) DO UPDATE SET
                  value = excluded.value, observed_at = excluded.observed_at, quality = excluded.quality`;
function saveMarketPoints(handle2, points) {
  const stmt = handle2.db.prepare(UPSERT);
  let count = 0;
  for (const point2 of points) {
    stmt.run(newId(), point2.instrumentId, point2.priceType, point2.value, point2.tradingDate, point2.observedAt, point2.provider, point2.quality);
    count += 1;
  }
  return count;
}
function latestPoint(handle2, instrumentId, priceTypes) {
  const placeholders = priceTypes.map(() => "?").join(",");
  const row = handle2.db.prepare(`SELECT * FROM market_data WHERE instrument_id = ? AND price_type IN (${placeholders})
              ORDER BY trading_date DESC, observed_at DESC LIMIT 1`).get(instrumentId, ...priceTypes);
  return row ? toPoint(row) : null;
}
function historyPoints(handle2, instrumentId, priceTypes, begin, end) {
  const placeholders = priceTypes.map(() => "?").join(",");
  const clauses = [`instrument_id = ?`, `price_type IN (${placeholders})`];
  const args = [instrumentId, ...priceTypes];
  if (begin) {
    clauses.push("trading_date >= ?");
    args.push(begin);
  }
  if (end) {
    clauses.push("trading_date <= ?");
    args.push(end);
  }
  const rows = handle2.db.prepare(`SELECT * FROM market_data WHERE ${clauses.join(" AND ")} ORDER BY trading_date ASC, observed_at ASC`).all(...args);
  return rows.map(toPoint);
}
function effectivePrice(handle2, instrument, today) {
  const manual = latestPoint(handle2, instrument.id, ["MANUAL_PRICE"]);
  if (manual) {
    return { value: manual.value, priceType: manual.priceType, quality: "MANUAL", tradingDate: manual.tradingDate, observedAt: manual.observedAt };
  }
  if (instrument.type === "OPEN_END_FUND") {
    const nav = latestPoint(handle2, instrument.id, ["OFFICIAL_NAV"]);
    if (nav) {
      return {
        value: nav.value,
        priceType: nav.priceType,
        quality: nav.tradingDate === today ? "FRESH" : "DELAYED",
        tradingDate: nav.tradingDate,
        observedAt: nav.observedAt
      };
    }
    return null;
  }
  const realtime = latestPoint(handle2, instrument.id, ["REALTIME_PRICE"]);
  if (realtime && realtime.tradingDate === today) {
    return { value: realtime.value, priceType: realtime.priceType, quality: "FRESH", tradingDate: realtime.tradingDate, observedAt: realtime.observedAt };
  }
  const close = latestPoint(handle2, instrument.id, ["CLOSE_PRICE"]);
  if (close) {
    return {
      value: close.value,
      priceType: close.priceType,
      quality: close.tradingDate === today ? "FRESH" : "DELAYED",
      tradingDate: close.tradingDate,
      observedAt: close.observedAt
    };
  }
  return realtime ? { value: realtime.value, priceType: realtime.priceType, quality: "STALE", tradingDate: realtime.tradingDate, observedAt: realtime.observedAt } : null;
}
var VAL_UPSERT = `INSERT INTO valuation_metrics (id, instrument_id, metric_key, value, as_of_date, provider, quality)
                    VALUES (?,?,?,?,?,?,?)
                    ON CONFLICT (instrument_id, metric_key, as_of_date) DO UPDATE SET
                      value = excluded.value, provider = excluded.provider, quality = excluded.quality`;
function saveValuationMetric(handle2, row) {
  handle2.db.prepare(VAL_UPSERT).run(newId(), row.instrumentId, row.metricKey, row.value, row.asOfDate, row.provider, row.quality);
}
function effectiveHistoryPoints(handle2, instrumentId, instrumentType, begin, end) {
  const types = instrumentType === "OPEN_END_FUND" ? ["OFFICIAL_NAV", "MANUAL_PRICE"] : ["CLOSE_PRICE", "REALTIME_PRICE", "MANUAL_PRICE"];
  const priority = {
    MANUAL_PRICE: 3,
    REALTIME_PRICE: 2,
    CLOSE_PRICE: 1,
    OFFICIAL_NAV: 1
  };
  const byDate = /* @__PURE__ */ new Map();
  for (const point2 of historyPoints(handle2, instrumentId, types, begin, end)) {
    const previous = byDate.get(point2.tradingDate);
    if (!previous || (priority[point2.priceType] ?? 0) >= (priority[previous.priceType] ?? 0)) {
      byDate.set(point2.tradingDate, point2);
    }
  }
  return [...byDate.values()].sort((a, b) => a.tradingDate.localeCompare(b.tradingDate));
}
function metricHistory(handle2, instrumentId, metricKey, since) {
  const clauses = ["instrument_id = ?", "metric_key = ?", "value IS NOT NULL"];
  const args = [instrumentId, metricKey];
  if (since) {
    clauses.push("as_of_date >= ?");
    args.push(since);
  }
  const rows = handle2.db.prepare(
    `SELECT as_of_date, value FROM valuation_metrics WHERE ${clauses.join(" AND ")} ORDER BY as_of_date ASC`
  ).all(...args);
  return rows.map((r) => ({ asOfDate: r.as_of_date, value: Number(r.value) })).filter((r) => Number.isFinite(r.value));
}
function latestValuationMetrics(handle2, instrumentId) {
  const rows = handle2.db.prepare(`SELECT instrument_id, metric_key, value, as_of_date, provider, quality
              FROM valuation_metrics WHERE instrument_id = ?
              ORDER BY metric_key, as_of_date`).all(instrumentId);
  const latest = /* @__PURE__ */ new Map();
  for (const row of rows) latest.set(row.metric_key, row);
  return [...latest.values()].map((row) => ({
    instrumentId: row.instrument_id,
    metricKey: row.metric_key,
    value: row.value,
    asOfDate: row.as_of_date,
    provider: row.provider,
    quality: row.quality
  }));
}

// plugin/core/src/calendar.ts
var WEEKDAY_CALENDAR = {
  source: "weekday",
  days: [],
  from: null,
  to: null,
  note: "\u5C1A\u65E0\u6307\u6570\u65E5\u7EBF\u6570\u636E\uFF0C\u6309\u300C\u5468\u4E00\u81F3\u5468\u4E94\u5373\u4EA4\u6613\u65E5\u300D\u63A8\u65AD\uFF0C\u8282\u5047\u65E5\u53EF\u80FD\u8BEF\u5224\u3002\u5BFC\u5165\u6307\u6570\u5E76\u5237\u65B0\u884C\u60C5\u540E\u4F1A\u81EA\u52A8\u6539\u7528\u771F\u5B9E\u4EA4\u6613\u65E5\u3002"
};
var CN_OFFSET_MIN = 8 * 60;
function pad(n) {
  return String(n).padStart(2, "0");
}
function shanghaiParts(now) {
  const shifted = new Date(now.getTime() + CN_OFFSET_MIN * 6e4);
  const date = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  return {
    date,
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay()
  };
}
function weekdayOf(date) {
  const [y, m2, d] = date.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m2) || !Number.isFinite(d)) return -1;
  return new Date(Date.UTC(y, m2 - 1, d)).getUTCDay();
}
function isWeekend(date) {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
}
function classifyDay(date, calendar) {
  if (isWeekend(date)) return { trading: false, assumed: false };
  if (calendar.source === "market" && calendar.from !== null && calendar.to !== null && date >= calendar.from && date <= calendar.to) {
    return { trading: calendar.days.includes(date), assumed: false };
  }
  return { trading: true, assumed: true };
}
function derivedHolidays(calendar) {
  if (calendar.source !== "market" || calendar.from === null || calendar.to === null) return [];
  const known = new Set(calendar.days);
  const result = [];
  const [fy, fm, fd] = calendar.from.split("-").map(Number);
  const [ty, tm, td] = calendar.to.split("-").map(Number);
  const cursor = new Date(Date.UTC(fy, fm - 1, fd));
  const end = Date.UTC(ty, tm - 1, td);
  while (cursor.getTime() <= end) {
    const date = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
    if (!isWeekend(date) && !known.has(date)) result.push(date);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}
var PHASE_LABELS = {
  "closed-day": "\u4F11\u5E02",
  before: "\u5F00\u76D8\u524D",
  morning: "\u4E0A\u5348\u76D8\u4E2D",
  lunch: "\u5348\u95F4\u4F11\u5E02",
  afternoon: "\u4E0B\u5348\u76D8\u4E2D",
  after: "\u5DF2\u6536\u76D8"
};
function sessionState(now, calendar) {
  const { date, minutes, weekday } = shanghaiParts(now);
  const time = `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const dayClass = weekday === 0 || weekday === 6 ? { trading: false, assumed: false } : classifyDay(date, calendar);
  let phase;
  if (!dayClass.trading) phase = "closed-day";
  else if (minutes < 570) phase = "before";
  else if (minutes < 690) phase = "morning";
  else if (minutes < 780) phase = "lunch";
  else if (minutes < 900) phase = "afternoon";
  else phase = "after";
  return {
    phase,
    open: phase === "morning" || phase === "afternoon",
    date,
    time,
    assumed: dayClass.assumed,
    label: dayClass.trading ? PHASE_LABELS[phase] : `${PHASE_LABELS[phase]}\uFF08\u975E\u4EA4\u6613\u65E5\uFF09`
  };
}

// plugin/server/src/services/calendar.ts
var MIN_MARKET_DAYS = 20;
var PREFERRED_BENCHMARK = "000300";
var cache = /* @__PURE__ */ new WeakMap();
function pickSourceInstrument(ctx) {
  const indices = listInstruments(ctx.handle).filter((i) => i.type === "INDEX" && i.active !== false);
  if (indices.length === 0) return null;
  const preferred = indices.find((i) => i.code === PREFERRED_BENCHMARK);
  if (preferred) return { id: preferred.id, code: preferred.code, name: preferred.name };
  let best = null;
  for (const index of indices) {
    const count = effectiveHistoryPoints(ctx.handle, index.id, index.type).length;
    if (!best || count > best.count) best = { id: index.id, code: index.code, name: index.name, count };
  }
  return best ? { id: best.id, code: best.code, name: best.name } : null;
}
function buildTradingCalendar(ctx) {
  const instrument = pickSourceInstrument(ctx);
  if (!instrument) return WEEKDAY_CALENDAR;
  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
  const dates = [...new Set(points.map((p) => p.tradingDate).filter((d) => !isWeekend(d)))].sort();
  const signature = `${instrument.id}:${dates.length}:${dates[0] ?? ""}:${dates[dates.length - 1] ?? ""}`;
  const hit = cache.get(ctx.handle);
  if (hit && hit.signature === signature) return hit.calendar;
  const calendar = dates.length < MIN_MARKET_DAYS ? { ...WEEKDAY_CALENDAR, note: `${instrument.name} \u53EA\u6709 ${dates.length} \u4E2A\u4EA4\u6613\u65E5\u6837\u672C\uFF08\u9700 \u2265 ${MIN_MARKET_DAYS}\uFF09\uFF0C\u6682\u6309\u5DE5\u4F5C\u65E5\u63A8\u65AD\uFF0C\u8282\u5047\u65E5\u53EF\u80FD\u8BEF\u5224\u3002` } : {
    source: "market",
    days: dates,
    from: dates[0],
    to: dates[dates.length - 1],
    note: `\u4EA4\u6613\u65E5\u53D6\u81EA\u672C\u673A ${instrument.name}\uFF08${instrument.code}\uFF09\u65E5\u7EBF\uFF0C\u5171 ${dates.length} \u4E2A\u4EA4\u6613\u65E5\uFF0C\u8986\u76D6 ${dates[0]} \u2192 ${dates[dates.length - 1]}\uFF1B\u533A\u95F4\u5916\u6309\u5DE5\u4F5C\u65E5\u63A8\u65AD\u3002`
  };
  cache.set(ctx.handle, { signature, calendar });
  return calendar;
}
function getTradingCalendarInfo(ctx, now = /* @__PURE__ */ new Date()) {
  const calendar = buildTradingCalendar(ctx);
  const holidays = derivedHolidays(calendar);
  return {
    calendar,
    session: sessionState(now, calendar),
    holidayCount: holidays.length,
    recentHolidays: holidays.slice(-12),
    tradingDayCount: calendar.days.length
  };
}

// plugin/core/src/risk.ts
function pairs(a, b) {
  if (a.length !== b.length || a.length < 2) return null;
  const xs = [];
  const ys = [];
  for (let i = 0; i < a.length; i += 1) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  return xs.length >= 2 ? { a: xs, b: ys } : null;
}
function meanOf(values) {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
function correlation(a, b) {
  const aligned = pairs(a, b);
  if (!aligned) return null;
  const meanA = meanOf(aligned.a);
  const meanB = meanOf(aligned.b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < aligned.a.length; i += 1) {
    const da = aligned.a[i] - meanA;
    const db = aligned.b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null;
  return cov / Math.sqrt(varA * varB);
}
function beta(assetReturns, benchReturns) {
  const aligned = pairs(assetReturns, benchReturns);
  if (!aligned) return null;
  const meanA = meanOf(aligned.a);
  const meanB = meanOf(aligned.b);
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < aligned.a.length; i += 1) {
    const db = aligned.b[i] - meanB;
    cov += (aligned.a[i] - meanA) * db;
    varB += db * db;
  }
  if (varB <= 0) return null;
  return cov / varB;
}
function trackingError(assetReturns, benchReturns) {
  const aligned = pairs(assetReturns, benchReturns);
  if (!aligned) return null;
  const diffs = aligned.a.map((v, i) => v - aligned.b[i]);
  const mean2 = meanOf(diffs);
  const variance = diffs.reduce((sum, d) => sum + (d - mean2) ** 2, 0) / (diffs.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
function annualizedVolatility(returns) {
  const clean = returns.filter(Number.isFinite);
  if (clean.length < 2) return null;
  const mean2 = meanOf(clean);
  const variance = clean.reduce((sum, r) => sum + (r - mean2) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
function equityRiskPremium(pe, riskFreeRate) {
  if (pe === null || !Number.isFinite(pe) || pe <= 0) return null;
  if (!Number.isFinite(riskFreeRate)) return null;
  return 1 / pe - riskFreeRate;
}

// plugin/core/src/goal.ts
function toSegments(categories, denominatorValueRaw, denominator) {
  return categories.map((c) => {
    const raw = parseFixed(c.value, SCALE_AMOUNT);
    if (denominatorValueRaw <= 0) {
      throw new RangeError("\u5206\u6BCD\u5FC5\u987B\u4E3A\u6B63\u6570");
    }
    return {
      key: c.key,
      label: c.label,
      value: formatFixed(raw, SCALE_AMOUNT),
      fraction: raw / denominatorValueRaw,
      denominator,
      color: c.color
    };
  });
}
function allocation(input) {
  const values = input.categories.map((c) => parseFixed(c.value, SCALE_AMOUNT));
  const totalRaw = values.reduce((a, b) => a + b, 0);
  const goalEnabled = input.mode === "goal" && input.goal !== null && input.goal.enabled;
  const goalRaw = goalEnabled && input.goal ? parseFixed(input.goal.targetAmount, SCALE_AMOUNT) : null;
  const total = formatFixed(totalRaw, SCALE_AMOUNT);
  if (!goalEnabled || goalRaw === null || goalRaw <= 0) {
    if (input.mode === "goal") {
      return {
        mode: "full",
        totalMarketValue: total,
        effectiveGoalAmount: null,
        segments: toSegments(input.categories, totalRaw, "current"),
        progressRatio: null,
        remainingAmount: null,
        overAmount: null,
        note: goalRaw !== null && goalRaw <= 0 ? "\u76EE\u6807\u91D1\u989D\u5FC5\u987B\u5927\u4E8E 0\uFF0C\u5DF2\u56DE\u9000\u5168\u91CF\u5206\u5E03" : null
      };
    }
    return {
      mode: "full",
      totalMarketValue: total,
      effectiveGoalAmount: null,
      segments: toSegments(input.categories, totalRaw, "current"),
      progressRatio: null,
      remainingAmount: null,
      overAmount: null,
      note: null
    };
  }
  if (goalRaw !== null && input.goal) {
    const progressRatio = totalRaw / goalRaw;
    if (totalRaw < goalRaw) {
      const segments = toSegments(input.categories, goalRaw, "goal");
      const remainingRaw = goalRaw - totalRaw;
      segments.push({
        key: "__remaining",
        label: "\u5F85\u8FBE\u6210",
        value: formatFixed(remainingRaw, SCALE_AMOUNT),
        fraction: remainingRaw / goalRaw,
        denominator: "goal",
        gray: true
      });
      return {
        mode: "goal",
        totalMarketValue: total,
        effectiveGoalAmount: formatFixed(goalRaw, SCALE_AMOUNT),
        segments,
        progressRatio,
        remainingAmount: formatFixed(remainingRaw, SCALE_AMOUNT),
        overAmount: null,
        note: null
      };
    }
    const overRaw = totalRaw - goalRaw;
    return {
      mode: "goal",
      totalMarketValue: total,
      effectiveGoalAmount: formatFixed(goalRaw, SCALE_AMOUNT),
      segments: toSegments(input.categories, totalRaw, "current"),
      progressRatio,
      remainingAmount: null,
      overAmount: overRaw > 0 ? formatFixed(overRaw, SCALE_AMOUNT) : null,
      note: overRaw > 0 ? "\u5DF2\u5B8C\u6210\u76EE\u6807\uFF1A\u5B8C\u6210\u7387\u4E3A\u8D44\u4EA7\u89C4\u6A21\u8FDB\u5EA6\uFF0C\u53EF\u8D85\u8FC7 100%\uFF0C\u4E0D\u4EE3\u8868\u6536\u76CA\u7387" : null
    };
  }
  throw new RangeError("unreachable");
}

// plugin/core/src/categories.ts
function categoryChipsFor(links, categories, instrumentId, max = 2) {
  const ids = links.filter((l) => l.instrumentId === instrumentId).map((l) => l.categoryId);
  const picked = ids.map((id) => categories.find((c) => c.id === id)).filter((c) => Boolean(c)).slice(0, max);
  return {
    names: picked.map((c) => c.name),
    colors: picked.map((c) => c.color),
    more: Math.max(ids.length - max, 0)
  };
}

// plugin/server/src/services/holdings.ts
var PINNED_KEY = "pinned_positions";
function pinnedSet(handle2) {
  const raw = getSetting(handle2, PINNED_KEY);
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}
function setPinned(handle2, positionId, pinned) {
  const current = pinnedSet(handle2);
  if (pinned) current.add(positionId);
  else current.delete(positionId);
  setSetting(handle2, PINNED_KEY, [...current]);
}
function firstHeldDate(txns, accountId, instrumentId) {
  const dates = txns.filter((t) => t.accountId === accountId && t.instrumentId === instrumentId && t.status === "CONFIRMED").map((t) => t.tradeDate).sort();
  return dates[0] ?? null;
}
function listHoldings(ctx, filter = {}) {
  const { handle: handle2 } = ctx;
  const txns = allTransactions(handle2);
  const positions = replayPositions(txns);
  const deleted = new Set(listDeletedPositions(handle2).map((d) => `${d.accountId}:${d.instrumentId}`));
  const accounts = new Map(listAccounts(handle2).map((a) => [a.id, a]));
  const instruments = new Map(listInstruments(handle2, { active: true }).map((i) => [i.id, i]));
  const links = listLinks(handle2);
  const categories = listCategories(handle2);
  const pinned = pinnedSet(handle2);
  const rows = [];
  const incomplete = [];
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
    const price = effectivePrice(handle2, instrument, ctx.today);
    let mvRaw = null;
    let pnlRaw = null;
    let pnlRate = null;
    if (price) {
      const priceRaw = parseFixed(price.value, SCALE_QTY);
      mvRaw = pos.qtyRaw > 0 ? mulToScale(priceRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) : 0;
      pnlRaw = unrealizedRaw(pos, priceRaw);
      pnlRate = pos.costTotalRaw > 0 ? pnlRaw / pos.costTotalRaw : null;
    } else if (pos.qtyRaw > 0) {
      incomplete.push(`${instrument.name}\uFF08${instrument.code}\uFF09`);
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
      pnlRate: pnlRate === null ? null : `${pnlRate >= 0 ? "+" : ""}${(pnlRate * 100).toFixed(2)}%`,
      realized: formatFixed(pos.realizedRaw, SCALE_AMOUNT),
      dividends: formatFixed(pos.dividendsRaw, SCALE_AMOUNT),
      weight: null,
      categories: categoryChipsFor(links, categories, pos.instrumentId),
      pinned: pinned.has(key),
      firstHeldDate: firstHeldDate(txns, pos.accountId, pos.instrumentId)
    });
  }
  for (const row of rows) {
    if (row.marketValue !== null && totalMvRaw > 0) {
      row.weight = parseFixed(row.marketValue, SCALE_AMOUNT) / totalMvRaw;
    }
  }
  let finalRows = rows;
  if (filter.pnl === "gain") finalRows = finalRows.filter((r) => r.pnl !== null && r.pnl.startsWith("+"));
  if (filter.pnl === "loss") finalRows = finalRows.filter((r) => r.pnl !== null && r.pnl.startsWith("-"));
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
    incomplete: [...new Set(incomplete)]
  };
}

// plugin/server/src/repo/cash.ts
function toCash(row) {
  return {
    id: row.id,
    name: row.name,
    currency: row.currency,
    balance: row.balance,
    note: row.note,
    active: row.active === 1,
    updatedAt: row.updated_at
  };
}
function listCashAccounts(handle2, options = {}) {
  const sql = options.activeOnly ? "SELECT * FROM cash_accounts WHERE active = 1 ORDER BY updated_at DESC" : "SELECT * FROM cash_accounts ORDER BY active DESC, updated_at DESC";
  return handle2.db.prepare(sql).all().map(toCash);
}
function saveCashAccount(handle2, input) {
  const name = input.name.trim();
  if (name === "") throw new ValidationError("\u73B0\u91D1\u8D26\u6237\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const amount = Number(input.balance);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ValidationError("\u73B0\u91D1\u4F59\u989D\u5FC5\u987B\u662F\u4E0D\u5C0F\u4E8E 0 \u7684\u6570\u5B57");
  }
  const formatted = formatFixed(parseFixed(input.balance, SCALE_AMOUNT), SCALE_AMOUNT);
  const now = nowIso();
  if (input.id) {
    const existing = handle2.db.prepare("SELECT id FROM cash_accounts WHERE id = ?").get(input.id);
    if (!existing) throw new ValidationError(`\u73B0\u91D1\u8D26\u6237\u4E0D\u5B58\u5728\uFF1A${input.id}`);
    handle2.db.prepare(
      "UPDATE cash_accounts SET name = ?, currency = ?, balance = ?, note = ?, active = ?, updated_at = ? WHERE id = ?"
    ).run(
      name,
      input.currency ?? "CNY",
      formatted,
      input.note ?? "",
      input.active === false ? 0 : 1,
      now,
      input.id
    );
    return toCash(handle2.db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(input.id));
  }
  const id = newId();
  handle2.db.prepare(
    "INSERT INTO cash_accounts (id,name,currency,balance,note,active,updated_at) VALUES (?,?,?,?,?,?,?)"
  ).run(id, name, input.currency ?? "CNY", formatted, input.note ?? "", input.active === false ? 0 : 1, now);
  return toCash(handle2.db.prepare("SELECT * FROM cash_accounts WHERE id = ?").get(id));
}
function deleteCashAccount(handle2, id) {
  const result = handle2.db.prepare("DELETE FROM cash_accounts WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}
function cashTotal(handle2) {
  const rows = listCashAccounts(handle2, { activeOnly: true });
  const total = rows.reduce((sum, row) => sum + parseFixed(row.balance, SCALE_AMOUNT), 0);
  return formatFixed(total, SCALE_AMOUNT);
}

// plugin/server/src/services/dashboard.ts
var CATEGORY_BY_TYPE = {
  STOCK: "stock",
  ETF: "etf",
  OPEN_END_FUND: "fund",
  INDEX: "index"
};
var CATEGORY_LABELS = {
  stock: "\u80A1\u7968",
  etf: "ETF",
  fund: "\u573A\u5916\u57FA\u91D1",
  index: "\u6307\u6570\uFF08\u5BF9\u7167\uFF09"
};
var CATEGORY_COLORS = {
  stock: "#4c6ef5",
  etf: "#ee9d3f",
  fund: "#9a6bf2"
};
function prevTradingPrice(ctx, instrument, currentDate) {
  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
  const earlier = points.filter((p) => p.tradingDate < currentDate);
  const prev = earlier[earlier.length - 1];
  return prev ? { date: prev.tradingDate, valueRaw: parseFixed(prev.value, SCALE_QTY) } : null;
}
function getDashboardSummary(ctx) {
  const holdings = listHoldings(ctx);
  const byCategoryMap = /* @__PURE__ */ new Map();
  let dayPnlRaw = 0;
  let dayPnlKnown = true;
  let updatedAt = null;
  let dataDate = null;
  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const instruments = new Map(listInstruments(ctx.handle).map((i) => [i.id, i]));
  for (const row of holdings.rows) {
    const value = row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0;
    const key = CATEGORY_BY_TYPE[row.type];
    byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + value);
    if (row.priceDate && (!dataDate || row.priceDate > dataDate)) dataDate = row.priceDate;
    if (row.observedAt && (!updatedAt || row.observedAt > updatedAt)) updatedAt = row.observedAt;
    if (row.price === null) continue;
    const instrument = instruments.get(row.instrumentId);
    if (!instrument) continue;
    const prev = prevTradingPrice(ctx, instrument, row.priceDate ?? ctx.today);
    if (!prev) {
      dayPnlKnown = false;
      continue;
    }
    const qtyRaw = parseFixed(row.qty, SCALE_QTY);
    const priceRaw = parseFixed(row.price, SCALE_QTY);
    dayPnlRaw += mulToScale(priceRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) - mulToScale(prev.valueRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
  }
  let realizedRaw = 0;
  let dividendsRaw = 0;
  const deletedKeys = new Set(listDeletedPositions(ctx.handle).map((d) => `${d.accountId}:${d.instrumentId}`));
  for (const [key, pos] of positions) {
    realizedRaw += pos.realizedRaw;
    dividendsRaw += pos.dividendsRaw;
    if (deletedKeys.has(key) && pos.qtyRaw === 0) continue;
  }
  const unrealizedRawTotal = holdings.rows.reduce((acc, row) => {
    if (row.marketValue === null || row.pnl === null) return acc;
    return acc + parseFixed(row.pnl, SCALE_AMOUNT);
  }, 0);
  const totalRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const byCategory = [...byCategoryMap.entries()].filter(([key]) => key !== "index").map(([key, value]) => ({
    key,
    label: CATEGORY_LABELS[key] ?? key,
    value: formatFixed(value, SCALE_AMOUNT),
    weight: totalRaw > 0 ? value / totalRaw : 0
  })).sort((a, b) => b.weight - a.weight);
  const cash = cashTotal(ctx.handle);
  const holdingsRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const cashRaw = parseFixed(cash, SCALE_AMOUNT);
  const assetsRaw = holdingsRaw + cashRaw;
  return {
    totalMarketValue: holdings.totalMarketValue,
    cashTotal: cash,
    totalAssets: formatFixed(assetsRaw, SCALE_AMOUNT),
    cashWeight: assetsRaw > 0 ? cashRaw / assetsRaw : null,
    byCategory,
    dayPnl: dayPnlKnown ? formatFixed(dayPnlRaw, SCALE_AMOUNT) : null,
    dayPnlNote: dayPnlKnown ? null : "\u90E8\u5206\u6301\u4ED3\u7F3A\u5C11\u4E0A\u4E00\u4EA4\u6613\u65E5\u53EF\u6BD4\u4EF7\u683C\uFF0C\u6682\u65E0\u53EF\u6BD4\u65E5\u6536\u76CA",
    unrealized: formatFixed(unrealizedRawTotal, SCALE_AMOUNT),
    realized: formatFixed(realizedRaw, SCALE_AMOUNT),
    dividends: formatFixed(dividendsRaw, SCALE_AMOUNT),
    cumulative: formatFixed(unrealizedRawTotal + realizedRaw + dividendsRaw, SCALE_AMOUNT),
    incomplete: holdings.incomplete,
    updatedAt,
    dataDate
  };
}
function getDashboardAllocation(ctx, mode) {
  const holdings = listHoldings(ctx);
  const byCategoryMap = /* @__PURE__ */ new Map();
  for (const row of holdings.rows) {
    const key = CATEGORY_BY_TYPE[row.type];
    if (key === "index") continue;
    byCategoryMap.set(key, (byCategoryMap.get(key) ?? 0) + (row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0));
  }
  const goal = getEnabledGoal(ctx.handle);
  const result = allocation({
    categories: [...byCategoryMap.entries()].map(([key, value]) => ({
      key,
      label: CATEGORY_LABELS[key] ?? key,
      value: formatFixed(value, SCALE_AMOUNT),
      color: CATEGORY_COLORS[key]
    })),
    goal: goal ? { targetAmount: goal.targetAmount, enabled: goal.enabled } : null,
    mode
  });
  return { ...result, incomplete: holdings.incomplete };
}
function resolveRange(range, custom, today) {
  const end = today ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const days = range === "1m" ? 30 : range === "3m" ? 91 : range === "1y" ? 365 : null;
  if (range === "custom" && custom) return { begin: custom.begin, end: custom.end || end };
  if (days === null) {
    return { begin: "1970-01-01", end };
  }
  const beginDate = /* @__PURE__ */ new Date(`${end}T00:00:00Z`);
  beginDate.setUTCDate(beginDate.getUTCDate() - days);
  return { begin: beginDate.toISOString().slice(0, 10), end };
}
function qtyAt(txns, accountId, instrumentId, date) {
  const positions = replayPositions(txns.filter((t) => t.tradeDate <= date));
  const pos = positions.get(`${accountId}:${instrumentId}`);
  return pos?.qtyRaw ?? 0;
}
function metricValue(rows, key) {
  const row = rows.find((r) => r.metricKey === key);
  if (!row || row.value === null) return null;
  const value = Number(row.value);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function portfolioValuation(ctx, rows) {
  let totalMv = 0;
  let coveredMv = 0;
  let peWeighted = 0;
  let pbWeighted = 0;
  for (const row of rows) {
    const mv = row.marketValue ? parseFixed(row.marketValue, SCALE_AMOUNT) : 0;
    if (mv <= 0) continue;
    totalMv += mv;
    const metrics = latestValuationMetrics(ctx.handle, row.instrumentId);
    const pe = metricValue(metrics, "pe");
    const pb = metricValue(metrics, "pb");
    if (pe !== null && pb !== null) {
      peWeighted += pe * mv;
      pbWeighted += pb * mv;
      coveredMv += mv;
    }
  }
  const coverage = totalMv > 0 ? coveredMv / totalMv : 0;
  if (coveredMv === 0) {
    return { portfolioPe: null, portfolioPb: null, valuationCoverage: coverage, valuationNote: "\u6682\u65E0\u53EF\u7528\u7684 PE / PB \u4F30\u503C\u622A\u9762\uFF08\u5237\u65B0\u884C\u60C5\u6216\u624B\u5DE5\u8865\u5F55\u540E\u663E\u793A\uFF09" };
  }
  if (coverage < 0.8) {
    return { portfolioPe: null, portfolioPb: null, valuationCoverage: coverage, valuationNote: `\u4F30\u503C\u622A\u9762\u8986\u76D6 ${(coverage * 100).toFixed(0)}%\uFF0C\u4F4E\u4E8E 80% \u4E0D\u4EA7\u751F\u7EC4\u5408\u4F30\u503C` };
  }
  return {
    portfolioPe: Math.round(peWeighted / coveredMv * 100) / 100,
    portfolioPb: Math.round(pbWeighted / coveredMv * 100) / 100,
    valuationCoverage: coverage,
    valuationNote: `\u6309 ${(coverage * 100).toFixed(0)}% \u8986\u76D6\u5E02\u503C\u52A0\u6743 \xB7 \u7F3A\u5931\u6210\u5206\u4E0D\u6309 0 \u5904\u7406`
  };
}
function getPerformance(ctx, range, custom) {
  const span = resolveRange(range, custom, ctx.today);
  const holdings = listHoldings(ctx);
  const instruments = new Map(listInstruments(ctx.handle).map((i) => [i.id, i]));
  const txns = allTransactions(ctx.handle);
  const histories = /* @__PURE__ */ new Map();
  const dateSet = /* @__PURE__ */ new Set();
  for (const row of holdings.rows) {
    const instrument = instruments.get(row.instrumentId);
    if (!instrument) continue;
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end);
    const series2 = points.map((p) => ({ date: p.tradingDate, raw: parseFixed(p.value, SCALE_QTY) }));
    histories.set(row.instrumentId, series2);
    for (const p of points) dateSet.add(p.tradingDate);
  }
  const dates = [...dateSet].sort();
  if (dates.length === 0) {
    return {
      range: span,
      xirr: null,
      xirrNote: "\u533A\u95F4\u5185\u6CA1\u6709\u53EF\u7528\u5386\u53F2\u4EF7\u683C",
      maxDrawdown: null,
      sharpe: null,
      seriesPoints: 0,
      coverage: 0,
      note: "\u5F00\u59CB\u8BB0\u5F55\u5E76\u5237\u65B0\u884C\u60C5\u540E\u53EF\u67E5\u770B",
      series: [],
      ...portfolioValuation(ctx, holdings.rows)
    };
  }
  const flows = listCashFlows(ctx.handle, { begin: span.begin, end: span.end });
  const series = [];
  let prevMvRaw = null;
  const returns = [];
  let missingDays = 0;
  for (const date of dates) {
    let mvRaw = 0;
    let complete = true;
    for (const row of holdings.rows) {
      const instrument = instruments.get(row.instrumentId);
      if (!instrument) continue;
      const qtyRaw = qtyAt(txns, row.accountId, row.instrumentId, date);
      if (qtyRaw === 0) continue;
      const history = histories.get(row.instrumentId) ?? [];
      let priceRaw = null;
      for (const p of history) {
        if (p.date <= date) priceRaw = p.raw;
        else break;
      }
      if (priceRaw === null) {
        complete = false;
        continue;
      }
      mvRaw += mulToScale(priceRaw, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
    }
    if (!complete) missingDays += 1;
    series.push({
      date,
      value: formatFixed(mvRaw, SCALE_AMOUNT),
      nav: null
    });
    if (prevMvRaw !== null && prevMvRaw > 0) {
      returns.push(mvRaw / prevMvRaw - 1);
    }
    prevMvRaw = mvRaw;
  }
  const flowsSorted = [...flows].sort((a, b) => a.flowDate < b.flowDate ? -1 : 1);
  let capitalRaw = 0;
  let flowIndex = 0;
  let unitNavBroken = false;
  for (const point2 of series) {
    while (flowIndex < flowsSorted.length && flowsSorted[flowIndex].flowDate <= point2.date) {
      const flow = flowsSorted[flowIndex];
      const raw = parseFixed(flow.amount, SCALE_AMOUNT);
      capitalRaw += flow.flowType === "CONTRIBUTION" ? raw : -raw;
      flowIndex += 1;
    }
    if (capitalRaw > 0) {
      const mvRaw = parseFixed(point2.value, SCALE_AMOUNT);
      point2.nav = formatFixed(divToScale(mvRaw, SCALE_AMOUNT, capitalRaw, SCALE_AMOUNT, SCALE_QTY), SCALE_QTY);
    } else if (flowsSorted.length > 0 && capitalRaw <= 0) {
      unitNavBroken = true;
    }
  }
  const navSeries = series.filter((p) => p.nav !== null).map((p) => parseFixed(p.nav, SCALE_QTY));
  const useNav = navSeries.length >= 2 && !unitNavBroken;
  const mdd = useNav ? maxDrawdown(navSeries) : maxDrawdown(series.map((p) => parseFixed(p.value, SCALE_AMOUNT)));
  const rets = useNav ? dailyReturns(navSeries) : returns;
  const sharpe = sharpeRatio(rets, {});
  const coverage = dates.length > 0 ? 1 - missingDays / dates.length : 0;
  const endMv = parseFixed(series[series.length - 1]?.value ?? "0", SCALE_AMOUNT);
  const xirrFlows = [
    ...flows.map((f) => ({
      date: f.flowDate,
      amount: f.flowType === "CONTRIBUTION" ? -parseFixed(f.amount, SCALE_AMOUNT) : parseFixed(f.amount, SCALE_AMOUNT)
    })),
    ...endMv > 0 ? [{ date: span.end, amount: endMv }] : []
  ];
  const xirrValue = xirr(xirrFlows);
  const hasFlows = flows.length > 0;
  return {
    range: span,
    xirr: xirrValue,
    xirrNote: xirrValue === null ? hasFlows ? "\u73B0\u91D1\u6D41\u4E0E\u671F\u672B\u4EF7\u503C\u65E0\u6CD5\u6C42\u89E3 XIRR" : "\u7F3A\u5C11\u7EC4\u5408\u5916\u90E8\u6295\u5165 / \u53D6\u51FA\u8BB0\u5F55\uFF0C\u65E0\u6CD5\u8BA1\u7B97 XIRR" : null,
    maxDrawdown: mdd,
    sharpe,
    seriesPoints: series.length,
    coverage,
    note: missingDays > 0 ? `${missingDays} \u4E2A\u4EA4\u6613\u65E5\u7F3A\u5C11\u90E8\u5206\u6301\u4ED3\u4EF7\u683C\uFF0C\u5DF2\u6309\u53EF\u5F97\u6570\u636E\u8BA1\u7B97` : null,
    series,
    ...portfolioValuation(ctx, holdings.rows)
  };
}

// plugin/server/src/services/risk.ts
var DEFAULT_RISK_FREE_RATE = 0.015;
var MIN_COMMON_SAMPLES = 20;
function getRiskFreeRate(handle2) {
  const raw = getSetting(handle2, "risk_free_rate");
  if (raw === null || raw === void 0 || raw === "") return DEFAULT_RISK_FREE_RATE;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 0.2 ? value : DEFAULT_RISK_FREE_RATE;
}
function saveRiskFreeRate(handle2, rate) {
  if (!Number.isFinite(rate) || rate < 0 || rate > 0.2) {
    throw new ValidationError("\u65E0\u98CE\u9669\u5229\u7387\u5FC5\u987B\u5728 0\u201320% \u4E4B\u95F4\uFF08\u5C0F\u6570\u5F62\u5F0F\uFF0C\u5982 0.015\uFF09");
  }
  setSetting(handle2, "risk_free_rate", rate);
  return rate;
}
function pickBenchmark(ctx) {
  const indices = listInstruments(ctx.handle, { type: "INDEX", active: true });
  const candidates = indices.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
    return { instrument, points };
  }).filter((entry) => entry.points.length >= MIN_COMMON_SAMPLES).sort((a, b) => {
    const aPreferred = a.instrument.code === "000300" ? 0 : 1;
    const bPreferred = b.instrument.code === "000300" ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    return b.points.length - a.points.length;
  });
  const picked = candidates[0];
  if (!picked) {
    return { instrumentId: null, code: null, name: null, byDate: /* @__PURE__ */ new Map() };
  }
  const byDate = /* @__PURE__ */ new Map();
  for (const point2 of picked.points) {
    const value = Number(point2.value);
    if (Number.isFinite(value) && value > 0) byDate.set(point2.tradingDate, value);
  }
  return {
    instrumentId: picked.instrument.id,
    code: picked.instrument.code,
    name: picked.instrument.name,
    byDate
  };
}
function getPortfolioRisk(ctx, range = "1y") {
  const performance = getPerformance(ctx, range);
  const riskFreeRate = getRiskFreeRate(ctx.handle);
  const benchmark = pickBenchmark(ctx);
  const navByDate = /* @__PURE__ */ new Map();
  for (const point2 of performance.series) {
    const nav = point2.nav === null ? Number.NaN : Number(point2.nav);
    if (Number.isFinite(nav) && nav > 0) navByDate.set(point2.date, nav);
  }
  const commonDates = [...navByDate.keys()].filter((d) => benchmark.byDate.has(d)).sort();
  const benchmarkMeta = {
    instrumentId: benchmark.instrumentId,
    code: benchmark.code,
    name: benchmark.name,
    samples: commonDates.length
  };
  if (commonDates.length < MIN_COMMON_SAMPLES) {
    return {
      range: performance.range,
      samples: commonDates.length,
      volatility: null,
      beta: null,
      correlation: null,
      trackingError: null,
      benchmark: benchmarkMeta,
      riskFreeRate,
      portfolioPe: performance.portfolioPe,
      erp: equityRiskPremium(performance.portfolioPe, riskFreeRate),
      note: benchmark.instrumentId === null ? "\u6CA1\u6709\u53EF\u7528\u7684\u57FA\u51C6\u6307\u6570\u5386\u53F2\uFF08\u5148\u5728\u6307\u6570\u9875\u5BFC\u5165\u5E38\u7528\u6307\u6570\u5E76\u5237\u65B0\uFF09\uFF0CBeta / \u76F8\u5173\u6027 / \u8DDF\u8E2A\u8BEF\u5DEE\u4E0D\u53EF\u8BA1\u7B97\u3002" : `\u7EC4\u5408\u4E0E\u57FA\u51C6\u7684\u5171\u540C\u4EA4\u6613\u65E5\u4EC5 ${commonDates.length} \u4E2A\uFF08\u9700 \u2265 ${MIN_COMMON_SAMPLES}\uFF09\uFF0C\u98CE\u9669\u6307\u6807\u6682\u4E0D\u4EA7\u751F\u3002`
    };
  }
  const navs = commonDates.map((d) => navByDate.get(d));
  const benchs = commonDates.map((d) => benchmark.byDate.get(d));
  const navReturns = [];
  const benchReturns = [];
  for (let i = 1; i < commonDates.length; i += 1) {
    navReturns.push(navs[i] / navs[i - 1] - 1);
    benchReturns.push(benchs[i] / benchs[i - 1] - 1);
  }
  return {
    range: performance.range,
    samples: commonDates.length,
    volatility: annualizedVolatility(navReturns),
    beta: beta(navReturns, benchReturns),
    correlation: correlation(navReturns, benchReturns),
    trackingError: trackingError(navReturns, benchReturns),
    benchmark: benchmarkMeta,
    riskFreeRate,
    portfolioPe: performance.portfolioPe,
    erp: equityRiskPremium(performance.portfolioPe, riskFreeRate),
    note: `\u57FA\u51C6 ${benchmark.name ?? "\u2014"}\uFF08${benchmark.code ?? "\u2014"}\uFF09\xB7 \u5171\u540C\u4EA4\u6613\u65E5 ${commonDates.length} \u4E2A \xB7 \u65E0\u98CE\u9669\u5229\u7387 ${(riskFreeRate * 100).toFixed(2)}%`
  };
}
function getCorrelationMatrix(ctx, limit = 12) {
  const rows = listHoldings(ctx).rows.filter((r) => r.marketValue !== null).sort((a, b) => Number(b.marketValue) - Number(a.marketValue)).slice(0, limit);
  const series = rows.map((row) => {
    const points = effectiveHistoryPoints(ctx.handle, row.instrumentId, row.type);
    const byDate = /* @__PURE__ */ new Map();
    for (const point2 of points) {
      const value = Number(point2.value);
      if (Number.isFinite(value) && value > 0) byDate.set(point2.tradingDate, value);
    }
    return { code: row.code, name: row.name, byDate };
  });
  const codes = series.map((s) => s.code);
  const names = series.map((s) => s.name);
  const matrix = series.map(() => series.map(() => null));
  let samples = 0;
  for (let i = 0; i < series.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < series.length; j += 1) {
      const common = [...series[i].byDate.keys()].filter((d) => series[j].byDate.has(d)).sort();
      if (common.length < MIN_COMMON_SAMPLES) continue;
      const a = common.map((d) => series[i].byDate.get(d));
      const b = common.map((d) => series[j].byDate.get(d));
      const ra = [];
      const rb = [];
      for (let k = 1; k < common.length; k += 1) {
        ra.push(a[k] / a[k - 1] - 1);
        rb.push(b[k] / b[k - 1] - 1);
      }
      const rho = correlation(ra, rb);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      if (rho !== null) samples = Math.max(samples, common.length);
    }
  }
  return {
    codes,
    names,
    matrix,
    samples,
    note: series.length < 2 ? "\u6301\u4ED3\u5C11\u4E8E 2 \u53EA\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u76F8\u5173\u6027\u3002" : "\u5BF9\u89D2\u7EBF\u4E3A 1\uFF1B\u7A7A\u503C\u8868\u793A\u4E24\u53EA\u6807\u7684\u5171\u540C\u4EA4\u6613\u65E5\u4E0D\u8DB3 20 \u4E2A\uFF0C\u4E0D\u80FD\u7528 0 \u4EE3\u66FF\u300C\u4E0D\u76F8\u5173\u300D\u3002"
  };
}

// plugin/server/src/services/index-analytics.ts
var MIN_COMMON_SAMPLES2 = 20;
var VOL_WINDOW = 252;
var HIGH_LOW_WINDOW = 60;
var MAX_INDICES = 30;
function finiteOrNull(value) {
  return value === void 0 || !Number.isFinite(value) ? null : value;
}
function shiftMonths(date, months) {
  const [y, m2, d] = date.split("-").map(Number);
  const total = y * 12 + (m2 - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}
function pointAtOrBefore(dates, values, date) {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = lo + hi >> 1;
    if (dates[mid] <= date) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : values[found];
}
function periodReturn2(dates, values, months) {
  const end = values[values.length - 1];
  const begin = pointAtOrBefore(dates, values, shiftMonths(dates[dates.length - 1], -months));
  if (begin === null || begin <= 0) return null;
  return end / begin - 1;
}
function ytdReturn(dates, values) {
  const year = dates[dates.length - 1].slice(0, 4);
  const begin = pointAtOrBefore(dates, values, `${Number(year) - 1}-12-31`);
  if (begin === null || begin <= 0) return null;
  return values[values.length - 1] / begin - 1;
}
function dailyReturns2(values) {
  const out = [];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i - 1] > 0) out.push(values[i] / values[i - 1] - 1);
  }
  return out;
}
function annualizedVolatility2(values) {
  const returns = dailyReturns2(values.slice(-(VOL_WINDOW + 1)));
  if (returns.length < MIN_COMMON_SAMPLES2) return null;
  const mean2 = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean2) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
function maxDrawdown2(values) {
  if (values.length < 2) return null;
  let peak = values[0];
  let worst = 0;
  for (const value of values) {
    if (value > peak) peak = value;
    if (peak > 0) worst = Math.min(worst, value / peak - 1);
  }
  return worst;
}
function dcaBacktest(dates, values, monthlyAmount = 1e3) {
  if (dates.length < MIN_COMMON_SAMPLES2) return null;
  const buys = [];
  let lastMonth = "";
  for (let i = 0; i < dates.length - 1; i += 1) {
    const month = dates[i].slice(0, 7);
    if (month !== lastMonth) {
      buys.push({ date: dates[i], index: i });
      lastMonth = month;
    }
  }
  if (buys.length === 0) return null;
  let units = 0;
  for (const buy of buys) {
    if (values[buy.index] > 0) units += monthlyAmount / values[buy.index];
  }
  const invested = buys.length * monthlyAmount;
  const finalValue = units * values[values.length - 1];
  const rate = xirr([
    ...buys.map((buy) => ({ date: buy.date, amount: -monthlyAmount })),
    { date: dates[dates.length - 1], amount: Number(finalValue.toFixed(2)) }
  ]);
  return {
    months: buys.length,
    invested,
    value: Number(finalValue.toFixed(2)),
    profit: Number((finalValue - invested).toFixed(2)),
    profitRate: invested > 0 ? finalValue / invested - 1 : null,
    xirr: rate
  };
}
function getIndexAnalytics(ctx, options = {}) {
  const indices = listInstruments(ctx.handle).filter((i) => i.type === "INDEX" && i.active !== false).slice(0, Math.max(1, Math.min(options.limit ?? MAX_INDICES, MAX_INDICES)));
  const riskFreeRate = getRiskFreeRate(ctx.handle);
  const series = indices.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
    const byDate = /* @__PURE__ */ new Map();
    for (const point2 of points) {
      const value = Number(point2.value);
      if (Number.isFinite(value) && value > 0) byDate.set(point2.tradingDate, value);
    }
    const dates = [...byDate.keys()].sort();
    return {
      instrument,
      dates,
      values: dates.map((d) => byDate.get(d)),
      byDate,
      metrics: new Map(latestValuationMetrics(ctx.handle, instrument.id).map((m2) => [m2.metricKey, Number(m2.value)]))
    };
  });
  const withHistory = series.filter((s) => s.dates.length > 0);
  const rows = withHistory.map((entry) => {
    const { dates, values } = entry;
    const close = values[values.length - 1];
    const windowValues = values.slice(-HIGH_LOW_WINDOW);
    const highValue = Math.max(...windowValues);
    const lowValue = Math.min(...windowValues);
    const pe = finiteOrNull(entry.metrics.get("pe"));
    return {
      id: entry.instrument.id,
      code: entry.instrument.code,
      name: entry.instrument.name,
      tag: entry.instrument.tag,
      close,
      lastDate: dates[dates.length - 1],
      samples: dates.length,
      returns: {
        // 1 周按 5 个交易日前取点，比「减 7 个自然日」更贴近 A 股习惯。
        w1: values.length >= 6 && values[values.length - 6] > 0 ? close / values[values.length - 6] - 1 : null,
        m1: periodReturn2(dates, values, 1),
        m3: periodReturn2(dates, values, 3),
        m6: periodReturn2(dates, values, 6),
        y1: periodReturn2(dates, values, 12),
        y3: periodReturn2(dates, values, 36),
        y5: periodReturn2(dates, values, 60),
        ytd: ytdReturn(dates, values)
      },
      volatility: annualizedVolatility2(values),
      maxDrawdown: maxDrawdown2(values.slice(-VOL_WINDOW)),
      high: {
        window: Math.min(HIGH_LOW_WINDOW, values.length),
        isNewHigh: close >= highValue,
        distance: highValue > 0 ? close / highValue - 1 : null
      },
      low: {
        window: Math.min(HIGH_LOW_WINDOW, values.length),
        isNewLow: close <= lowValue,
        distance: lowValue > 0 ? close / lowValue - 1 : null
      },
      rps: null,
      // 下面统一按 1 年收益排名回填
      turnover: null,
      pe,
      pb: finiteOrNull(entry.metrics.get("pb")),
      dividendYield: finiteOrNull(entry.metrics.get("dividend_yield"))
    };
  });
  if (rows.length >= 2) {
    const ranked = [...rows].sort((a, b) => (b.returns.y1 ?? Number.NEGATIVE_INFINITY) - (a.returns.y1 ?? Number.NEGATIVE_INFINITY));
    ranked.forEach((row, index) => {
      if (row.returns.y1 === null) return;
      row.rps = Number((100 * (1 - index / (ranked.length - 1))).toFixed(1));
    });
  }
  const matrix = withHistory.map(() => withHistory.map(() => null));
  let samples = 0;
  for (let i = 0; i < withHistory.length; i += 1) {
    matrix[i][i] = 1;
    for (let j = i + 1; j < withHistory.length; j += 1) {
      const common = withHistory[i].dates.filter((d) => withHistory[j].byDate.has(d));
      if (common.length < MIN_COMMON_SAMPLES2) continue;
      const ra = [];
      const rb = [];
      for (let k = 1; k < common.length; k += 1) {
        const a0 = withHistory[i].byDate.get(common[k - 1]);
        const a1 = withHistory[i].byDate.get(common[k]);
        const b0 = withHistory[j].byDate.get(common[k - 1]);
        const b1 = withHistory[j].byDate.get(common[k]);
        if (a0 > 0 && b0 > 0) {
          ra.push(a1 / a0 - 1);
          rb.push(b1 / b0 - 1);
        }
      }
      const rho = correlation(ra, rb);
      matrix[i][j] = rho;
      matrix[j][i] = rho;
      if (rho !== null) samples = Math.max(samples, common.length);
    }
  }
  const dca = withHistory.map((entry) => {
    const result = dcaBacktest(entry.dates, entry.values);
    return result ? { code: entry.instrument.code, name: entry.instrument.name, ...result } : null;
  }).filter((row) => row !== null);
  const graham = rows.map((row) => {
    const earningsYield = row.pe !== null && row.pe > 0 ? 1 / row.pe : null;
    return {
      code: row.code,
      name: row.name,
      pe: row.pe,
      earningsYield,
      riskFreeRate,
      grahamIndex: earningsYield !== null && riskFreeRate > 0 ? earningsYield / riskFreeRate : null,
      erp: earningsYield !== null ? earningsYield - riskFreeRate : null
    };
  });
  const beginDates = withHistory.map((s) => s.dates[0]).sort();
  const endDates = withHistory.map((s) => s.dates[s.dates.length - 1]).sort();
  const etf = listInstruments(ctx.handle).filter((i) => i.type === "ETF" && i.active !== false).slice(0, 50).map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
    const byDate = /* @__PURE__ */ new Map();
    for (const point2 of points) {
      const value = Number(point2.value);
      if (Number.isFinite(value) && value > 0) byDate.set(point2.tradingDate, value);
    }
    const dates = [...byDate.keys()].sort();
    const values = dates.map((d) => byDate.get(d));
    const metrics = new Map(latestValuationMetrics(ctx.handle, instrument.id).map((m2) => [m2.metricKey, Number(m2.value)]));
    return {
      id: instrument.id,
      code: instrument.code,
      name: instrument.name,
      close: values.length > 0 ? values[values.length - 1] : null,
      lastDate: dates.length > 0 ? dates[dates.length - 1] : null,
      samples: dates.length,
      y1: values.length > 0 ? periodReturn2(dates, values, 12) : null,
      ytd: values.length > 0 ? ytdReturn(dates, values) : null,
      pe: finiteOrNull(metrics.get("pe"))
    };
  });
  return {
    window: {
      begin: beginDates[0] ?? null,
      end: endDates[endDates.length - 1] ?? null,
      tradingDays: withHistory.reduce((max, s) => Math.max(max, s.dates.length), 0)
    },
    rows,
    etf,
    correlation: {
      codes: withHistory.map((s) => s.instrument.code),
      names: withHistory.map((s) => s.instrument.name),
      matrix,
      samples
    },
    dca,
    graham,
    coverage: {
      indices: indices.length,
      withHistory: withHistory.length,
      withValuation: rows.filter((r) => r.pe !== null).length,
      etf: etf.length
    },
    note: withHistory.length === 0 ? "\u5C1A\u65E0\u6307\u6570\u65E5\u7EBF\u6570\u636E\u3002\u5148\u5728\u300C\u6307\u6570\u300D\u9875\u5BFC\u5165\u5E38\u7528\u6307\u6570\u5E76\u5237\u65B0\u884C\u60C5\uFF0C\u8FD9\u91CC\u7684\u9636\u6BB5\u6536\u76CA\u3001\u6CE2\u52A8\u7387\u3001\u65B0\u9AD8\u65B0\u4F4E\u624D\u6709\u6570\u503C\u3002" : `\u57FA\u4E8E\u672C\u673A\u6307\u6570\u65E5\u7EBF\u8BA1\u7B97\uFF1A\u9636\u6BB5\u6536\u76CA\u6309\u81EA\u7136\u6708\u56DE\u9000\u53D6\u6700\u8FD1\u4EA4\u6613\u65E5\uFF0C\u4E0D\u63D2\u503C\uFF1B\u6CE2\u52A8\u7387\u53D6\u8FD1 ${VOL_WINDOW} \u4E2A\u4EA4\u6613\u65E5 \xD7 \u221A252\uFF1B\u65B0\u9AD8\u65B0\u4F4E\u7A97\u53E3 ${HIGH_LOW_WINDOW} \u4E2A\u4EA4\u6613\u65E5\uFF1B\u6362\u624B\u7387 / \u4E24\u878D / \u4E92\u8054\u4E92\u901A\u6570\u636E\u6E90\u4E0D\u542B\uFF0C\u6052\u4E3A\u7A7A\u3002`
  };
}

// plugin/core/src/strategy.ts
var m = (key, label, weight, direction, favorableAt, adverseAt, required = false) => ({ key, label, weight, direction, favorableAt, adverseAt, required });
var BUILTIN_TEMPLATES = [
  {
    id: "dividend-lowvol",
    name: "\u7EA2\u5229\u4F4E\u6CE2",
    scope: "\u7EA2\u5229 / \u4F4E\u6CE2\u6307\u6570\u53CA\u76F8\u5173 ETF\u3001\u57FA\u91D1",
    metrics: [
      m("pe_percentile", "PE \u5386\u53F2\u5206\u4F4D", 25, "lower-better", 20, 60, true),
      m("pb_percentile", "PB \u5386\u53F2\u5206\u4F4D", 20, "lower-better", 20, 60),
      m("dividend_yield", "\u80A1\u606F\u7387\uFF08%\uFF09", 25, "higher-better", 4, 2),
      m("sharpe", "\u590F\u666E\u6BD4\u7387", 15, "higher-better", 0.8, 0.2),
      m("max_drawdown_pct", "\u6700\u5927\u56DE\u64A4\uFF08%\uFF0C\u6B63\u503C\uFF09", 15, "lower-better", 15, 30)
    ]
  },
  {
    id: "broad-index",
    name: "\u5BBD\u57FA\u6307\u6570",
    scope: "\u6CAA\u6DF1 300 / \u4E2D\u8BC1 500 / A500 \u53CA\u76F8\u5173 ETF\u3001\u57FA\u91D1",
    metrics: [
      m("pe_percentile", "PE \u5386\u53F2\u5206\u4F4D", 35, "lower-better", 20, 60, true),
      m("pb_percentile", "PB \u5386\u53F2\u5206\u4F4D", 25, "lower-better", 20, 60),
      m("dividend_yield", "\u80A1\u606F\u7387\uFF08%\uFF09", 20, "higher-better", 2.5, 1.5),
      m("sharpe", "\u590F\u666E\u6BD4\u7387", 10, "higher-better", 0.8, 0.2),
      m("max_drawdown_pct", "\u6700\u5927\u56DE\u64A4\uFF08%\uFF0C\u6B63\u503C\uFF09", 10, "lower-better", 20, 35)
    ]
  },
  {
    id: "growth-tech",
    name: "\u6210\u957F / \u79D1\u6280",
    scope: "\u79D1\u521B\u3001\u521B\u4E1A\u677F\u3001\u534A\u5BFC\u4F53\u53CA\u76F8\u5173\u4EA7\u54C1",
    metrics: [
      m("pe_percentile", "PE \u5386\u53F2\u5206\u4F4D", 25, "lower-better", 30, 70, true),
      m("pb_percentile", "PB \u5386\u53F2\u5206\u4F4D", 15, "lower-better", 30, 70),
      m("sharpe", "\u590F\u666E\u6BD4\u7387", 20, "higher-better", 0.9, 0.2),
      m("max_drawdown_pct", "\u6700\u5927\u56DE\u64A4\uFF08%\uFF0C\u6B63\u503C\uFF09", 20, "lower-better", 25, 40),
      m("annual_volatility_pct", "\u5E74\u5316\u6CE2\u52A8\u7387\uFF08%\uFF09", 20, "lower-better", 22, 35)
    ]
  },
  {
    id: "stock-value",
    name: "\u4E2A\u80A1\u4EF7\u503C / \u8D28\u91CF",
    scope: "A \u80A1\u4E2A\u80A1",
    metrics: [
      m("pe", "PE-TTM", 20, "lower-better", 12, 30, true),
      m("pb", "PB", 15, "lower-better", 1.5, 3),
      m("roe", "ROE\uFF08%\uFF09", 20, "higher-better", 14, 8),
      m("dividend_yield", "\u80A1\u606F\u7387\uFF08%\uFF09", 15, "higher-better", 3, 1.5),
      m("max_drawdown_pct", "\u6700\u5927\u56DE\u64A4\uFF08%\uFF0C\u6B63\u503C\uFF09", 10, "lower-better", 25, 40),
      m("annual_volatility_pct", "\u5E74\u5316\u6CE2\u52A8\u7387\uFF08%\uFF09", 20, "lower-better", 30, 45)
    ]
  }
];
function scoreMetric(rule, value) {
  if (value === null || !Number.isFinite(value)) {
    return { score: null, status: "missing" };
  }
  if (rule.direction === "lower-better") {
    if (value <= rule.favorableAt) return { score: rule.weight, status: "favorable" };
    if (value >= rule.adverseAt) return { score: rule.weight * 0.1, status: "adverse" };
    const span2 = rule.adverseAt - rule.favorableAt;
    const ratio2 = span2 > 0 ? (value - rule.favorableAt) / span2 : 1;
    return { score: rule.weight * (0.9 - 0.8 * Math.min(Math.max(ratio2, 0), 1)), status: "neutral" };
  }
  if (value >= rule.favorableAt) return { score: rule.weight, status: "favorable" };
  if (value <= rule.adverseAt) return { score: rule.weight * 0.1, status: "adverse" };
  const span = rule.favorableAt - rule.adverseAt;
  const ratio = span > 0 ? (rule.favorableAt - value) / span : 1;
  return { score: rule.weight * (0.9 - 0.8 * Math.min(Math.max(ratio, 0), 1)), status: "neutral" };
}
function levelOf(total) {
  if (total === null) return "\u6570\u636E\u4E0D\u8DB3";
  if (total >= 80) return "\u4F18\u5148\u7814\u7A76";
  if (total >= 65) return "\u6301\u7EED\u89C2\u5BDF";
  if (total >= 45) return "\u4E2D\u6027\u89C2\u5BDF";
  return "\u6682\u7F13\u65B0\u589E\u5173\u6CE8";
}
function scoreWithTemplate(template, values) {
  const valueMap = new Map(values.map((v) => [v.key, v.value]));
  const scored = [];
  let total = 0;
  let weightCovered = 0;
  let missingRequired = false;
  for (const rule of template.metrics) {
    const { score, status } = scoreMetric(rule, valueMap.get(rule.key) ?? null);
    if (status === "missing" && rule.required) missingRequired = true;
    if (score !== null) {
      total += score;
      weightCovered += rule.weight;
    }
    scored.push({ key: rule.key, label: rule.label, value: valueMap.get(rule.key) ?? null, weight: rule.weight, score, status });
  }
  if (missingRequired) {
    return {
      templateId: template.id,
      templateName: template.name,
      total: null,
      level: "\u6570\u636E\u4E0D\u8DB3",
      coverage: weightCovered / 100,
      metrics: scored,
      reason: "\u5FC5\u9700\u6307\u6807\u7F3A\u5931\uFF0C\u4E0D\u4EA7\u751F\u8BC4\u5206"
    };
  }
  const coverage = weightCovered / 100;
  if (coverage < 0.8) {
    return {
      templateId: template.id,
      templateName: template.name,
      total: null,
      level: "\u6570\u636E\u4E0D\u8DB3",
      coverage,
      metrics: scored,
      reason: `\u6570\u636E\u8986\u76D6\u7387 ${(coverage * 100).toFixed(0)}% \u4F4E\u4E8E 80%`
    };
  }
  return {
    templateId: template.id,
    templateName: template.name,
    total: Math.round(total * 10) / 10,
    level: levelOf(total),
    coverage,
    metrics: scored,
    reason: null
  };
}

// plugin/server/src/repo/strategies.ts
function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new ValidationError("\u7B56\u7565\u89C4\u5219\u4E0D\u80FD\u4E3A\u7A7A");
  const out = [];
  let weightSum = 0;
  for (const raw of rules) {
    const rule = raw;
    if (!rule || typeof rule.key !== "string" || rule.key.trim() === "") throw new ValidationError("\u89C4\u5219\u7F3A\u5C11\u6307\u6807\u952E");
    if (typeof rule.label !== "string" || rule.label.trim() === "") throw new ValidationError(`\u89C4\u5219 ${rule.key} \u7F3A\u5C11\u540D\u79F0`);
    const weight = Number(rule.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new ValidationError(`\u89C4\u5219 ${rule.key} \u6743\u91CD\u5FC5\u987B\u5728 0\u2013100 \u4E4B\u95F4`);
    if (rule.direction !== "lower-better" && rule.direction !== "higher-better") throw new ValidationError(`\u89C4\u5219 ${rule.key} \u65B9\u5411\u4E0D\u5408\u6CD5`);
    const favorableAt = Number(rule.favorableAt);
    const adverseAt = Number(rule.adverseAt);
    if (!Number.isFinite(favorableAt) || !Number.isFinite(adverseAt)) throw new ValidationError(`\u89C4\u5219 ${rule.key} \u9608\u503C\u5FC5\u987B\u662F\u6570\u5B57`);
    if (rule.direction === "lower-better" ? favorableAt >= adverseAt : favorableAt <= adverseAt) {
      throw new ValidationError(`\u89C4\u5219 ${rule.key} \u7684\u4F18\u5148\u7EBF\u5FC5\u987B\u4F18\u4E8E\u4E0D\u5229\u7EBF`);
    }
    weightSum += weight;
    out.push({
      key: rule.key.trim(),
      label: rule.label.trim(),
      weight,
      direction: rule.direction,
      favorableAt,
      adverseAt,
      required: rule.required === true
    });
  }
  if (Math.abs(weightSum - 100) > 1e-3) throw new ValidationError(`\u6743\u91CD\u5408\u8BA1\u5FC5\u987B\u4E3A 100\uFF08\u5F53\u524D ${weightSum}\uFF09`);
  if (!out.some((r) => r.required)) throw new ValidationError("\u81F3\u5C11\u9700\u8981\u4E00\u6761\u5FC5\u9700\u6307\u6807\uFF08\u7F3A\u5931\u65F6\u4E0D\u4EA7\u751F\u8BC4\u5206\uFF09");
  const keys = new Set(out.map((r) => r.key));
  if (keys.size !== out.length) throw new ValidationError("\u540C\u4E00\u6307\u6807\u4E0D\u80FD\u91CD\u590D\u51FA\u73B0\u5728\u89C4\u5219\u4E2D");
  return out;
}
function currentRules(handle2, row) {
  const version = handle2.db.prepare(
    "SELECT rules_json FROM strategy_versions WHERE template_id = ? AND version = ?"
  ).get(row.id, row.current_version);
  if (!version) return [];
  try {
    return validateRules(JSON.parse(version.rules_json));
  } catch {
    return [];
  }
}
function listTemplates(handle2) {
  const rows = handle2.db.prepare("SELECT * FROM strategy_templates ORDER BY created_at").all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out = BUILTIN_TEMPLATES.map((template) => {
    const row = byId.get(template.id);
    if (!row) {
      return { ...template, metrics: template.metrics, origin: "builtin", version: 0, updatedAt: null, editable: true };
    }
    byId.delete(template.id);
    const rules = currentRules(handle2, row);
    return {
      ...template,
      metrics: rules.length > 0 ? rules : template.metrics,
      origin: "builtin",
      version: row.current_version,
      updatedAt: row.updated_at,
      editable: true
    };
  });
  for (const row of byId.values()) {
    const rules = currentRules(handle2, row);
    out.push({
      id: row.id,
      name: row.name,
      scope: row.scope,
      metrics: rules,
      origin: "custom",
      version: row.current_version,
      updatedAt: row.updated_at,
      editable: true
    });
  }
  return out;
}
function saveTemplate(handle2, input) {
  const rules = validateRules(input.metrics);
  const name = String(input.name ?? "").trim();
  if (!name) throw new ValidationError("\u6A21\u677F\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A");
  const now = nowIso();
  const builtin = input.id ? BUILTIN_TEMPLATES.some((t) => t.id === input.id) : false;
  const id = input.id ?? newId();
  const existing = handle2.db.prepare("SELECT * FROM strategy_templates WHERE id = ?").get(id);
  const version = (existing?.current_version ?? 0) + 1;
  handle2.db.exec("BEGIN;");
  try {
    if (existing) {
      handle2.db.prepare("UPDATE strategy_templates SET name = ?, scope = ?, current_version = ?, updated_at = ? WHERE id = ?").run(name, input.scope ?? existing.scope, version, now, id);
    } else {
      handle2.db.prepare("INSERT INTO strategy_templates (id, name, scope, origin, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)").run(id, name, input.scope ?? "", builtin ? "builtin" : "custom", version, now, now);
    }
    handle2.db.prepare("INSERT INTO strategy_versions (id, template_id, version, rules_json, note, created_at) VALUES (?,?,?,?,?,?)").run(newId(), id, version, JSON.stringify(rules), input.note ?? "", now);
    handle2.db.exec("COMMIT;");
  } catch (error) {
    handle2.db.exec("ROLLBACK;");
    throw error;
  }
  return listTemplates(handle2).find((t) => t.id === id);
}
function listVersions(handle2, templateId) {
  const current = handle2.db.prepare("SELECT current_version FROM strategy_templates WHERE id = ?").get(templateId);
  const rows = handle2.db.prepare("SELECT * FROM strategy_versions WHERE template_id = ? ORDER BY version DESC").all(templateId);
  return rows.map((row) => ({
    templateId: row.template_id,
    version: row.version,
    rules: (() => {
      try {
        return JSON.parse(row.rules_json);
      } catch {
        return [];
      }
    })(),
    note: row.note,
    createdAt: row.created_at,
    current: current?.current_version === row.version
  }));
}
function restoreVersion(handle2, templateId, version) {
  const row = handle2.db.prepare("SELECT * FROM strategy_versions WHERE template_id = ? AND version = ?").get(templateId, version);
  if (!row) throw new NotFoundError(`\u7248\u672C\u4E0D\u5B58\u5728\uFF1Av${version}`);
  const template = listTemplates(handle2).find((t) => t.id === templateId);
  if (!template) throw new NotFoundError(`\u6A21\u677F\u4E0D\u5B58\u5728\uFF1A${templateId}`);
  return saveTemplate(handle2, {
    id: templateId,
    name: template.name,
    scope: template.scope,
    metrics: validateRules(JSON.parse(row.rules_json)),
    note: `\u56DE\u6EDA\u81EA v${version}`
  });
}

// plugin/server/src/services/import.ts
var HEADERS = {
  "\u8D26\u6237": "accountName",
  "account": "accountName",
  "\u6807\u7684\u4EE3\u7801": "instrumentCode",
  "\u4EE3\u7801": "instrumentCode",
  "code": "instrumentCode",
  "\u6807\u7684\u540D\u79F0": "instrumentName",
  "\u540D\u79F0": "instrumentName",
  "name": "instrumentName",
  "\u8D44\u4EA7\u7C7B\u522B": "instrumentType",
  "\u6807\u7684\u7C7B\u578B": "instrumentType",
  "asset_type": "instrumentType",
  "\u4EA4\u6613\u7C7B\u578B": "txnType",
  "\u7C7B\u578B": "txnType",
  "type": "txnType",
  "\u4EA4\u6613\u65E5": "tradeDate",
  "\u65E5\u671F": "tradeDate",
  "trade_date": "tradeDate",
  "\u6570\u91CF": "quantity",
  "\u4EFD\u989D": "quantity",
  "quantity": "quantity",
  "\u4EF7\u683C": "price",
  "\u5355\u4EF7": "price",
  "price": "price",
  "\u91D1\u989D": "amount",
  "amount": "amount",
  "\u624B\u7EED\u8D39": "fee",
  "fee": "fee",
  "\u7A0E\u8D39": "tax",
  "tax": "tax",
  "\u72B6\u6001": "status",
  "status": "status",
  "\u5907\u6CE8": "note",
  "note": "note",
  "\u5E42\u7B49\u952E": "requestId",
  "request_id": "requestId"
};
var TXN_TYPES = {
  "\u4E70\u5165": "BUY",
  "buy": "BUY",
  "BUY": "BUY",
  "\u5356\u51FA": "SELL",
  "sell": "SELL",
  "SELL": "SELL",
  "\u671F\u521D": "OPENING",
  "\u671F\u521D\u5EFA\u8D26": "OPENING",
  "opening": "OPENING",
  "OPENING": "OPENING",
  "\u73B0\u91D1\u5206\u7EA2": "DIVIDEND_CASH",
  "dividend_cash": "DIVIDEND_CASH",
  "DIVIDEND_CASH": "DIVIDEND_CASH",
  "\u7EA2\u5229\u518D\u6295": "DIVIDEND_REINVEST",
  "dividend_reinvest": "DIVIDEND_REINVEST",
  "DIVIDEND_REINVEST": "DIVIDEND_REINVEST",
  "\u8D39\u7528": "FEE",
  "fee": "FEE",
  "FEE": "FEE",
  "\u62C6\u5206": "SPLIT",
  "split": "SPLIT",
  "SPLIT": "SPLIT",
  "\u4FEE\u6B63": "CORRECTION",
  "correction": "CORRECTION",
  "CORRECTION": "CORRECTION"
};
var ASSET_TYPES = {
  "\u80A1\u7968": "STOCK",
  "stock": "STOCK",
  "STOCK": "STOCK",
  "ETF": "ETF",
  "etf": "ETF",
  "\u57FA\u91D1": "OPEN_END_FUND",
  "\u573A\u5916\u57FA\u91D1": "OPEN_END_FUND",
  "fund": "OPEN_END_FUND",
  "OPEN_END_FUND": "OPEN_END_FUND"
};
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
function fixed(value, scale, label, line) {
  if (value.trim() === "") return null;
  const parsed = parseFixed(value.trim(), scale);
  if (!Number.isFinite(parsed)) throw new ValidationError(`\u7B2C ${line} \u884C ${label} \u4E0D\u662F\u5408\u6CD5\u6570\u503C\uFF1A${value}`);
  return formatFixed(parsed, scale);
}
function previewImport(ctx, text) {
  const table = parseCsv(text);
  if (table.length === 0) throw new ValidationError("CSV \u4E3A\u7A7A");
  const header = table[0].map((h) => h.trim());
  const keys = header.map((h) => {
    const key = HEADERS[h] ?? HEADERS[h.toLowerCase()];
    if (!key) throw new ValidationError(`\u4E0D\u8BA4\u8BC6\u7684\u8868\u5934\u300C${h}\u300D\uFF0C\u53EF\u7528\u5217\uFF1A\u8D26\u6237,\u6807\u7684\u4EE3\u7801,\u6807\u7684\u540D\u79F0,\u8D44\u4EA7\u7C7B\u522B,\u4EA4\u6613\u7C7B\u578B,\u4EA4\u6613\u65E5,\u6570\u91CF,\u4EF7\u683C,\u91D1\u989D,\u624B\u7EED\u8D39,\u7A0E\u8D39,\u72B6\u6001,\u5907\u6CE8,\u5E42\u7B49\u952E`);
    return key;
  });
  const errors = [];
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1;
    const cells = table[i];
    const record = {};
    keys.forEach((key, col) => {
      record[key] = (cells[col] ?? "").trim();
    });
    try {
      if (!record.accountName) throw new ValidationError("\u8D26\u6237\u4E0D\u80FD\u4E3A\u7A7A");
      if (!record.instrumentCode) throw new ValidationError("\u6807\u7684\u4EE3\u7801\u4E0D\u80FD\u4E3A\u7A7A");
      const txnType = TXN_TYPES[record.txnType ?? ""];
      if (!txnType) throw new ValidationError(`\u4EA4\u6613\u7C7B\u578B\u4E0D\u8BA4\u8BC6\uFF1A${record.txnType || "\uFF08\u7A7A\uFF09"}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.tradeDate ?? "")) throw new ValidationError("\u4EA4\u6613\u65E5\u5FC5\u987B\u4E3A YYYY-MM-DD");
      const instrumentType = ASSET_TYPES[record.instrumentType ?? ""] ?? "STOCK";
      const row = {
        line,
        accountName: record.accountName,
        instrumentCode: record.instrumentCode,
        instrumentName: record.instrumentName || record.instrumentCode,
        instrumentType,
        txnType,
        tradeDate: record.tradeDate,
        quantity: fixed(record.quantity ?? "", SCALE_QTY, "\u6570\u91CF", line),
        price: fixed(record.price ?? "", SCALE_QTY, "\u4EF7\u683C", line),
        amount: fixed(record.amount ?? "", SCALE_AMOUNT, "\u91D1\u989D", line),
        fee: fixed(record.fee ?? "", SCALE_AMOUNT, "\u624B\u7EED\u8D39", line),
        tax: fixed(record.tax ?? "", SCALE_AMOUNT, "\u7A0E\u8D39", line),
        status: /待确认|PENDING/i.test(record.status ?? "") ? "PENDING_CONFIRMATION" : "CONFIRMED",
        note: record.note ?? "",
        requestId: record.requestId || `csv:${line}:${[record.tradeDate, record.instrumentCode, txnType, record.quantity, record.price, record.amount, record.accountName].join(":")}`
      };
      rows.push(row);
    } catch (error) {
      errors.push({ line, message: error.message });
    }
  }
  const accounts = new Set(listAccounts(ctx.handle).map((a) => a.name.trim()));
  const instruments = new Set(listInstruments(ctx.handle).map((i) => `${i.code}:${i.type}`));
  return {
    header,
    rows,
    errors,
    summary: {
      total: table.length - 1,
      valid: rows.length,
      invalid: errors.length,
      newAccounts: [...new Set(rows.filter((r) => !accounts.has(r.accountName)).map((r) => r.accountName))],
      newInstruments: [...new Set(rows.filter((r) => !instruments.has(`${r.instrumentCode}:${r.instrumentType}`)).map((r) => `${r.instrumentName} ${r.instrumentCode}`))]
    }
  };
}
function commitImport(ctx, text) {
  const preview = previewImport(ctx, text);
  const handle2 = ctx.handle;
  const createdAccounts = [];
  const createdInstruments = [];
  let imported = 0;
  let skipped = 0;
  handle2.db.exec("BEGIN;");
  try {
    const accounts = new Map(listAccounts(handle2).map((a) => [a.name.trim(), a]));
    const instruments = new Map(listInstruments(handle2).map((i) => [`${i.code}:${i.type}`, i]));
    for (const row of preview.rows) {
      let account = accounts.get(row.accountName);
      if (!account) {
        account = saveAccount(handle2, { name: row.accountName, platform: "CSV \u5BFC\u5165" });
        accounts.set(row.accountName, account);
        createdAccounts.push(row.accountName);
      }
      const key = `${row.instrumentCode}:${row.instrumentType}`;
      let instrument = instruments.get(key);
      if (!instrument) {
        const market = row.instrumentType === "OPEN_END_FUND" ? "OTC" : row.instrumentCode.startsWith("6") || row.instrumentCode.startsWith("5") ? "SH" : "SZ";
        instrument = saveInstrument(handle2, {
          code: row.instrumentCode,
          name: row.instrumentName,
          type: row.instrumentType,
          market,
          fundCode: row.instrumentType === "OPEN_END_FUND" ? row.instrumentCode : null
        });
        instruments.set(key, instrument);
        createdInstruments.push(`${row.instrumentName} ${row.instrumentCode}`);
      }
      const saved = saveTransaction(handle2, {
        accountId: account.id,
        instrumentId: instrument.id,
        type: row.txnType,
        status: row.status,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        price: row.price,
        amount: row.amount,
        fee: row.fee,
        tax: row.tax,
        note: `${row.note}${row.note ? " \xB7 " : ""}CSV \u5BFC\u5165\uFF08\u7B2C ${row.line} \u884C\uFF09`,
        requestId: row.requestId
      });
      if (saved.deduplicated) skipped += 1;
      else imported += 1;
    }
    replayPositions(allTransactions(handle2));
    handle2.db.exec("COMMIT;");
  } catch (error) {
    handle2.db.exec("ROLLBACK;");
    throw error;
  }
  return {
    imported,
    skipped,
    newAccounts: createdAccounts,
    newInstruments: createdInstruments,
    errors: preview.errors,
    note: "CSV \u5BFC\u5165\u5728\u5355\u4E2A\u4E8B\u52A1\u5185\u5B8C\u6210\uFF1B\u9519\u8BEF\u884C\u8DF3\u8FC7\uFF0C\u91CD\u590D\u5E42\u7B49\u952E\u4E0D\u91CD\u590D\u5199\u5165\uFF0C\u56DE\u653E\u6821\u9A8C\u5931\u8D25\u6574\u6279\u56DE\u6EDA\u3002"
  };
}

// plugin/server/src/xlsx.ts
import { inflateRawSync } from "node:zlib";
var EOCD_SIG = 101010256;
var CEN_SIG = 33639248;
var LOC_SIG = 67324752;
function readZipEntries(buffer) {
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 65535 - 22);
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ValidationError("\u4E0D\u662F\u6709\u6548\u7684 .xlsx\uFF08\u672A\u627E\u5230 ZIP \u76EE\u5F55\uFF09\uFF1B\u5982\u4E3A .xls \u8001\u683C\u5F0F\u8BF7\u53E6\u5B58\u4E3A .xlsx");
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = /* @__PURE__ */ new Map();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CEN_SIG) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    entries.set(name, { name, offset, compressedSize, method });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function readEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.offset) !== LOC_SIG) {
    throw new ValidationError(`xlsx \u5185\u6587\u4EF6\u635F\u574F\uFF1A${entry.name}`);
  }
  const nameLen = buffer.readUInt16LE(entry.offset + 26);
  const extraLen = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      throw new ValidationError(`xlsx \u89E3\u538B\u5931\u8D25\uFF1A${entry.name}`);
    }
  }
  throw new ValidationError(`\u4E0D\u652F\u6301\u7684 ZIP \u538B\u7F29\u65B9\u5F0F ${entry.method}\uFF1A${entry.name}`);
}
function decodeXml(text) {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, entity) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  });
}
function joinText(xml) {
  const parts = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = re.exec(xml)) !== null) parts.push(decodeXml(match[1]));
  return parts.join("");
}
function attr(tag, name) {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const match = re.exec(tag);
  return match ? match[1] : null;
}
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "";
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}
var BUILTIN_DATE_FORMATS = /* @__PURE__ */ new Set([
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  27,
  28,
  29,
  30,
  31,
  34,
  35,
  36,
  45,
  46,
  47,
  50,
  51,
  52,
  53,
  54,
  55,
  56,
  57,
  58
]);
function isDateFormatCode(code) {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return /[ymdhs]/i.test(stripped);
}
function excelSerialToDate(serial) {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2958465) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 864e5);
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m2 = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (y < 1900 || y > 2200) return null;
  return `${y}-${m2}-${d}`;
}
function normalizeNumber(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  return String(Math.round(value * 1e10) / 1e10);
}
function readDateStyles(xml) {
  const customDateFormats = /* @__PURE__ */ new Set();
  const fmtRe = /<numFmt\b[^>]*\/?>/g;
  let fmtMatch;
  while ((fmtMatch = fmtRe.exec(xml)) !== null) {
    const id = attr(fmtMatch[0], "numFmtId");
    const code = attr(fmtMatch[0], "formatCode");
    if (id !== null && code !== null && isDateFormatCode(decodeXml(code))) customDateFormats.add(Number(id));
  }
  const dateStyleIndexes = /* @__PURE__ */ new Set();
  const xfBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? "";
  const xfRe = /<xf\b[^>]*\/?>/g;
  let index = 0;
  let xfMatch;
  while ((xfMatch = xfRe.exec(xfBlock)) !== null) {
    const numFmtId = Number(attr(xfMatch[0], "numFmtId") ?? "0");
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) dateStyleIndexes.add(index);
    index += 1;
  }
  return { dateStyleIndexes };
}
function pickSheetPath(entries) {
  if (entries.has("xl/worksheets/sheet1.xml")) return "xl/worksheets/sheet1.xml";
  const candidates = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1]));
  if (candidates.length === 0) throw new ValidationError("xlsx \u5185\u6CA1\u6709\u5DE5\u4F5C\u8868");
  return candidates[0];
}
function readSharedStrings(xml) {
  const items = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = re.exec(xml)) !== null) items.push(joinText(match[1]));
  return items;
}
function readXlsxFirstSheet(buffer) {
  const entries = readZipEntries(buffer);
  const shared = entries.has("xl/sharedStrings.xml") ? readSharedStrings(readEntry(buffer, entries.get("xl/sharedStrings.xml")).toString("utf8")) : [];
  const styles = entries.has("xl/styles.xml") ? readDateStyles(readEntry(buffer, entries.get("xl/styles.xml")).toString("utf8")) : { dateStyleIndexes: /* @__PURE__ */ new Set() };
  const sheetPath = pickSheetPath(entries);
  const sheetXml = readEntry(buffer, entries.get(sheetPath)).toString("utf8");
  if (!/<sheetData/.test(sheetXml)) throw new ValidationError("\u5DE5\u4F5C\u8868\u4E3A\u7A7A\uFF08\u6CA1\u6709 sheetData\uFF09");
  const grid = [];
  const rowRe = /<row\b([^>]*?)(\/?)>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const rowTag = rowMatch[1];
    const rowIndex = Number(attr(rowTag, "r") ?? String(grid.length + 1)) - 1;
    const cells = [];
    let rowBody = "";
    if (rowMatch[2] !== "/") {
      const rowEnd = sheetXml.indexOf("</row>", rowRe.lastIndex);
      if (rowEnd >= 0) {
        rowBody = sheetXml.slice(rowRe.lastIndex, rowEnd);
        rowRe.lastIndex = rowEnd + "</row>".length;
      }
    }
    const cellRe = /<c\b([^>]*?)(\/?)>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const tag = cellMatch[1];
      let body = "";
      if (cellMatch[2] !== "/") {
        const cellEnd = rowBody.indexOf("</c>", cellRe.lastIndex);
        if (cellEnd >= 0) {
          body = rowBody.slice(cellRe.lastIndex, cellEnd);
          cellRe.lastIndex = cellEnd + "</c>".length;
        }
      }
      const ref = attr(tag, "r") ?? "";
      const col = ref ? columnIndex(ref) : cells.length;
      const type = attr(tag, "t") ?? "n";
      const styleIndex = attr(tag, "s") === null ? null : Number(attr(tag, "s"));
      let value = "";
      if (type === "s") {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = shared[Number(raw)] ?? "";
      } else if (type === "inlineStr") {
        value = joinText(body);
      } else if (type === "str" || type === "e") {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      } else if (type === "b") {
        value = (/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "") === "1" ? "TRUE" : "FALSE";
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        if (raw === "") value = "";
        else if (styleIndex !== null && styles.dateStyleIndexes.has(styleIndex)) {
          const asDate = excelSerialToDate(Number(raw));
          value = asDate ?? normalizeNumber(raw);
        } else value = normalizeNumber(raw);
      }
      while (cells.length < col) cells.push("");
      cells[col] = value.trim();
    }
    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = cells;
  }
  const nonEmpty = grid.filter((row) => row.some((cell) => cell !== ""));
  if (nonEmpty.length === 0) throw new ValidationError("\u5DE5\u4F5C\u8868\u6CA1\u6709\u4EFB\u4F55\u6570\u636E\u884C");
  const header = nonEmpty[0].map((cell) => cell.trim());
  const rows = nonEmpty.slice(1).map((row) => {
    const padded = [...row];
    while (padded.length < header.length) padded.push("");
    return padded;
  });
  return {
    sheetName: sheetPath,
    header,
    rows,
    skippedRows: grid.length - nonEmpty.length
  };
}
function sheetToCsv(table) {
  const escape = (cell) => /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
  const lines = [table.header.map(escape).join(",")];
  for (const row of table.rows) {
    const padded = [...row];
    while (padded.length < table.header.length) padded.push("");
    lines.push(padded.slice(0, table.header.length).map(escape).join(","));
  }
  return lines.join("\n");
}
function xlsxBase64ToCsv(base64) {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (cleaned === "") throw new ValidationError("xlsx \u5185\u5BB9\u4E3A\u7A7A");
  let buffer;
  try {
    buffer = Buffer.from(cleaned, "base64");
  } catch {
    throw new ValidationError("xlsx base64 \u89E3\u7801\u5931\u8D25");
  }
  const table = readXlsxFirstSheet(buffer);
  return { csv: sheetToCsv(table), sheetName: table.sheetName, rows: table.rows.length, header: table.header };
}

// plugin/server/src/services/restore.ts
import fs2 from "node:fs";
import path2 from "node:path";
var ARRAY_FIELDS = [
  "accounts",
  "instruments",
  "transactions",
  "categories",
  "categoryLinks",
  "marketData",
  "valuationMetrics",
  "goals",
  "cashFlows",
  "aiRecords",
  "deletedPositions",
  "strategyTemplates",
  "strategyVersions"
];
function asArray(payload, key) {
  const value = payload[key];
  return Array.isArray(value) ? value.filter((v) => v && typeof v === "object") : [];
}
function previewRestore(payload) {
  const errors = [];
  const warnings = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, kind: null, schemaVersion: null, exportedAt: null, counts: {}, warnings, errors: ["\u4E0D\u662F\u5408\u6CD5\u7684 JSON \u5907\u4EFD\u5BF9\u8C61"] };
  }
  const data = payload;
  const kind = typeof data.kind === "string" ? data.kind : null;
  if (kind !== "plug-funds-backup") errors.push(`\u5907\u4EFD\u6807\u8BC6\u4E0D\u5339\u914D\uFF1A${kind ?? "\uFF08\u7F3A\u5931\uFF09"}`);
  const schemaVersion = typeof data.schemaVersion === "number" ? data.schemaVersion : null;
  if (schemaVersion === null) errors.push("\u7F3A\u5C11 schemaVersion");
  else if (schemaVersion > SCHEMA_VERSION) errors.push(`\u5907\u4EFD\u7531\u66F4\u65B0\u7248\u672C\u5199\u5165\uFF08schema ${schemaVersion} > \u63D2\u4EF6 ${SCHEMA_VERSION}\uFF09\uFF0C\u8BF7\u5148\u5347\u7EA7\u63D2\u4EF6`);
  else if (schemaVersion < SCHEMA_VERSION) warnings.push(`\u5907\u4EFD\u6765\u81EA schema v${schemaVersion}\uFF0C\u5F53\u524D v${SCHEMA_VERSION}\uFF1B\u7F3A\u5931\u7684\u65B0\u8868\u5C06\u4E3A\u7A7A`);
  for (const key of ARRAY_FIELDS) {
    if (data[key] === void 0) warnings.push(`\u5907\u4EFD\u7F3A\u5C11 ${key}\uFF08\u6309\u7A7A\u6570\u636E\u5904\u7406\uFF09`);
    else if (!Array.isArray(data[key])) errors.push(`${key} \u4E0D\u662F\u6570\u7EC4`);
  }
  const counts = {};
  for (const key of ARRAY_FIELDS) counts[key] = asArray(data, key).length;
  return {
    ok: errors.length === 0,
    kind,
    schemaVersion,
    exportedAt: typeof data.exportedAt === "string" ? data.exportedAt : null,
    counts,
    warnings,
    errors
  };
}
function str(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function backupCurrentDb(ctx) {
  const file = path2.join(ctx.dirs.data, "invest.db");
  if (!fs2.existsSync(file)) return null;
  const backupDir = path2.join(ctx.dirs.data, "backups");
  fs2.mkdirSync(backupDir, { recursive: true });
  const target = path2.join(backupDir, `pre-restore-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.db`);
  fs2.copyFileSync(file, target);
  return target;
}
function restoreBackup(ctx, payload) {
  const preview = previewRestore(payload);
  if (!preview.ok) throw new ValidationError(`\u5907\u4EFD\u6821\u9A8C\u5931\u8D25\uFF1A${preview.errors.join("\uFF1B")}`);
  const data = payload;
  const handle2 = ctx.handle;
  const backupPath = backupCurrentDb(ctx);
  const restored = {};
  handle2.db.exec("BEGIN;");
  try {
    for (const table of [
      "instrument_category_links",
      "transactions",
      "market_data",
      "valuation_metrics",
      "portfolio_goal_events",
      "portfolio_cash_flows",
      "ai_analysis_records",
      "deleted_positions",
      "strategy_versions",
      "holding_snapshots",
      "categories",
      "instruments",
      "accounts",
      "portfolio_goals",
      "strategy_templates",
      "portfolio_snapshots",
      "data_source_runs"
    ]) {
      handle2.db.prepare(`DELETE FROM ${table}`).run();
    }
    const insert = (sql, rows, key, mapper) => {
      const stmt = handle2.db.prepare(sql);
      for (const row of rows) stmt.run(...mapper(row));
      restored[key] = rows.length;
    };
    insert(
      `INSERT INTO accounts (id,name,platform,currency,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      asArray(data, "accounts"),
      "accounts",
      (r) => [str(r.id) || newId(), str(r.name), str(r.platform), str(r.currency, "CNY"), str(r.status, "ACTIVE"), str(r.note), str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]
    );
    insert(
      `INSERT INTO instruments (id,code,name,type,market,currency,benchmark_index,secid,fund_code,tag,founded_date,scale_info,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asArray(data, "instruments"),
      "instruments",
      (r) => [
        str(r.id) || newId(),
        str(r.code),
        str(r.name),
        str(r.type, "STOCK"),
        str(r.market, "SH"),
        str(r.currency, "CNY"),
        typeof r.benchmarkIndex === "string" ? r.benchmarkIndex : null,
        typeof r.secid === "string" ? r.secid : null,
        typeof r.fundCode === "string" ? r.fundCode : null,
        str(r.tag),
        typeof r.foundedDate === "string" ? r.foundedDate : null,
        typeof r.scaleInfo === "string" ? r.scaleInfo : null,
        r.active === false ? 0 : 1,
        str(r.createdAt, nowIso()),
        str(r.updatedAt, nowIso())
      ]
    );
    insert(
      `INSERT INTO categories (id,name,color,sort_order,created_at) VALUES (?,?,?,?,?)`,
      asArray(data, "categories"),
      "categories",
      (r) => [str(r.id) || newId(), str(r.name), str(r.color, "#3d6ef2"), num(r.sortOrder), str(r.createdAt, nowIso())]
    );
    insert(
      `INSERT INTO instrument_category_links (instrument_id,category_id) VALUES (?,?)`,
      asArray(data, "categoryLinks"),
      "categoryLinks",
      (r) => [str(r.instrumentId), str(r.categoryId)]
    );
    insert(
      `INSERT INTO transactions (id,account_id,instrument_id,type,status,trade_date,seq,quantity,price,amount,fee,tax,note,request_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      asArray(data, "transactions"),
      "transactions",
      (r) => [
        str(r.id) || newId(),
        str(r.accountId),
        str(r.instrumentId),
        str(r.type),
        str(r.status, "CONFIRMED"),
        str(r.tradeDate),
        num(r.seq),
        r.quantity ?? null,
        r.price ?? null,
        r.amount ?? null,
        r.fee ?? null,
        r.tax ?? null,
        str(r.note),
        typeof r.requestId === "string" ? r.requestId : null,
        str(r.createdAt, nowIso())
      ]
    );
    insert(
      `INSERT INTO market_data (id,instrument_id,price_type,value,trading_date,observed_at,provider,quality) VALUES (?,?,?,?,?,?,?,?)`,
      asArray(data, "marketData"),
      "marketData",
      (r) => [newId(), str(r.instrumentId), str(r.priceType), str(r.value), str(r.tradingDate), str(r.observedAt, nowIso()), str(r.provider, "restore"), str(r.quality, "STALE")]
    );
    insert(
      `INSERT INTO valuation_metrics (id,instrument_id,metric_key,value,as_of_date,provider,quality) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, "valuationMetrics"),
      "valuationMetrics",
      (r) => [newId(), str(r.instrumentId), str(r.metricKey), typeof r.value === "string" ? r.value : null, str(r.asOfDate), str(r.provider, "restore"), str(r.quality, "STALE")]
    );
    insert(
      `INSERT INTO portfolio_goals (id,name,target_amount,currency,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, "goals"),
      "goals",
      (r) => [str(r.id) || newId(), str(r.name), str(r.targetAmount, "0"), str(r.currency, "CNY"), r.enabled === true ? 1 : 0, str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]
    );
    insert(
      `INSERT INTO portfolio_cash_flows (id,flow_type,flow_date,amount,note,created_at) VALUES (?,?,?,?,?,?)`,
      asArray(data, "cashFlows"),
      "cashFlows",
      (r) => [str(r.id) || newId(), str(r.flowType, "CONTRIBUTION"), str(r.flowDate), str(r.amount, "0"), str(r.note), str(r.createdAt, nowIso())]
    );
    insert(
      `INSERT INTO ai_analysis_records (id,instrument_id,model,source,prompt_scope,result,created_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, "aiRecords"),
      "aiRecords",
      (r) => [newId(), str(r.instrumentId), str(r.model), str(r.source, "REAL"), str(r.promptScope), str(r.result), str(r.createdAt, nowIso())]
    );
    insert(
      `INSERT INTO deleted_positions (account_id,instrument_id,deleted_at) VALUES (?,?,?)`,
      asArray(data, "deletedPositions"),
      "deletedPositions",
      (r) => [str(r.accountId), str(r.instrumentId), str(r.deletedAt, nowIso())]
    );
    insert(
      `INSERT INTO strategy_templates (id,name,scope,origin,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`,
      asArray(data, "strategyTemplates"),
      "strategyTemplates",
      (r) => [str(r.id) || newId(), str(r.name), str(r.scope), str(r.origin, "custom"), num(r.currentVersion, 1), str(r.createdAt, nowIso()), str(r.updatedAt, nowIso())]
    );
    insert(
      `INSERT INTO strategy_versions (id,template_id,version,rules_json,note,created_at) VALUES (?,?,?,?,?,?)`,
      asArray(data, "strategyVersions"),
      "strategyVersions",
      (r) => [str(r.id) || newId(), str(r.templateId), num(r.version, 1), str(r.rulesJson, "[]"), str(r.note), str(r.createdAt, nowIso())]
    );
    const orphan = handle2.db.prepare(
      "SELECT COUNT(*) AS n FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id LEFT JOIN instruments i ON i.id=t.instrument_id WHERE a.id IS NULL OR i.id IS NULL"
    ).get();
    if (orphan.n > 0) throw new ValidationError(`\u5907\u4EFD\u4E0D\u5B8C\u6574\uFF1A${orphan.n} \u6761\u6D41\u6C34\u7F3A\u5C11\u8D26\u6237\u6216\u6807\u7684`);
    handle2.db.exec("COMMIT;");
  } catch (error) {
    handle2.db.exec("ROLLBACK;");
    throw error;
  }
  return {
    restored,
    backupPath,
    note: "\u6062\u590D\u4E3A\u66FF\u6362\u5F0F\uFF08\u5F53\u524D\u8D26\u672C\u5DF2\u88AB\u5907\u4EFD\u540E\u66FF\u6362\uFF09\uFF1B\u4E8B\u52A1\u5931\u8D25\u65F6\u81EA\u52A8\u56DE\u6EDA\uFF0C\u672A\u6539\u52A8\u4EFB\u4F55\u6570\u636E\u3002"
  };
}

// plugin/server/src/market/eastmoney.ts
var UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
var TIMEOUT_MS = 15e3;
var MIN_INTERVAL_MS = 400;
var INDEX_SECIDS = {
  \u6CAA\u6DF1300: "1.000300",
  \u521B\u4E1A\u677F\u6307: "0.399006",
  \u4E0A\u8BC1\u6307\u6570: "1.000001",
  \u4E2D\u8BC1500: "1.000905",
  \u79D1\u521B50: "1.000688"
};
var lastRequestAt = 0;
function todayUtc8() {
  return shanghaiParts(/* @__PURE__ */ new Date()).date;
}
async function paced() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}
async function fetchJson(url, headers = {}) {
  const text = await fetchText(url, headers);
  return JSON.parse(text);
}
async function fetchText(url, headers = {}) {
  await paced();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
function secidOf(instrument) {
  if (instrument.secid) return instrument.secid;
  if (instrument.market === "SH") return `1.${instrument.code}`;
  if (instrument.market === "SZ") return `0.${instrument.code}`;
  return null;
}
function point(partial) {
  return { currency: "CNY", ...partial };
}
function parseStockQuote(payload, instrumentId, today) {
  const data = payload.data;
  if (!data || typeof data.f43 !== "number" || data.f43 <= 0) return null;
  const tradingDate = typeof data.f86 === "number" && data.f86 > 0 ? new Date(data.f86 * 1e3).toISOString().slice(0, 10) : today;
  return point({
    instrumentId,
    priceType: tradingDate === today ? "REALTIME_PRICE" : "CLOSE_PRICE",
    value: formatFixed(parseFixed(String(data.f43), SCALE_QTY), SCALE_QTY),
    tradingDate,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    provider: "eastmoney",
    quality: tradingDate === today ? "FRESH" : "DELAYED"
  });
}
function parseKlines(payload, instrumentId) {
  const out = [];
  for (const line of payload.data?.klines ?? []) {
    const [date, close] = line.split(",");
    if (!date || !close) continue;
    out.push(point({
      instrumentId,
      priceType: "CLOSE_PRICE",
      value: formatFixed(parseFixed(close, SCALE_QTY), SCALE_QTY),
      tradingDate: date,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider: "eastmoney",
      quality: "FRESH"
    }));
  }
  return out;
}
function parseLsjz(payload, instrumentId, range) {
  const today = todayUtc8();
  const out = [];
  for (const row of payload.Data?.LSJZList ?? []) {
    if (!row.FSRQ || !row.DWJZ) continue;
    if (range && (row.FSRQ < range.begin || row.FSRQ > range.end)) continue;
    out.push(point({
      instrumentId,
      priceType: "OFFICIAL_NAV",
      value: formatFixed(parseFixed(row.DWJZ, SCALE_QTY), SCALE_QTY),
      tradingDate: row.FSRQ,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider: "eastmoney",
      // 非当日净值是「已确认但非最新」，标 DELAYED，不假装实时。
      quality: row.FSRQ === today ? "FRESH" : "DELAYED"
    }));
  }
  return out;
}
function sliceJsArray(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf("[", at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
function parsePingzhongNav(text, instrumentId, range) {
  const raw = sliceJsArray(text, "Data_netWorthTrend");
  if (!raw) return [];
  let rows;
  try {
    rows = JSON.parse(raw);
  } catch {
    return [];
  }
  const today = todayUtc8();
  const out = [];
  for (const row of rows) {
    if (typeof row.x !== "number" || typeof row.y !== "number" || row.y <= 0) continue;
    const tradingDate = new Date(row.x + 8 * 60 * 6e4).toISOString().slice(0, 10);
    if (range && (tradingDate < range.begin || tradingDate > range.end)) continue;
    out.push(point({
      instrumentId,
      priceType: "OFFICIAL_NAV",
      value: formatFixed(parseFixed(String(row.y), SCALE_QTY), SCALE_QTY),
      tradingDate,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider: "eastmoney",
      quality: tradingDate === today ? "FRESH" : "DELAYED"
    }));
  }
  return out;
}
function parseFundGz(text, instrumentId) {
  const match = /jsonpgz\((\{.*\})\);?/.exec(text);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!parsed.gsz || !parsed.gztime) return null;
  const gzDate = parsed.gztime.slice(0, 10);
  return point({
    instrumentId,
    priceType: "ESTIMATED_NAV",
    value: formatFixed(parseFixed(parsed.gsz, SCALE_QTY), SCALE_QTY),
    tradingDate: gzDate,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    provider: "eastmoney-estimate",
    quality: "ESTIMATED"
  });
}
function parseStockMetrics(payload, instrumentId, today) {
  const data = payload.data;
  if (!data) return [];
  const out = [];
  if (typeof data.f115 === "number" && data.f115 > 0) {
    out.push({ metricKey: "pe", value: String(data.f115), asOfDate: today, quality: "FRESH" });
  }
  if (typeof data.f167 === "number" && data.f167 > 0) {
    out.push({ metricKey: "pb", value: String(data.f167), asOfDate: today, quality: "FRESH" });
  }
  if (typeof data.f20 === "number" && data.f20 > 0) {
    out.push({ metricKey: "scale_info", value: `\u603B\u5E02\u503C ${(data.f20 / 1e8).toFixed(0)} \u4EBF`, asOfDate: today, quality: "FRESH" });
  }
  return out;
}
var FUND_NAV_PAGE_SIZE = 20;
var FUND_NAV_MAX_PAGES = 40;
async function fetchFundNavPage(instrument, pages, range) {
  const code = instrument.fundCode;
  if (!code) return [];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (let page = 1; page <= pages; page += 1) {
    const payload = await fetchJson(
      `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${page}&pageSize=${FUND_NAV_PAGE_SIZE}&type=&_=x`,
      { Referer: `https://fundf10.eastmoney.com/jjjz_${code}.html` }
    );
    const rows = payload.Data?.LSJZList ?? [];
    if (rows.length === 0) break;
    for (const p of parseLsjz({ Data: { LSJZList: rows } }, instrument.id, range)) {
      if (seen.has(p.tradingDate)) continue;
      seen.add(p.tradingDate);
      out.push(p);
    }
    const oldest = rows[rows.length - 1]?.FSRQ;
    if (range && oldest !== void 0 && oldest < range.begin) break;
    if (rows.length < FUND_NAV_PAGE_SIZE) break;
  }
  return out;
}
async function fetchFundNavFull(instrument, range) {
  const code = instrument.fundCode;
  if (!code) return [];
  try {
    const text = await fetchText(
      `https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`,
      { Referer: `https://fund.eastmoney.com/${code}.html` }
    );
    const full = parsePingzhongNav(text, instrument.id, range);
    if (full.length > 0) return full;
  } catch {
  }
  return fetchFundNavPage(instrument, FUND_NAV_MAX_PAGES, range);
}
function createEastmoneyProvider() {
  const todayStr = todayUtc8;
  return {
    id: "eastmoney",
    supports: (instrument) => secidOf(instrument) !== null || Boolean(instrument.fundCode),
    async fetchQuote(instrument) {
      const today = todayStr();
      if (instrument.type === "OPEN_END_FUND" && instrument.fundCode) {
        const points = await fetchFundNavPage(instrument, 1);
        return points.reduce(
          (latest, p) => latest === null || p.tradingDate > latest.tradingDate ? p : latest,
          null
        );
      }
      const secid = secidOf(instrument);
      if (!secid) return null;
      const payload = await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2&fields=f43,f57,f58,f59,f60,f86`
      );
      return parseStockQuote(payload, instrument.id, today);
    },
    async fetchHistory(instrument, range) {
      const secid = secidOf(instrument);
      if (!secid) {
        if (instrument.type === "OPEN_END_FUND" && instrument.fundCode) {
          return fetchFundNavFull(instrument, range);
        }
        return [];
      }
      const beg = range.begin.replace(/-/g, "");
      const end = range.end.replace(/-/g, "");
      const payload = await fetchJson(
        `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&beg=${beg}&end=${end}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f53`
      );
      return parseKlines(payload, instrument.id);
    },
    async fetchMetrics(instrument) {
      const today = todayStr();
      const target = instrument.type === "STOCK" ? instrument : instrument.benchmarkIndex && INDEX_SECIDS[instrument.benchmarkIndex] ? { ...instrument, secid: INDEX_SECIDS[instrument.benchmarkIndex], type: "STOCK", market: "SH", code: INDEX_SECIDS[instrument.benchmarkIndex].split(".")[1] } : null;
      if (!target) return [];
      const secid = secidOf(target);
      if (!secid) return [];
      const payload = await fetchJson(
        `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&invt=2&fltt=2&fields=f43,f59,f115,f167,f20`
      );
      const metrics = parseStockMetrics(payload, instrument.id, today);
      return instrument.type === "STOCK" ? metrics : metrics.filter((m2) => m2.metricKey !== "scale_info");
    },
    async fetchEstimate(instrument) {
      if (instrument.type !== "OPEN_END_FUND" || !instrument.fundCode) return null;
      const text = await fetchText(
        `https://fundgz.1234567.com.cn/js/${instrument.fundCode}.js?rt=${Date.now()}`,
        { Referer: "https://fund.eastmoney.com/" }
      );
      return parseFundGz(text, instrument.id);
    }
  };
}

// plugin/server/src/services/charts.ts
function resolveSpan(ctx, period, custom) {
  const end = ctx.today;
  const days = period === "1m" ? 30 : period === "3m" ? 91 : period === "1y" ? 365 : null;
  if (period === "custom" && custom) return { begin: custom.begin, end: custom.end || end };
  if (days === null) return { begin: "1970-01-01", end };
  const begin = /* @__PURE__ */ new Date(`${end}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - days);
  return { begin: begin.toISOString().slice(0, 10), end };
}
function ensureIndexInstrument(ctx, name) {
  const secid = INDEX_SECIDS[name];
  if (!secid) return null;
  const [marketCode, code] = secid.split(".");
  const existing = listInstruments(ctx.handle).find((i) => i.type === "INDEX" && i.code === code);
  if (existing) return existing;
  try {
    return saveInstrument(ctx.handle, {
      code,
      name,
      type: "INDEX",
      market: marketCode === "1" ? "SH" : "SZ",
      secid,
      tag: "\u6307\u6570\uFF08\u5BF9\u7167\uFF09"
    });
  } catch {
    return null;
  }
}
async function ensureIndexHistory(ctx, indexInstrument, span) {
  const provider = ctx.registry.resolve(indexInstrument);
  if (!provider) return;
  const cached = historyPoints(ctx.handle, indexInstrument.id, ["CLOSE_PRICE"], span.begin, span.end);
  if (cached.length > 0) return;
  try {
    const points = await provider.fetchHistory(indexInstrument, span);
    if (points.length > 0) saveMarketPoints(ctx.handle, points);
  } catch {
  }
}
async function getInstrumentChartSeries(ctx, input) {
  const instrument = getInstrument(ctx.handle, input.instrumentId);
  if (!instrument) throw new Error(`instrument not found: ${input.instrumentId}`);
  const span = resolveSpan(ctx, input.period, input.custom);
  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const pos = [...positions.values()].find((p) => p.instrumentId === instrument.id && p.qtyRaw > 0) ?? null;
  const unitCostRaw = pos && pos.qtyRaw > 0 ? pos.unitCostRaw : null;
  const qtyRaw = pos && pos.qtyRaw > 0 ? pos.qtyRaw : null;
  const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end);
  const minePoints = input.tab === "mine" && unitCostRaw !== null && qtyRaw !== null ? myProfitSeries(ctx, instrument.id, span) : [];
  const series = input.tab === "mine" ? minePoints.map((p) => ({ date: p.date, value: p.cumulative })) : points.map((p) => ({ date: p.tradingDate, value: p.value }));
  const markers = txns.filter((t) => t.instrumentId === instrument.id && t.status === "CONFIRMED" && t.tradeDate >= span.begin && t.tradeDate <= span.end).filter((t) => ["BUY", "OPENING", "DIVIDEND_REINVEST", "SELL"].includes(t.type)).map((t) => ({
    date: t.tradeDate,
    type: t.type === "SELL" ? "sell" : "buy",
    label: `${t.tradeDate} ${t.type === "SELL" ? "\u5356\u51FA" : "\u4E70\u5165"} ${t.quantity ?? ""} @${t.price ?? ""}`
  }));
  let compare = null;
  if (input.tab === "perf" && input.compare && input.compare !== "none") {
    const indexInstrument = ensureIndexInstrument(ctx, input.compare);
    if (indexInstrument) {
      await ensureIndexHistory(ctx, indexInstrument, span);
      const idxPoints = historyPoints(ctx.handle, indexInstrument.id, ["CLOSE_PRICE"], span.begin, span.end);
      if (idxPoints.length > 0) {
        compare = {
          name: input.compare,
          series: idxPoints.map((p) => ({ date: p.tradingDate, value: p.value }))
        };
      }
    }
  }
  if (input.tab === "sector" && instrument.benchmarkIndex) {
    const indexInstrument = ensureIndexInstrument(ctx, instrument.benchmarkIndex);
    if (indexInstrument) {
      await ensureIndexHistory(ctx, indexInstrument, span);
      const idxPoints = historyPoints(ctx.handle, indexInstrument.id, ["CLOSE_PRICE"], span.begin, span.end);
      if (idxPoints.length > 0) {
        compare = {
          name: instrument.benchmarkIndex,
          series: idxPoints.map((p) => ({ date: p.tradingDate, value: p.value }))
        };
      }
    }
  }
  const list = [];
  if (input.tab === "mine") {
    for (const point2 of minePoints) {
      list.push({ date: point2.date, value: point2.daily, change: null, extra: point2.cumulative });
    }
  } else {
    for (let i = 0; i < series.length; i += 1) {
      const point2 = series[i];
      const prevRaw = i === 0 ? null : parseFixed(series[i - 1].value, SCALE_QTY);
      const raw = parseFixed(point2.value, SCALE_QTY);
      const change = prevRaw === null || prevRaw === 0 ? null : `${raw >= prevRaw ? "+" : ""}${((raw / prevRaw - 1) * 100).toFixed(2)}%`;
      list.push({ date: point2.date, value: point2.value, change, extra: null });
    }
  }
  let note = null;
  if (input.tab === "sector" && !compare) {
    note = "\u8BE5\u6807\u7684\u672A\u5173\u8054\u6307\u6570 / \u677F\u5757\uFF0C\u65E0\u6CD5\u5C55\u793A\u677F\u5757\u8D70\u52BF\uFF1B\u53EF\u5728\u7F16\u8F91\u6807\u7684\u65F6\u8865\u5145\u5173\u8054\u6307\u6570";
  }
  if (input.tab === "mine" && (unitCostRaw === null || qtyRaw === null)) {
    note = "\u5F53\u524D\u672A\u6301\u6709\u8BE5\u6807\u7684\uFF0C\u65E0\u6CD5\u5C55\u793A\u6211\u7684\u6536\u76CA";
  }
  if (series.length === 0) {
    note = note ?? "\u533A\u95F4\u5185\u6CA1\u6709\u53EF\u7528\u5386\u53F2\u6570\u636E\uFF0C\u8BF7\u5148\u5237\u65B0\u884C\u60C5";
  }
  return {
    tab: input.tab,
    period: input.period,
    span,
    instrument: { id: instrument.id, code: instrument.code, name: instrument.name, type: instrument.type },
    unitCost: unitCostRaw === null ? null : formatFixed(unitCostRaw, SCALE_QTY),
    series,
    costLine: input.tab === "mine" ? minePoints.length > 0 ? "0" : null : unitCostRaw === null ? null : formatFixed(unitCostRaw, SCALE_QTY),
    markers,
    compare,
    list,
    note
  };
}
function myProfitSeries(ctx, instrumentId, span) {
  const instrument = getInstrument(ctx.handle, instrumentId);
  if (!instrument) return [];
  const txns = allTransactions(ctx.handle);
  const positions = replayPositions(txns);
  const pos = [...positions.values()].find((p) => p.instrumentId === instrumentId && p.qtyRaw > 0);
  if (!pos || pos.qtyRaw === 0) return [];
  const points = effectiveHistoryPoints(ctx.handle, instrumentId, instrument.type, span.begin, span.end);
  const out = [];
  let prevProfit = null;
  for (const p of points) {
    const raw = parseFixed(p.value, SCALE_QTY);
    const profit = mulToScale(raw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) - mulToScale(pos.unitCostRaw, pos.qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2);
    out.push({
      date: p.tradingDate,
      daily: formatFixed(prevProfit === null ? 0 : profit - prevProfit, SCALE_AMOUNT),
      cumulative: formatFixed(profit, SCALE_AMOUNT)
    });
    prevProfit = profit;
  }
  return out;
}
function seriesStats(series) {
  const navs = series.map((p) => parseFixed(p.value, SCALE_QTY));
  const rets = dailyReturns(navs);
  return {
    sharpe: sharpeRatio(rets, { minSamples: 20 }),
    vol: annualVolatility(rets, { minSamples: 20 }),
    mdd: maxDrawdown(navs)
  };
}

// plugin/server/src/services/valuation-view.ts
function metricNumber(metrics, key) {
  const row = metrics.find((m2) => m2.key === key);
  if (!row || row.value === null) return null;
  const parsed = Number(row.value);
  return Number.isFinite(parsed) ? parsed : null;
}
function oneYearSpan(today) {
  const begin = /* @__PURE__ */ new Date(`${today}T00:00:00Z`);
  begin.setUTCDate(begin.getUTCDate() - 365);
  return { begin: begin.toISOString().slice(0, 10), end: today };
}
function riskStats(ctx, instrument) {
  try {
    const span = oneYearSpan(ctx.today);
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type, span.begin, span.end);
    if (points.length < 20) return { sharpe: null, vol: null, mdd: null };
    const series = points.map((p) => ({ date: p.tradingDate, value: p.value }));
    return seriesStats(series);
  } catch {
    return { sharpe: null, vol: null, mdd: null };
  }
}
function caliberFor(instrument, metrics, pe) {
  const asOf = metrics[0]?.asOfDate;
  const isFund = instrument.type === "OPEN_END_FUND";
  const isEtf = instrument.type === "ETF";
  const hasIndexLink = Boolean(instrument.benchmarkIndex);
  let caliber;
  if (instrument.type === "STOCK") {
    caliber = `\u4E2A\u80A1 PE-TTM / PB \xB7 ${asOf ?? "\u6682\u65E0\u62AB\u9732"}`;
  } else if (instrument.type === "INDEX") {
    caliber = asOf ? `\u6307\u6570\u4F30\u503C\u622A\u9762 \xB7 ${asOf}` : "\u6307\u6570\u4F30\u503C\u622A\u9762 \xB7 \u6682\u65E0\u6570\u636E";
  } else if (isFund && !hasIndexLink && pe === null) {
    caliber = "\u4E3B\u52A8\u57FA\u91D1 \xB7 \u6301\u4ED3\u62AB\u9732\u6EDE\u540E\uFF08\u5B63\u62A5\uFF09\uFF0C\u4E0D\u63D0\u4F9B\u5B9E\u65F6\u7A7F\u900F\u4F30\u503C";
  } else if ((isFund || isEtf) && hasIndexLink) {
    caliber = `\u8DDF\u8E2A\u6307\u6570\u7A7F\u900F\uFF08${instrument.benchmarkIndex}\uFF09\xB7 ${asOf ?? "\u2014"}`;
  } else {
    caliber = asOf ? `\u4F30\u503C\u622A\u9762 ${asOf}` : "\u6682\u65E0\u4F30\u503C\u6570\u636E";
  }
  const manualCount = metrics.filter((m2) => m2.provider === "manual").length;
  if (manualCount > 0) caliber += ` \xB7 \u542B ${manualCount} \u9879\u624B\u5DE5\u8865\u5F55\uFF08MANUAL\uFF09`;
  return caliber;
}
async function getHoldingsValuation(ctx, filter = {}) {
  const scope = filter.scope === "all" ? "all" : "holdings";
  const holdings = listHoldings(ctx);
  const heldIds = new Set(holdings.rows.map((row) => row.instrumentId));
  const everyInstrument = listInstruments(ctx.handle);
  const byId = new Map(everyInstrument.map((instrument) => [instrument.id, instrument]));
  const templates = listTemplates(ctx.handle);
  const targets = [];
  if (scope === "all") {
    for (const instrument of everyInstrument) {
      if (!instrument.active) continue;
      targets.push({ instrument, held: heldIds.has(instrument.id) });
    }
    targets.sort((a, b) => a.held === b.held ? 0 : a.held ? -1 : 1);
  } else {
    for (const row of holdings.rows) {
      const instrument = byId.get(row.instrumentId) ?? getInstrument(ctx.handle, row.instrumentId);
      if (instrument) targets.push({ instrument, held: true });
    }
  }
  const rows = [];
  for (const { instrument, held } of targets) {
    if (filter.type && instrument.type !== filter.type) continue;
    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const lite = metrics.map((m2) => ({ key: m2.metricKey, value: m2.value, asOfDate: m2.asOfDate, provider: m2.provider }));
    const stats = riskStats(ctx, instrument);
    const pe = metricNumber(lite, "pe");
    const pb = metricNumber(lite, "pb");
    const pePct = metricNumber(lite, "pe_percentile");
    const pbPct = metricNumber(lite, "pb_percentile");
    const dy = metricNumber(lite, "dividend_yield");
    const roe = metricNumber(lite, "roe");
    const metricValues = [
      { key: "pe", value: pe },
      { key: "pb", value: pb },
      { key: "pe_percentile", value: pePct },
      { key: "pb_percentile", value: pbPct },
      { key: "dividend_yield", value: dy },
      { key: "roe", value: roe },
      { key: "sharpe", value: stats.sharpe },
      { key: "max_drawdown_pct", value: stats.mdd === null ? null : stats.mdd * 100 },
      { key: "annual_volatility_pct", value: stats.vol === null ? null : stats.vol * 100 }
    ];
    const applicable = templates.filter((template) => template.origin === "custom" || (instrument.type === "STOCK" ? template.id === "stock-value" : template.id !== "stock-value"));
    const strategies = applicable.map((template) => scoreWithTemplate(template, metricValues));
    rows.push({
      instrumentId: instrument.id,
      code: instrument.code,
      name: instrument.name,
      type: instrument.type,
      held,
      pe: pe === null ? null : String(pe),
      pePercentile: pePct,
      pb: pb === null ? null : String(pb),
      pbPercentile: pbPct,
      dividendYield: dy === null ? null : `${dy}%`,
      roe: roe === null ? null : `${roe}%`,
      sharpe: stats.sharpe,
      volatilityPct: stats.vol === null ? null : stats.vol * 100,
      maxDrawdownPct: stats.mdd === null ? null : stats.mdd * 100,
      caliber: caliberFor(instrument, lite, pe),
      strategies
    });
  }
  return {
    rows,
    scope,
    total: scope === "all" ? everyInstrument.filter((instrument) => instrument.active).length : rows.length,
    note: "\u53E3\u5F84\uFF1A\u57FA\u91D1 / ETF \u7528\u8DDF\u8E2A\u6307\u6570\u7A7F\u900F\u4F30\u503C\u5E76\u6807\u6CE8\u65E5\u671F\uFF1B\u4E3B\u52A8\u57FA\u91D1\u4E0D\u63D0\u4F9B\u5B9E\u65F6\u7A7F\u900F\uFF1B\u80A1\u7968\u4E3A PE-TTM / \u6700\u8FD1\u62AB\u9732\u8D22\u62A5\uFF1B\u6307\u6570\u4E3A\u6307\u6570\u4F30\u503C\u622A\u9762\u3002\u5206\u4F4D\u4E3A\u8FD1 3 \u5E74\u5386\u53F2\u5206\u4F4D\uFF08\u6837\u672C\u4E0D\u8DB3\u663E\u793A\u300C\u6837\u672C\u4E0D\u8DB3\u300D\uFF09\u3002\u672C\u89C6\u56FE\u4E0D\u542B\u6536\u76CA\uFF1B\u7F3A\u5931\u6307\u6807\u663E\u793A\u300C\u6570\u636E\u4E0D\u8DB3\u300D\uFF0C\u4E0D\u586B 0\u3002"
  };
}

// plugin/server/src/services/ai.ts
var AI_TIMEOUT_MS = 3e4;
function aiConfigured(settings) {
  return Boolean(settings.baseUrl && settings.apiKey && settings.model);
}
function getAiStatus(ctx) {
  const settings = getAiSettings(ctx.handle);
  return {
    configured: aiConfigured(settings),
    masked: { ...settings, apiKey: maskApiKey(settings.apiKey) },
    secretBackend: currentSecretBackend(),
    scope: "\u6807\u7684\u540D\u79F0\u4E0E\u4EE3\u7801\u3001\u8D44\u4EA7\u7C7B\u578B\u3001\u8D26\u6237\uFF08\u8131\u654F\uFF09\u3001\u6301\u6709\u91D1\u989D / \u4EFD\u989D / \u6210\u672C / \u6536\u76CA\u3001\u8FD1 1 \u5E74\u8D70\u52BF\u6458\u8981\u3001\u81EA\u5B9A\u4E49\u5206\u7C7B\u6807\u7B7E\u3002\u4E0D\u53D1\u9001\uFF1A\u4EA4\u6613\u6D41\u6C34\u660E\u7EC6\u3001\u5176\u4ED6\u6807\u7684\u6301\u4ED3\u3001\u8D26\u6237\u4F59\u989D\u3002"
  };
}
function updateAiSettings(ctx, input) {
  const next = saveAiSettings(ctx.handle, input);
  return {
    configured: aiConfigured(next),
    masked: { ...next, apiKey: maskApiKey(next.apiKey) },
    secretBackend: currentSecretBackend()
  };
}
async function chatCompletion(ctx, settings, messages, maxTokens = 1200) {
  const url = `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens
      }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`AI \u670D\u52A1\u8FD4\u56DE ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI \u670D\u52A1\u672A\u8FD4\u56DE\u5185\u5BB9");
    return content;
  } finally {
    clearTimeout(timer);
  }
}
async function testAiConnection(ctx) {
  const settings = getAiSettings(ctx.handle);
  if (!aiConfigured(settings)) return { ok: false, message: "\u8BF7\u5148\u5B8C\u6574\u586B\u5199 Base URL\u3001Key \u4E0E\u6A21\u578B" };
  try {
    const reply2 = await chatCompletion(ctx, settings, [{ role: "user", content: "\u8BF7\u53EA\u56DE\u590D\u4E24\u4E2A\u5B57\uFF1A\u8FDE\u901A" }], 16);
    return { ok: true, message: `\u8FDE\u63A5\u6210\u529F\uFF08\u6A21\u578B\u56DE\u590D\uFF1A${reply2.slice(0, 20).replace(/\s+/g, " ")}\uFF09` };
  } catch (error) {
    return { ok: false, message: `\u8FDE\u63A5\u5931\u8D25\uFF1A${String(error.message)}` };
  }
}
async function analyzeHolding(ctx, positionId) {
  const settings = getAiSettings(ctx.handle);
  if (!aiConfigured(settings)) {
    throw new Error("AI_NOT_CONFIGURED: \u8BF7\u5148\u5728\u300C\u8BBE\u7F6E \u2192 AI \u914D\u7F6E\u300D\u586B\u5199 Base URL\u3001Key \u4E0E\u6A21\u578B");
  }
  const [accountId, instrumentId] = positionId.split(":");
  const instrument = getInstrument(ctx.handle, instrumentId);
  if (!instrument) throw new Error(`instrument not found: ${instrumentId}`);
  const holdings = listHoldings(ctx, { accountId });
  const holding = holdings.rows.find((r) => r.instrumentId === instrumentId);
  if (!holding) throw new Error(`holding not found: ${positionId}`);
  let trendSummary = "\u65E0\u5386\u53F2\u6570\u636E";
  try {
    const chart = await getInstrumentChartSeries(ctx, { instrumentId, tab: "perf", period: "1y", compare: "none" });
    if (chart.series.length >= 2) {
      const first = Number(chart.series[0].value);
      const last = Number(chart.series[chart.series.length - 1].value);
      trendSummary = `\u8FD1 1 \u5E74 ${chart.series[0].date} \u2192 ${chart.series[chart.series.length - 1].date}\uFF0C${first} \u2192 ${last}\uFF08${((last / first - 1) * 100).toFixed(1)}%\uFF09\uFF0C\u5171 ${chart.series.length} \u4E2A\u4EA4\u6613\u65E5`;
    }
  } catch {
  }
  const categoriesText = holding.categories.names.length > 0 ? holding.categories.names.join("\u3001") : "\u672A\u5206\u7C7B";
  const scope = {
    name: instrument.name,
    code: instrument.code,
    type: instrument.type,
    accountMasked: `${holding.accountName.slice(0, 2)}**`,
    marketValue: holding.marketValue,
    qty: holding.qty,
    unitCost: holding.unitCost,
    costTotal: holding.costTotal,
    pnl: holding.pnl,
    pnlRate: holding.pnlRate,
    portfolioWeight: holding.weight === null ? null : `${(holding.weight * 100).toFixed(2)}%`,
    trend1y: trendSummary,
    categories: categoriesText
  };
  const prompt = [
    "\u4F60\u662F\u4E2A\u4EBA\u6295\u8D44\u7814\u7A76\u52A9\u624B\u3002\u57FA\u4E8E\u7528\u6237\u63D0\u4F9B\u7684\u5355\u4E00\u6301\u4ED3\u6458\u8981\uFF0C\u7ED9\u51FA\u7ED3\u6784\u5316\u5206\u6790\uFF0C\u5305\u542B\uFF1A\u6574\u4F53\u8BC4\u4EF7\u3001\u503C\u5F97\u5173\u6CE8\u7684\u70B9\uFF082-3 \u6761\uFF09\u3001\u98CE\u9669\u63D0\u793A\uFF082-3 \u6761\uFF09\u3001\u53C2\u8003\u7ED3\u8BBA\u3002",
    "\u8981\u6C42\uFF1A\u4E2D\u6587\uFF1B\u5BA2\u89C2\uFF1B\u4E0D\u6784\u6210\u6295\u8D44\u5EFA\u8BAE\uFF1B\u4E0D\u9884\u6D4B\u5177\u4F53\u4EF7\u683C\uFF1B\u6700\u540E\u5FC5\u987B\u9644\u4E00\u884C\u514D\u8D23\u58F0\u660E\u3002",
    `\u6301\u4ED3\u6458\u8981\uFF08JSON\uFF09\uFF1A${JSON.stringify(scope)}`
  ].join("\n");
  const content = await chatCompletion(ctx, settings, [
    { role: "system", content: "\u4F60\u662F\u4E25\u8C28\u7684\u4E2A\u4EBA\u6295\u8D44\u5206\u6790\u52A9\u624B\uFF0C\u8F93\u51FA\u7B80\u4F53\u4E2D\u6587\uFF0C\u59CB\u7EC8\u9644\u514D\u8D23\u58F0\u660E\u3002" },
    { role: "user", content: prompt }
  ]);
  const record = saveAiRecord(ctx.handle, {
    instrumentId,
    model: settings.model,
    source: "REAL",
    promptScope: JSON.stringify(scope),
    result: content
  });
  return {
    instrumentId,
    code: instrument.code,
    name: instrument.name,
    model: settings.model,
    source: "REAL",
    content,
    recordId: record.id
  };
}

// plugin/server/src/services/backup.ts
function exportBackup(ctx) {
  const handle2 = ctx.handle;
  const instruments = listInstruments(handle2);
  const templates = handle2.db.prepare("SELECT * FROM strategy_templates ORDER BY created_at").all();
  const versions = handle2.db.prepare("SELECT * FROM strategy_versions ORDER BY version").all();
  return {
    kind: "plug-funds-backup",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
    accounts: listAccounts(handle2),
    instruments,
    transactions: allTransactions(handle2),
    categories: listCategories(handle2),
    categoryLinks: listLinks(handle2),
    marketData: instruments.flatMap(
      (i) => historyPoints(handle2, i.id, ["CLOSE_PRICE", "OFFICIAL_NAV", "REALTIME_PRICE", "MANUAL_PRICE", "ESTIMATED_NAV"])
    ),
    valuationMetrics: instruments.flatMap((i) => latestValuationMetrics(handle2, i.id)),
    goals: listGoals(handle2),
    cashFlows: listCashFlows(handle2),
    aiRecords: listAiRecords(handle2).map((r) => ({
      instrumentId: r.instrumentId,
      model: r.model,
      source: r.source,
      promptScope: r.promptScope,
      createdAt: r.createdAt,
      result: r.result
    })),
    deletedPositions: handle2.db.prepare("SELECT account_id, instrument_id, deleted_at FROM deleted_positions").all().map((r) => ({ accountId: r.account_id, instrumentId: r.instrument_id, deletedAt: r.deleted_at })),
    strategyTemplates: templates.map((r) => ({
      id: r.id,
      name: r.name,
      scope: r.scope,
      origin: r.origin,
      currentVersion: r.current_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    })),
    strategyVersions: versions.map((r) => ({
      id: r.id,
      templateId: r.template_id,
      version: r.version,
      rulesJson: r.rules_json,
      note: r.note,
      createdAt: r.created_at
    })),
    note: "JSON \u5168\u91CF\u5907\u4EFD\uFF08\u542B\u7B56\u7565\u7248\u672C\u4E0E\u5220\u9664\u89C6\u56FE\u6807\u8BB0\uFF09\uFF0C\u53EF\u5728\u300C\u8BBE\u7F6E \u2192 \u5907\u4EFD\u4E0E\u6062\u590D\u300D\u8FD8\u539F\u3002\u4E0D\u542B AI Key\u3002"
  };
}
function exportHoldingsCsv(ctx) {
  const holdings = listHoldings(ctx);
  const header = ["\u7C7B\u522B", "\u6807\u7684\u540D\u79F0", "\u4EE3\u7801", "\u8D26\u6237", "\u6570\u91CF", "\u5355\u4F4D\u6210\u672C", "\u73B0\u4EF7/\u51C0\u503C", "\u5E02\u503C", "\u6301\u4ED3\u76C8\u4E8F", "\u6536\u76CA\u7387", "\u6570\u636E\u65E5\u671F"];
  const lines = [header.join(",")];
  for (const row of holdings.rows) {
    lines.push([
      row.type,
      `"${row.name.replace(/"/g, '""')}"`,
      row.code,
      `"${row.accountName.replace(/"/g, '""')}"`,
      row.qty,
      row.unitCost,
      row.price ?? "",
      row.marketValue ?? "",
      row.pnl ?? "",
      row.pnlRate ?? "",
      row.priceDate ?? ""
    ].join(","));
  }
  return `\uFEFF${lines.join("\n")}`;
}

// plugin/server/src/market/conflict.ts
var DEFAULT_CONFLICT_THRESHOLD = 0.01;
function relativeDiff(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  return Math.abs(x - y) / Math.max(x, y);
}
function detectConflict(candidates, threshold = DEFAULT_CONFLICT_THRESHOLD) {
  if (candidates.length < 2) return null;
  const primary = candidates[0];
  let worst = null;
  for (const other of candidates.slice(1)) {
    if (other.provider === primary.provider) continue;
    if (other.priceType !== primary.priceType) continue;
    if (other.tradingDate !== primary.tradingDate) continue;
    const diff = relativeDiff(primary.value, other.value);
    if (diff === null || diff <= threshold) continue;
    if (!worst || diff > worst.diffPct) {
      worst = { tradingDate: primary.tradingDate, priceType: primary.priceType, primary, secondary: other, diffPct: diff };
    }
  }
  return worst;
}

// plugin/server/src/services/refresh.ts
var MIN_PERCENTILE_SAMPLES = 20;
function daysAgo(days) {
  const d = /* @__PURE__ */ new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function messageOf(error) {
  return String(error.message ?? error).slice(0, 200);
}
async function refreshMarketData(ctx, filter = {}) {
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const today = todayLocal();
  const instruments = listInstruments(ctx.handle, { active: true }).filter(
    (i) => !filter.instrumentIds || filter.instrumentIds.includes(i.id)
  );
  const results = [];
  for (const instrument of instruments) {
    const providers = ctx.registry.resolveAll(instrument);
    const item = {
      instrumentId: instrument.id,
      code: instrument.code,
      name: instrument.name,
      ok: false,
      provider: null,
      providers: providers.map((p) => p.id),
      quotes: 0,
      history: 0,
      metrics: 0,
      error: null,
      conflict: null
    };
    if (providers.length === 0) {
      item.error = "\u65E0\u53EF\u7528\u6570\u636E\u6E90\u9002\u914D\u5668\uFF08\u53EF\u624B\u5DE5\u5F55\u5165\u4EF7\u683C\uFF09";
      results.push(item);
      continue;
    }
    const candidates = [];
    const quotes = [];
    const notes = [];
    const writtenMetricKeys = /* @__PURE__ */ new Set();
    const currentMetrics = /* @__PURE__ */ new Map();
    let historyDone = false;
    let estimateTried = false;
    for (const provider of providers) {
      try {
        const quote = await provider.fetchQuote(instrument);
        if (quote) {
          quotes.push({ quote, provider: provider.id });
          candidates.push({
            provider: provider.id,
            value: quote.value,
            priceType: quote.priceType,
            tradingDate: quote.tradingDate
          });
        }
      } catch (error) {
        notes.push(`${provider.id} \u62A5\u4EF7\u5931\u8D25\uFF1A${messageOf(error)}`);
      }
      if (!historyDone) {
        try {
          const history = await provider.fetchHistory(instrument, { begin: daysAgo(400), end: today });
          if (history.length > 0) {
            saveMarketPoints(ctx.handle, history);
            item.history = history.length;
            historyDone = true;
            item.provider = item.provider ?? provider.id;
          }
        } catch (error) {
          notes.push(`${provider.id} \u5386\u53F2\u5931\u8D25\uFF1A${messageOf(error)}`);
        }
      }
      if (provider.fetchMetrics) {
        try {
          const metrics = await provider.fetchMetrics(instrument);
          for (const metric of metrics) {
            if (writtenMetricKeys.has(metric.metricKey)) continue;
            saveValuationMetric(ctx.handle, {
              instrumentId: instrument.id,
              metricKey: metric.metricKey,
              value: metric.value,
              asOfDate: metric.asOfDate,
              provider: provider.id,
              quality: metric.quality
            });
            writtenMetricKeys.add(metric.metricKey);
            item.metrics += 1;
            if (metric.value !== null) currentMetrics.set(metric.metricKey, { value: metric.value, asOfDate: metric.asOfDate });
          }
        } catch (error) {
          notes.push(`${provider.id} \u4F30\u503C\u5931\u8D25\uFF1A${messageOf(error)}`);
        }
      }
      if (!estimateTried && provider.fetchEstimate) {
        estimateTried = true;
        try {
          const estimate = await provider.fetchEstimate(instrument);
          if (estimate) saveMarketPoints(ctx.handle, [estimate]);
        } catch {
        }
      }
      if (!item.provider) item.provider = provider.id;
    }
    const conflict = detectConflict(candidates);
    if (quotes.length > 0) {
      const primary = quotes[0];
      const quality = conflict ? "CONFLICT" : primary.quote.quality;
      saveMarketPoints(ctx.handle, [{ ...primary.quote, quality }]);
      item.quotes = 1;
      item.provider = primary.provider;
      if (conflict) {
        item.conflict = {
          primary: conflict.primary.provider,
          secondary: conflict.secondary.provider,
          diffPct: Math.round(conflict.diffPct * 1e4) / 1e4,
          tradingDate: conflict.tradingDate
        };
        notes.push(
          `\u591A\u6E90\u5206\u6B67 ${(conflict.diffPct * 100).toFixed(2)}%\uFF1A${conflict.primary.provider}=${conflict.primary.value} vs ${conflict.secondary.provider}=${conflict.secondary.value}`
        );
      }
    }
    const since = /* @__PURE__ */ new Date(`${today}T00:00:00Z`);
    since.setUTCFullYear(since.getUTCFullYear() - 3);
    const sinceDate = since.toISOString().slice(0, 10);
    for (const key of ["pe", "pb"]) {
      const current = currentMetrics.get(key);
      if (!current) continue;
      const history = metricHistory(ctx.handle, instrument.id, key, sinceDate).map((h) => h.value);
      if (history.length < MIN_PERCENTILE_SAMPLES) continue;
      const pct2 = percentile(history, Number(current.value));
      if (pct2 === null) continue;
      saveValuationMetric(ctx.handle, {
        instrumentId: instrument.id,
        metricKey: `${key}_percentile`,
        value: (Math.round(pct2 * 100) / 100).toFixed(2),
        asOfDate: current.asOfDate,
        provider: "derived",
        quality: "FRESH"
      });
    }
    item.ok = item.quotes > 0 || item.history > 0 || item.metrics > 0;
    if (!item.ok) {
      item.error = notes.length > 0 ? notes.join("\uFF1B").slice(0, 300) : "\u6570\u636E\u6E90\u672A\u8FD4\u56DE\u6709\u6548\u6570\u636E";
    } else if (notes.length > 0) {
      item.error = notes.join("\uFF1B").slice(0, 300);
    }
    results.push(item);
  }
  const snapshots = saveDailySnapshots(ctx, today);
  recordRun(ctx, startedAt, results);
  return { results, startedAt, snapshots };
}
function saveDailySnapshots(ctx, date) {
  const holdings = listHoldings(ctx);
  const priced = holdings.rows.filter((r) => r.marketValue !== null).length;
  const coverage = holdings.rows.length > 0 ? priced / holdings.rows.length : 0;
  let realized = 0;
  let dividends = 0;
  for (const pos of replayPositions(allTransactions(ctx.handle)).values()) {
    realized += pos.realizedRaw;
    dividends += pos.dividendsRaw;
  }
  const db = ctx.handle.db;
  db.exec("BEGIN;");
  try {
    db.prepare(`INSERT INTO portfolio_snapshots
      (id,snapshot_date,total_market_value,total_cost,realized,dividends,positions,coverage,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date) DO UPDATE SET
        total_market_value=excluded.total_market_value, total_cost=excluded.total_cost,
        realized=excluded.realized, dividends=excluded.dividends,
        positions=excluded.positions, coverage=excluded.coverage, created_at=excluded.created_at`).run(
      newId(),
      date,
      holdings.totalMarketValue,
      holdings.totalCost,
      formatFixed(realized, SCALE_AMOUNT),
      formatFixed(dividends, SCALE_AMOUNT),
      holdings.rows.length,
      coverage,
      nowIso()
    );
    const stmt = db.prepare(`INSERT INTO holding_snapshots
      (id,snapshot_date,account_id,instrument_id,qty,cost_total,market_value,price,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_date,account_id,instrument_id) DO UPDATE SET
        qty=excluded.qty, cost_total=excluded.cost_total,
        market_value=excluded.market_value, price=excluded.price, created_at=excluded.created_at`);
    for (const row of holdings.rows) {
      stmt.run(newId(), date, row.accountId, row.instrumentId, row.qty, row.costTotal, row.marketValue, row.price, nowIso());
    }
    db.exec("COMMIT;");
    return { portfolio: true, holdings: holdings.rows.length };
  } catch {
    db.exec("ROLLBACK;");
    return { portfolio: false, holdings: 0 };
  }
}
function recordRun(ctx, startedAt, results) {
  const ok2 = results.filter((r) => r.ok).length;
  const conflicts = results.filter((r) => r.conflict !== null).length;
  try {
    ctx.handle.db.prepare(
      "INSERT INTO data_source_runs (id,started_at,finished_at,instruments,ok,failed,note) VALUES (?,?,?,?,?,?,?)"
    ).run(
      newId(),
      startedAt,
      nowIso(),
      results.length,
      ok2,
      results.length - ok2,
      conflicts > 0 ? `refresh_market_data | conflicts:${conflicts}` : "refresh_market_data"
    );
  } catch {
  }
}

// plugin/server/src/services/index-valuation.ts
var MIN_PERCENTILE_SAMPLES2 = 20;
function quantileOf(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}
function buildStats(values, current) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    current,
    percentile: current === null || n < MIN_PERCENTILE_SAMPLES2 ? null : percentile(sorted, current),
    avg: n === 0 ? null : sorted.reduce((a, b) => a + b, 0) / n,
    min: n === 0 ? null : sorted[0],
    p20: quantileOf(sorted, 0.2),
    p50: quantileOf(sorted, 0.5),
    p80: quantileOf(sorted, 0.8),
    max: n === 0 ? null : sorted[n - 1],
    samples: n
  };
}
function sinceFor(years, today) {
  if (!Number.isFinite(years) || years <= 0) return void 0;
  const d = /* @__PURE__ */ new Date(`${today}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - Math.round(years));
  return d.toISOString().slice(0, 10);
}
function currentMetric(metrics, key) {
  const row = metrics.find((m2) => m2.metricKey === key);
  if (!row || row.value === null || row.value === "") return null;
  const value = Number(row.value);
  return Number.isFinite(value) ? value : null;
}
function recentRoe(history) {
  const byYear = /* @__PURE__ */ new Map();
  for (const point2 of history) byYear.set(point2.asOfDate.slice(0, 4), point2.value);
  const years = [...byYear.keys()].sort((a, b) => b.localeCompare(a)).slice(0, 3);
  return [0, 1, 2].map((i) => years[i] ? byYear.get(years[i]) ?? null : null);
}
function getIndexValuation(ctx, options = {}) {
  const years = Number.isFinite(Number(options.years)) ? Number(options.years) : 10;
  const since = sinceFor(years, ctx.today);
  const instruments = listInstruments(ctx.handle, { type: "INDEX", active: true });
  const rows = instruments.map((instrument) => {
    const points = effectiveHistoryPoints(ctx.handle, instrument.id, instrument.type);
    const numbers = points.map((p) => Number(p.value)).filter(Number.isFinite);
    const close = numbers.length > 0 ? numbers[numbers.length - 1] : null;
    const yearStart = `${ctx.today.slice(0, 4)}-01-01`;
    const firstOfYear = points.find((p) => p.tradingDate >= yearStart);
    const firstValue = firstOfYear ? Number(firstOfYear.value) : null;
    const ytdReturn2 = close !== null && firstValue !== null && firstValue > 0 && points.length >= 2 ? (close / firstValue - 1) * 100 : null;
    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const statFor = (key) => buildStats(
      metricHistory(ctx.handle, instrument.id, key, since).map((p) => p.value),
      currentMetric(metrics, key)
    );
    const pe = statFor("pe");
    const pb = statFor("pb");
    const ps = statFor("ps");
    const roe = recentRoe(metricHistory(ctx.handle, instrument.id, "roe", since));
    const dividendYield = currentMetric(metrics, "dividend_yield");
    const filled = [close, pe.current, pb.current, ps.current, dividendYield].filter((v) => v !== null).length;
    const quality = filled === 0 ? "INSUFFICIENT" : filled < 5 ? "PARTIAL" : "REAL";
    return {
      id: instrument.id,
      code: instrument.code,
      name: instrument.name,
      tag: instrument.tag,
      market: instrument.market,
      publishDate: instrument.foundedDate ?? null,
      close,
      ytdReturn: ytdReturn2,
      fundOn: null,
      fundOff: null,
      pe,
      pb,
      ps,
      roe,
      dividendYield,
      marketValue: null,
      quality
    };
  });
  return {
    rows,
    count: rows.length,
    note: `\u6570\u503C\u5168\u90E8\u53D6\u81EA\u672C\u673A valuation_metrics / market_points\uFF08\u6709\u6548\u4EF7\u683C\u53E3\u5F84\uFF09\uFF0C\u7F3A\u6570\u636E\u4E3A null \u5E76\u663E\u793A\u300C\u2014\u300D\u3002\u5206\u4F4D\u70B9\u6837\u672C < ${MIN_PERCENTILE_SAMPLES2} \u4E0D\u4EA7\u751F\u6570\u503C\uFF1B\u573A\u5185|\u573A\u5916\u57FA\u91D1\u6570\u4E0E\u6307\u6570\u603B\u5E02\u503C\u9879\u76EE\u672A\u5B58\uFF0C\u6052\u4E3A\u300C\u2014\u300D\u3002\u53C2\u8003\u9875\u7684\u52A0\u6743/\u7B49\u6743/\u7B97\u6570/\u4E2D\u4F4D\u6570\u4E3A\u6210\u5206\u80A1\u805A\u5408\u53E3\u5F84\uFF0C\u672C\u9879\u76EE\u6570\u636E\u6E90\u4E0D\u542B\u6210\u5206\u80A1\uFF0C\u8BE5\u9009\u62E9\u4EC5\u4F5C\u53E3\u5F84\u6807\u6CE8\u3001\u4E0D\u6539\u53D8\u6570\u503C\u3002`,
    caliber: {
      market: String(options.market ?? "\u5168\u90E8"),
      category: String(options.category ?? "\u5168\u90E8"),
      stat: String(options.stat ?? "\u52A0\u6743\u5E73\u5747\u503C"),
      years
    }
  };
}

// plugin/core/src/portfolio-risk.ts
var CONCENTRATION_THRESHOLDS = {
  top1Watch: 0.25,
  top1High: 0.4,
  top3Watch: 0.55,
  top3High: 0.7,
  categoryWatch: 0.8,
  /** 少于该持仓数时不做前三大集中度评判（小样本下 top3 恒接近 100%，无区分度）。 */
  top3MinHoldings: 5,
  fewHoldings: 5
};
var EMPTY = {
  coveredValue: "0",
  missingCount: 0,
  countedCount: 0,
  top1: null,
  top3Weight: null,
  hhi: null,
  effectiveHoldings: null,
  byCategory: [],
  flags: []
};
function concentration(holdings) {
  const missingCount = holdings.filter((h) => h.marketValue === null).length;
  const counted = holdings.map((h) => ({ ...h, raw: h.marketValue === null ? 0 : parseFixed(h.marketValue, SCALE_AMOUNT) })).filter((h) => h.raw > 0);
  if (counted.length === 0) {
    return {
      ...EMPTY,
      missingCount,
      flags: missingCount > 0 ? [{ code: "MISSING_VALUE", level: "WATCH", message: `${missingCount} \u4E2A\u6301\u4ED3\u7F3A\u4EF7\u683C\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u96C6\u4E2D\u5EA6\u3002` }] : []
    };
  }
  const totalRaw = counted.reduce((sum, h) => sum + h.raw, 0);
  const weights = counted.map((h) => ({ id: h.id, name: h.name, category: h.category, weight: h.raw / totalRaw })).sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, "zh-CN"));
  const top1 = weights[0] ? { id: weights[0].id, name: weights[0].name, weight: weights[0].weight } : null;
  const top3Weight = weights.slice(0, 3).reduce((sum, w) => sum + w.weight, 0);
  const hhi = weights.reduce((sum, w) => sum + w.weight * w.weight, 0);
  const categoryMap = /* @__PURE__ */ new Map();
  for (const w of weights) categoryMap.set(w.category, (categoryMap.get(w.category) ?? 0) + w.weight);
  const byCategory = [...categoryMap.entries()].map(([category, weight]) => ({ category, weight })).sort((a, b) => b.weight - a.weight);
  const flags = [];
  if (top1) {
    if (top1.weight >= CONCENTRATION_THRESHOLDS.top1High) {
      flags.push({
        code: "SINGLE_HOLDING",
        level: "HIGH",
        message: `\u5355\u4E00\u6301\u4ED3\u300C${top1.name}\u300D\u5360 ${(top1.weight * 100).toFixed(1)}%\uFF0C\u8D85\u8FC7 ${(CONCENTRATION_THRESHOLDS.top1High * 100).toFixed(0)}% \u9AD8\u5EA6\u96C6\u4E2D\u7EBF\u3002`
      });
    } else if (top1.weight >= CONCENTRATION_THRESHOLDS.top1Watch) {
      flags.push({
        code: "SINGLE_HOLDING",
        level: "WATCH",
        message: `\u5355\u4E00\u6301\u4ED3\u300C${top1.name}\u300D\u5360 ${(top1.weight * 100).toFixed(1)}%\uFF0C\u8D85\u8FC7 ${(CONCENTRATION_THRESHOLDS.top1Watch * 100).toFixed(0)}% \u89C2\u5BDF\u7EBF\u3002`
      });
    }
  }
  if (counted.length >= CONCENTRATION_THRESHOLDS.top3MinHoldings) {
    if (top3Weight >= CONCENTRATION_THRESHOLDS.top3High) {
      flags.push({
        code: "TOP3",
        level: "HIGH",
        message: `\u524D\u4E09\u5927\u6301\u4ED3\u5408\u8BA1\u5360 ${(top3Weight * 100).toFixed(1)}%\uFF0C\u8D85\u8FC7 ${(CONCENTRATION_THRESHOLDS.top3High * 100).toFixed(0)}%\u3002`
      });
    } else if (top3Weight >= CONCENTRATION_THRESHOLDS.top3Watch) {
      flags.push({
        code: "TOP3",
        level: "WATCH",
        message: `\u524D\u4E09\u5927\u6301\u4ED3\u5408\u8BA1\u5360 ${(top3Weight * 100).toFixed(1)}%\uFF0C\u8D85\u8FC7 ${(CONCENTRATION_THRESHOLDS.top3Watch * 100).toFixed(0)}%\u3002`
      });
    }
  }
  const heaviestCategory = byCategory[0];
  if (heaviestCategory && heaviestCategory.weight >= CONCENTRATION_THRESHOLDS.categoryWatch) {
    flags.push({
      code: "SINGLE_CATEGORY",
      level: "WATCH",
      message: `\u300C${heaviestCategory.category}\u300D\u7C7B\u522B\u5360 ${(heaviestCategory.weight * 100).toFixed(1)}%\uFF0C\u8D44\u4EA7\u7C7B\u522B\u9AD8\u5EA6\u5355\u4E00\u3002`
    });
  }
  if (counted.length < CONCENTRATION_THRESHOLDS.fewHoldings) {
    flags.push({
      code: "TOO_FEW_HOLDINGS",
      level: "WATCH",
      message: `\u4EC5 ${counted.length} \u4E2A\u6301\u4ED3\u8BA1\u5165\u5360\u6BD4\uFF0C\u5206\u6563\u5EA6\u4E0D\u8DB3\uFF0C\u96C6\u4E2D\u5EA6\u6307\u6807\u53C2\u8003\u610F\u4E49\u6709\u9650\u3002`
    });
  }
  if (missingCount > 0) {
    flags.push({
      code: "MISSING_VALUE",
      level: "WATCH",
      message: `${missingCount} \u4E2A\u6301\u4ED3\u7F3A\u4EF7\u683C\uFF0C\u672A\u8BA1\u5165\u5360\u6BD4\uFF1B\u96C6\u4E2D\u5EA6\u53EF\u80FD\u88AB\u4F4E\u4F30\u3002`
    });
  }
  return {
    coveredValue: formatFixed(totalRaw, SCALE_AMOUNT),
    missingCount,
    countedCount: counted.length,
    top1,
    top3Weight,
    hhi,
    effectiveHoldings: hhi > 0 ? 1 / hhi : null,
    byCategory,
    flags
  };
}

// plugin/server/src/services/decision-readiness.ts
var WEIGHTS = {
  holdings: 14,
  pricing: 18,
  valuation: 11,
  cashflow: 9,
  performance: 13,
  goal: 7,
  concentration: 10,
  index: 7,
  cash: 11
};
var VALUATION_COVERAGE_FLOOR = 0.8;
function pct(value) {
  return `${(value * 100).toFixed(0)}%`;
}
function getDecisionReadiness(ctx) {
  const holdings = listHoldings(ctx);
  const rows = holdings.rows;
  const holdingCount = rows.length;
  const priced = rows.filter((r) => r.marketValue !== null && r.price !== null);
  const pricedCount = priced.length;
  const totalRaw = rows.reduce(
    (sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)),
    0
  );
  const pricedRaw = priced.reduce(
    (sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)),
    0
  );
  const priceCoverage = totalRaw > 0 ? pricedRaw / totalRaw : 0;
  const dataDate = rows.reduce((latest, r) => {
    if (!r.priceDate) return latest;
    return !latest || r.priceDate > latest ? r.priceDate : latest;
  }, null);
  const performance = getPerformance(ctx, "1y");
  const cashFlows = listCashFlows(ctx.handle);
  const goal = getEnabledGoal(ctx.handle);
  const indexInstruments = listInstruments(ctx.handle, { type: "INDEX", active: true });
  const indexWithMetrics = indexInstruments.filter((inst) => {
    const metrics = latestValuationMetrics(ctx.handle, inst.id);
    return metrics.some((m2) => m2.metricKey === "pe" && m2.value !== null);
  }).length;
  const concentrationResult = concentration(rows.map((r) => ({
    id: r.instrumentId,
    name: r.name,
    category: r.type,
    marketValue: r.marketValue
  })));
  const items = [];
  items.push({
    key: "holdings",
    question: "\u6211\u73B0\u5728\u6301\u6709\u4EC0\u4E48\u3001\u6210\u672C\u591A\u5C11\uFF1F",
    label: "\u6301\u4ED3\u4E0E\u6210\u672C",
    status: holdingCount > 0 ? "OK" : "MISSING",
    detail: holdingCount > 0 ? `${holdingCount} \u4E2A\u6301\u4ED3\uFF0C\u6210\u672C\u4E0E\u6570\u91CF\u6765\u81EA\u4EA4\u6613\u6D41\u6C34\u56DE\u653E\u3002` : "\u6CA1\u6709\u4EFB\u4F55\u6301\u4ED3\u3002",
    action: holdingCount > 0 ? "\u2014" : "\u5728\u300C\u6301\u4ED3 \u2192 \u8BB0\u4E00\u7B14\u300D\u5F55\u5165\u4E70\u5165\u4EA4\u6613\uFF0C\u6216\u4ECE CSV \u5BFC\u5165\u6D41\u6C34\u3002",
    weight: WEIGHTS.holdings
  });
  if (holdingCount === 0) {
    items.push({
      key: "pricing",
      question: "\u6211\u7684\u8D44\u4EA7\u73B0\u5728\u503C\u591A\u5C11\u94B1\uFF1F",
      label: "\u4EF7\u683C\u4E0E\u5E02\u503C",
      status: "MISSING",
      detail: "\u65E0\u6301\u4ED3\uFF0C\u65E0\u53EF\u4F30\u503C\u8D44\u4EA7\u3002",
      action: "\u5148\u5F55\u5165\u6301\u4ED3\u3002",
      weight: WEIGHTS.pricing
    });
  } else if (priceCoverage >= 0.999) {
    items.push({
      key: "pricing",
      question: "\u6211\u7684\u8D44\u4EA7\u73B0\u5728\u503C\u591A\u5C11\u94B1\uFF1F",
      label: "\u4EF7\u683C\u4E0E\u5E02\u503C",
      status: "OK",
      detail: `${pricedCount}/${holdingCount} \u4E2A\u6301\u4ED3\u6709\u6709\u6548\u4EF7\u683C\uFF0C\u5E02\u503C\u5B8C\u6574\uFF1B\u6700\u65B0\u4EF7\u683C\u65E5\u671F ${dataDate ?? "\u2014"}\u3002`,
      action: "\u2014",
      weight: WEIGHTS.pricing
    });
  } else if (priceCoverage > 0) {
    items.push({
      key: "pricing",
      question: "\u6211\u7684\u8D44\u4EA7\u73B0\u5728\u503C\u591A\u5C11\u94B1\uFF1F",
      label: "\u4EF7\u683C\u4E0E\u5E02\u503C",
      status: "PARTIAL",
      detail: `\u4EC5 ${pricedCount}/${holdingCount} \u4E2A\u6301\u4ED3\u6709\u4EF7\u683C\uFF08\u6309\u5E02\u503C\u8986\u76D6 ${pct(priceCoverage)}\uFF09\uFF0C\u603B\u5E02\u503C\u4E0E\u6536\u76CA\u88AB\u4F4E\u4F30\u3002`,
      action: "\u5728\u300C\u8BBE\u7F6E \u2192 \u5237\u65B0\u884C\u60C5\u300D\u62C9\u53D6\uFF0C\u6216\u5BF9\u7F3A\u4EF7\u6807\u7684\u7528\u300C\u624B\u5DE5\u4EF7\u683C\u300D\u8865\u5F55\u3002",
      weight: WEIGHTS.pricing
    });
  } else {
    items.push({
      key: "pricing",
      question: "\u6211\u7684\u8D44\u4EA7\u73B0\u5728\u503C\u591A\u5C11\u94B1\uFF1F",
      label: "\u4EF7\u683C\u4E0E\u5E02\u503C",
      status: "MISSING",
      detail: "\u6240\u6709\u6301\u4ED3\u90FD\u7F3A\u6709\u6548\u4EF7\u683C\uFF0C\u603B\u5E02\u503C\u4E0D\u53EF\u7528\u3002",
      action: "\u5237\u65B0\u884C\u60C5\u6216\u624B\u5DE5\u8865\u5F55\u4EF7\u683C\u3002",
      weight: WEIGHTS.pricing
    });
  }
  const valuationCoverage = performance.valuationCoverage ?? 0;
  if (holdingCount === 0) {
    items.push({
      key: "valuation",
      question: "\u6211\u6301\u6709\u7684\u4E1C\u897F\u73B0\u5728\u8D35\u4E0D\u8D35\uFF1F",
      label: "\u7EC4\u5408\u4F30\u503C",
      status: "MISSING",
      detail: "\u65E0\u6301\u4ED3\uFF0C\u65E0\u7EC4\u5408\u4F30\u503C\u3002",
      action: "\u5148\u5F55\u5165\u6301\u4ED3\u4E0E\u4F30\u503C\u6307\u6807\u3002",
      weight: WEIGHTS.valuation
    });
  } else if (valuationCoverage >= VALUATION_COVERAGE_FLOOR && performance.portfolioPe !== null) {
    items.push({
      key: "valuation",
      question: "\u6211\u6301\u6709\u7684\u4E1C\u897F\u73B0\u5728\u8D35\u4E0D\u8D35\uFF1F",
      label: "\u7EC4\u5408\u4F30\u503C",
      status: "OK",
      detail: `\u7EC4\u5408 PE ${performance.portfolioPe} \xB7 PB ${performance.portfolioPb ?? "\u2014"}\uFF0C\u6309 ${pct(valuationCoverage)} \u8986\u76D6\u5E02\u503C\u52A0\u6743\u3002`,
      action: "\u2014",
      weight: WEIGHTS.valuation
    });
  } else if (valuationCoverage > 0) {
    items.push({
      key: "valuation",
      question: "\u6211\u6301\u6709\u7684\u4E1C\u897F\u73B0\u5728\u8D35\u4E0D\u8D35\uFF1F",
      label: "\u7EC4\u5408\u4F30\u503C",
      status: "PARTIAL",
      detail: `\u4F30\u503C\u622A\u9762\u8986\u76D6 ${pct(valuationCoverage)}\uFF0C\u4F4E\u4E8E ${pct(VALUATION_COVERAGE_FLOOR)} \u4E0D\u4EA7\u751F\u7EC4\u5408 PE/PB\u3002`,
      action: "\u5237\u65B0\u884C\u60C5\u8865\u9F50 PE/PB\uFF0C\u6216\u5728\u6301\u4ED3\u8BE6\u60C5\u300C\u8865\u5F55\u4F30\u503C\u6307\u6807\u300D\u3002",
      weight: WEIGHTS.valuation
    });
  } else {
    items.push({
      key: "valuation",
      question: "\u6211\u6301\u6709\u7684\u4E1C\u897F\u73B0\u5728\u8D35\u4E0D\u8D35\uFF1F",
      label: "\u7EC4\u5408\u4F30\u503C",
      status: "MISSING",
      detail: "\u6CA1\u6709\u4EFB\u4F55 PE / PB \u4F30\u503C\u622A\u9762\u3002",
      action: "\u5237\u65B0\u884C\u60C5\uFF0C\u6216\u624B\u5DE5\u8865\u5F55 PE / PB\u3002",
      weight: WEIGHTS.valuation
    });
  }
  items.push({
    key: "cashflow",
    question: "\u6211\u7684\u771F\u5B9E\u6536\u76CA\u7387\u662F\u591A\u5C11\uFF1F",
    label: "\u5916\u90E8\u8D44\u91D1\u6D41",
    status: cashFlows.length > 0 ? "OK" : "MISSING",
    detail: cashFlows.length > 0 ? `${cashFlows.length} \u7B14\u5916\u90E8\u8D44\u91D1\u6D41\uFF0C\u53EF\u8BA1\u7B97 XIRR\u3002` : "\u672A\u5F55\u5165\u5916\u90E8\u8D44\u91D1\u6D41\uFF0CXIRR \u65E0\u6CD5\u8BA1\u7B97\uFF08\u53EA\u80FD\u770B\u8D26\u9762\u6DA8\u8DCC\uFF09\u3002",
    action: cashFlows.length > 0 ? "\u2014" : "\u5728\u300C\u603B\u89C8 \u2192 \u8D44\u91D1\u6D41\u300D\u5F55\u5165\u5165\u91D1 / \u51FA\u91D1\u8BB0\u5F55\u3002",
    weight: WEIGHTS.cashflow
  });
  const hasXirr = performance.xirr !== null;
  const hasDrawdown = performance.maxDrawdown !== null;
  const hasSharpe = performance.sharpe !== null;
  if (hasXirr && hasDrawdown) {
    items.push({
      key: "performance",
      question: "\u6211\u627F\u62C5\u4E86\u591A\u5C11\u98CE\u9669\u3001\u6027\u4EF7\u6BD4\u5982\u4F55\uFF1F",
      label: "\u6536\u76CA\u4E0E\u98CE\u9669",
      status: hasSharpe ? "OK" : "PARTIAL",
      detail: `XIRR ${(performance.xirr * 100).toFixed(2)}% \xB7 \u6700\u5927\u56DE\u64A4 ${(performance.maxDrawdown * 100).toFixed(2)}% \xB7 \u590F\u666E ${hasSharpe ? performance.sharpe.toFixed(2) : "\u6837\u672C\u4E0D\u8DB3"}\uFF0C\u533A\u95F4 ${performance.range.begin} \u2192 ${performance.range.end}\uFF08${performance.seriesPoints} \u4E2A\u51C0\u503C\u70B9\uFF09\u3002`,
      action: hasSharpe ? "\u2014" : "\u8865\u9F50\u65E0\u98CE\u9669\u5229\u7387\u4E0E\u66F4\u591A\u5386\u53F2\u51C0\u503C\u70B9\u540E\u590F\u666E\u624D\u53EF\u7528\u3002",
      weight: WEIGHTS.performance
    });
  } else if (hasXirr || hasDrawdown) {
    items.push({
      key: "performance",
      question: "\u6211\u627F\u62C5\u4E86\u591A\u5C11\u98CE\u9669\u3001\u6027\u4EF7\u6BD4\u5982\u4F55\uFF1F",
      label: "\u6536\u76CA\u4E0E\u98CE\u9669",
      status: "PARTIAL",
      detail: `\u4EC5\u6709\u90E8\u5206\u6307\u6807\uFF08XIRR ${hasXirr ? "\u53EF\u7528" : "\u4E0D\u53EF\u7528"} / \u6700\u5927\u56DE\u64A4 ${hasDrawdown ? "\u53EF\u7528" : "\u4E0D\u53EF\u7528"}\uFF09\u3002`,
      action: "\u8865\u9F50\u5916\u90E8\u8D44\u91D1\u6D41\u4E0E\u5386\u53F2\u4EF7\u683C\uFF0C\u4F7F\u51C0\u503C\u5E8F\u5217\u5B8C\u6574\u3002",
      weight: WEIGHTS.performance
    });
  } else {
    items.push({
      key: "performance",
      question: "\u6211\u627F\u62C5\u4E86\u591A\u5C11\u98CE\u9669\u3001\u6027\u4EF7\u6BD4\u5982\u4F55\uFF1F",
      label: "\u6536\u76CA\u4E0E\u98CE\u9669",
      status: "MISSING",
      detail: "XIRR \u4E0E\u6700\u5927\u56DE\u64A4\u5747\u4E0D\u53EF\u7528\uFF08\u6837\u672C\u4E0D\u8DB3\u6216\u8D44\u91D1\u6D41\u7F3A\u5931\uFF09\u3002",
      action: "\u5F55\u5165\u5916\u90E8\u8D44\u91D1\u6D41 + \u56DE\u8865\u5386\u53F2\u4EF7\u683C\u3002",
      weight: WEIGHTS.performance
    });
  }
  items.push({
    key: "goal",
    question: "\u6211\u8981\u53BB\u54EA\u91CC\u3001\u8FD8\u5DEE\u591A\u5C11\uFF1F",
    label: "\u6295\u8D44\u76EE\u6807",
    status: goal ? "OK" : "MISSING",
    detail: goal ? `\u5DF2\u8BBE\u7F6E\u76EE\u6807\u91D1\u989D\uFF08${goal.enabled ? "\u76EE\u6807\u6A21\u5F0F\u542F\u7528\u4E2D" : "\u76EE\u6807\u6A21\u5F0F\u672A\u542F\u7528"}\uFF09\uFF0C\u53EF\u5728\u300C\u603B\u89C8 \u2192 \u76EE\u6807\u8FBE\u6210\u300D\u67E5\u770B\u8FDB\u5EA6\u3002` : "\u672A\u8BBE\u7F6E\u76EE\u6807\u91D1\u989D\uFF0C\u65E0\u6CD5\u5224\u65AD\u8FDB\u5EA6\u4E0E\u6240\u9700\u6536\u76CA\u7387\u3002",
    action: goal ? "\u2014" : "\u5728\u300C\u603B\u89C8 \u2192 \u76EE\u6807\u8FBE\u6210\u300D\u8BBE\u7F6E\u76EE\u6807\u91D1\u989D\u4E0E\u671F\u9650\u3002",
    weight: WEIGHTS.goal
  });
  const highFlags = concentrationResult.flags.filter((f) => f.level === "HIGH");
  if (concentrationResult.top1 === null) {
    items.push({
      key: "concentration",
      question: "\u6211\u7684\u98CE\u9669\u662F\u5426\u8FC7\u5EA6\u96C6\u4E2D\uFF1F",
      label: "\u96C6\u4E2D\u5EA6",
      status: "MISSING",
      detail: "\u65E0\u53EF\u7528\u5E02\u503C\uFF0C\u65E0\u6CD5\u8BA1\u7B97\u96C6\u4E2D\u5EA6\u3002",
      action: "\u5148\u8865\u9F50\u6301\u4ED3\u4EF7\u683C\u3002",
      weight: WEIGHTS.concentration
    });
  } else if (highFlags.length > 0) {
    items.push({
      key: "concentration",
      question: "\u6211\u7684\u98CE\u9669\u662F\u5426\u8FC7\u5EA6\u96C6\u4E2D\uFF1F",
      label: "\u96C6\u4E2D\u5EA6",
      status: "PARTIAL",
      detail: `\u5355\u4E00\u6301\u4ED3 ${pct(concentrationResult.top1.weight)} \xB7 \u524D\u4E09\u5927 ${pct(concentrationResult.top3Weight ?? 0)} \xB7 \u6709\u6548\u6301\u4ED3\u6570 ${concentrationResult.effectiveHoldings?.toFixed(1) ?? "\u2014"}\uFF1B${highFlags.length} \u9879\u8D85\u9AD8\u5EA6\u96C6\u4E2D\u7EBF\u3002`,
      action: "\u68C0\u67E5\u662F\u5426\u8981\u964D\u4F4E\u5355\u4E00\u6807\u7684\u6743\u91CD\uFF08\u672C\u5DE5\u5177\u53EA\u63D0\u793A\uFF0C\u4E0D\u81EA\u52A8\u4E0B\u5355\uFF09\u3002",
      weight: WEIGHTS.concentration
    });
  } else {
    items.push({
      key: "concentration",
      question: "\u6211\u7684\u98CE\u9669\u662F\u5426\u8FC7\u5EA6\u96C6\u4E2D\uFF1F",
      label: "\u96C6\u4E2D\u5EA6",
      status: "OK",
      detail: `\u5355\u4E00\u6301\u4ED3 ${pct(concentrationResult.top1.weight)} \xB7 \u524D\u4E09\u5927 ${pct(concentrationResult.top3Weight ?? 0)} \xB7 \u6709\u6548\u6301\u4ED3\u6570 ${concentrationResult.effectiveHoldings?.toFixed(1) ?? "\u2014"}\u3002`,
      action: "\u2014",
      weight: WEIGHTS.concentration
    });
  }
  const cash = cashTotal(ctx.handle);
  const cashRaw = parseFixed(cash, SCALE_AMOUNT);
  const holdingsRaw = parseFixed(holdings.totalMarketValue, SCALE_AMOUNT);
  const assetsRaw = holdingsRaw + cashRaw;
  const cashShare = assetsRaw > 0 ? cashRaw / assetsRaw : null;
  if (assetsRaw <= 0) {
    items.push({
      key: "cash",
      question: "\u6211\u7559\u4E86\u591A\u5C11\u73B0\u91D1\u3001\u5E94\u6025\u80FD\u529B\u5982\u4F55\uFF1F",
      label: "\u73B0\u91D1\u4E0E\u6D41\u52A8\u6027",
      status: "MISSING",
      detail: "\u6CA1\u6709\u6301\u4ED3\u4E5F\u6CA1\u6709\u73B0\u91D1\u4F59\u989D\uFF0C\u65E0\u6CD5\u8BC4\u4F30\u6D41\u52A8\u6027\u3002",
      action: "\u5728\u300C\u603B\u89C8 \u2192 \u73B0\u91D1\u300D\u5F55\u5165\u73B0\u91D1 / \u8D27\u5E01\u57FA\u91D1\u4F59\u989D\u3002",
      weight: WEIGHTS.cash
    });
  } else if (cashRaw > 0) {
    items.push({
      key: "cash",
      question: "\u6211\u7559\u4E86\u591A\u5C11\u73B0\u91D1\u3001\u5E94\u6025\u80FD\u529B\u5982\u4F55\uFF1F",
      label: "\u73B0\u91D1\u4E0E\u6D41\u52A8\u6027",
      status: "OK",
      detail: `\u73B0\u91D1 ${cash} \u5143\uFF0C\u5360\u603B\u8D44\u4EA7 ${pct(cashShare ?? 0)}\uFF1B\u603B\u8D44\u4EA7 = \u6301\u4ED3\u5E02\u503C + \u73B0\u91D1\u3002`,
      action: "\u2014",
      weight: WEIGHTS.cash
    });
  } else {
    items.push({
      key: "cash",
      question: "\u6211\u7559\u4E86\u591A\u5C11\u73B0\u91D1\u3001\u5E94\u6025\u80FD\u529B\u5982\u4F55\uFF1F",
      label: "\u73B0\u91D1\u4E0E\u6D41\u52A8\u6027",
      status: "PARTIAL",
      detail: "\u672A\u5F55\u5165\u73B0\u91D1\u4F59\u989D\uFF0C\u603B\u8D44\u4EA7\u53EA\u7B49\u4E8E\u6301\u4ED3\u5E02\u503C\uFF0C\u4ED3\u4F4D\u6BD4\u4F8B\u4F1A\u504F\u9AD8\u3002",
      action: "\u5728\u300C\u603B\u89C8 \u2192 \u73B0\u91D1\u300D\u8865\u5F55\u73B0\u91D1 / \u8D27\u5E01\u57FA\u91D1\u4F59\u989D\u3002",
      weight: WEIGHTS.cash
    });
  }
  if (indexWithMetrics > 0) {
    items.push({
      key: "index",
      question: "\u6574\u4E2A\u5E02\u573A\u73B0\u5728\u5904\u5728\u4EC0\u4E48\u4F30\u503C\u4F4D\u7F6E\uFF1F",
      label: "\u5E02\u573A\u4F30\u503C\u5750\u6807",
      status: "OK",
      detail: `${indexWithMetrics}/${indexInstruments.length} \u4E2A\u6307\u6570\u6709 PE \u622A\u9762\u3002`,
      action: "\u2014",
      weight: WEIGHTS.index
    });
  } else if (indexInstruments.length > 0) {
    items.push({
      key: "index",
      question: "\u6574\u4E2A\u5E02\u573A\u73B0\u5728\u5904\u5728\u4EC0\u4E48\u4F30\u503C\u4F4D\u7F6E\uFF1F",
      label: "\u5E02\u573A\u4F30\u503C\u5750\u6807",
      status: "PARTIAL",
      detail: `${indexInstruments.length} \u4E2A\u6307\u6570\u6807\u7684\u5DF2\u5F55\u5165\uFF0C\u4F46\u90FD\u6CA1\u6709 PE/PB \u622A\u9762\uFF0C\u6307\u6570\u9875\u663E\u793A\u300C\u2014\u300D\u3002`,
      action: "\u4E3A\u6307\u6570\u8865\u5F55\u4F30\u503C\u6307\u6807\uFF0C\u6216\u5237\u65B0\u884C\u60C5\uFF08\u9700\u6570\u636E\u6E90\u652F\u6301\u6307\u6570\u4F30\u503C\uFF09\u3002",
      weight: WEIGHTS.index
    });
  } else {
    items.push({
      key: "index",
      question: "\u6574\u4E2A\u5E02\u573A\u73B0\u5728\u5904\u5728\u4EC0\u4E48\u4F30\u503C\u4F4D\u7F6E\uFF1F",
      label: "\u5E02\u573A\u4F30\u503C\u5750\u6807",
      status: "MISSING",
      detail: "\u6CA1\u6709\u4EFB\u4F55 INDEX \u6807\u7684\uFF0C\u6307\u6570\u9875\u4E3A\u300C\u7ED3\u6784\u9884\u89C8\u300D\uFF0C\u6570\u503C\u5217\u5168\u4E3A\u300C\u2014\u300D\u3002",
      action: "\u5728\u300C\u6807\u7684\u300D\u4E2D\u65B0\u589E type=INDEX \u7684\u6307\u6570\uFF08\u5982\u6CAA\u6DF1300 / \u4E2D\u8BC1500\uFF09\uFF0C\u5E76\u8865\u5F55\u4F30\u503C\u6307\u6807\u3002",
      weight: WEIGHTS.index
    });
  }
  const earned = items.reduce((sum, item) => {
    const factor = item.status === "OK" ? 1 : item.status === "PARTIAL" ? 0.5 : 0;
    return sum + item.weight * factor;
  }, 0);
  const score = Math.round(earned);
  const blockers = items.filter((i) => i.status === "MISSING").map((i) => i.label);
  const verdict = score >= 80 && blockers.length === 0 ? "READY" : score >= 40 ? "PARTIAL" : "INSUFFICIENT";
  const verdictText = verdict === "READY" ? "\u6570\u636E\u5B8C\u5907\u5EA6\u8DB3\u4EE5\u652F\u6491\u5E38\u89C4\u8D44\u4EA7\u51B3\u7B56\uFF08\u914D\u7F6E\u3001\u52A0\u51CF\u4ED3\u3001\u518D\u5E73\u8861\u590D\u6838\uFF09\u3002" : verdict === "PARTIAL" ? `\u4EC5\u90E8\u5206\u652F\u6491\uFF1A${blockers.length > 0 ? `\u7F3A ${blockers.join(" / ")}` : "\u90E8\u5206\u7EF4\u5EA6\u8986\u76D6\u7387\u4E0D\u8DB3"}\uFF0C\u7ED3\u8BBA\u9700\u6253\u6298\u4F7F\u7528\u3002` : `\u4E0D\u8DB3\u4EE5\u652F\u6491\u8D44\u4EA7\u51B3\u7B56\uFF1A\u7F3A\u5C11 ${blockers.join(" / ") || "\u57FA\u7840\u6570\u636E"}\u3002`;
  return {
    score,
    verdict,
    verdictText,
    items,
    blockers,
    concentration: concentrationResult,
    metrics: {
      holdingCount,
      pricedCount,
      priceCoverage,
      totalMarketValue: rows.reduce((sum, r) => sum + (r.marketValue === null ? 0 : parseFixed(r.marketValue, SCALE_AMOUNT)), 0).toFixed(2),
      valuationCoverage,
      cashFlowCount: cashFlows.length,
      goalEnabled: goal !== null && goal.enabled,
      xirr: performance.xirr,
      maxDrawdown: performance.maxDrawdown,
      sharpe: performance.sharpe,
      portfolioPe: performance.portfolioPe,
      indexCount: indexInstruments.length,
      indexWithMetrics,
      dataDate
    },
    note: "\u5206\u6570\u53EA\u8868\u793A\u300C\u4FE1\u606F\u5B8C\u5907\u5EA6\u300D\uFF0C\u4E0D\u4EE3\u8868\u6807\u7684\u4F18\u52A3\u6216\u6536\u76CA\u9884\u671F\uFF1B\u6240\u6709\u6307\u6807\u5747\u4E3A\u63CF\u8FF0\u6027\u7EDF\u8BA1\uFF0C\u4E0D\u6784\u6210\u6295\u8D44\u5EFA\u8BAE\u3002"
  };
}

// plugin/server/src/services/indices.ts
var COMMON_INDICES = [
  { code: "000300", name: "\u6CAA\u6DF1300", market: "SH", secid: "1.000300", tag: "\u5BBD\u57FA" },
  { code: "000905", name: "\u4E2D\u8BC1500", market: "SH", secid: "1.000905", tag: "\u5BBD\u57FA" },
  { code: "000852", name: "\u4E2D\u8BC11000", market: "SH", secid: "1.000852", tag: "\u5BBD\u57FA" },
  { code: "000016", name: "\u4E0A\u8BC150", market: "SH", secid: "1.000016", tag: "\u5BBD\u57FA" },
  { code: "000001", name: "\u4E0A\u8BC1\u6307\u6570", market: "SH", secid: "1.000001", tag: "\u5BBD\u57FA" },
  { code: "399001", name: "\u6DF1\u8BC1\u6210\u6307", market: "SZ", secid: "0.399001", tag: "\u5BBD\u57FA" },
  { code: "399006", name: "\u521B\u4E1A\u677F\u6307", market: "SZ", secid: "0.399006", tag: "\u5BBD\u57FA" },
  { code: "000688", name: "\u79D1\u521B50", market: "SH", secid: "1.000688", tag: "\u5BBD\u57FA" }
];
function seedCommonIndices(ctx) {
  const before = new Set(
    listInstruments(ctx.handle, { type: "INDEX" }).map((i) => `${i.code}:${i.market}`)
  );
  const created = [];
  const existing = [];
  for (const item of COMMON_INDICES) {
    saveInstrument(ctx.handle, {
      code: item.code,
      name: item.name,
      type: "INDEX",
      market: item.market,
      secid: item.secid,
      tag: item.tag
    });
    if (before.has(`${item.code}:${item.market}`)) existing.push(item.name);
    else created.push(item.name);
  }
  const total = listInstruments(ctx.handle, { type: "INDEX" }).length;
  return {
    created,
    existing,
    total,
    note: created.length > 0 ? `\u5DF2\u521B\u5EFA ${created.length} \u4E2A\u6307\u6570\u6807\u7684\uFF1B\u70B9\u300C\u5237\u65B0\u300D\u4ECE\u771F\u5B9E\u6570\u636E\u6E90\u62C9\u53D6\u4EF7\u683C\u4E0E\u4F30\u503C\uFF0C\u6570\u503C\u4E0D\u4F1A\u81EA\u52A8\u586B\u5145\u3002` : "\u5E38\u7528\u6307\u6570\u5747\u5DF2\u5B58\u5728\uFF1B\u70B9\u300C\u5237\u65B0\u300D\u66F4\u65B0\u6570\u636E\u3002"
  };
}
async function bootstrapIndices(ctx) {
  const seeded = seedCommonIndices(ctx);
  const ids = listInstruments(ctx.handle, { type: "INDEX" }).map((i) => i.id);
  if (ids.length === 0) {
    return {
      seeded,
      refresh: { total: 0, ok: 0, failed: 0, problems: [] },
      note: "\u6CA1\u6709\u53EF\u5237\u65B0\u7684\u6307\u6570\u6807\u7684\u3002"
    };
  }
  const { results } = await refreshMarketData(ctx, { instrumentIds: ids });
  const ok2 = results.filter((r) => r.ok).length;
  const problems = results.filter((r) => !r.ok).slice(0, 8).map((r) => ({ code: r.code, name: r.name, error: r.error ?? "\u6570\u636E\u6E90\u672A\u8FD4\u56DE\u6709\u6548\u6570\u636E" }));
  return {
    seeded,
    refresh: { total: results.length, ok: ok2, failed: results.length - ok2, problems },
    note: ok2 === results.length && results.length > 0 ? `\u5DF2\u5C31\u7EEA\uFF1A${results.length} \u4E2A\u6307\u6570\u7684\u884C\u60C5\u4E0E\u4F30\u503C\u6765\u81EA\u771F\u5B9E\u6570\u636E\u6E90\u3002` : `\u90E8\u5206\u6307\u6570\u672A\u53D6\u5230\u6570\u636E\uFF08${results.length - ok2}/${results.length}\uFF09\uFF1A\u53EF\u5728\u300C\u5237\u65B0\u6570\u636E\u300D\u91CD\u8BD5\uFF0C\u6216\u68C0\u67E5\u7F51\u7EDC\u4E0E\u6570\u636E\u6E90\u3002`
  };
}

// plugin/server/src/services/rebalance.ts
var DEFAULT_REBALANCE_THRESHOLD = 0.05;
var REBALANCE_CATEGORIES = [
  { key: "stock", label: "\u80A1\u7968" },
  { key: "etf", label: "ETF" },
  { key: "fund", label: "\u573A\u5916\u57FA\u91D1" },
  { key: "cash", label: "\u73B0\u91D1" }
];
var LABELS = new Map(REBALANCE_CATEGORIES.map((c) => [c.key, c.label]));
function listRebalanceTargets(ctx) {
  const rows = ctx.handle.db.prepare("SELECT category, target_weight FROM rebalance_targets ORDER BY category").all();
  return rows.map((row) => ({ category: row.category, targetWeight: row.target_weight }));
}
function saveRebalanceTargets(ctx, targets, threshold) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new ValidationError("\u81F3\u5C11\u9700\u8981\u4E00\u9879\u76EE\u6807\u6743\u91CD");
  }
  let sum = 0;
  for (const target of targets) {
    if (!LABELS.has(target.category)) {
      throw new ValidationError(`\u672A\u77E5\u8D44\u4EA7\u7C7B\u522B\uFF1A${String(target.category)}`);
    }
    if (!Number.isFinite(target.targetWeight) || target.targetWeight < 0 || target.targetWeight > 1) {
      throw new ValidationError("\u76EE\u6807\u6743\u91CD\u5FC5\u987B\u5728 0\u20131 \u4E4B\u95F4\uFF08\u5C0F\u6570\u5F62\u5F0F\uFF0C\u5982 0.4\uFF09");
    }
    sum += target.targetWeight;
  }
  if (sum > 1.0001) {
    throw new ValidationError(`\u76EE\u6807\u6743\u91CD\u5408\u8BA1 ${(sum * 100).toFixed(1)}% \u8D85\u8FC7 100%`);
  }
  if (threshold !== void 0 && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new ValidationError("\u518D\u5E73\u8861\u9608\u503C\u5FC5\u987B\u5728 0\u20131 \u4E4B\u95F4");
  }
  const db = ctx.handle.db;
  db.exec("BEGIN;");
  try {
    db.prepare("DELETE FROM rebalance_targets").run();
    const stmt = db.prepare("INSERT INTO rebalance_targets (id,category,target_weight,updated_at) VALUES (?,?,?,?)");
    for (const target of targets) {
      stmt.run(`rb-${target.category}`, target.category, target.targetWeight, (/* @__PURE__ */ new Date()).toISOString());
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
  if (threshold !== void 0) {
    setSetting(ctx.handle, "rebalance_threshold", threshold);
  }
  return { targets, threshold: threshold ?? getRebalanceThreshold(ctx) };
}
function getRebalanceThreshold(ctx) {
  const raw = getSetting(ctx.handle, "rebalance_threshold");
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_REBALANCE_THRESHOLD;
}
function getRebalancePlan(ctx) {
  const holdings = listHoldings(ctx);
  const cash = cashTotal(ctx.handle);
  const targets = listRebalanceTargets(ctx);
  const threshold = getRebalanceThreshold(ctx);
  const byCategory = /* @__PURE__ */ new Map();
  let missingValueCount = 0;
  for (const row of holdings.rows) {
    if (row.marketValue === null) {
      missingValueCount += 1;
      continue;
    }
    const key = row.type === "STOCK" ? "stock" : row.type === "ETF" ? "etf" : row.type === "OPEN_END_FUND" ? "fund" : "other";
    byCategory.set(key, (byCategory.get(key) ?? 0) + parseFixed(row.marketValue, SCALE_AMOUNT));
  }
  byCategory.set("cash", parseFixed(cash, SCALE_AMOUNT));
  const totalRaw = [...byCategory.values()].reduce((sum, v) => sum + v, 0);
  const targetsSum = targets.reduce((sum, t) => sum + t.targetWeight, 0);
  const keys = /* @__PURE__ */ new Set([...byCategory.keys(), ...targets.map((t) => t.category)]);
  keys.delete("other");
  const rows = [];
  for (const key of keys) {
    const valueRaw = byCategory.get(key) ?? 0;
    const target = targets.find((t) => t.category === key);
    const targetWeight = target?.targetWeight ?? 0;
    const currentWeight = totalRaw > 0 ? valueRaw / totalRaw : 0;
    const drift = currentWeight - targetWeight;
    let action = "HOLD";
    let amountRaw = 0;
    if (targets.length > 0 && Math.abs(drift) > threshold && totalRaw > 0) {
      if (drift > 0) {
        action = "SELL";
        amountRaw = Math.round((currentWeight - targetWeight) * totalRaw);
      } else {
        action = "BUY";
        amountRaw = Math.round((targetWeight - currentWeight) * totalRaw);
      }
    }
    rows.push({
      category: key,
      label: LABELS.get(key) ?? key,
      currentValue: formatFixed(valueRaw, SCALE_AMOUNT),
      currentWeight,
      targetWeight,
      drift,
      action,
      amount: formatFixed(amountRaw, SCALE_AMOUNT)
    });
  }
  rows.sort((a, b) => b.currentWeight - a.currentWeight);
  const actions = rows.filter((r) => r.action !== "HOLD").length;
  return {
    totalAssets: formatFixed(totalRaw, SCALE_AMOUNT),
    investableAssets: formatFixed(totalRaw, SCALE_AMOUNT),
    cashTotal: cash,
    rows,
    targetsSum,
    threshold,
    missingValueCount,
    note: missingValueCount > 0 ? `${missingValueCount} \u4E2A\u6301\u4ED3\u7F3A\u4EF7\u683C\uFF0C\u672A\u8BA1\u5165\u5206\u6BCD\uFF1B\u518D\u5E73\u8861\u6BD4\u4F8B\u53EF\u80FD\u5931\u771F\uFF0C\u5EFA\u8BAE\u5148\u5237\u65B0\u884C\u60C5\u3002` : targets.length === 0 ? "\u5C1A\u672A\u8BBE\u7F6E\u76EE\u6807\u6743\u91CD\u3002\u4E0A\u8868\u5DF2\u7ED9\u51FA\u5404\u7C7B\u522B\u5F53\u524D\u6743\u91CD\uFF0C\u53EF\u76F4\u63A5\u586B\u5199\u76EE\u6807\u767E\u5206\u6BD4\u540E\u4FDD\u5B58\uFF08\u4EC5\u5EFA\u8BAE\uFF0C\u4E0D\u4E0B\u5355\uFF09\u3002" : actions > 0 ? `${actions} \u4E2A\u7C7B\u522B\u504F\u79BB\u8D85\u8FC7 ${(threshold * 100).toFixed(0)}%\uFF0C\u5DF2\u7ED9\u51FA\u5EFA\u8BAE\u8C03\u6574\u91D1\u989D\uFF08\u4EC5\u5EFA\u8BAE\uFF0C\u4E0D\u751F\u6210\u8BA2\u5355\uFF09\u3002` : `\u6240\u6709\u7C7B\u522B\u504F\u79BB\u5747\u5728 ${(threshold * 100).toFixed(0)}% \u9608\u503C\u5185\uFF0C\u65E0\u9700\u8C03\u6574\u3002`
  };
}

// plugin/server/src/api.ts
var APP_VERSION = "0.1.2";
var MASKED_KEYS = /* @__PURE__ */ new Set([
  "totalMarketValue",
  "marketValue",
  "pnl",
  "costTotal",
  "realized",
  "dividends",
  "cumulative",
  "dayPnl",
  "unrealized",
  "totalCost",
  "totalPnl",
  "remainingAmount",
  "overAmount",
  "effectiveGoalAmount",
  "targetAmount",
  "amount",
  "daily",
  // 集中度 / 就绪度里的合计金额属于展示口径，隐藏金额时必须一起掩码。
  "coveredValue",
  // 现金与再平衡同样是金额展示口径：漏掉就会在隐藏金额时把余额暴露出来。
  "cashTotal",
  "totalAssets",
  "investableAssets",
  "currentValue",
  "balance"
]);
var MASK_EXEMPT = /* @__PURE__ */ new Set([
  "export_backup",
  "export_holdings_csv",
  "get_app_info",
  "get_ai_settings",
  "save_ai_settings",
  "test_ai_connection",
  "analyze_holding_with_ai",
  "preview_import_transactions",
  "commit_import_transactions",
  "preview_restore_backup",
  "restore_backup"
]);
function maskDeep(data) {
  if (Array.isArray(data)) return data.map((item) => maskDeep(item));
  if (data && typeof data === "object") {
    const out = {};
    for (const [key, value] of Object.entries(data)) {
      out[key] = typeof value === "string" && MASKED_KEYS.has(key) && value !== "" && value !== "-" ? "****" : maskDeep(value);
    }
    return out;
  }
  return data;
}
function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
}
function getPositionDetail(ctx, positionId) {
  const [accountId] = positionId.split(":");
  const holdings = listHoldings(ctx, { accountId });
  const holding = holdings.rows.find((r) => `${r.accountId}:${r.instrumentId}` === positionId);
  if (!holding) throw new NotFoundError(`position not found: ${positionId}`);
  const instrument = getInstrument(ctx.handle, holding.instrumentId);
  if (!instrument) throw new NotFoundError(`instrument not found: ${holding.instrumentId}`);
  const points = effectiveHistoryPoints(ctx.handle, holding.instrumentId, instrument.type);
  const qtyRaw = parseFixed(holding.qty, SCALE_QTY);
  const current = points.length > 0 ? parseFixed(points[points.length - 1].value, SCALE_QTY) : null;
  const prev = points.length >= 2 ? parseFixed(points[points.length - 2].value, SCALE_QTY) : null;
  const prev2 = points.length >= 3 ? parseFixed(points[points.length - 3].value, SCALE_QTY) : null;
  const dayPnlAmount = current !== null && prev !== null ? mulToScale(current - prev, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) : null;
  const ydayPnlAmount = prev !== null && prev2 !== null ? mulToScale(prev - prev2, qtyRaw, SCALE_AMOUNT, SCALE_QTY * 2) : null;
  const flows = listTransactions(ctx.handle, { instrumentId: holding.instrumentId, accountId });
  return {
    holding,
    instrument,
    basics: {
      marketValue: holding.marketValue,
      qty: holding.qty,
      weight: holding.weight,
      pnl: holding.pnl,
      pnlRate: holding.pnlRate,
      costTotal: holding.costTotal,
      unitCost: holding.unitCost,
      dayPnl: dayPnlAmount === null ? null : formatFixed(dayPnlAmount, SCALE_AMOUNT),
      ydayPnl: ydayPnlAmount === null ? null : formatFixed(ydayPnlAmount, SCALE_AMOUNT),
      heldDays: holding.firstHeldDate ? daysBetween(holding.firstHeldDate, ctx.today) : null,
      firstHeldDate: holding.firstHeldDate,
      dayPnlNote: dayPnlAmount === null ? "\u7F3A\u5C11\u53EF\u6BD4\u4EF7\u683C\uFF0C\u6682\u65E0\u53EF\u6BD4\u5F53\u65E5\u6536\u76CA" : null
    },
    transactions: flows,
    transactionsNote: "\u5220\u9664\u6301\u4ED3\u4E0D\u5220\u9664\u4EA4\u6613\u6D41\u6C34\uFF08\u5BA1\u8BA1\u4FDD\u7559\uFF09"
  };
}
async function compareInstruments(ctx, input) {
  const a = getInstrument(ctx.handle, input.aInstrumentId);
  const b = getInstrument(ctx.handle, input.bInstrumentId);
  if (!a || !b) throw new NotFoundError("instrument not found");
  if (a.type === "STOCK" !== (b.type === "STOCK")) {
    throw new ValidationError("PK \u4EC5\u652F\u6301\u540C\u7C7B\u578B\u5BF9\u6BD4\uFF08\u57FA\u91D1 / ETF \u6216\u80A1\u7968\uFF09");
  }
  const range = input.period ?? "1y";
  const rowFor = async (instrument) => {
    const chart = await getInstrumentChartSeries(ctx, { instrumentId: instrument.id, tab: "perf", period: range, compare: "none" });
    const values = chart.series.map((p) => parseFixed(p.value, SCALE_QTY));
    const metrics = latestValuationMetrics(ctx.handle, instrument.id);
    const metricValue2 = (key) => metrics.find((m2) => m2.metricKey === key)?.value ?? null;
    return {
      name: instrument.name,
      code: instrument.code,
      periodReturn: periodReturn(values),
      foundedDate: instrument.foundedDate,
      scaleInfo: instrument.scaleInfo,
      pe: metricValue2("pe"),
      pb: metricValue2("pb"),
      dividendYield: metricValue2("dividend_yield"),
      roe: metricValue2("roe"),
      series: chart.series,
      seriesPoints: chart.series.length
    };
  };
  const rowA = await rowFor(a);
  const rowB = await rowFor(b);
  return {
    period: range,
    a: rowA,
    b: rowB,
    note: "\u6536\u76CA\u7387\u4E3A\u533A\u95F4\u7D2F\u8BA1\u6DA8\u8DCC\u5E45\uFF1B\u89C4\u6A21 / \u6210\u7ACB\u65E5\u671F\u6765\u81EA\u6807\u7684\u6863\u6848\uFF1B\u6307\u6807\u7F3A\u5931\u663E\u793A\u300C\u2014\u300D\uFF0C\u4E0D\u9ED8\u8BA4 0\u3002\u5BF9\u6BD4\u7ED3\u679C\u4EC5\u4F9B\u7814\u7A76\u53C2\u8003\uFF0C\u4E0D\u6784\u6210\u6295\u8D44\u5EFA\u8BAE\u3002"
  };
}
function str2(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
function importText(params) {
  const xlsx = str2(params.xlsxBase64);
  if (xlsx !== "") return xlsxBase64ToCsv(xlsx).csv;
  return str2(params.csv);
}
var HANDLERS = {
  get_app_info: (ctx) => ({
    name: "\u4E2A\u4EBA\u6295\u8D44\u5DE5\u4F5C\u7AD9",
    version: APP_VERSION,
    schemaVersion: ctx.handle.schemaVersion,
    engine: ctx.handle.engine,
    dataDir: ctx.dirs.data,
    isNew: ctx.handle.isNew,
    hideAmount: getSetting(ctx.handle, "hide_amount") === true,
    secretBackend: currentSecretBackend()
  }),
  get_dashboard_summary: (ctx) => getDashboardSummary(ctx),
  get_dashboard_allocation: (ctx, params) => getDashboardAllocation(ctx, str2(params.mode, "full") === "goal" ? "goal" : "full"),
  get_portfolio_goal: (ctx) => ({
    enabled: getEnabledGoal(ctx.handle),
    goals: listGoals(ctx.handle),
    cashFlows: listCashFlows(ctx.handle)
  }),
  save_portfolio_goal: (ctx, params) => saveGoal(ctx.handle, {
    id: typeof params.id === "string" ? params.id : void 0,
    name: str2(params.name, "\u6211\u7684\u6295\u8D44\u8D44\u4EA7\u76EE\u6807"),
    targetAmount: str2(params.targetAmount, "0"),
    enabled: params.enabled === true,
    note: str2(params.note)
  }),
  get_portfolio_performance_metrics: (ctx, params) => getPerformance(
    ctx,
    str2(params.range, "1y"),
    params.custom
  ),
  list_accounts: (ctx, params) => listAccounts(
    ctx.handle,
    params.status === "ARCHIVED" ? "ARCHIVED" : params.status === "ACTIVE" ? "ACTIVE" : void 0
  ),
  save_account: (ctx, params) => saveAccount(ctx.handle, {
    id: typeof params.id === "string" ? params.id : void 0,
    name: str2(params.name),
    platform: str2(params.platform),
    note: str2(params.note)
  }),
  archive_account: (ctx, params) => archiveAccount(ctx.handle, str2(params.id)),
  search_instruments: (ctx, params) => searchInstruments(ctx.handle, str2(params.keyword)),
  save_instrument: (ctx, params) => saveInstrument(ctx.handle, {
    id: typeof params.id === "string" ? params.id : void 0,
    code: str2(params.code),
    name: str2(params.name),
    type: str2(params.type, "STOCK"),
    market: str2(params.market, "SH"),
    benchmarkIndex: typeof params.benchmarkIndex === "string" ? params.benchmarkIndex : null,
    secid: typeof params.secid === "string" ? params.secid : null,
    fundCode: typeof params.fundCode === "string" ? params.fundCode : null,
    tag: str2(params.tag),
    foundedDate: typeof params.foundedDate === "string" ? params.foundedDate : null,
    scaleInfo: typeof params.scaleInfo === "string" ? params.scaleInfo : null
  }),
  list_positions: (ctx, params) => listHoldings(ctx, {
    type: typeof params.type === "string" && params.type !== "all" ? params.type : void 0,
    accountId: typeof params.accountId === "string" && params.accountId !== "all" ? params.accountId : void 0,
    pnl: params.pnl === "gain" || params.pnl === "loss" ? params.pnl : void 0
  }),
  get_position_detail: (ctx, params) => getPositionDetail(ctx, str2(params.positionId)),
  record_transaction: (ctx, params) => {
    const saved = saveTransaction(ctx.handle, {
      accountId: str2(params.accountId),
      instrumentId: str2(params.instrumentId),
      type: str2(params.type),
      status: params.status === "PENDING_CONFIRMATION" ? "PENDING_CONFIRMATION" : "CONFIRMED",
      tradeDate: str2(params.tradeDate),
      quantity: typeof params.quantity === "string" ? params.quantity : null,
      price: typeof params.price === "string" ? params.price : null,
      amount: typeof params.amount === "string" ? params.amount : null,
      fee: typeof params.fee === "string" ? params.fee : null,
      tax: typeof params.tax === "string" ? params.tax : null,
      note: str2(params.note),
      requestId: typeof params.requestId === "string" ? params.requestId : null
    });
    try {
      replayPositions(allTransactions(ctx.handle));
    } catch (error) {
      if (!saved.deduplicated) {
        ctx.handle.db.prepare("DELETE FROM transactions WHERE id = ?").run(saved.txn.id);
      }
      throw error;
    }
    return saved;
  },
  list_transactions: (ctx, params) => listTransactions(ctx.handle, {
    accountId: typeof params.accountId === "string" ? params.accountId : void 0,
    instrumentId: typeof params.instrumentId === "string" ? params.instrumentId : void 0,
    type: typeof params.type === "string" ? params.type : void 0,
    status: typeof params.status === "string" ? params.status : void 0
  }),
  delete_position: (ctx, params) => {
    const positionId = str2(params.positionId);
    const [accountId, instrumentId] = positionId.split(":");
    deletePosition(ctx.handle, accountId, instrumentId);
    return { ok: true, note: "\u4EA4\u6613\u6D41\u6C34\u4FDD\u7559\uFF08\u5BA1\u8BA1\uFF09" };
  },
  pin_position: (ctx, params) => {
    setPinned(ctx.handle, str2(params.positionId), params.pinned === true);
    return { ok: true };
  },
  list_categories: (ctx) => {
    const categories = listCategories(ctx.handle);
    const links = listLinks(ctx.handle);
    return {
      categories: categories.map((c) => ({
        ...c,
        count: links.filter((l) => l.categoryId === c.id).length
      })),
      links
    };
  },
  save_category: (ctx, params) => saveCategory(ctx.handle, {
    id: typeof params.id === "string" ? params.id : void 0,
    name: str2(params.name),
    color: str2(params.color, "#3d6ef2")
  }),
  delete_category: (ctx, params) => ({ deleted: deleteCategory(ctx.handle, str2(params.id)) }),
  set_instrument_categories: (ctx, params) => {
    setInstrumentCategories(
      ctx.handle,
      str2(params.instrumentId),
      Array.isArray(params.categoryIds) ? params.categoryIds.map(String) : []
    );
    return { ok: true };
  },
  get_instrument_chart_series: (ctx, params) => getInstrumentChartSeries(ctx, {
    instrumentId: str2(params.instrumentId),
    tab: str2(params.tab, "perf"),
    period: str2(params.period, "1y"),
    compare: typeof params.compare === "string" ? params.compare : "none",
    custom: params.custom
  }),
  get_instrument_detail: async (ctx, params) => {
    const instrument = getInstrument(ctx.handle, str2(params.instrumentId));
    if (!instrument) throw new NotFoundError(`instrument not found: ${String(params.instrumentId)}`);
    const chart = await getInstrumentChartSeries(ctx, { instrumentId: instrument.id, tab: "perf", period: "1y", compare: "none" });
    const values = chart.series.map((p) => parseFixed(p.value, SCALE_QTY));
    return {
      instrument,
      stageReturns: {
        "\u8FD1 1 \u6708": periodReturn(values.slice(-21)),
        "\u8FD1 3 \u6708": periodReturn(values.slice(-64)),
        "\u8FD1 1 \u5E74": periodReturn(values)
      },
      series: chart.series
    };
  },
  get_holdings_valuation: (ctx, params) => getHoldingsValuation(ctx, {
    type: typeof params.type === "string" && params.type !== "all" ? params.type : void 0,
    // 估值页要「全部标的」；总览 / 持仓页保持只出持仓的原有口径。
    scope: params.scope === "all" ? "all" : "holdings"
  }),
  analyze_holding_with_ai: async (ctx, params) => analyzeHolding(ctx, str2(params.positionId)),
  get_ai_settings: (ctx) => getAiStatus(ctx),
  save_ai_settings: (ctx, params) => updateAiSettings(ctx, {
    baseUrl: typeof params.baseUrl === "string" ? params.baseUrl : void 0,
    apiKey: typeof params.apiKey === "string" ? params.apiKey : void 0,
    model: typeof params.model === "string" ? params.model : void 0
  }),
  test_ai_connection: (ctx) => testAiConnection(ctx),
  compare_instruments: (ctx, params) => compareInstruments(ctx, {
    aInstrumentId: str2(params.aInstrumentId),
    bInstrumentId: str2(params.bInstrumentId),
    period: typeof params.period === "string" ? params.period : void 0
  }),
  refresh_market_data: async (ctx, params) => refreshMarketData(ctx, {
    instrumentIds: Array.isArray(params.instrumentIds) ? params.instrumentIds.map(String) : void 0
  }),
  get_refresh_settings: (ctx) => {
    const calendar = getTradingCalendarInfo(ctx);
    return {
      settings: getRefreshSettings(ctx.handle),
      // 用真实交易日历判定，而不是「周一到周五」：节假日不再触发无效刷新。
      inTradingHours: calendar.session.open,
      session: calendar.session,
      // 只回摘要，不回整段日期数组：几千个日期字符串对页面没有价值，还会撑大响应。
      calendar: {
        source: calendar.calendar.source,
        dayCount: calendar.tradingDayCount,
        from: calendar.calendar.from,
        to: calendar.calendar.to,
        holidays: calendar.holidayCount,
        recentHolidays: calendar.recentHolidays
      },
      limits: { minSec: MIN_REFRESH_INTERVAL_SEC, maxSec: MAX_REFRESH_INTERVAL_SEC },
      note: calendar.calendar.source === "market" ? "\u4EA4\u6613\u65F6\u6BB5\u6309 UTC+8 \u7684 09:30\u201311:30 / 13:00\u201315:00 \u5224\u65AD\uFF0C\u4EA4\u6613\u65E5\u53D6\u81EA\u672C\u673A\u6307\u6570\u65E5\u7EBF\uFF08\u5DF2\u6392\u9664\u8282\u5047\u65E5\uFF09\u3002" : "\u4EA4\u6613\u65F6\u6BB5\u6309 UTC+8 \u7684 09:30\u201311:30 / 13:00\u201315:00 \u5224\u65AD\uFF1B\u5C1A\u65E0\u8DB3\u591F\u6307\u6570\u65E5\u7EBF\uFF0C\u8282\u5047\u65E5\u53EF\u80FD\u8BEF\u5224\u3002"
    };
  },
  save_refresh_settings: (ctx, params) => ({
    settings: saveRefreshSettings(ctx.handle, {
      enabled: typeof params.enabled === "boolean" ? params.enabled : void 0,
      intervalSec: params.intervalSec === void 0 ? void 0 : Number(params.intervalSec),
      tradingHoursOnly: typeof params.tradingHoursOnly === "boolean" ? params.tradingHoursOnly : void 0
    })
  }),
  get_index_valuation: (ctx, params) => getIndexValuation(ctx, {
    market: typeof params.market === "string" ? params.market : void 0,
    category: typeof params.category === "string" ? params.category : void 0,
    stat: typeof params.stat === "string" ? params.stat : void 0,
    years: params.years === void 0 ? void 0 : Number(params.years)
  }),
  get_decision_readiness: (ctx) => getDecisionReadiness(ctx),
  seed_common_indices: (ctx) => seedCommonIndices(ctx),
  bootstrap_indices: (ctx) => bootstrapIndices(ctx),
  get_portfolio_risk: (ctx, params) => getPortfolioRisk(ctx, str2(params.range, "1y")),
  save_risk_settings: (ctx, params) => {
    const rate = Number(params.riskFreeRate);
    if (!Number.isFinite(rate)) throw new ValidationError("riskFreeRate \u5FC5\u987B\u662F 0\u20130.2 \u4E4B\u95F4\u7684\u5C0F\u6570");
    return { riskFreeRate: saveRiskFreeRate(ctx.handle, rate) };
  },
  get_correlation_matrix: (ctx, params) => getCorrelationMatrix(ctx, params.limit === void 0 ? 12 : Number(params.limit)),
  list_cash_accounts: (ctx) => ({ accounts: listCashAccounts(ctx.handle) }),
  save_cash_account: (ctx, params) => saveCashAccount(ctx.handle, {
    id: typeof params.id === "string" ? params.id : void 0,
    name: str2(params.name),
    balance: str2(params.balance, "0"),
    currency: typeof params.currency === "string" ? params.currency : void 0,
    note: str2(params.note),
    active: params.active === void 0 ? void 0 : params.active === true
  }),
  delete_cash_account: (ctx, params) => ({ deleted: deleteCashAccount(ctx.handle, str2(params.id)) }),
  get_rebalance_plan: (ctx) => getRebalancePlan(ctx),
  save_rebalance_targets: (ctx, params) => saveRebalanceTargets(
    ctx,
    Array.isArray(params.targets) ? params.targets : [],
    params.threshold === void 0 ? void 0 : Number(params.threshold)
  ),
  get_trading_calendar: (ctx, params) => {
    const info = getTradingCalendarInfo(
      ctx,
      typeof params.now === "string" && params.now !== "" ? new Date(params.now) : /* @__PURE__ */ new Date()
    );
    return info;
  },
  get_index_analytics: (ctx, params) => getIndexAnalytics(ctx, {
    limit: params.limit === void 0 ? void 0 : Number(params.limit)
  }),
  export_backup: (ctx) => exportBackup(ctx),
  export_holdings_csv: (ctx) => ({ csv: exportHoldingsCsv(ctx) }),
  set_hide_amount: (ctx, params) => {
    setSetting(ctx.handle, "hide_amount", params.enabled === true);
    return { enabled: params.enabled === true };
  },
  save_manual_price: (ctx, params) => {
    const instrument = getInstrument(ctx.handle, str2(params.instrumentId));
    if (!instrument) throw new NotFoundError(`instrument not found: ${String(params.instrumentId)}`);
    const tradingDate = typeof params.tradingDate === "string" && params.tradingDate !== "" ? params.tradingDate : ctx.today;
    saveMarketPoints(ctx.handle, [{
      instrumentId: instrument.id,
      priceType: "MANUAL_PRICE",
      value: str2(params.value),
      currency: "CNY",
      tradingDate,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider: "manual",
      quality: "MANUAL"
    }]);
    return { ok: true, note: "\u624B\u5DE5\u4EF7\u683C\u5DF2\u5F55\u5165\uFF08MANUAL_PRICE\uFF0C\u4F18\u5148\u4E8E\u5176\u4ED6\u6765\u6E90\uFF09" };
  },
  /* ---------------- 组合外部资金流水（XIRR / 单位净值的输入） ---------------- */
  save_portfolio_cash_flow: (ctx, params) => saveCashFlow(ctx.handle, {
    flowType: params.flowType === "WITHDRAWAL" ? "WITHDRAWAL" : "CONTRIBUTION",
    flowDate: str2(params.flowDate, ctx.today),
    amount: str2(params.amount),
    note: str2(params.note)
  }),
  delete_portfolio_cash_flow: (ctx, params) => ({ deleted: deleteCashFlow(ctx.handle, str2(params.id)) }),
  /* ---------------- CSV 导入 / 备份恢复 ---------------- */
  preview_import_transactions: (ctx, params) => previewImport(ctx, importText(params)),
  commit_import_transactions: (ctx, params) => commitImport(ctx, importText(params)),
  preview_restore_backup: (_ctx, params) => previewRestore(params.payload),
  restore_backup: (ctx, params) => restoreBackup(ctx, params.payload),
  /* ---------------- 策略模板可编辑 + 版本化 ---------------- */
  list_strategy_templates: (ctx) => ({ templates: listTemplates(ctx.handle) }),
  save_strategy_template: (ctx, params) => ({
    template: saveTemplate(ctx.handle, {
      id: typeof params.id === "string" && params.id !== "" ? params.id : void 0,
      name: str2(params.name),
      scope: str2(params.scope),
      metrics: params.metrics,
      note: str2(params.note)
    })
  }),
  list_strategy_versions: (ctx, params) => ({ versions: listVersions(ctx.handle, str2(params.templateId)) }),
  restore_strategy_version: (ctx, params) => ({
    template: restoreVersion(ctx.handle, str2(params.templateId), Number(params.version))
  }),
  /* ---------------- 手工补录估值指标（数据源缺失时诚实标注 MANUAL） ---------------- */
  save_manual_metric: (ctx, params) => {
    const allowed = /* @__PURE__ */ new Set([
      "pe",
      "pb",
      "pe_percentile",
      "pb_percentile",
      "dividend_yield",
      "roe",
      "sharpe",
      "max_drawdown_pct",
      "annual_volatility_pct"
    ]);
    const metricKey = str2(params.metricKey);
    if (!allowed.has(metricKey)) throw new ValidationError(`\u4E0D\u652F\u6301\u7684\u4F30\u503C\u6307\u6807\uFF1A${metricKey}`);
    const value = str2(params.value);
    if (value === "" || !Number.isFinite(Number(value))) throw new ValidationError("\u6307\u6807\u503C\u5FC5\u987B\u662F\u6570\u5B57");
    const instrument = getInstrument(ctx.handle, str2(params.instrumentId));
    if (!instrument) throw new NotFoundError("\u6807\u7684\u4E0D\u5B58\u5728");
    saveValuationMetric(ctx.handle, {
      instrumentId: instrument.id,
      metricKey,
      value,
      asOfDate: str2(params.asOfDate, ctx.today),
      provider: "manual",
      quality: "MANUAL"
    });
    return { ok: true, note: "\u624B\u5DE5\u4F30\u503C\u6307\u6807\u5DF2\u5F55\u5165\uFF08MANUAL\uFF0C\u8BC4\u5206\u6309\u6765\u6E90\u6807\u6CE8\uFF0C\u4E0D\u5192\u5145\u884C\u60C5\u6570\u636E\uFF09" };
  }
};
async function dispatch(ctx, method, params = {}) {
  const traceId = randomUUID2();
  const handler = HANDLERS[method];
  if (!handler) {
    return { status: 404, envelope: fail(traceId, "unknown-method", `\u672A\u77E5\u65B9\u6CD5: ${method}`) };
  }
  try {
    const data = await handler(ctx, params);
    let payload = data;
    if (!MASK_EXEMPT.has(method) && getSetting(ctx.handle, "hide_amount") === true) {
      payload = maskDeep(payload);
    }
    return { status: 200, envelope: ok(traceId, payload) };
  } catch (error) {
    if (error instanceof LedgerError) {
      return { status: 422, envelope: fail(traceId, error.code, error.message, error.detail) };
    }
    if (error instanceof SchemaError) {
      return { status: 409, envelope: fail(traceId, error.code, error.message, error.detail) };
    }
    if (error instanceof ValidationError) {
      return { status: 422, envelope: fail(traceId, error.code, error.message) };
    }
    if (error instanceof NotFoundError) {
      return { status: 404, envelope: fail(traceId, error.code, error.message) };
    }
    const message = String(error?.message ?? error);
    const aiNotConfigured = message.startsWith("AI_NOT_CONFIGURED");
    return {
      status: aiNotConfigured ? 409 : 500,
      envelope: fail(
        traceId,
        aiNotConfigured ? "ai-not-configured" : "internal-error",
        aiNotConfigured ? message.replace(/^AI_NOT_CONFIGURED:\s*/, "") : message
      )
    };
  }
}

// plugin/server/src/market/tencent.ts
var UA2 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
var TIMEOUT_MS2 = 12e3;
var MIN_INTERVAL_MS2 = 200;
var lastRequestAt2 = 0;
async function paced2() {
  const wait = lastRequestAt2 + MIN_INTERVAL_MS2 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt2 = Date.now();
}
async function fetchGbkText(url) {
  await paced2();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS2);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA2, Referer: "https://gu.qq.com/" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    try {
      return new TextDecoder("gbk").decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJson2(url) {
  await paced2();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS2);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA2, Referer: "https://gu.qq.com/" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${url.slice(0, 120)}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
var SECID_PREFIX_MARKET = { "1": "sh", "0": "sz", "116": "hk", "105": "us", "106": "us" };
function tencentSymbol(instrument) {
  if (instrument.type === "OPEN_END_FUND") {
    return instrument.fundCode ? `jj${instrument.fundCode}` : null;
  }
  if (instrument.secid) {
    const [prefix, code] = instrument.secid.split(".");
    const market2 = SECID_PREFIX_MARKET[prefix];
    if (market2 && code) return `${market2}${code}`;
  }
  const market = instrument.market?.toUpperCase();
  if (market === "SH" || market === "SZ" || market === "HK" || market === "US") {
    return `${market.toLowerCase()}${instrument.code}`;
  }
  return null;
}
function normalizeTencentDate(raw) {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  const y = digits.slice(0, 4);
  const m2 = digits.slice(4, 6);
  const d = digits.slice(6, 8);
  const year = Number(y);
  const month = Number(m2);
  const day = Number(d);
  if (year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  return `${y}-${m2}-${d}`;
}
function num2(raw) {
  if (raw === void 0 || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}
function positive(raw) {
  const value = num2(raw);
  return value !== null && value > 0 ? value : null;
}
function parseTencentFields(text) {
  const match = /="([^"]*)"/.exec(text);
  if (!match) return null;
  const fields = match[1].split("~");
  return fields.length >= 6 ? fields : null;
}
function decodeTencentFields(fields) {
  const price = positive(fields[3]);
  if (price === null) return null;
  const marketFlag = fields[0] ?? "";
  return {
    marketFlag,
    name: fields[1] ?? "",
    code: fields[2] ?? "",
    price,
    prevClose: positive(fields[4]) ?? 0,
    open: positive(fields[5]) ?? 0,
    tradingDate: normalizeTencentDate(fields[30] ?? ""),
    changePct: num2(fields[32]),
    high: positive(fields[33]),
    low: positive(fields[34]),
    turnoverRate: num2(fields[38]),
    pe: positive(fields[39]),
    // 仅 A 股（marketFlag=1）的 46 位是 PB；港股 / 美股该位是名称或其它字段。
    pb: marketFlag === "1" ? positive(fields[46]) : null,
    floatCapYi: positive(fields[44]),
    totalCapYi: positive(fields[45])
  };
}
function parseTencentQuote(text, instrumentId, today) {
  const fields = parseTencentFields(text);
  if (!fields) return null;
  const decoded = decodeTencentFields(fields);
  if (!decoded) return null;
  const tradingDate = decoded.tradingDate ?? today;
  return {
    instrumentId,
    priceType: tradingDate === today ? "REALTIME_PRICE" : "CLOSE_PRICE",
    value: formatFixed(parseFixed(String(decoded.price), SCALE_QTY), SCALE_QTY),
    tradingDate,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    provider: "tencent",
    quality: tradingDate === today ? "FRESH" : "DELAYED",
    currency: "CNY"
  };
}
function decodeTencentFundFields(fields) {
  const nav = positive(fields[5]);
  if (nav === null) return null;
  return {
    code: fields[0] ?? "",
    name: fields[1] ?? "",
    nav,
    accNav: positive(fields[6]),
    changePct: num2(fields[7]),
    tradingDate: normalizeTencentDate(fields[8] ?? "")
  };
}
function parseTencentFundQuote(text, instrumentId, today) {
  const fields = parseTencentFields(text);
  if (!fields) return null;
  const decoded = decodeTencentFundFields(fields);
  if (!decoded) return null;
  return {
    instrumentId,
    priceType: "OFFICIAL_NAV",
    value: formatFixed(parseFixed(String(decoded.nav), SCALE_QTY), SCALE_QTY),
    tradingDate: decoded.tradingDate ?? today,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    provider: "tencent",
    quality: decoded.tradingDate === today ? "FRESH" : "DELAYED",
    currency: "CNY"
  };
}
function parseTencentKline(payload, symbol, instrumentId) {
  const data = payload?.data;
  const node = data?.[symbol];
  const rows = node?.qfqday ?? node?.day ?? [];
  const out = [];
  for (const row of rows) {
    const [date, , close] = row;
    if (!date || !close) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const value = Number(close);
    if (!Number.isFinite(value) || value <= 0) continue;
    out.push({
      instrumentId,
      priceType: "CLOSE_PRICE",
      value: formatFixed(parseFixed(close, SCALE_QTY), SCALE_QTY),
      tradingDate: date,
      observedAt: (/* @__PURE__ */ new Date()).toISOString(),
      provider: "tencent",
      quality: "FRESH",
      currency: "CNY"
    });
  }
  return out;
}
function parseTencentMetrics(text, instrumentId, today) {
  const fields = parseTencentFields(text);
  if (!fields) return [];
  const decoded = decodeTencentFields(fields);
  if (!decoded) return [];
  const asOfDate = decoded.tradingDate ?? today;
  const out = [];
  if (decoded.pe !== null) out.push({ metricKey: "pe", value: String(decoded.pe), asOfDate, quality: "FRESH" });
  if (decoded.pb !== null) out.push({ metricKey: "pb", value: String(decoded.pb), asOfDate, quality: "FRESH" });
  if (decoded.turnoverRate !== null) {
    out.push({ metricKey: "turnover_rate", value: String(decoded.turnoverRate), asOfDate, quality: "FRESH" });
  }
  if (decoded.totalCapYi !== null) {
    out.push({ metricKey: "scale_info", value: `\u603B\u5E02\u503C ${decoded.totalCapYi.toFixed(0)} \u4EBF`, asOfDate, quality: "FRESH" });
  }
  return out;
}
function createTencentProvider() {
  const todayStr = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return {
    id: "tencent",
    supports: (instrument) => tencentSymbol(instrument) !== null,
    async fetchQuote(instrument) {
      const symbol = tencentSymbol(instrument);
      if (!symbol) return null;
      const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbol}`);
      return instrument.type === "OPEN_END_FUND" ? parseTencentFundQuote(text, instrument.id, todayStr()) : parseTencentQuote(text, instrument.id, todayStr());
    },
    async fetchHistory(instrument, range) {
      const symbol = tencentSymbol(instrument);
      if (!symbol || instrument.type === "OPEN_END_FUND") return [];
      const days = Math.max(
        30,
        Math.min(1200, Math.round((Date.parse(`${range.end}T00:00:00Z`) - Date.parse(`${range.begin}T00:00:00Z`)) / 864e5) + 10)
      );
      const payload = await fetchJson2(
        `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,${range.begin},${range.end},${days},qfq`
      );
      return parseTencentKline(payload, symbol, instrument.id);
    },
    async fetchMetrics(instrument) {
      const symbol = tencentSymbol(instrument);
      if (!symbol || instrument.type === "OPEN_END_FUND") return [];
      const text = await fetchGbkText(`https://qt.gtimg.cn/q=${symbol}`);
      return parseTencentMetrics(text, instrument.id, todayStr());
    }
  };
}

// plugin/server/src/market/provider.ts
function createRegistry(providers) {
  return {
    resolve(instrument) {
      return providers.find((p) => p.supports(instrument)) ?? null;
    },
    resolveAll(instrument) {
      return providers.filter((p) => p.supports(instrument));
    },
    all: () => [...providers]
  };
}
function createDefaultRegistry() {
  return createRegistry([createTencentProvider(), createEastmoneyProvider()]);
}

// plugin/targets/mcp/server.ts
var SERVER_NAME = "plug-funds";
var SERVER_VERSION = "0.1.2";
var PROTOCOL_VERSION = "2024-11-05";
var str3 = (description) => ({ type: "string", description });
var num3 = (description) => ({ type: "number", description });
var TOOLS = [
  {
    name: "get_dashboard_summary",
    description: "\u7EC4\u5408\u603B\u89C8\uFF1A\u6301\u4ED3\u5E02\u503C\u3001\u73B0\u91D1\u3001\u603B\u8D44\u4EA7\u3001\u5F53\u65E5/\u7D2F\u8BA1\u76C8\u4E8F\u3001\u6570\u636E\u65E5\u671F\u4E0E\u4E0D\u5B8C\u6574\u6301\u4ED3\u63D0\u793A\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "list_positions",
    description: "\u6301\u4ED3\u660E\u7EC6\u5217\u8868\uFF1A\u6BCF\u53EA\u6807\u7684\u7684\u6570\u91CF\u3001\u6210\u672C\u3001\u73B0\u4EF7\u3001\u5E02\u503C\u3001\u76C8\u4E8F\u3001\u6743\u91CD\u4E0E\u4EF7\u683C\u6765\u6E90\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "get_position_detail",
    description: "\u5355\u4E2A\u6301\u4ED3\u7684\u5B8C\u6574\u8BE6\u60C5\uFF08\u57FA\u7840\u4FE1\u606F\u4E5D\u9879 + \u4EA4\u6613\u6D41\u6C34\uFF09\u3002",
    inputSchema: { type: "object", properties: { positionId: str3("\u6301\u4ED3 ID\uFF0C\u6765\u81EA list_positions") }, required: ["positionId"] },
    readOnly: true
  },
  {
    name: "get_holdings_valuation",
    description: "\u6301\u4ED3\u4F30\u503C\u622A\u9762\uFF1APE / PB / \u80A1\u606F\u7387 / ROE \u4E0E\u7B56\u7565\u8BC4\u5206\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "get_decision_readiness",
    description: "\u51B3\u7B56\u5C31\u7EEA\u5EA6\uFF1A9 \u4E2A\u7EF4\u5EA6\u6253\u5206\uFF080\u2013100\uFF09\u3001\u7F3A\u53E3\u6E05\u5355\u4E0E\u96C6\u4E2D\u5EA6\u6307\u6807\uFF0C\u7528\u4E8E\u5224\u65AD\u6570\u636E\u662F\u5426\u8DB3\u4EE5\u652F\u6491\u8D44\u4EA7\u51B3\u7B56\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "get_portfolio_risk",
    description: "\u7EC4\u5408\u98CE\u9669\u753B\u50CF\uFF1A\u5E74\u5316\u6CE2\u52A8\u7387\u3001Beta\u3001\u4E0E\u57FA\u51C6\u76F8\u5173\u6027\u3001\u8DDF\u8E2A\u8BEF\u5DEE\u3001\u80A1\u503A\u6027\u4EF7\u6BD4\uFF08ERP\uFF09\u3002",
    inputSchema: { type: "object", properties: { range: str3("\u533A\u95F4\uFF1A1m / 3m / 1y / all") } },
    readOnly: true
  },
  {
    name: "get_correlation_matrix",
    description: "\u6301\u4ED3\u76F8\u5173\u6027\u77E9\u9635\uFF08\u6309\u5E02\u503C\u53D6\u524D N \u53EA\uFF0C\u5171\u540C\u4EA4\u6613\u65E5\u4E0D\u8DB3 20 \u7684\u4F4D\u7F6E\u4E3A\u7A7A\uFF09\u3002",
    inputSchema: { type: "object", properties: { limit: num3("\u6700\u591A\u51E0\u53EA\uFF0C\u9ED8\u8BA4 12") } },
    readOnly: true
  },
  {
    name: "get_rebalance_plan",
    description: "\u518D\u5E73\u8861\u8BA1\u5212\uFF1A\u7C7B\u522B\u76EE\u6807\u6743\u91CD vs \u5B9E\u9645\u6743\u91CD\u3001\u504F\u79BB\u4E0E\u5EFA\u8BAE\u8C03\u6574\u91D1\u989D\uFF08\u4EC5\u5EFA\u8BAE\uFF0C\u4E0D\u4E0B\u5355\uFF09\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "list_cash_accounts",
    description: "\u73B0\u91D1 / \u6D41\u52A8\u6027\u8D26\u6237\u5217\u8868\u4E0E\u5408\u8BA1\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "get_index_valuation",
    description: "\u6307\u6570\u4F30\u503C\u4E00\u89C8\uFF1A\u70B9\u4F4D\u3001\u4ECA\u5E74\u6536\u76CA\u3001PE/PB/PS \u7684\u5F53\u524D\u503C / \u5206\u4F4D / \u5747\u503C / \u6781\u503C\u3001ROE\u3002",
    inputSchema: {
      type: "object",
      properties: {
        market: str3("\u5E02\u573A\uFF1A\u5168\u90E8 / \u4E0A\u8BC1 / \u6DF1\u8BC1 / \u4E2D\u8BC1 / \u6E2F\u80A1\u6307\u6570 \u2026"),
        category: str3("\u7C7B\u522B\uFF1A\u5168\u90E8 / \u5BBD\u57FA / \u884C\u4E1A / \u4E3B\u9898 / \u7B56\u7565"),
        stat: str3("\u805A\u5408\u53E3\u5F84\u6807\u6CE8\uFF1A\u52A0\u6743\u5E73\u5747\u503C / \u7B49\u6743\u5E73\u5747\u503C / \u7B97\u6570\u5E73\u5747\u503C / \u4E2D\u4F4D\u6570"),
        years: num3("\u56DE\u770B\u5E74\u6570\uFF1A0=\u6240\u6709\uFF0C20 / 10 / 5 / 3")
      }
    },
    readOnly: true
  },
  {
    name: "get_index_analytics",
    description: "\u6307\u6570\u5206\u6790\uFF1A\u9636\u6BB5\u6536\u76CA\u3001\u6CE2\u52A8\u7387\u3001\u6700\u5927\u56DE\u64A4\u3001\u65B0\u9AD8\u65B0\u4F4E\u3001RPS\u3001\u76F8\u5173\u6027\u77E9\u9635\u3001\u5B9A\u6295\u56DE\u6D4B\u3001\u683C\u96F7\u5384\u59C6\u6307\u6570\u3002",
    inputSchema: { type: "object", properties: { limit: num3("\u6700\u591A\u51E0\u4E2A\u6307\u6570\uFF0C\u9ED8\u8BA4 30") } },
    readOnly: true
  },
  {
    name: "get_trading_calendar",
    description: "\u4EA4\u6613\u65E5\u5386\uFF1A\u6570\u636E\u6765\u6E90\uFF08\u771F\u5B9E\u6307\u6570\u65E5\u7EBF / \u5DE5\u4F5C\u65E5\u63A8\u65AD\uFF09\u3001\u4EA4\u6613\u65E5\u6570\u3001\u63A8\u5BFC\u51FA\u7684\u4F11\u5E02\u65E5\u3001\u5F53\u524D\u4F1A\u8BDD\u72B6\u6001\u3002",
    inputSchema: { type: "object", properties: {} },
    readOnly: true
  },
  {
    name: "refresh_market_data",
    description: "\u5237\u65B0\u884C\u60C5\uFF1A\u591A\u6E90\uFF08\u817E\u8BAF\u4F18\u5148\u3001\u4E1C\u8D22\u515C\u5E95\uFF09\u62C9\u53D6\u62A5\u4EF7 / \u5386\u53F2 / \u4F30\u503C\uFF0C\u8FD4\u56DE\u6BCF\u4E2A\u6807\u7684\u7684\u6210\u529F\u4E0E\u5426\u4E0E\u591A\u6E90\u5206\u6B67\u3002",
    inputSchema: { type: "object", properties: { instrumentIds: { type: "array", items: { type: "string" }, description: "\u53EF\u9009\uFF0C\u53EA\u5237\u65B0\u6307\u5B9A\u6807\u7684" } } },
    readOnly: false
  },
  {
    name: "record_transaction",
    description: "\u8BB0\u4E00\u7B14\u4EA4\u6613\u6D41\u6C34\uFF08\u4E70\u5165 / \u5356\u51FA / \u5206\u7EA2 / \u671F\u521D\u7B49\uFF09\uFF1Bcreate-only\uFF0C\u5199\u5165\u540E\u6301\u4ED3\u6309\u6D41\u6C34\u56DE\u653E\u91CD\u7B97\u3002",
    inputSchema: {
      type: "object",
      properties: {
        accountId: str3("\u8D26\u6237 ID"),
        instrumentId: str3("\u6807\u7684 ID"),
        type: str3("\u4EA4\u6613\u7C7B\u578B\uFF1ABUY / SELL / OPENING / DIVIDEND_CASH / DIVIDEND_REINVEST / FEE / SPLIT / CORRECTION"),
        tradeDate: str3("\u4EA4\u6613\u65E5 YYYY-MM-DD"),
        quantity: str3("\u6570\u91CF / \u4EFD\u989D"),
        price: str3("\u4EF7\u683C"),
        amount: str3("\u91D1\u989D"),
        fee: str3("\u624B\u7EED\u8D39"),
        tax: str3("\u7A0E\u8D39"),
        note: str3("\u5907\u6CE8"),
        requestId: str3("\u5E42\u7B49\u952E\uFF08\u91CD\u590D\u63D0\u4EA4\u4E0D\u4F1A\u91CD\u590D\u5199\u5165\uFF09")
      },
      required: ["accountId", "instrumentId", "type", "tradeDate"]
    },
    readOnly: false
  },
  {
    name: "save_manual_price",
    description: "\u5F55\u5165\u624B\u5DE5\u4EF7\u683C\uFF08MANUAL_PRICE\uFF0C\u4F18\u5148\u7EA7\u9AD8\u4E8E\u5B9E\u65F6\u4E0E\u6536\u76D8\u4EF7\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        instrumentId: str3("\u6807\u7684 ID"),
        value: str3("\u4EF7\u683C"),
        tradingDate: str3("\u65E5\u671F YYYY-MM-DD\uFF0C\u9ED8\u8BA4\u4ECA\u5929")
      },
      required: ["instrumentId", "value"]
    },
    readOnly: false
  },
  {
    name: "save_cash_account",
    description: "\u65B0\u589E\u6216\u66F4\u65B0\u73B0\u91D1\u8D26\u6237\uFF08\u65F6\u70B9\u4F59\u989D\uFF0C\u8BA1\u5165\u603B\u8D44\u4EA7\u4E0E\u518D\u5E73\u8861\u5206\u6BCD\uFF09\u3002",
    inputSchema: {
      type: "object",
      properties: {
        id: str3("\u8D26\u6237 ID\uFF08\u4F20\u5165\u8868\u793A\u66F4\u65B0\uFF09"),
        name: str3("\u8D26\u6237\u540D\u79F0"),
        balance: str3("\u4F59\u989D"),
        currency: str3("\u5E01\u79CD\uFF0C\u9ED8\u8BA4 CNY"),
        note: str3("\u5907\u6CE8")
      },
      required: ["name"]
    },
    readOnly: false
  },
  {
    name: "save_rebalance_targets",
    description: "\u4FDD\u5B58\u518D\u5E73\u8861\u76EE\u6807\u6743\u91CD\uFF080\u20131 \u5C0F\u6570\uFF0C\u5408\u8BA1 \u2264 1\uFF09\u4E0E\u89E6\u53D1\u9608\u503C\u3002",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          description: '\u76EE\u6807\u6743\u91CD\u6570\u7EC4\uFF0C\u5982 [{"category":"stock","targetWeight":0.6}]',
          items: {
            type: "object",
            properties: { category: str3("stock / etf / fund / cash"), targetWeight: num3("0\u20131") },
            required: ["category", "targetWeight"]
          }
        },
        threshold: num3("\u504F\u79BB\u9608\u503C\uFF0C\u9ED8\u8BA4 0.05")
      },
      required: ["targets"]
    },
    readOnly: false
  }
];
var TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
var handle = null;
var handleError = null;
function ensureHandle() {
  if (handle) return handle;
  if (handleError) return null;
  try {
    handle = openState(resolveStateDirs());
    return handle;
  } catch (error) {
    handleError = error.message;
    return null;
  }
}
function makeContext(db) {
  return {
    handle: db,
    dirs: resolveStateDirs(),
    registry: createDefaultRegistry(),
    today: todayLocal(),
    hideAmount: false
  };
}
function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}
`);
}
function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}
`);
}
async function callTool(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new Error(`\u672A\u77E5\u5DE5\u5177\uFF1A${name}`);
  const db = ensureHandle();
  if (!db) throw new Error(`\u72B6\u6001\u5E93\u6253\u5F00\u5931\u8D25\uFF1A${handleError ?? "\u672A\u77E5\u539F\u56E0"}`);
  const result = await dispatch(makeContext(db), tool.rpc ?? tool.name, args);
  if (result.status !== 200) {
    throw new Error(`[${result.envelope.error?.code ?? "error"}] ${result.envelope.error?.message ?? "\u8C03\u7528\u5931\u8D25"}`);
  }
  return result.envelope.data;
}
async function handleMessage(message) {
  const id = message.id ?? null;
  const method = String(message.method ?? "");
  const params = message.params ?? {};
  if (message.id === void 0) {
    if (method === "notifications/initialized" || method === "notifications/cancelled") return;
    return;
  }
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: "\u4E2A\u4EBA\u6295\u8D44\u5DE5\u4F5C\u7AD9\u672C\u5730\u6570\u636E\uFF1A\u6301\u4ED3\u3001\u73B0\u91D1\u3001\u6307\u6570\u4F30\u503C\u3001\u98CE\u9669\u4E0E\u51B3\u7B56\u5C31\u7EEA\u5EA6\u3002\u6570\u636E\u6765\u81EA\u672C\u673A SQLite\uFF0C\u4E0D\u4E0A\u4F20\u4E91\u7AEF\u3002"
      });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, {
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          description: `${tool.description}${tool.readOnly ? "" : "\uFF08\u5199\u5165\u672C\u673A\u6570\u636E\u5E93\uFF09"}`,
          inputSchema: tool.inputSchema
        }))
      });
      return;
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = params.arguments ?? {};
      try {
        const data = await callTool(name, args);
        reply(id, { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false });
      } catch (error) {
        reply(id, { content: [{ type: "text", text: error.message }], isError: true });
      }
      return;
    }
    case "shutdown":
      reply(id, { ok: true });
      process.exit(0);
      return;
    default:
      replyError(id, -32601, `\u672A\u5B9E\u73B0\u7684\u65B9\u6CD5\uFF1A${method}`);
  }
}
var reader = createInterface({ input: process.stdin, terminal: false });
reader.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    replyError(null, -32700, "JSON \u89E3\u6790\u5931\u8D25");
    return;
  }
  void handleMessage(message).catch((error) => {
    replyError(message.id ?? null, -32603, error.message);
  });
});
reader.on("close", () => {
  if (handle) {
    try {
      handle.db.close();
    } catch {
    }
  }
  process.exit(0);
});
console.error(`[${SERVER_NAME}] MCP server ready \xB7 ${TOOLS.length} tools \xB7 state=${resolveStateDirs().data}`);
