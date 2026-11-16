/**
 * 中证指数官网指数估值（官方口径）适配器。
 *
 * 为什么需要它：
 * - 腾讯 / 东财的指数报价只给 PE，没有 PB、更没有股息率；红利类模板 25% 权重压在股息率上，
 *   没有官方口径就只能显示「数据不足」；
 * - 中证指数有限公司（csindex.com.cn）按日发布《指数估值》xls，字段为
 *   市盈率1（总股本）/ 市盈率2（计算用股本）/ 股息率1（总股本）/ 股息率2（计算用股本），
 *   是这套指标唯一的官方来源，且两种口径都给出，可直接标注而不是猜。
 *
 * 纪律：
 * - 只解析文件里真实存在的列，不推算、不补零；
 * - **不覆盖报价端口径的 `pe`**：中证 PE2（计算用股本）与腾讯 / 东财的 TTM 实测差 2%–19%，
 *   直接顶替会让历史分位与横向比较静默跳变。官方值单独落 `pe_official`（PE2）与
 *   `pe_official_total_share`（PE1），由核查脚本并列展示；
 * - `dividend_yield` 是唯一能拿到的真实来源（报价端不提供），作为主值写入；
 * - 只覆盖中证 / 上证系列；深证成指、创业板指等国证系列返回 404 → 空数组，
 *   由上层如实标注「数据源未覆盖」，不得用别的指数代替；
 * - 文件是 20 个交易日的滚动窗口：每天可取，但想要长周期分位必须逐日累积，
 *   因此这里逐日写入 metric 历史，而不是只写当天一行。
 */
import type { Instrument } from '../../../core/src/types.ts';
import type { MarketPoint } from '../../../core/src/types.ts';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const TIMEOUT_MS = 15_000;
const MIN_INTERVAL_MS = 250;

let lastRequestAt = 0;
/** 403 = 命中 OSS 的 WAF 限流；退避期内直接跳过，避免越刷越封。 */
let blockedUntil = 0;
const BLOCK_BACKOFF_MS = 10 * 60 * 1000;

async function paced(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
}

export function csindexIndicatorUrl(code: string): string {
  return `https://oss-ch.csindex.com.cn/static/html/csindex/public/uploads/file/autofile/indicator/${code}indicator.xls`;
}

/* ---------------- OLE2（CFB）+ BIFF8 最小解析 ---------------- */

interface OleStreams {
  workbook: Buffer;
}

/** 读出 OLE2 复合文档里的 Workbook 流；结构非法时抛错（由上层归为「解析失败」）。 */
export function readOleWorkbook(buffer: Buffer): Buffer {
  if (buffer.length < 512 || buffer.readUInt32LE(0) !== 0xe011cfd0) throw new Error('不是 OLE2 复合文档');
  const sectorShift = buffer.readUInt16LE(0x1e);
  // 合法值只有 9（512B）与 12（4096B）；其它值说明头部损坏，直接拒绝而不是算出负偏移
  if (sectorShift !== 9 && sectorShift !== 12) throw new Error('OLE2 扇区大小异常');
  const sectorSize = 1 << sectorShift;
  const maxSector = Math.ceil(buffer.length / sectorSize);
  const dirStart = buffer.readUInt32LE(0x30);
  const difStart = buffer.readUInt32LE(0x44);

  const fatSectorIds: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const sid = buffer.readUInt32LE(0x4c + i * 4);
    if (sid === 0xffffffff) break;
    fatSectorIds.push(sid);
  }
  // DIFAT 扩展：文件大于 109 个 FAT 扇区时才存在，这里做完整处理以防大文件
  for (let sid = difStart, guard = 0; Number.isInteger(sid) && sid >= 0 && sid < maxSector && guard < 4096; guard += 1) {
    const offset = (sid + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) break;
    const slots = sectorSize / 4 - 1;
    for (let i = 0; i < slots; i += 1) {
      const next = buffer.readUInt32LE(offset + i * 4);
      if (next !== 0xffffffff) fatSectorIds.push(next);
    }
    sid = buffer.readUInt32LE(offset + slots * 4);
  }

  const fat: number[] = [];
  for (const sid of fatSectorIds) {
    const offset = (sid + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) continue;
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(buffer.readUInt32LE(offset + i * 4));
  }

  const readChain = (start: number, size: number): Buffer => {
    const chunks: Buffer[] = [];
    let sid = start;
    for (let guard = 0; guard < 100_000; guard += 1) {
      if (!Number.isInteger(sid) || sid < 0 || sid >= fat.length) break;
      const offset = (sid + 1) * sectorSize;
      if (offset + sectorSize > buffer.length) break;
      chunks.push(buffer.subarray(offset, offset + sectorSize));
      sid = fat[sid];
    }
    return Buffer.concat(chunks).subarray(0, size);
  };

  const directory = readChain(dirStart, sectorSize * 8);
  for (let i = 0; i < directory.length; i += 128) {
    const entry = directory.subarray(i, i + 128);
    const nameLength = entry.readUInt16LE(0x40);
    if (nameLength < 2 || entry.readUInt8(0x42) !== 2) continue; // 2 = stream
    const name = entry.subarray(0, nameLength - 2).toString('utf16le');
    if (name === 'Workbook' || name === 'Book') {
      return readChain(entry.readUInt32LE(0x74), entry.readUInt32LE(0x78));
    }
  }
  throw new Error('OLE2 文档里没有 Workbook 流');
}

/** BIFF8 RK 压缩数值解码。 */
function decodeRk(rk: number): number {
  let value: number;
  if (rk & 0x02) {
    value = rk >> 2; // 有符号 30 位整数
  } else {
    const scratch = Buffer.alloc(8);
    scratch.writeUInt32LE(0, 0);
    scratch.writeUInt32LE(rk & 0xfffffffc, 4);
    value = scratch.readDoubleLE(0);
  }
  return rk & 0x01 ? value / 100 : value;
}

export interface SheetCell {
  row: number;
  col: number;
  value: string | number;
}

/** 极简 BIFF8 单元格解析：只处理本文件会用到的 字符串 / 数字 / 多列数字 记录。 */
export function parseBiffCells(workbook: Buffer): SheetCell[] {
  // 先收集 SST（共享字符串表），LABELSST 只存索引
  const shared: string[] = [];
  for (let p = 0; p + 4 <= workbook.length;) {
    const type = workbook.readUInt16LE(p);
    const length = workbook.readUInt16LE(p + 2);
    if (p + 4 + length > workbook.length) break;
    const body = workbook.subarray(p + 4, p + 4 + length);
    if (type === 0x00fc) {
      const unique = body.readUInt32LE(4);
      let q = 8;
      for (let i = 0; i < unique && q + 3 <= body.length; i += 1) {
        const cch = body.readUInt16LE(q);
        const flags = body.readUInt8(q + 2);
        q += 3;
        if (flags & 0x08) q += 2;
        if (flags & 0x04) q += 4;
        if (flags & 0x01) {
          shared.push(body.subarray(q, q + cch * 2).toString('utf16le'));
          q += cch * 2;
        } else {
          shared.push(body.subarray(q, q + cch).toString('latin1'));
          q += cch;
        }
      }
    }
    p += 4 + length;
  }

  const cells: SheetCell[] = [];
  for (let p = 0; p + 4 <= workbook.length;) {
    const type = workbook.readUInt16LE(p);
    const length = workbook.readUInt16LE(p + 2);
    if (p + 4 + length > workbook.length) break;
    const body = workbook.subarray(p + 4, p + 4 + length);
    p += 4 + length;
    if (type === 0x00fd && body.length >= 10) {
      cells.push({ row: body.readUInt16LE(0), col: body.readUInt16LE(2), value: shared[body.readUInt32LE(6)] ?? '' });
    } else if (type === 0x0204 && body.length >= 9) {
      const cch = body.readUInt16LE(6);
      const flags = body.readUInt8(8);
      cells.push({
        row: body.readUInt16LE(0),
        col: body.readUInt16LE(2),
        value: body.subarray(9, 9 + (flags & 0x01 ? cch * 2 : cch)).toString(flags & 0x01 ? 'utf16le' : 'latin1'),
      });
    } else if (type === 0x0203 && body.length >= 14) {
      cells.push({ row: body.readUInt16LE(0), col: body.readUInt16LE(2), value: body.readDoubleLE(6) });
    } else if (type === 0x027e && body.length >= 10) {
      cells.push({ row: body.readUInt16LE(0), col: body.readUInt16LE(2), value: decodeRk(body.readUInt32LE(6)) });
    } else if (type === 0x00bd && body.length >= 6) {
      const row = body.readUInt16LE(0);
      const firstCol = body.readUInt16LE(2);
      const count = Math.floor((body.length - 6) / 6);
      for (let i = 0; i < count; i += 1) {
        cells.push({ row, col: firstCol + i, value: decodeRk(body.readUInt32LE(4 + i * 6 + 2)) });
      }
    }
  }
  return cells;
}

export interface CsindexSnapshot {
  tradeDate: string;
  code: string;
  name: string;
  /** 市盈率1（总股本口径）。 */
  peTotalShare: number | null;
  /** 市盈率2（计算用股本口径，主值）。 */
  peCalcShare: number | null;
  /** 股息率1（总股本口径，%）。 */
  dividendTotalShare: number | null;
  /** 股息率2（计算用股本口径，主值，%）。 */
  dividendCalcShare: number | null;
}

const HEADER_TOKENS = ['市盈率', '股息率', '指数代码'];

/**
 * 把 xls 单元格还原成按日期倒序的估值快照。
 * 表头两个维度都随文件语言变化，因此按表头关键字定位列，而不是写死列号。
 */
export function parseCsindexIndicator(workbook: Buffer): CsindexSnapshot[] {
  const cells = parseBiffCells(workbook);
  if (cells.length === 0) return [];
  const byRow = new Map<number, Map<number, string | number>>();
  for (const cell of cells) {
    const row = byRow.get(cell.row) ?? new Map<number, string | number>();
    row.set(cell.col, cell.value);
    byRow.set(cell.row, row);
  }
  const rowIndexes = [...byRow.keys()].sort((a, b) => a - b);

  // 表头行：包含 PE / 股息率 关键字的行
  let headerRow = -1;
  const columns = { date: -1, code: -1, name: -1, pe1: -1, pe2: -1, dp1: -1, dp2: -1 };
  for (const rowIndex of rowIndexes) {
    const row = byRow.get(rowIndex)!;
    const text = [...row.values()].filter((v) => typeof v === 'string').join('|');
    if (!HEADER_TOKENS.some((token) => text.includes(token))) continue;
    headerRow = rowIndex;
    for (const [col, value] of row) {
      if (typeof value !== 'string') continue;
      const label = value.trim();
      if (columns.date < 0 && /日期|Date/i.test(label)) columns.date = col;
      else if (columns.code < 0 && /代码|Code/i.test(label)) columns.code = col;
      // 中文简称（不是「全称」）：列头形如「指数中文简称Index Chinese Name」
      else if (columns.name < 0 && /简称|Short ?Name|Index Chinese Name/i.test(label)) columns.name = col;
      else if (columns.pe1 < 0 && /市盈率1|P\/E1/i.test(label)) columns.pe1 = col;
      else if (columns.pe2 < 0 && /市盈率2|P\/E2/i.test(label)) columns.pe2 = col;
      else if (columns.dp1 < 0 && /股息率1|D\/P1/i.test(label)) columns.dp1 = col;
      else if (columns.dp2 < 0 && /股息率2|D\/P2/i.test(label)) columns.dp2 = col;
    }
    break;
  }
  if (headerRow < 0 || columns.date < 0) return [];

  const toNumber = (value: string | number | undefined): number | null => {
    if (value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[,%]/g, ''));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };
  const normalizeDate = (value: string | number | undefined): string | null => {
    const digits = String(value ?? '').replace(/[^0-9]/g, '');
    if (digits.length < 8) return null;
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  };

  const out: CsindexSnapshot[] = [];
  for (const rowIndex of rowIndexes) {
    if (rowIndex <= headerRow) continue;
    const row = byRow.get(rowIndex)!;
    const tradeDate = normalizeDate(row.get(columns.date));
    const code = String(row.get(columns.code) ?? '').trim();
    if (!tradeDate || !/^\d{6}$/.test(code)) continue;
    out.push({
      tradeDate,
      code,
      name: String(row.get(columns.name) ?? '').trim(),
      peTotalShare: toNumber(row.get(columns.pe1)),
      peCalcShare: toNumber(row.get(columns.pe2)),
      dividendTotalShare: toNumber(row.get(columns.dp1)),
      dividendCalcShare: toNumber(row.get(columns.dp2)),
    });
  }
  return out.sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
}

/* ---------------- 抓取 ---------------- */

/** 只对中证 / 上证系列（6 位数字，00/000 开头或 93 开头）生效；国证系列直接跳过。 */
export function supportsCsindex(instrument: Instrument): boolean {
  return instrument.type === 'INDEX' && /^(000|930|931|h30)?\d{6}$/i.test(instrument.code);
}

export async function fetchCsindexIndicator(instrument: Instrument): Promise<CsindexSnapshot[]> {
  if (!supportsCsindex(instrument)) return [];
  if (Date.now() < blockedUntil) return [];
  await paced();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(csindexIndicatorUrl(instrument.code), {
      headers: { 'User-Agent': UA, Referer: 'https://www.csindex.com.cn/' },
      signal: controller.signal,
    });
    // 404 = 该指数不由中证发布（深证成指 / 创业板指等），属已知边界，返回空数组
    if (response.status === 404) return [];
    // 403 / 429 = OSS 的 WAF 限流：进入退避期，本轮不再尝试，错误上抛让上层记录原因
    if (response.status === 403 || response.status === 429) {
      blockedUntil = Date.now() + BLOCK_BACKOFF_MS;
      throw new Error(`HTTP ${response.status} csindex 限流（${Math.round(BLOCK_BACKOFF_MS / 60000)} 分钟内不再请求）`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status} csindex ${instrument.code}`);
    // WAF 会以 200 返回 HTML 拦截页的情况也要拦住：xls 必须是 OLE2 魔数
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 512 || buffer.readUInt32LE(0) !== 0xe011cfd0) {
      throw new Error('csindex 返回的不是 OLE2 表格（可能被拦截页替换）');
    }
    return parseCsindexIndicator(readOleWorkbook(buffer));
  } finally {
    clearTimeout(timer);
  }
}

export interface CsindexMetric {
  metricKey: string;
  value: string | null;
  asOfDate: string;
  quality: MarketPoint['quality'];
}

/** 快照 → 指标写入项：最新一天写当期值，全部日期写历史截面（供分位累积）。 */
export function snapshotToMetrics(instrumentId: string, snapshots: CsindexSnapshot[]): {
  latest: CsindexMetric[];
  history: (CsindexMetric & { instrumentId: string })[];
} {
  if (snapshots.length === 0) return { latest: [], history: [] };
  const history: (CsindexMetric & { instrumentId: string })[] = [];
  for (const snapshot of snapshots) {
    const asOfDate = snapshot.tradeDate;
    const quality: MarketPoint['quality'] = 'FRESH';
    // 官方 PE 走独立键，绝不顶替报价端 pe（两者口径不同，混用会让分位跳变）
    if (snapshot.peCalcShare !== null) history.push({ instrumentId, metricKey: 'pe_official', value: String(snapshot.peCalcShare), asOfDate, quality });
    if (snapshot.peTotalShare !== null) history.push({ instrumentId, metricKey: 'pe_official_total_share', value: String(snapshot.peTotalShare), asOfDate, quality });
    // 股息率只有官方源提供，作为主值
    if (snapshot.dividendCalcShare !== null) history.push({ instrumentId, metricKey: 'dividend_yield', value: String(snapshot.dividendCalcShare), asOfDate, quality });
    if (snapshot.dividendTotalShare !== null) history.push({ instrumentId, metricKey: 'dividend_yield_total_share', value: String(snapshot.dividendTotalShare), asOfDate, quality });
  }
  const newest = snapshots[0].tradeDate;
  const latest = history.filter((row) => row.asOfDate === newest).map((row) => ({
    metricKey: row.metricKey, value: row.value, asOfDate: row.asOfDate, quality: row.quality,
  }));
  return { latest, history };
}
