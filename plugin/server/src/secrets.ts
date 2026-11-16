/**
 * API Key 的系统钥匙串存储（macOS Keychain / Linux secret-tool / Windows cmdkey 不做，
 * 只用能可靠读回明文的那两种：macOS security、Linux secret-tool）。
 *
 * 为什么需要：以前的 Key 明文躺在 invest.db 的 app_settings 里，任何能读这个文件的进程都能拿走。
 * 现在优先写系统钥匙串，SQLite 只留一个哨兵值 KEYCHAIN_MARKER，便于「是否配置过」这类判断。
 *
 * 降级策略是显式的：
 * - 平台不支持 / 命令不存在 / 调用失败 → 回退 SQLite 明文，并通过 backend 字段如实告知前端；
 * - 绝不静默「以为存进钥匙串了，其实没存」。
 */
import { execFileSync } from 'node:child_process';

export const KEYCHAIN_MARKER = '__keychain__';
const SERVICE = 'plug-funds';
const ACCOUNT = 'ai-api-key';

export type SecretBackend = 'keychain' | 'sqlite';

let probe: boolean | null = null;

function disabledByEnv(): boolean {
  const flag = process.env.PLUG_FUNDS_DISABLE_KEYCHAIN;
  return flag === '1' || flag === 'true';
}

function run(args: string[], input?: string): string | null {
  try {
    return execFileSync(args[0], args.slice(1), {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

/** 钥匙串是否可用：探测一次就缓存（避免每次读设置都起子进程）。 */
export function keychainAvailable(): boolean {
  if (disabledByEnv()) return false;
  if (probe !== null) return probe;
  if (process.platform === 'darwin') {
    probe = run(['/usr/bin/security', 'list-keychains']) !== null;
  } else if (process.platform === 'linux') {
    probe = run(['secret-tool', '--version']) !== null;
  } else {
    probe = false;
  }
  return probe;
}

export function currentSecretBackend(): SecretBackend {
  return keychainAvailable() ? 'keychain' : 'sqlite';
}

export function readKeychain(): string | null {
  if (!keychainAvailable()) return null;
  if (process.platform === 'darwin') {
    const value = run(['/usr/bin/security', 'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    return value === null || value === '' ? null : value;
  }
  const value = run(['secret-tool', 'lookup', 'service', SERVICE, 'account', ACCOUNT]);
  return value === null || value === '' ? null : value;
}

export function writeKeychain(value: string): boolean {
  if (!keychainAvailable()) return false;
  if (process.platform === 'darwin') {
    // -U 表示已存在则更新；-w 后面跟值。值通过参数传递，不进 shell，避免转义问题。
    return run(['/usr/bin/security', 'add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', value]) !== null;
  }
  if (process.platform === 'linux') {
    return run(['secret-tool', 'store', '--label', 'plug-funds AI key', 'service', SERVICE, 'account', ACCOUNT], value) !== null;
  }
  return false;
}

export function deleteKeychain(): boolean {
  if (!keychainAvailable()) return false;
  if (process.platform === 'darwin') {
    return run(['/usr/bin/security', 'delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]) !== null;
  }
  if (process.platform === 'linux') {
    return run(['secret-tool', 'clear', 'service', SERVICE, 'account', ACCOUNT]) !== null;
  }
  return false;
}
