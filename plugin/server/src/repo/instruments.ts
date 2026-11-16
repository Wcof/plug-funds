import type { Instrument, InstrumentType, Market } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

interface Row {
  id: string;
  code: string;
  name: string;
  type: string;
  market: string;
  currency: string;
  benchmark_index: string | null;
  secid: string | null;
  fund_code: string | null;
  tag: string;
  founded_date: string | null;
  scale_info: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function toInstrument(row: Row): Instrument {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type as InstrumentType,
    market: row.market as Market,
    currency: row.currency as Instrument['currency'],
    benchmarkIndex: row.benchmark_index,
    secid: row.secid,
    fundCode: row.fund_code,
    tag: row.tag,
    foundedDate: row.founded_date,
    scaleInfo: row.scale_info,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listInstruments(handle: DbHandle, opts: { active?: boolean; type?: InstrumentType } = {}): Instrument[] {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (opts.active !== undefined) {
    clauses.push('active = ?');
    args.push(opts.active ? 1 : 0);
  }
  if (opts.type) {
    clauses.push('type = ?');
    args.push(opts.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = handle.db.prepare(`SELECT * FROM instruments ${where} ORDER BY code`).all(...args) as Row[];
  return rows.map(toInstrument);
}

export function getInstrument(handle: DbHandle, id: string): Instrument | null {
  const row = handle.db.prepare('SELECT * FROM instruments WHERE id = ?').get(id) as Row | undefined;
  return row ? toInstrument(row) : null;
}

/** 代码 + 类型 + 市场联合唯一（PRD §4.3）。 */
export function findByCode(handle: DbHandle, code: string, type: InstrumentType, market: Market): Instrument | null {
  const row = handle.db
    .prepare('SELECT * FROM instruments WHERE code = ? AND type = ? AND market = ?')
    .get(code, type, market) as Row | undefined;
  return row ? toInstrument(row) : null;
}

export function searchInstruments(handle: DbHandle, keyword: string): Instrument[] {
  const kw = `%${keyword.trim()}%`;
  const rows = handle.db
    .prepare('SELECT * FROM instruments WHERE code LIKE ? OR name LIKE ? ORDER BY code LIMIT 50')
    .all(kw, kw) as Row[];
  return rows.map(toInstrument);
}

export interface InstrumentInput {
  id?: string;
  code: string;
  name: string;
  type: InstrumentType;
  market: Market;
  benchmarkIndex?: string | null;
  secid?: string | null;
  fundCode?: string | null;
  tag?: string;
  foundedDate?: string | null;
  scaleInfo?: string | null;
  active?: boolean;
}

export function saveInstrument(handle: DbHandle, input: InstrumentInput): Instrument {
  const now = nowIso();
  if (!/^\d{5,6}$/.test(input.code.trim())) {
    throw new Error(`invalid instrument code: ${input.code}`);
  }
  const code = input.code.trim();
  if (input.id) {
    const existing = getInstrument(handle, input.id);
    if (!existing) throw new Error(`instrument not found: ${input.id}`);
    handle.db
      .prepare(`UPDATE instruments SET name = ?, benchmark_index = ?, secid = ?, fund_code = ?, tag = ?, founded_date = ?, scale_info = ?, active = ?, updated_at = ? WHERE id = ?`)
      .run(input.name.trim(), input.benchmarkIndex ?? existing.benchmarkIndex, input.secid ?? existing.secid,
        input.fundCode ?? existing.fundCode, input.tag ?? existing.tag,
        input.foundedDate ?? existing.foundedDate, input.scaleInfo ?? existing.scaleInfo,
        (input.active ?? existing.active) ? 1 : 0, now, input.id);
    return getInstrument(handle, input.id)!;
  }
  const dup = findByCode(handle, code, input.type, input.market);
  if (dup) return dup; // 幂等：同 code+type+market 视为同一标的
  const id = newId();
  handle.db
    .prepare(`INSERT INTO instruments (id, code, name, type, market, currency, benchmark_index, secid, fund_code, tag, founded_date, scale_info, active, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, code, input.name.trim(), input.type, input.market, 'CNY',
      input.benchmarkIndex ?? null, input.secid ?? null, input.fundCode ?? null,
      input.tag ?? '', input.foundedDate ?? null, input.scaleInfo ?? null,
      (input.active ?? true) ? 1 : 0, now, now);
  return getInstrument(handle, id)!;
}
