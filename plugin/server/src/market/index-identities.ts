/** 只有官方文件明确并列的同一指数代码才可映射；不按同名或近似价格推断。 */
export const CSINDEX_IDENTITIES: Readonly<Record<string, { officialCode: string; name: string; evidence: string; reason: string }>> = {
  '000974': { officialCode: 'H30086', name: '800金融',
    evidence: 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/H30086factsheet.pdf',
    reason: '官方单张指数代码 H30086，彭博代码 SH000974，名称为中证800金融指数' },
  '399903': { officialCode: '000903', name: '中证A100',
    evidence: 'https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/indices/detail/files/zh_CN/000903_Index_Methodology_cn.pdf',
    reason: '中证 A100 编制方案明确指数代码 000903/399903，两者为同一指数' },
};

export function csindexOfficialCode(code: string): string {
  return CSINDEX_IDENTITIES[code]?.officialCode ?? code;
}
