/**
 * 密钥存储回归：钥匙串不可用时必须显式退回 SQLite，并用 marker 语义保持「配置过」可判断。
 *
 * 测试统一禁用真钥匙串（PLUG_FUNDS_DISABLE_KEYCHAIN=1），避免往开发机 Keychain 写测试数据。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import { getSetting, setSetting, getAiSettings, saveAiSettings, migrateSecretsToKeychain } from '../server/src/repo/settings.ts';
import { KEYCHAIN_MARKER, currentSecretBackend, keychainAvailable } from '../server/src/secrets.ts';
import type { ServiceContext } from '../server/src/context.ts';

process.env.PLUG_FUNDS_DISABLE_KEYCHAIN = '1';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-secrets-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

test('禁用钥匙串时后端为 sqlite，Key 落库但出口始终脱敏', async () => {
  assert.equal(keychainAvailable(), false);
  assert.equal(currentSecretBackend(), 'sqlite');

  const saved = await rpc<{ configured: boolean; masked: { apiKey: string }; secretBackend: string }>('save_ai_settings', {
    baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdef123456', model: 'deepseek-chat',
  });
  assert.equal(saved.configured, true);
  assert.equal(saved.masked.apiKey, 'sk-****456');
  assert.equal(saved.secretBackend, 'sqlite');

  // 落库的仍是明文（无钥匙串可用），但任何 RPC 出口都不返回明文。
  const stored = getSetting(handle, 'ai_settings') as { apiKey: string };
  assert.equal(stored.apiKey, 'sk-abcdef123456');

  const status = await rpc<{ configured: boolean; masked: { apiKey: string }; secretBackend: string }>('get_ai_settings');
  assert.equal(status.configured, true);
  assert.equal(status.masked.apiKey, 'sk-****456');
  assert.equal(status.secretBackend, 'sqlite');
});

test('掩码形态回传不会覆盖真实 Key；空串表示未修改', async () => {
  await rpc('save_ai_settings', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdef123456', model: 'm1' });
  await rpc('save_ai_settings', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-****456', model: 'm2' });
  assert.equal(getAiSettings(handle).apiKey, 'sk-abcdef123456', '掩码回传必须被识别为「未修改」');

  await rpc('save_ai_settings', { apiKey: '', model: 'm3' });
  assert.equal(getAiSettings(handle).apiKey, 'sk-abcdef123456', '空串同样表示未修改');
});

test('库中存 marker 但钥匙串不可用 → Key 视为缺失，不伪造', () => {
  // 直接写一条带 marker 的设置，模拟「在别的机器上打开同一份库」。
  setSetting(handle, 'ai_settings', {
    baseUrl: 'https://api.example.com/v1', apiKey: KEYCHAIN_MARKER, model: 'm1', enabled: true,
  });
  assert.equal(getAiSettings(handle).apiKey, '');
});

test('saveAiSettings 在无钥匙串时不写 marker，避免留下读不回的悬空标记', () => {
  const next = saveAiSettings(handle, { baseUrl: 'https://x/v1', apiKey: 'sk-plain-123456', model: 'm' });
  assert.equal(next.apiKey, 'sk-plain-123456');
  const stored = getSetting(handle, 'ai_settings') as { apiKey: string };
  assert.notEqual(stored.apiKey, KEYCHAIN_MARKER);
});

test('迁移函数在无钥匙串时不动数据并如实上报后端', async () => {
  await rpc('save_ai_settings', { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abcdef123456', model: 'm1' });
  const result = migrateSecretsToKeychain(handle);
  assert.equal(result.migrated, false);
  assert.equal(result.backend, 'sqlite');
  const stored = getSetting(handle, 'ai_settings') as { apiKey: string };
  assert.equal(stored.apiKey, 'sk-abcdef123456');
});

test('get_app_info 暴露 secretBackend，供设置页如实提示', async () => {
  const info = await rpc<{ secretBackend: string }>('get_app_info');
  assert.equal(info.secretBackend, 'sqlite');
});
