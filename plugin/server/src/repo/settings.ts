import type { AiAnalysisRecord, AiSettings } from '../../../core/src/types.ts';
import type { DbHandle } from '../db.ts';
import { newId, nowIso } from '../ids.ts';
import {
  KEYCHAIN_MARKER, currentSecretBackend, keychainAvailable, readKeychain, writeKeychain,
} from '../secrets.ts';

export function getSetting(handle: DbHandle, key: string): unknown | null {
  const row = handle.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

export function setSetting(handle: DbHandle, key: string, value: unknown): void {
  handle.db
    .prepare(`INSERT INTO app_settings (key, value_json, updated_at) VALUES (?,?,?)
              ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), nowIso());
}

/* ---------------- AI 设置（PRD §4.11） ---------------- */

const AI_KEY = 'ai_settings';

const DEFAULT_AI: AiSettings = { baseUrl: '', apiKey: '', model: '', enabled: false };

export function getAiSettings(handle: DbHandle): AiSettings {
  const stored = getSetting(handle, AI_KEY) as Partial<AiSettings> | null;
  const merged: AiSettings = { ...DEFAULT_AI, ...(stored ?? {}) };
  // 哨兵值 / 空值都表示「Key 在钥匙串里」，需要实时读回；老库里的明文按原样返回。
  if (merged.apiKey === KEYCHAIN_MARKER || merged.apiKey === '') {
    merged.apiKey = readKeychain() ?? '';
  }
  return merged;
}

/** Key 任何出口都脱敏：仅保留前后 3 位提示，不返回完整明文。 */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}****${key.slice(-3)}`;
}

export function saveAiSettings(handle: DbHandle, input: Partial<AiSettings>): AiSettings {
  const current = getAiSettings(handle);
  // 空字符串 / 掩码形态表示「未修改」，保留原值（与旧行为一致）。
  const provided = input.apiKey !== undefined && input.apiKey !== '' && !input.apiKey.includes('****');
  const baseUrl = (input.baseUrl ?? current.baseUrl).trim();
  const model = (input.model ?? current.model).trim();
  const apiKey = provided ? (input.apiKey as string) : current.apiKey;
  const next: AiSettings = {
    baseUrl,
    apiKey,
    model,
    enabled: input.enabled ?? (baseUrl !== '' && apiKey !== '' && model !== ''),
  };

  // 能进钥匙串就只存哨兵值；不能则退回明文，并由 currentSecretBackend 如实上报。
  let stored = apiKey;
  if (apiKey !== '' && keychainAvailable() && (readKeychain() === apiKey || writeKeychain(apiKey))) {
    stored = KEYCHAIN_MARKER;
  }
  setSetting(handle, AI_KEY, { ...next, apiKey: stored });
  return next;
}

/**
 * 迁移：把老库里明文的 apiKey 搬到钥匙串，SQLite 只留哨兵值。
 * 在宿主启动时调用一次；失败不影响启动（下次再试）。
 */
export function migrateSecretsToKeychain(handle: DbHandle): { migrated: boolean; backend: ReturnType<typeof currentSecretBackend> } {
  const backend = currentSecretBackend();
  if (backend !== 'keychain') return { migrated: false, backend };
  const stored = getSetting(handle, AI_KEY) as Partial<AiSettings> | null;
  const apiKey = stored?.apiKey ?? '';
  if (apiKey === '' || apiKey === KEYCHAIN_MARKER) return { migrated: false, backend };
  if (!writeKeychain(apiKey)) return { migrated: false, backend };
  setSetting(handle, AI_KEY, { ...stored, apiKey: KEYCHAIN_MARKER });
  return { migrated: true, backend };
}

/* ---------------- AI 分析记录 ---------------- */

interface RecordRow {
  id: string;
  instrument_id: string;
  model: string;
  source: string;
  prompt_scope: string;
  result: string;
  created_at: string;
}

function toRecord(row: RecordRow): AiAnalysisRecord {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    model: row.model,
    source: row.source as AiAnalysisRecord['source'],
    promptScope: row.prompt_scope,
    result: row.result,
    createdAt: row.created_at,
  };
}

export function saveAiRecord(handle: DbHandle, record: Omit<AiAnalysisRecord, 'id' | 'createdAt'>): AiAnalysisRecord {
  const id = newId();
  handle.db
    .prepare('INSERT INTO ai_analysis_records (id, instrument_id, model, source, prompt_scope, result, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, record.instrumentId, record.model, record.source, record.promptScope, record.result, nowIso());
  const row = handle.db.prepare('SELECT * FROM ai_analysis_records WHERE id = ?').get(id) as RecordRow;
  return toRecord(row);
}

export function listAiRecords(handle: DbHandle, instrumentId?: string): AiAnalysisRecord[] {
  const rows = (instrumentId
    ? handle.db.prepare('SELECT * FROM ai_analysis_records WHERE instrument_id = ? ORDER BY created_at DESC LIMIT 50').all(instrumentId)
    : handle.db.prepare('SELECT * FROM ai_analysis_records ORDER BY created_at DESC LIMIT 50').all()) as RecordRow[];
  return rows.map(toRecord);
}
