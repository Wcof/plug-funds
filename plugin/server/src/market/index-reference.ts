/** 官方参考资料纯解析。日期、产品分类和资料缺项均保留明确含义。 */
export interface ReferenceStatus { state: 'VALID' | 'MISSING' | 'STALE' | 'SUSPECT' | 'CONFLICT'; reason: string | null }
export interface FundReference {
  on: number | null;
  off: number | null;
  total: number;
  unclassified: number;
  excluded: number;
  sourceDate: string | null;
  observedDate: string;
  provider: string;
  status: ReferenceStatus;
  note: string;
}
export interface IndexReference {
  code: string;
  provider: string;
  observedDate: string;
  publishDate: string | null;
  publishStatus: ReferenceStatus;
  funds: FundReference | null;
  unavailable: Record<string, string>;
  evidence: { url: string; sha256: string }[];
}

export function validReferenceDate(value: unknown, today: string): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function parsePublishDate(payload: any, provider: 'csindex' | 'cnindex', code: string, today: string): string | null {
  if (!payload || String(payload.code) !== '200') throw new Error('官方基本资料返回失败');
  if (!payload.data) return null;
  if (provider === 'csindex' && payload.data.indexCode !== code) throw new Error('中证基本资料指数代码不匹配');
  const date = provider === 'cnindex' ? payload.data.fbrq : payload.data.publishDate;
  if (date == null || date === '') return null;
  if (!validReferenceDate(date, today)) throw new Error('官方发布日期非法或在未来');
  return date;
}

/** 按官方目录中的境内产品代码计数，A/C 份额不推断合并，境外产品排除并列出数量。 */
export function parseFundReference(payload: any, provider: 'csindex' | 'cnindex', code: string, observedDate: string): FundReference {
  if (!payload || String(payload.code) !== '200') throw new Error('官方关联产品返回失败');
  const rows = provider === 'cnindex' ? payload.data?.rows : payload.data;
  if (!Array.isArray(rows)) throw new Error('官方关联产品列表无效');
  if (provider === 'cnindex' && (!Number.isSafeInteger(payload.data.total) || payload.data.total !== rows.length)) {
    throw new Error('国证关联产品分页不完整');
  }
  const sourceDate = provider === 'cnindex' && validReferenceDate(payload.data.msg, observedDate) ? payload.data.msg : null;
  const seen = new Set<string>();
  let on = 0, off = 0, excluded = 0, unclassified = 0;
  for (const row of rows) {
    const indexCode = provider === 'cnindex' ? row.fundIndexCode : row.indexCode;
    if (indexCode !== code && indexCode !== `${code}.SZ`) throw new Error('官方关联产品跟踪指数不匹配');
    const productCode = provider === 'cnindex' ? row.fundCode : row.productCode;
    if (typeof productCode !== 'string' || !productCode.trim() || seen.has(productCode)) throw new Error('关联产品代码缺失或重复，不能确定计数口径');
    if (/^399\d{3}$/.test(productCode)) throw new Error('关联产品代码落入深市指数代码段，官方原文疑似错码，暂不采用计数');
    seen.add(productCode);
    if (provider === 'csindex' && row.coverage !== '境内') { excluded++; continue; }
    const exchange = provider === 'cnindex' ? row.foundLocation : row.exchange;
    const type = row.fundType;
    if (exchange === '上海证券交易所' || exchange === '深圳证券交易所' || exchange === '北京证券交易所') on++;
    else if ((exchange == null || exchange === '-' || exchange === '')
      && ['指数基金', 'ETF联接', '联接基金', '指数增强', '增强指数基金', '指数增强基金'].includes(type)) off++;
    else unclassified++;
  }
  const age = sourceDate ? (Date.parse(observedDate) - Date.parse(sourceDate)) / 86400000 : null;
  const status: ReferenceStatus = unclassified > 0
    ? { state: 'SUSPECT', reason: `${unclassified} 个产品无法据目录确认场内/场外分类，两个计数保持缺失` }
    : sourceDate && age! > 7 ? { state: 'STALE', reason: `官方目录统计日期 ${sourceDate}，并非当日全市场产品数` }
      : !sourceDate ? { state: 'SUSPECT', reason: '官方关联目录未提供统计日期；仅表示本次观察到的产品记录数' }
        : { state: 'VALID', reason: null };
  return { on: unclassified ? null : on, off: unclassified ? null : off, total: rows.length,
    unclassified, excluded, sourceDate, observedDate, provider, status,
    note: '仅统计官方关联目录列出的境内产品代码；有明确上市交易所归场内，未上市的指数/联接基金归场外。A/C 份额不推断合并；空目录只表示该目录列出 0 条，不证明全市场无基金。' };
}

/** PDF 文本仅接受身份、日期、人民币及计算用股本口径均可核实的单张。 */
export function parseCsindexFactsheet(text: string, code: string, today: string) {
  const match = text.match(/^(?:\s*)(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const date = match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : null;
  if (!date || !validReferenceDate(date, today)) throw new Error('中证单张缺少合法原始日期');
  const identity = /指数代码\s+(\d{6})(?!\d)/.exec(text)?.[1];
  if (identity !== code) throw new Error('中证单张指数代码不匹配');
  if (!/货币\s+人民币/.test(text)) throw new Error('中证单张货币不是已核实的人民币口径');
  if (!/指数指标均采用个股[“"]计算用股本[”"]计算得出/.test(text)) throw new Error('中证单张未说明计算用股本口径');
  const number = (label: string, zero = false) => {
    const matches = [...text.matchAll(new RegExp(`${label}[ \\t]+([+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+))(?:%|[ \\t]*\\n|$)`, 'g'))];
    if (matches.length === 0) return null;
    if (matches.length !== 1) throw new Error(`中证单张 ${label} 数值存在歧义`);
    const n = Number(matches[0][1]);
    if (!Number.isFinite(n) || (zero ? n < 0 : n <= 0)) throw new Error(`中证单张 ${label} 数值无效`);
    return n;
  };
  const published = /发布日期\s+(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  const publishDate = published ? `${published[1]}-${published[2].padStart(2, '0')}-${published[3].padStart(2, '0')}` : null;
  if (publishDate && !validReferenceDate(publishDate, today)) throw new Error('中证单张发布日期无效');
  return { code, date, publishDate, pb: number('市净率'), pe: number('滚动市盈率'), dividendYield: number('股息率', true),
    quality: (Date.parse(today) - Date.parse(date)) / 86400000 > 7 ? 'STALE' as const : 'FRESH' as const };
}
