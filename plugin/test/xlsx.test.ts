/**
 * .xlsx 导入回归：自包含 ZIP/XML 解析 + 与 CSV 导入链路的衔接。
 *
 * 测试用最小 ZIP 构造器在内存里现做工作簿（不引入任何依赖），
 * 覆盖共享字符串、稀疏单元格、日期序列号、实体转义这几个真实 Excel 会出现的形态。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import { columnIndex, readXlsxFirstSheet, sheetToCsv, xlsxBase64ToCsv } from '../server/src/xlsx.ts';
import type { ServiceContext } from '../server/src/context.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

async function failing(method: string, params: Record<string, unknown> = {}): Promise<{ status: number; code: string; message: string }> {
  const result = await dispatch(ctx, method, params);
  assert.notEqual(result.status, 200, `${method} 本应失败却成功`);
  return {
    status: result.status,
    code: result.envelope.error?.code ?? '',
    message: result.envelope.error?.message ?? '',
  };
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-xlsx-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

/* ---------------- 最小 ZIP 构造器（仅测试用） ---------------- */

function buildZip(files: { name: string; content: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.content, 'utf8');
    const packed = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** 2026-10-20 的 Excel 日期序列号。 */
function excelSerial(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

const HEADER = ['账户', '标的代码', '标的名称', '资产类别', '交易类型', '交易日', '数量', '价格', '金额', '手续费', '税费', '状态', '备注', '幂等键'];

function workbook(): Buffer {
  const shared = ['账户', '标的代码', '标的名称', '资产类别', '交易类型', '交易日', '数量', '价格', '金额',
    '手续费', '税费', '状态', '备注', '幂等键',
    '华宝证券', '600036', '招商银行', '股票', '期初', '已确认', '期初建账',
    '买入', '加仓 & 回调'];
  const sharedXml = `<?xml version="1.0"?><sst count="${shared.length}">${
    shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')
  }</sst>`;

  // style 0 = 常规，style 1 = 日期（numFmtId 14）
  const stylesXml = '<?xml version="1.0"?><styleSheet>'
    + '<numFmts count="0"/>'
    + '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs>'
    + '</styleSheet>';

  const s = (index: number, ref: string): string => `<c r="${ref}" t="s"><v>${index}</v></c>`;
  const n = (value: string, ref: string, style = 0): string => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;

  const headerRow = `<row r="1">${HEADER.map((_, i) => s(i, `${String.fromCharCode(65 + i)}1`)).join('')}</row>`;

  // 第 2 行：期初建账。刻意跳过「价格」列（H2 缺失），验证稀疏单元格不会错列。
  const row2 = `<row r="2">`
    + s(14, 'A2') + s(15, 'B2') + s(16, 'C2') + s(17, 'D2') + s(18, 'E2')
    + n(String(excelSerial('2026-10-20')), 'F2', 1)
    + n('400', 'G2') + n('11550', 'I2') + n('5', 'J2') + n('0', 'K2')
    + s(19, 'L2') + s(20, 'M2')
    + '</row>';

  // 第 3 行：买入，备注含实体与富文本分段
  const row3 = `<row r="3">`
    + s(14, 'A3') + s(15, 'B3') + s(16, 'C3') + s(17, 'D3') + s(21, 'E3')
    + n(String(excelSerial('2026-10-25')), 'F3', 1)
    + n('100', 'G3') + n('41.25', 'H3') + n('5', 'J3') + n('0', 'K3')
    + s(19, 'L3')
    + '<c r="M3" t="inlineStr"><is><t>加仓</t><t xml:space="preserve"> &amp; 回调</t></is></c>'
    + '<c r="N3" t="str"><v>req-001</v></c>'
    + '</row>';

  const sheetXml = '<?xml version="1.0"?><worksheet><sheetData>'
    + headerRow + row2 + row3
    + '</sheetData></worksheet>';

  return buildZip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types/>' },
    { name: 'xl/sharedStrings.xml', content: sharedXml },
    { name: 'xl/styles.xml', content: stylesXml },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
}

/* ---------------- 1. 纯解析 ---------------- */

test('列号解析：A=0 / Z=25 / AA=26 / AB=27', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('Z9'), 25);
  assert.equal(columnIndex('AA1'), 26);
  assert.equal(columnIndex('AB1'), 27);
  assert.equal(columnIndex('BA2'), 52);
});

test('xlsx 解析：表头、稀疏单元格、日期序列号、实体与富文本', () => {
  const table = readXlsxFirstSheet(workbook());
  assert.deepEqual(table.header, HEADER);
  assert.equal(table.rows.length, 2);

  const [first, second] = table.rows;
  assert.equal(first[0], '华宝证券');
  assert.equal(first[5], '2026-10-20');   // 日期按 numFmt 转成 YYYY-MM-DD
  assert.equal(first[6], '400');
  assert.equal(first[8], '11550');
  assert.equal(first[9], '5');
  assert.equal(first[10], '0');
  assert.equal(first[11], '已确认');
  assert.equal(first[13], '');            // 幂等键列空着

  assert.equal(second[4], '买入');
  assert.equal(second[5], '2026-10-25');
  assert.equal(second[6], '100');
  assert.equal(second[7], '41.25');
  assert.equal(second[12], '加仓 & 回调');
  assert.equal(second[13], 'req-001');
});

test('sheetToCsv 会补齐列并对含逗号的单元格加引号', () => {
  const csv = sheetToCsv({
    sheetName: 'sheet1',
    header: ['a', 'b', 'c'],
    rows: [['1'], ['x,y', '2', '3']],
    skippedRows: 0,
  });
  const lines = csv.split('\n');
  assert.equal(lines[0], 'a,b,c');
  assert.equal(lines[1], '1,,');
  assert.equal(lines[2], '"x,y",2,3');
});

/* ---------------- 2. 与导入链路衔接 ---------------- */

test('xlsx → CSV → preview_import_transactions 全链路可用', async () => {
  const preview = await rpc<{
    summary: { total: number; valid: number; invalid: number; newAccounts: string[]; newInstruments: string[] };
    errors: { line: number; message: string }[]; rows: { tradeDate: string }[];
  }>('preview_import_transactions', { xlsxBase64: workbook().toString('base64') });

  assert.equal(preview.summary.total, 2);
  assert.equal(preview.summary.valid, 2, JSON.stringify(preview.errors));
  assert.deepEqual(preview.summary.newAccounts, ['华宝证券']);
  assert.deepEqual(preview.summary.newInstruments, ['招商银行 600036']);
  assert.deepEqual(preview.rows.map((r) => r.tradeDate), ['2026-10-20', '2026-10-25']);
});

test('xlsx 提交后持仓按流水回放生成', async () => {
  const committed = await rpc<{ imported: number; skipped: number }>('commit_import_transactions', {
    xlsxBase64: workbook().toString('base64'),
  });
  assert.equal(committed.imported, 2);
  assert.equal(committed.skipped, 0);

  const holdings = await rpc<{ rows: { code: string; qty: string; costTotal: string }[] }>('list_positions');
  assert.equal(holdings.rows.length, 1);
  assert.equal(holdings.rows[0].code, '600036');
  assert.equal(holdings.rows[0].qty, '500');       // 400 + 100
});

test('xlsx 重复导入按幂等键跳过', async () => {
  await rpc('commit_import_transactions', { xlsxBase64: workbook().toString('base64') });
  const again = await rpc<{ imported: number; skipped: number }>('commit_import_transactions', {
    xlsxBase64: workbook().toString('base64'),
  });
  // 幂等键为空的行按「同账户+同标的+同日期+同类型+同数量」去重，因此第二次全部跳过。
  assert.equal(again.imported, 0);
  assert.equal(again.skipped, 2);
});

/* ---------------- 3. 错误要可诊断 ---------------- */

test('不是 ZIP / 空内容 → 422 validation-error', async () => {
  const notZip = await failing('preview_import_transactions', {
    xlsxBase64: Buffer.from('账户,标的代码\n华宝,600036').toString('base64'),
  });
  assert.equal(notZip.status, 422);
  assert.equal(notZip.code, 'validation-error');
  assert.match(notZip.message, /xlsx|ZIP/);

  const empty = await failing('preview_import_transactions', { xlsxBase64: '' });
  assert.equal(empty.status, 422);
});

test('缺少工作表 / 空表 → 422 且提示原因', () => {
  const noSheet = buildZip([{ name: '[Content_Types].xml', content: '<Types/>' }]);
  assert.throws(() => xlsxBase64ToCsv(noSheet.toString('base64')), /工作表/);

  const emptySheet = buildZip([
    { name: 'xl/worksheets/sheet1.xml', content: '<?xml version="1.0"?><worksheet><sheetData></sheetData></worksheet>' },
  ]);
  assert.throws(() => xlsxBase64ToCsv(emptySheet.toString('base64')), /没有任何数据行/);
});
