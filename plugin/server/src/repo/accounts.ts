import type { Account } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

interface Row {
  id: string;
  name: string;
  platform: string;
  currency: string;
  status: string;
  note: string;
  created_at: string;
  updated_at: string;
}

function toAccount(row: Row): Account {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    currency: row.currency as Account['currency'],
    status: row.status as Account['status'],
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAccounts(handle: DbHandle, status?: 'ACTIVE' | 'ARCHIVED'): Account[] {
  const rows = (status
    ? handle.db.prepare('SELECT * FROM accounts WHERE status = ? ORDER BY created_at').all(status)
    : handle.db.prepare('SELECT * FROM accounts ORDER BY created_at').all()) as Row[];
  return rows.map(toAccount);
}

export function getAccount(handle: DbHandle, id: string): Account | null {
  const row = handle.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
  return row ? toAccount(row) : null;
}

export interface AccountInput {
  id?: string;
  name: string;
  platform?: string;
  note?: string;
  status?: Account['status'];
}

export function saveAccount(handle: DbHandle, input: AccountInput): Account {
  const now = nowIso();
  if (input.id) {
    const existing = getAccount(handle, input.id);
    if (!existing) throw new Error(`account not found: ${input.id}`);
    handle.db
      .prepare('UPDATE accounts SET name = ?, platform = ?, note = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(input.name.trim(), input.platform ?? existing.platform, input.note ?? existing.note,
        input.status ?? existing.status, now, input.id);
    return getAccount(handle, input.id)!;
  }
  const id = newId();
  handle.db
    .prepare('INSERT INTO accounts (id, name, platform, currency, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, input.name.trim(), input.platform ?? '', 'CNY', input.status ?? 'ACTIVE', input.note ?? '', now, now);
  return getAccount(handle, id)!;
}

/** 归档而非物理删除（PRD §4.2：有流水的账户用归档）。 */
export function archiveAccount(handle: DbHandle, id: string): Account {
  const existing = getAccount(handle, id);
  if (!existing) throw new Error(`account not found: ${id}`);
  handle.db.prepare('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?')
    .run('ARCHIVED', nowIso(), id);
  return getAccount(handle, id)!;
}
