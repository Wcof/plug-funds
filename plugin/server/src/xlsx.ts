/**
 * .xlsx 读取（自包含实现）：ZIP → sharedStrings + styles + 第一个工作表 → 表格。
 *
 * 为什么要自己写：插件是自包含 npm tarball，安装器不装依赖，index.js 只能依赖 node: 内置模块，
 * 因此不能引 xlsx / exceljs。这里只用 node:zlib 解 deflate，再按 OOXML 的最小必要子集解析。
 *
 * 能正确处理：
 * - 共享字符串（t="s"）与内联字符串（t="inlineStr" / t="str"）；
 * - 稀疏单元格（靠 r="C5" 定位列号，不按出现顺序硬排）；
 * - 日期序列号：按 styles.xml 的 numFmtId 判定是否日期格式，再转 YYYY-MM-DD（不把 45678 当金额）；
 * - XML 实体（&amp; / &#x...;）与富文本分段（多个 <t> 拼接）。
 *
 * 明确不做：公式计算（取缓存值 <v>）、合并单元格展开、多表合并、样式与图表。
 * 遇到读不懂的结构抛 ValidationError 并说明原因，不静默给出错行错列的数据。
 */
import { inflateRawSync } from 'node:zlib';
import { ValidationError } from './errors.ts';

export interface SheetTable {
  sheetName: string;
  header: string[];
  rows: string[][];
  /** 被跳过的空行数（尾部空行 / 全空行）。 */
  skippedRows: number;
}

/* ---------------- ZIP ---------------- */

interface ZipEntry { name: string; offset: number; compressedSize: number; method: number }

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new ValidationError('不是有效的 .xlsx（未找到 ZIP 目录）；如为 .xls 老格式请另存为 .xlsx');

  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CEN_SIG) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    entries.set(name, { name, offset, compressedSize, method });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  if (buffer.readUInt32LE(entry.offset) !== LOC_SIG) {
    throw new ValidationError(`xlsx 内文件损坏：${entry.name}`);
  }
  const nameLen = buffer.readUInt16LE(entry.offset + 26);
  const extraLen = buffer.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    try { return inflateRawSync(raw); } catch { throw new ValidationError(`xlsx 解压失败：${entry.name}`); }
  }
  throw new ValidationError(`不支持的 ZIP 压缩方式 ${entry.method}：${entry.name}`);
}

/* ---------------- XML 助手 ---------------- */

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (whole, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
  });
}

/** 取一段 XML 里所有 <t> 文本拼接（富文本会拆成多个 run）。 */
function joinText(xml: string): string {
  const parts: string[] = [];
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) parts.push(decodeXml(match[1]));
  return parts.join('');
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}="([^"]*)"`);
  const match = re.exec(tag);
  return match ? match[1] : null;
}

/** "AB12" → 27（0 基列号）。 */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/* ---------------- 数字 / 日期 ---------------- */

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
]);

/** 自定义格式里出现 y/m/d/h/s（且不含引号内的字面量）即视为日期时间。 */
function isDateFormatCode(code: string): boolean {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  return /[ymdhs]/i.test(stripped);
}

function excelSerialToDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2958465) return null;
  // Excel 以 1899-12-30 为 0（已包含 1900 闰年 bug 的补偿）。
  const ms = Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000);
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  if (y < 1900 || y > 2200) return null;
  return `${y}-${m}-${d}`;
}

function normalizeNumber(raw: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  // 避免 12.300000000000001 这类浮点尾巴：按 10 位有效小数收敛。
  return String(Math.round(value * 1e10) / 1e10);
}

/* ---------------- 主流程 ---------------- */

interface StyleInfo { dateStyleIndexes: Set<number> }

function readDateStyles(xml: string): StyleInfo {
  const customDateFormats = new Set<number>();
  const fmtRe = /<numFmt\b[^>]*\/?>/g;
  let fmtMatch: RegExpExecArray | null;
  while ((fmtMatch = fmtRe.exec(xml)) !== null) {
    const id = attr(fmtMatch[0], 'numFmtId');
    const code = attr(fmtMatch[0], 'formatCode');
    if (id !== null && code !== null && isDateFormatCode(decodeXml(code))) customDateFormats.add(Number(id));
  }

  const dateStyleIndexes = new Set<number>();
  const xfBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const xfRe = /<xf\b[^>]*\/?>/g;
  let index = 0;
  let xfMatch: RegExpExecArray | null;
  while ((xfMatch = xfRe.exec(xfBlock)) !== null) {
    const numFmtId = Number(attr(xfMatch[0], 'numFmtId') ?? '0');
    if (BUILTIN_DATE_FORMATS.has(numFmtId) || customDateFormats.has(numFmtId)) dateStyleIndexes.add(index);
    index += 1;
  }
  return { dateStyleIndexes };
}

function pickSheetPath(entries: Map<string, ZipEntry>): string {
  if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
  const candidates = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/sheet(\d+)/)?.[1]) - Number(b.match(/sheet(\d+)/)?.[1]));
  if (candidates.length === 0) throw new ValidationError('xlsx 内没有工作表');
  return candidates[0];
}

function readSharedStrings(xml: string): string[] {
  const items: string[] = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) items.push(joinText(match[1]));
  return items;
}

export function readXlsxFirstSheet(buffer: Buffer): SheetTable {
  const entries = readZipEntries(buffer);
  const shared = entries.has('xl/sharedStrings.xml')
    ? readSharedStrings(readEntry(buffer, entries.get('xl/sharedStrings.xml')!).toString('utf8'))
    : [];
  const styles = entries.has('xl/styles.xml')
    ? readDateStyles(readEntry(buffer, entries.get('xl/styles.xml')!).toString('utf8'))
    : { dateStyleIndexes: new Set<number>() };

  const sheetPath = pickSheetPath(entries);
  const sheetXml = readEntry(buffer, entries.get(sheetPath)!).toString('utf8');
  if (!/<sheetData/.test(sheetXml)) throw new ValidationError('工作表为空（没有 sheetData）');

  const grid: string[][] = [];
  const rowRe = /<row\b([^>]*?)(\/?)>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(sheetXml)) !== null) {
    const rowTag = rowMatch[1];
    const rowIndex = Number(attr(rowTag, 'r') ?? String(grid.length + 1)) - 1;
    const cells: string[] = [];
    // 先取 <row ...> 的行体（自闭合行没有行体），再在行体内逐格解析，避免把自闭合单元格误当开标签。
    let rowBody = '';
    if (rowMatch[2] !== '/') {
      const rowEnd = sheetXml.indexOf('</row>', rowRe.lastIndex);
      if (rowEnd >= 0) {
        rowBody = sheetXml.slice(rowRe.lastIndex, rowEnd);
        rowRe.lastIndex = rowEnd + '</row>'.length;
      }
    }
    const cellRe = /<c\b([^>]*?)(\/?)>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowBody)) !== null) {
      const tag = cellMatch[1];
      let body = '';
      if (cellMatch[2] !== '/') {
        const cellEnd = rowBody.indexOf('</c>', cellRe.lastIndex);
        if (cellEnd >= 0) {
          body = rowBody.slice(cellRe.lastIndex, cellEnd);
          cellRe.lastIndex = cellEnd + '</c>'.length;
        }
      }
      const ref = attr(tag, 'r') ?? '';
      const col = ref ? columnIndex(ref) : cells.length;
      const type = attr(tag, 't') ?? 'n';
      const styleIndex = attr(tag, 's') === null ? null : Number(attr(tag, 's'));

      let value = '';
      if (type === 's') {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        value = shared[Number(raw)] ?? '';
      } else if (type === 'inlineStr') {
        value = joinText(body);
      } else if (type === 'str' || type === 'e') {
        value = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else if (type === 'b') {
        value = (/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '') === '1' ? 'TRUE' : 'FALSE';
      } else {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        if (raw === '') value = '';
        else if (styleIndex !== null && styles.dateStyleIndexes.has(styleIndex)) {
          const asDate = excelSerialToDate(Number(raw));
          value = asDate ?? normalizeNumber(raw);
        } else value = normalizeNumber(raw);
      }
      while (cells.length < col) cells.push('');
      cells[col] = value.trim();
    }
    while (grid.length < rowIndex) grid.push([]);
    grid[rowIndex] = cells;
  }

  const nonEmpty = grid.filter((row) => row.some((cell) => cell !== ''));
  if (nonEmpty.length === 0) throw new ValidationError('工作表没有任何数据行');
  const header = nonEmpty[0].map((cell) => cell.trim());
  // 补齐到表头宽度：尾部缺列一律补空串，避免下游按索引取值拿到 undefined。
  const rows = nonEmpty.slice(1).map((row) => {
    const padded = [...row];
    while (padded.length < header.length) padded.push('');
    return padded;
  });
  return {
    sheetName: sheetPath,
    header,
    rows,
    skippedRows: grid.length - nonEmpty.length,
  };
}

/** 转成 CSV 文本，复用既有的 CSV 导入 / 校验 / 幂等链路。 */
export function sheetToCsv(table: SheetTable): string {
  const escape = (cell: string): string => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  const lines = [table.header.map(escape).join(',')];
  for (const row of table.rows) {
    const padded = [...row];
    while (padded.length < table.header.length) padded.push('');
    lines.push(padded.slice(0, table.header.length).map(escape).join(','));
  }
  return lines.join('\n');
}

/** base64 → xlsx → CSV（供 RPC 层直接调用）。 */
export function xlsxBase64ToCsv(base64: string): { csv: string; sheetName: string; rows: number; header: string[] } {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (cleaned === '') throw new ValidationError('xlsx 内容为空');
  let buffer: Buffer;
  try {
    buffer = Buffer.from(cleaned, 'base64');
  } catch {
    throw new ValidationError('xlsx base64 解码失败');
  }
  const table = readXlsxFirstSheet(buffer);
  return { csv: sheetToCsv(table), sheetName: table.sheetName, rows: table.rows.length, header: table.header };
}
