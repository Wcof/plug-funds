/**
 * CSV 流水导入（PRD §13.1）：预览 → 错误行可见 → 单事务提交 → 失败整批回滚。
 * 金额 / 份额一律走定点解析（不静默填 0），requestId 保证重复导入同文件幂等。
 */
import { formatFixed, parseFixed, SCALE_AMOUNT, SCALE_QTY } from '../../../core/src/money.ts';
import { replayPositions } from '../../../core/src/ledger.ts';
import type { InstrumentType, TxnStatus, TxnType } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { ValidationError } from '../errors.ts';
import { listAccounts, saveAccount } from '../repo/accounts.ts';
import { listInstruments, saveInstrument } from '../repo/instruments.ts';
import { allTransactions, saveTransaction } from '../repo/transactions.ts';

export interface ImportRow {
  line: number;
  accountName: string;
  instrumentCode: string;
  instrumentName: string;
  instrumentType: InstrumentType;
  txnType: TxnType;
  tradeDate: string;
  quantity: string | null;
  price: string | null;
  amount: string | null;
  fee: string | null;
  tax: string | null;
  status: TxnStatus;
  note: string;
  requestId: string;
}

export interface ImportPreview {
  header: string[];
  rows: ImportRow[];
  errors: { line: number; message: string }[];
  summary: { total: number; valid: number; invalid: number; newAccounts: string[]; newInstruments: string[] };
}

const HEADERS: Record<string, string> = {
  '账户': 'accountName', 'account': 'accountName',
  '标的代码': 'instrumentCode', '代码': 'instrumentCode', 'code': 'instrumentCode',
  '标的名称': 'instrumentName', '名称': 'instrumentName', 'name': 'instrumentName',
  '资产类别': 'instrumentType', '标的类型': 'instrumentType', 'asset_type': 'instrumentType',
  '交易类型': 'txnType', '类型': 'txnType', 'type': 'txnType',
  '交易日': 'tradeDate', '日期': 'tradeDate', 'trade_date': 'tradeDate',
  '数量': 'quantity', '份额': 'quantity', 'quantity': 'quantity',
  '价格': 'price', '单价': 'price', 'price': 'price',
  '金额': 'amount', 'amount': 'amount',
  '手续费': 'fee', 'fee': 'fee',
  '税费': 'tax', 'tax': 'tax',
  '状态': 'status', 'status': 'status',
  '备注': 'note', 'note': 'note',
  '幂等键': 'requestId', 'request_id': 'requestId',
};

const TXN_TYPES: Record<string, TxnType> = {
  '买入': 'BUY', 'buy': 'BUY', 'BUY': 'BUY',
  '卖出': 'SELL', 'sell': 'SELL', 'SELL': 'SELL',
  '期初': 'OPENING', '期初建账': 'OPENING', 'opening': 'OPENING', 'OPENING': 'OPENING',
  '现金分红': 'DIVIDEND_CASH', 'dividend_cash': 'DIVIDEND_CASH', 'DIVIDEND_CASH': 'DIVIDEND_CASH',
  '红利再投': 'DIVIDEND_REINVEST', 'dividend_reinvest': 'DIVIDEND_REINVEST', 'DIVIDEND_REINVEST': 'DIVIDEND_REINVEST',
  '费用': 'FEE', 'fee': 'FEE', 'FEE': 'FEE',
  '拆分': 'SPLIT', 'split': 'SPLIT', 'SPLIT': 'SPLIT',
  '修正': 'CORRECTION', 'correction': 'CORRECTION', 'CORRECTION': 'CORRECTION',
};

const ASSET_TYPES: Record<string, InstrumentType> = {
  '股票': 'STOCK', 'stock': 'STOCK', 'STOCK': 'STOCK',
  'ETF': 'ETF', 'etf': 'ETF',
  '基金': 'OPEN_END_FUND', '场外基金': 'OPEN_END_FUND', 'fund': 'OPEN_END_FUND', 'OPEN_END_FUND': 'OPEN_END_FUND',
};

/** 标准 CSV 解析（BOM、引号、引号内逗号与换行、双引号转义）。 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(cell); cell = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

function fixed(value: string, scale: number, label: string, line: number): string | null {
  if (value.trim() === '') return null;
  const parsed = parseFixed(value.trim(), scale);
  if (!Number.isFinite(parsed)) throw new ValidationError(`第 ${line} 行 ${label} 不是合法数值：${value}`);
  return formatFixed(parsed, scale);
}

export function previewImport(ctx: ServiceContext, text: string): ImportPreview {
  const table = parseCsv(text);
  if (table.length === 0) throw new ValidationError('CSV 为空');
  const header = table[0].map((h) => h.trim());
  const keys = header.map((h) => {
    const key = HEADERS[h] ?? HEADERS[h.toLowerCase()];
    if (!key) throw new ValidationError(`不认识的表头「${h}」，可用列：账户,标的代码,标的名称,资产类别,交易类型,交易日,数量,价格,金额,手续费,税费,状态,备注,幂等键`);
    return key;
  });
  const errors: { line: number; message: string }[] = [];
  const rows: ImportRow[] = [];
  for (let i = 1; i < table.length; i += 1) {
    const line = i + 1;
    const cells = table[i];
    const record: Record<string, string> = {};
    keys.forEach((key, col) => { record[key] = (cells[col] ?? '').trim(); });
    try {
      if (!record.accountName) throw new ValidationError('账户不能为空');
      if (!record.instrumentCode) throw new ValidationError('标的代码不能为空');
      const txnType = TXN_TYPES[record.txnType ?? ''];
      if (!txnType) throw new ValidationError(`交易类型不认识：${record.txnType || '（空）'}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record.tradeDate ?? '')) throw new ValidationError('交易日必须为 YYYY-MM-DD');
      const instrumentType = ASSET_TYPES[record.instrumentType ?? ''] ?? 'STOCK';
      const row: ImportRow = {
        line,
        accountName: record.accountName,
        instrumentCode: record.instrumentCode,
        instrumentName: record.instrumentName || record.instrumentCode,
        instrumentType,
        txnType,
        tradeDate: record.tradeDate,
        quantity: fixed(record.quantity ?? '', SCALE_QTY, '数量', line),
        price: fixed(record.price ?? '', SCALE_QTY, '价格', line),
        amount: fixed(record.amount ?? '', SCALE_AMOUNT, '金额', line),
        fee: fixed(record.fee ?? '', SCALE_AMOUNT, '手续费', line),
        tax: fixed(record.tax ?? '', SCALE_AMOUNT, '税费', line),
        status: /待确认|PENDING/i.test(record.status ?? '') ? 'PENDING_CONFIRMATION' : 'CONFIRMED',
        note: record.note ?? '',
        requestId: record.requestId || `csv:${line}:${[record.tradeDate, record.instrumentCode, txnType, record.quantity, record.price, record.amount, record.accountName].join(':')}`,
      };
      rows.push(row);
    } catch (error) {
      errors.push({ line, message: (error as Error).message });
    }
  }
  const accounts = new Set(listAccounts(ctx.handle).map((a) => a.name.trim()));
  const instruments = new Set(listInstruments(ctx.handle).map((i) => `${i.code}:${i.type}`));
  return {
    header,
    rows,
    errors,
    summary: {
      total: table.length - 1,
      valid: rows.length,
      invalid: errors.length,
      newAccounts: [...new Set(rows.filter((r) => !accounts.has(r.accountName)).map((r) => r.accountName))],
      newInstruments: [...new Set(rows.filter((r) => !instruments.has(`${r.instrumentCode}:${r.instrumentType}`)).map((r) => `${r.instrumentName} ${r.instrumentCode}`))],
    },
  };
}

export interface ImportCommitResult {
  imported: number;
  skipped: number;
  newAccounts: string[];
  newInstruments: string[];
  errors: { line: number; message: string }[];
  note: string;
}

/** 单事务提交：任何一行失败（含回放超卖）整批回滚。 */
export function commitImport(ctx: ServiceContext, text: string): ImportCommitResult {
  const preview = previewImport(ctx, text);
  const handle = ctx.handle;
  const createdAccounts: string[] = [];
  const createdInstruments: string[] = [];
  let imported = 0;
  let skipped = 0;
  handle.db.exec('BEGIN;');
  try {
    const accounts = new Map(listAccounts(handle).map((a) => [a.name.trim(), a]));
    const instruments = new Map(listInstruments(handle).map((i) => [`${i.code}:${i.type}`, i]));
    for (const row of preview.rows) {
      let account = accounts.get(row.accountName);
      if (!account) {
        account = saveAccount(handle, { name: row.accountName, platform: 'CSV 导入' });
        accounts.set(row.accountName, account);
        createdAccounts.push(row.accountName);
      }
      const key = `${row.instrumentCode}:${row.instrumentType}`;
      let instrument = instruments.get(key);
      if (!instrument) {
        const market = row.instrumentType === 'OPEN_END_FUND'
          ? 'OTC'
          : row.instrumentCode.startsWith('6') || row.instrumentCode.startsWith('5') ? 'SH' : 'SZ';
        instrument = saveInstrument(handle, {
          code: row.instrumentCode, name: row.instrumentName, type: row.instrumentType, market,
          fundCode: row.instrumentType === 'OPEN_END_FUND' ? row.instrumentCode : null,
        });
        instruments.set(key, instrument);
        createdInstruments.push(`${row.instrumentName} ${row.instrumentCode}`);
      }
      const saved = saveTransaction(handle, {
        accountId: account.id,
        instrumentId: instrument.id,
        type: row.txnType,
        status: row.status,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        price: row.price,
        amount: row.amount,
        fee: row.fee,
        tax: row.tax,
        note: `${row.note}${row.note ? ' · ' : ''}CSV 导入（第 ${row.line} 行）`,
        requestId: row.requestId,
      });
      if (saved.deduplicated) skipped += 1;
      else imported += 1;
    }
    // 写后校验：回放失败（如超卖）→ 整批回滚
    replayPositions(allTransactions(handle));
    handle.db.exec('COMMIT;');
  } catch (error) {
    handle.db.exec('ROLLBACK;');
    throw error;
  }
  return {
    imported, skipped,
    newAccounts: createdAccounts,
    newInstruments: createdInstruments,
    errors: preview.errors,
    note: 'CSV 导入在单个事务内完成；错误行跳过，重复幂等键不重复写入，回放校验失败整批回滚。',
  };
}
