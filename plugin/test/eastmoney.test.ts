/**
 * Eastmoney 适配器解析函数 fixture 测试（无网络）。
 * 锁定解析行为：K 线 / 历史净值 / 估算净值 / 报价与指标。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFundGz,
  parseKlines,
  parseLsjz,
  parsePingzhongNav,
  parseStockMetrics,
  parseStockQuote,
  secidOf,
  sliceJsArray,
  createEastmoneyProvider,
} from '../server/src/market/eastmoney.ts';
import type { Instrument } from '../core/src/types.ts';

const ins: Instrument = {
  id: 'ins1', code: '600036', name: '招商银行', type: 'STOCK', market: 'SH', currency: 'CNY',
  benchmarkIndex: null, secid: '1.600036', fundCode: null, tag: '', foundedDate: null, scaleInfo: null,
  active: true, createdAt: '', updatedAt: '',
};

const TODAY = '2026-11-13';

test('secidOf：显式 secid 优先，SH/SZ 推导，OTC 为空', () => {
  assert.equal(secidOf(ins), '1.600036');
  assert.equal(secidOf({ ...ins, secid: null, market: 'SZ', code: '002475' }), '0.002475');
  assert.equal(secidOf({ ...ins, secid: null, market: 'OTC' }), null);
});

test('东财估值保留源日期、负盈利率，拒绝无日期、未来日期和空白值', () => {
  const f86 = Date.parse('2026-11-12T23:30:00+08:00') / 1000;
  const metrics = parseStockMetrics({ data: { f86, f164: 12.3456, f173: -3.5, f187: 0, f188: ' ' } }, 'ins1', TODAY);
  assert.ok(metrics.every((m) => m.asOfDate === '2026-11-12' && m.quality === 'DELAYED'));
  assert.equal(metrics.find((m) => m.metricKey === 'pe')?.value, '12.3456');
  assert.equal(metrics.find((m) => m.metricKey === 'roe')?.value, '-3.5');
  assert.equal(metrics.find((m) => m.metricKey === 'gross_margin_pct')?.value, '0');
  assert.equal(metrics.find((m) => m.metricKey === 'net_margin_pct'), undefined);
  assert.deepEqual(parseStockMetrics({ data: { f164: 12 } }, 'i', TODAY), []);
  assert.deepEqual(parseStockMetrics({ data: { f86: Infinity, f164: 12 } }, 'i', TODAY), []);
  assert.deepEqual(parseStockMetrics({ data: { f86: Date.parse('2027-01-01') / 1000, f164: 12 } }, 'i', TODAY), []);
  const midnight = parseStockMetrics({ data: { f86: Date.parse(`${TODAY}T00:30:00+08:00`) / 1000, f164: 12 } }, 'i', TODAY);
  assert.equal(midnight[0].asOfDate, TODAY);
});

test('东财 INDEX 直接取自身估值和市值；基金映射不透传指数市值；错码拒绝', async () => {
  const original = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input)); requests.push(url);
    return Response.json({ data: { f57: '399001', f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000,
      f164: 19.258, f167: 2.16, f20: 23276633043254.82 } });
  };
  try {
    const provider = createEastmoneyProvider();
    const metrics = await provider.fetchMetrics!({ ...ins, code: '399001', type: 'INDEX', market: 'SZ', secid: '0.399001' });
    assert.equal(requests[0].searchParams.get('secid'), '0.399001');
    assert.ok(requests[0].searchParams.get('fields')?.includes('f86'));
    assert.equal(metrics.find((m) => m.metricKey === 'pb')?.value, '2.16');
    assert.ok(metrics.some((m) => m.metricKey === 'scale_info'));
    // 已知映射中的沪深300，返回相同代码供身份断言。
    globalThis.fetch = async () => Response.json({ data: { f57: '000300', f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000, f164: 12, f20: 1e12 } });
    const fund = await provider.fetchMetrics!({ ...ins, type: 'ETF', benchmarkIndex: '沪深300' });
    assert.ok(!fund.some((m) => m.metricKey === 'scale_info'));
    globalThis.fetch = async () => Response.json({ data: { f57: '399006', f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000, f164: 12 } });
    await assert.rejects(provider.fetchMetrics!({ ...ins, code: '399001', type: 'INDEX', secid: '0.399001' }), /代码不匹配/);
  } finally { globalThis.fetch = original; }
});

test('parseStockQuote：当日实时 → REALTIME_PRICE / FRESH', () => {
  const point = parseStockQuote(
    { data: { f43: 41.25, f57: '600036', f58: '招商银行', f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000 } },
    'ins1',
    TODAY,
  );
  assert.ok(point);
  assert.equal(point.priceType, 'REALTIME_PRICE');
  assert.equal(point.value, '41.25');
  assert.equal(point.quality, 'FRESH');
  assert.equal(point.tradingDate, TODAY);
});

test('parseStockQuote：非当日 → CLOSE_PRICE / DELAYED；无数据 → null', () => {
  const stale = parseStockQuote({ data: { f43: 41.25, f86: Date.parse('2026-11-12T15:00:00+08:00') / 1000 } }, 'ins1', TODAY);
  assert.equal(stale?.priceType, 'CLOSE_PRICE');
  assert.equal(stale?.quality, 'DELAYED');
  assert.equal(parseStockQuote({ data: null }, 'ins1', TODAY), null);
  assert.equal(parseStockQuote({ data: { f43: 0 } }, 'ins1', TODAY), null);
});

test('parseKlines：日期,收盘 解析', () => {
  const points = parseKlines(
    { data: { klines: ['2026-11-12,41.02', '2026-11-13,41.25', 'broken'] } },
    'ins1',
  );
  assert.equal(points.length, 2);
  assert.equal(points[0].tradingDate, '2026-11-12');
  assert.equal(points[1].value, '41.25');
  assert.ok(points.every((p) => p.priceType === 'CLOSE_PRICE' && p.provider === 'eastmoney'));
});

test('parseLsjz：正式净值 + 区间过滤 + 空净值跳过', () => {
  const points = parseLsjz(
    {
      Data: {
        LSJZList: [
          { FSRQ: '2026-11-12', DWJZ: '1.2691', JZZZL: '0.31' },
          { FSRQ: '2026-11-11', DWJZ: '' },
          { FSRQ: '2026-06-01', DWJZ: '1.1800' },
        ],
      },
    },
    'ins1',
    { begin: '2026-11-01', end: '2026-11-30' },
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].priceType, 'OFFICIAL_NAV');
  assert.equal(points[0].value, '1.2691');
  const all = parseLsjz({ Data: { LSJZList: [{ FSRQ: '2026-11-12', DWJZ: '1.2691' }] } }, 'ins1');
  assert.equal(all.length, 1);
  // 非法基金代码：接口返回 Data.LSJZList 为空且 ErrCode=0，只能按无数据处理。
  assert.equal(parseLsjz({ Data: { LSJZList: [] }, ErrCode: 0 }, 'ins1').length, 0);
  assert.equal(parseLsjz({ Data: null, ErrCode: 4, ErrMsg: '404' }, 'ins1').length, 0);
});

test('sliceJsArray：按括号深度配对（字符串内的括号不计数）', () => {
  const text = 'var a=1;Data_netWorthTrend = [{"x":1,"y":2,"unitMoney":"[]"}];var b=2;';
  assert.equal(sliceJsArray(text, 'Data_netWorthTrend'), '[{"x":1,"y":2,"unitMoney":"[]"}]');
  assert.equal(sliceJsArray('no marker here', 'Data_netWorthTrend'), null);
  assert.equal(sliceJsArray('Data_netWorthTrend = ;', 'Data_netWorthTrend'), null);
  // 未闭合时返回 null，不返回半截内容
  assert.equal(sliceJsArray('Data_netWorthTrend = [{"x":1}', 'Data_netWorthTrend'), null);
});

test('parsePingzhongNav：毫秒时间戳按 UTC+8 折算交易日 + 区间过滤', () => {
  // 1794499200000 = 2026-11-12T16:00Z = 北京时间 2026-11-13 零点
  const text = `var Data_netWorthTrend = [{"x":1794412800000,"y":4.0238},{"x":1794499200000,"y":4.0421},{"x":1794000000000,"y":0}];`;
  const all = parsePingzhongNav(text, 'ins1');
  assert.equal(all.length, 2, '净值为 0 的行应跳过');
  assert.equal(all[0].tradingDate, '2026-11-12');
  assert.equal(all[1].tradingDate, '2026-11-13');
  assert.equal(all[1].value, '4.0421');
  assert.ok(all.every((p) => p.priceType === 'OFFICIAL_NAV' && p.provider === 'eastmoney'));
  const filtered = parsePingzhongNav(text, 'ins1', { begin: '2026-11-13', end: '2026-11-30' });
  assert.deepEqual(filtered.map((p) => p.tradingDate), ['2026-11-13']);
  assert.equal(parsePingzhongNav('var other = 1;', 'ins1').length, 0);
});

test('东财净值端点必须是 /f10/lsjz（lsjnz 会返回 ErrCode=4 空数据）', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'server', 'src', 'market', 'eastmoney.ts'), 'utf8');
  assert.ok(source.includes('api.fund.eastmoney.com/f10/lsjz?fundCode='), '净值接口路径应为 /f10/lsjz');
  // 只检查真正会被请求的 URL 模板，注释里提旧名不算（否则守卫会误伤自己）。
  assert.ok(!/`https:\/\/[^`]*\/f10\/lsjnz\?/.test(source), '请求 URL 不得再出现拼错的 /f10/lsjnz');
  // 服务端硬性每页 20 条：请求更大的 pageSize 会被截断，传 400 直接 0 行。
  assert.match(source, /FUND_NAV_PAGE_SIZE = 20;/, 'pageSize 必须固定为服务端上限 20');
  assert.ok(!/pageSize=(3\d\d|[4-9]\d\d|\d{4,})/.test(source), '不得再请求 400 这类被服务端拒绝的 pageSize');
});

test('parseFundGz：jsonpgz 文本 → ESTIMATED_NAV（与正式净值分离）', () => {
  const text = `jsonpgz({"fundcode":"007466","name":"华泰柏瑞红利低波ETF联接A","jzrq":"2026-11-12","dwjz":"1.2691","gsz":"1.2698","gszzl":"0.06","gztime":"${TODAY} 15:00"});`;
  const point = parseFundGz(text, 'ins1');
  assert.ok(point);
  assert.equal(point.priceType, 'ESTIMATED_NAV');
  assert.equal(point.value, '1.2698');
  assert.equal(point.quality, 'ESTIMATED');
  assert.equal(parseFundGz('not jsonp', 'ins1'), null);
  assert.equal(parseFundGz('jsonpgz({"gsz":""});', 'ins1'), null);
});

test('parseStockMetrics：PE-TTM / PB / ROE / 毛利率 / 总市值（fltt=2 原始浮点）', () => {
  const metrics = parseStockMetrics(
    { data: { f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000, f115: '-', f164: 7.12, f162: 7.01, f163: 7.25, f167: 0.92, f173: 10.12, f187: 44.23, f188: 89.9, f20: 1.03e14 } },
    'ins1',
    TODAY,
  );
  const value = (key: string): string | undefined => metrics.find((m) => m.metricKey === key)?.value;
  // f115 在 fltt=2 下常为 "-"，PE-TTM 必须从 f164 取
  assert.equal(value('pe'), '7.12');
  assert.equal(value('pe_dynamic'), '7.01');
  assert.equal(value('pe_static'), '7.25');
  assert.equal(value('pb'), '0.92');
  assert.equal(value('roe'), '10.12');
  assert.equal(value('gross_margin_pct'), '44.23');
  assert.equal(value('net_margin_pct'), '89.9');
  assert.ok((value('scale_info') ?? '').includes('亿'));
  assert.equal(parseStockMetrics({ data: null }, 'ins1', TODAY).length, 0);

  // 只有 f115（旧字段）时不再冒充 PE-TTM —— 取不到就是取不到
  const legacy = parseStockMetrics({ data: { f115: 7.8 } }, 'ins1', TODAY);
  assert.equal(legacy.find((m) => m.metricKey === 'pe'), undefined);

  // 亏损股 PE 为负、字段为 "-"：一律跳过，不写 0
  const loss = parseStockMetrics({ data: { f86: Date.parse(`${TODAY}T15:00:00+08:00`) / 1000, f164: '-', f167: 1.2, f173: -3.5 } }, 'ins1', TODAY);
  assert.equal(loss.find((m) => m.metricKey === 'pe'), undefined);
  assert.equal(loss.find((m) => m.metricKey === 'roe')?.value, '-3.5');
  assert.equal(loss.find((m) => m.metricKey === 'pb')?.value, '1.2');
});
