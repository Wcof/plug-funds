import type { DbHandle } from '../db.ts';
import type { IndexReference } from '../market/index-reference.ts';
import { getSetting, setSetting } from './settings.ts';

const prefix = 'index_reference:';
export function getIndexReference(handle: DbHandle, instrumentId: string): IndexReference | null {
  const value = getSetting(handle, `${prefix}${instrumentId}`) as IndexReference | null;
  return value && typeof value.code === 'string' && typeof value.observedDate === 'string' ? value : null;
}
export function saveIndexReference(handle: DbHandle, instrumentId: string, value: IndexReference): void {
  setSetting(handle, `${prefix}${instrumentId}`, value);
}
