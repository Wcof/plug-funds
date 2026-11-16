import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  categoryChipsFor,
  categoryCountLabel,
  normalizeCategoryColor,
  normalizeCategoryName,
} from '../core/src/categories.ts';
import type { Category, CategoryLink } from '../core/src/types.ts';

const cats: Category[] = [
  { id: 'c1', name: '长期核心', color: '#3d6ef2', sortOrder: 0, createdAt: '2026-11-15T00:00:00Z' },
  { id: 'c2', name: '红利收息', color: '#0e9f6e', sortOrder: 1, createdAt: '2026-11-15T00:00:00Z' },
];
const links: CategoryLink[] = [
  { instrumentId: 'a', categoryId: 'c1' },
  { instrumentId: 'a', categoryId: 'c2' },
  { instrumentId: 'b', categoryId: 'c1' },
];

test('名称归一化：trim、非空、长度上限', () => {
  assert.equal(normalizeCategoryName('  卫星仓 '), '卫星仓');
  assert.throws(() => normalizeCategoryName('   '), (e: Error) => (e as { code?: string }).code === 'name-required');
  assert.throws(() => normalizeCategoryName('x'.repeat(31)), (e: Error) => (e as { code?: string }).code === 'name-too-long');
});

test('颜色归一化：仅 #RRGGBB', () => {
  assert.equal(normalizeCategoryColor('#3D6EF2'), '#3d6ef2');
  assert.throws(() => normalizeCategoryColor('red'), (e: Error) => (e as { code?: string }).code === 'color-invalid');
  assert.throws(() => normalizeCategoryColor('#12345'), (e: Error) => (e as { code?: string }).code === 'color-invalid');
});

test('计数标签：名称（N）', () => {
  assert.equal(categoryCountLabel(cats[0], links), '长期核心（2）');
  assert.equal(categoryCountLabel(cats[1], links), '红利收息（1）');
});

test('资产分类标签：最多 max 个 + 溢出计数', () => {
  const a = categoryChipsFor(links, cats, 'a', 2);
  assert.deepEqual(a.names, ['长期核心', '红利收息']);
  assert.equal(a.more, 0);
  const b = categoryChipsFor(links, cats, 'b', 1);
  assert.deepEqual(b.names, ['长期核心']);
  assert.equal(b.more, 0);
  // 溢出：三个分类只显示前两个
  const overflowLinks: CategoryLink[] = [
    { instrumentId: 'c', categoryId: 'c1' },
    { instrumentId: 'c', categoryId: 'c2' },
    { instrumentId: 'c', categoryId: 'c3' },
  ];
  const c3: Category = { ...cats[0], id: 'c3', name: '卫星仓' };
  const c = categoryChipsFor(overflowLinks, [...cats, c3], 'c', 2);
  assert.deepEqual(c.names, ['长期核心', '红利收息']);
  assert.equal(c.more, 1);
  assert.deepEqual(categoryChipsFor(links, cats, 'unknown', 2), { names: [], colors: [], more: 0 });
});
