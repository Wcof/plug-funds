/**
 * 策略模板与版本（PRD §4.6.7）：内置模板只读展示，用户编辑后生成新版本覆盖；
 * 自定义模板与全部历史版本都落在 SQLite，评分仍走 core/strategy.ts 的纯函数。
 */
import { BUILTIN_TEMPLATES, type StrategyMetricRule, type StrategyTemplate } from '../../../core/src/strategy.ts';
import type { DbHandle } from '../db.ts';
import { NotFoundError, ValidationError } from '../errors.ts';
import { newId, nowIso } from '../ids.ts';

interface TemplateRow {
  id: string;
  name: string;
  scope: string;
  origin: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  template_id: string;
  version: number;
  rules_json: string;
  note: string;
  created_at: string;
}

export interface StoredTemplate extends StrategyTemplate {
  origin: 'builtin' | 'custom';
  version: number;
  updatedAt: string | null;
  editable: boolean;
}

export interface TemplateVersion {
  templateId: string;
  version: number;
  rules: StrategyMetricRule[];
  note: string;
  createdAt: string;
  current: boolean;
}

export function validateRules(rules: unknown): StrategyMetricRule[] {
  if (!Array.isArray(rules) || rules.length === 0) throw new ValidationError('策略规则不能为空');
  const out: StrategyMetricRule[] = [];
  let weightSum = 0;
  for (const raw of rules) {
    const rule = raw as Partial<StrategyMetricRule>;
    if (!rule || typeof rule.key !== 'string' || rule.key.trim() === '') throw new ValidationError('规则缺少指标键');
    if (typeof rule.label !== 'string' || rule.label.trim() === '') throw new ValidationError(`规则 ${rule.key} 缺少名称`);
    const weight = Number(rule.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new ValidationError(`规则 ${rule.key} 权重必须在 0–100 之间`);
    if (rule.direction !== 'lower-better' && rule.direction !== 'higher-better') throw new ValidationError(`规则 ${rule.key} 方向不合法`);
    const favorableAt = Number(rule.favorableAt);
    const adverseAt = Number(rule.adverseAt);
    if (!Number.isFinite(favorableAt) || !Number.isFinite(adverseAt)) throw new ValidationError(`规则 ${rule.key} 阈值必须是数字`);
    if (rule.direction === 'lower-better' ? favorableAt >= adverseAt : favorableAt <= adverseAt) {
      throw new ValidationError(`规则 ${rule.key} 的优先线必须优于不利线`);
    }
    weightSum += weight;
    out.push({
      key: rule.key.trim(), label: rule.label.trim(), weight,
      direction: rule.direction, favorableAt, adverseAt, required: rule.required === true,
    });
  }
  if (Math.abs(weightSum - 100) > 0.001) throw new ValidationError(`权重合计必须为 100（当前 ${weightSum}）`);
  if (!out.some((r) => r.required)) throw new ValidationError('至少需要一条必需指标（缺失时不产生评分）');
  const keys = new Set(out.map((r) => r.key));
  if (keys.size !== out.length) throw new ValidationError('同一指标不能重复出现在规则中');
  return out;
}

function currentRules(handle: DbHandle, row: TemplateRow): StrategyMetricRule[] {
  const version = handle.db.prepare(
    'SELECT rules_json FROM strategy_versions WHERE template_id = ? AND version = ?',
  ).get(row.id, row.current_version) as { rules_json: string } | undefined;
  if (!version) return [];
  try {
    return validateRules(JSON.parse(version.rules_json) as unknown);
  } catch {
    return [];
  }
}

/** 内置模板 + 用户覆盖 + 自定义模板；覆盖时保留内置 id，评分与机会摘要无需改键。 */
export function listTemplates(handle: DbHandle): StoredTemplate[] {
  const rows = handle.db.prepare('SELECT * FROM strategy_templates ORDER BY created_at').all() as TemplateRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: StoredTemplate[] = BUILTIN_TEMPLATES.map((template) => {
    const row = byId.get(template.id);
    if (!row) {
      return { ...template, metrics: template.metrics, origin: 'builtin', version: 0, updatedAt: null, editable: true };
    }
    byId.delete(template.id);
    const rules = currentRules(handle, row);
    return {
      ...template,
      metrics: rules.length > 0 ? rules : template.metrics,
      origin: 'builtin', version: row.current_version, updatedAt: row.updated_at, editable: true,
    };
  });
  for (const row of byId.values()) {
    const rules = currentRules(handle, row);
    out.push({
      id: row.id, name: row.name, scope: row.scope, metrics: rules,
      origin: 'custom', version: row.current_version, updatedAt: row.updated_at, editable: true,
    });
  }
  return out;
}

/** 保存编辑 / 新建：每次保存生成一个不可变版本。 */
export function saveTemplate(
  handle: DbHandle,
  input: { id?: string; name: string; scope?: string; metrics: unknown; note?: string },
): StoredTemplate {
  const rules = validateRules(input.metrics);
  const name = String(input.name ?? '').trim();
  if (!name) throw new ValidationError('模板名称不能为空');
  const now = nowIso();
  const builtin = input.id ? BUILTIN_TEMPLATES.some((t) => t.id === input.id) : false;
  const id = input.id ?? newId();
  const existing = handle.db.prepare('SELECT * FROM strategy_templates WHERE id = ?').get(id) as TemplateRow | undefined;
  const version = (existing?.current_version ?? 0) + 1;

  handle.db.exec('BEGIN;');
  try {
    if (existing) {
      handle.db.prepare('UPDATE strategy_templates SET name = ?, scope = ?, current_version = ?, updated_at = ? WHERE id = ?')
        .run(name, input.scope ?? existing.scope, version, now, id);
    } else {
      handle.db.prepare('INSERT INTO strategy_templates (id, name, scope, origin, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, name, input.scope ?? '', builtin ? 'builtin' : 'custom', version, now, now);
    }
    handle.db.prepare('INSERT INTO strategy_versions (id, template_id, version, rules_json, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(newId(), id, version, JSON.stringify(rules), input.note ?? '', now);
    handle.db.exec('COMMIT;');
  } catch (error) {
    handle.db.exec('ROLLBACK;');
    throw error;
  }
  return listTemplates(handle).find((t) => t.id === id)!;
}

export function listVersions(handle: DbHandle, templateId: string): TemplateVersion[] {
  const current = handle.db.prepare('SELECT current_version FROM strategy_templates WHERE id = ?').get(templateId) as { current_version: number } | undefined;
  const rows = handle.db.prepare('SELECT * FROM strategy_versions WHERE template_id = ? ORDER BY version DESC').all(templateId) as VersionRow[];
  return rows.map((row) => ({
    templateId: row.template_id,
    version: row.version,
    rules: (() => { try { return JSON.parse(row.rules_json) as StrategyMetricRule[]; } catch { return []; } })(),
    note: row.note,
    createdAt: row.created_at,
    current: current?.current_version === row.version,
  }));
}

/** 回滚 = 把历史规则复制为一个新版本（不删除任何历史）。 */
export function restoreVersion(handle: DbHandle, templateId: string, version: number): StoredTemplate {
  const row = handle.db.prepare('SELECT * FROM strategy_versions WHERE template_id = ? AND version = ?')
    .get(templateId, version) as VersionRow | undefined;
  if (!row) throw new NotFoundError(`版本不存在：v${version}`);
  const template = listTemplates(handle).find((t) => t.id === templateId);
  if (!template) throw new NotFoundError(`模板不存在：${templateId}`);
  return saveTemplate(handle, {
    id: templateId, name: template.name, scope: template.scope,
    metrics: validateRules(JSON.parse(row.rules_json) as unknown),
    note: `回滚自 v${version}`,
  });
}
