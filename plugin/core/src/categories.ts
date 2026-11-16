/**
 * 自定义分类（PRD §4.10）：仅「名称 + 颜色」，可选、默认不勾选、非必填。
 */
import type { Category, CategoryLink } from './types.ts';

export class CategoryError extends Error {
  override name = 'CategoryError';
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function normalizeCategoryName(name: string): string {
  const trimmed = String(name).trim();
  if (!trimmed) throw new CategoryError('name-required', '分类名称不能为空');
  if (trimmed.length > 30) throw new CategoryError('name-too-long', '分类名称不能超过 30 个字符');
  return trimmed;
}

export function normalizeCategoryColor(color: string): string {
  const value = String(color).trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(value)) {
    throw new CategoryError('color-invalid', '颜色必须是 #RRGGBB 格式');
  }
  return value;
}

/** 计数展示「名称（N）」。 */
export function categoryCountLabel(category: Category, links: CategoryLink[]): string {
  const count = links.filter((l) => l.categoryId === category.id).length;
  return `${category.name}（${count}）`;
}

/** 资产的分类标签（最多 max 个，超出返回 +N）。 */
export function categoryChipsFor(
  links: CategoryLink[],
  categories: Category[],
  instrumentId: string,
  max = 2,
): { names: string[]; colors: string[]; more: number } {
  const ids = links.filter((l) => l.instrumentId === instrumentId).map((l) => l.categoryId);
  const picked = ids
    .map((id) => categories.find((c) => c.id === id))
    .filter((c): c is Category => Boolean(c))
    .slice(0, max);
  return {
    names: picked.map((c) => c.name),
    colors: picked.map((c) => c.color),
    more: Math.max(ids.length - max, 0),
  };
}
