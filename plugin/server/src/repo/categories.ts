import type { Category, CategoryLink } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';

interface Row {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}

function toCategory(row: Row): Category {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order, createdAt: row.created_at };
}

export function listCategories(handle: DbHandle): Category[] {
  const rows = handle.db.prepare('SELECT * FROM categories ORDER BY sort_order, created_at').all() as Row[];
  return rows.map(toCategory);
}

export interface CategoryInput {
  id?: string;
  name: string;
  color: string;
}

export function saveCategory(handle: DbHandle, input: CategoryInput): Category {
  if (input.id) {
    const existing = handle.db.prepare('SELECT * FROM categories WHERE id = ?').get(input.id) as Row | undefined;
    if (!existing) throw new Error(`category not found: ${input.id}`);
    handle.db.prepare('UPDATE categories SET name = ?, color = ? WHERE id = ?')
      .run(input.name.trim(), input.color, input.id);
    return toCategory(handle.db.prepare('SELECT * FROM categories WHERE id = ?').get(input.id) as Row);
  }
  const dup = handle.db.prepare('SELECT id FROM categories WHERE name = ?').get(input.name.trim());
  if (dup) throw new Error('同名分类已存在');
  const id = newId();
  const maxRow = handle.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM categories').get() as { next: number };
  handle.db.prepare('INSERT INTO categories (id, name, color, sort_order, created_at) VALUES (?,?,?,?,?)')
    .run(id, input.name.trim(), input.color, maxRow.next, nowIso());
  return toCategory(handle.db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as Row);
}

/** 删除分类只解除关联，不影响资产（PRD §4.10）。 */
export function deleteCategory(handle: DbHandle, id: string): boolean {
  handle.db.prepare('DELETE FROM instrument_category_links WHERE category_id = ?').run(id);
  const result = handle.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  return Number(result.changes ?? 0) > 0;
}

export function listLinks(handle: DbHandle): CategoryLink[] {
  const rows = handle.db.prepare('SELECT instrument_id, category_id FROM instrument_category_links').all() as
    { instrument_id: string; category_id: string }[];
  return rows.map((r) => ({ instrumentId: r.instrument_id, categoryId: r.category_id }));
}

/** 设置资产分类（全量替换该资产的关联；空数组 = 未分类）。 */
export function setInstrumentCategories(handle: DbHandle, instrumentId: string, categoryIds: string[]): void {
  const tx = handle.db;
  tx.prepare('DELETE FROM instrument_category_links WHERE instrument_id = ?').run(instrumentId);
  const insert = tx.prepare('INSERT OR IGNORE INTO instrument_category_links (instrument_id, category_id) VALUES (?,?)');
  for (const categoryId of categoryIds) insert.run(instrumentId, categoryId);
}
