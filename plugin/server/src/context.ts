import type { StateDirs, DbHandle } from './db.ts';
import type { ProviderRegistry } from './market/provider.ts';

export interface ServiceContext {
  handle: DbHandle;
  dirs: StateDirs;
  registry: ProviderRegistry;
  /** 可注入的「今天」，隔离测试用；默认本地日期。 */
  today: string;
  /** 金额掩码（DASH-12）由 API 层统一应用。 */
  hideAmount: boolean;
}
