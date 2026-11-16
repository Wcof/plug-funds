/** 指数的样本资产类别与计价币；保留官方字段，不按名称或代码前缀猜测。 */
import { csindexOfficialCode } from './index-identities.ts';

export interface IndexProfile {
  assetClass: 'EQUITY' | 'BOND' | 'FUND' | 'UNKNOWN';
  provider: 'csindex' | 'cnindex';
  classification: { field: string; value: string | null; reason: string };
  currency: 'CNY' | 'USD' | 'HKD' | null;
  currencyReason: string;
  evidence?: { url: string; sha256: string; observedDate: string };
}

export function parseIndexProfile(payload: any, provider: 'csindex' | 'cnindex', code: string): IndexProfile {
  if (!payload || String(payload.code) !== '200' || !payload.data || typeof payload.data !== 'object') throw new Error('官方指数分类资料无效');
  const data = payload.data;
  let assetClass: IndexProfile['assetClass'] = 'UNKNOWN';
  let currency: IndexProfile['currency'] = null;
  const field = provider === 'csindex' ? 'indexType' : 'xyfw';
  const value = typeof data[field] === 'string' ? data[field] : null;
  if (provider === 'csindex') {
    if (data.indexCode !== csindexOfficialCode(code)) throw new Error('中证分类资料指数代码不匹配');
    if (value === 'stock') assetClass = 'EQUITY';
    if (value === 'bond') assetClass = 'BOND';
    if (value === 'other' && typeof data.indexCnDesc === 'string' && /成[份分]股是所有.*上市的证券投资基金/.test(data.indexCnDesc)) assetClass = 'FUND';
    const names = { CNY: '人民币', USD: '美元', HKD: '港币' };
    if (typeof data.currencyEn === 'string' && Object.hasOwn(names, data.currencyEn)) {
      currency = data.currencyEn;
      if (data.currencyCn && data.currencyCn !== names[currency!]) throw new Error('官方中英文计价币不一致');
    }
  } else {
    // cnintro 本身无代码字段，调用方必须先用完整官方目录与请求 URL 核验代码身份。
    if (['深市债券', '深市可转债', '境内证券交易所可转债'].includes(value ?? '')) assetClass = 'BOND';
    else if (['深市上市基金', '深市上市ETF', '沪深上市基金', '沪深上市ETF'].includes(value ?? '')) assetClass = 'FUND';
    else if (['深市A股', '深市B股', '深市AB股', '深沪B股', '深沪京A股', '深市原中小板市场', '深市创业板市场', '深市主板',
      '深市原中小板和创业板市场', 'A股和红筹企业发行的存托凭证', '深沪京A股和红筹企业发行的存托凭证'].includes(value ?? '')) assetClass = 'EQUITY';
  }
  const label = { EQUITY: '股票', BOND: '债券', FUND: '基金', UNKNOWN: '未确认' }[assetClass];
  return { assetClass, provider, classification: { field, value,
    reason: assetClass === 'UNKNOWN' ? '官方类型或样本范围不足以确定资产类别，不能按名称猜测'
      : `官方 ${field}=${value}${assetClass === 'FUND' && provider === 'csindex' ? '，样本说明明确为上市证券投资基金' : ''}，确认属于${label}指数` },
    currency, currencyReason: currency ? `同码中证基本资料 currencyEn=${currency}；指数点位计价币，不是账本金额币种`
      : '本次官方基本资料未明确提供已核实计价币，不能用账本默认 CNY 代替' };
}

export function indexMetricApplicability(profile: IndexProfile | null | undefined, key: string) {
  if (!profile || !['BOND', 'FUND'].includes(profile.assetClass) || !/^(?:pe|pb|ps|roe)(?:_|$)/.test(key)) return null;
  return { state: 'NOT_APPLICABLE' as const,
    reason: `${profile.classification.reason}；本项目直接股票估值口径的 ${key.toUpperCase()} 不适用。原始观测留档；基金穿透估值需要另行核实成分资产和聚合方法` };
}
