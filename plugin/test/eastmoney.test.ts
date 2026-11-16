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

test('parseStockMetrics：PE / PB / 总市值（fltt=2 原始浮点）', () => {
  const metrics = parseStockMetrics(
    { data: { f115: 7.8, f167: 0.92, f20: 1.03e14 } },
    'ins1',
    TODAY,
  );
  assert.equal(metrics.find((m) => m.metricKey === 'pe')?.value, '7.8');
  assert.equal(metrics.find((m) => m.metricKey === 'pb')?.value, '0.92');
  assert.ok((metrics.find((m) => m.metricKey === 'scale_info')?.value ?? '').includes('亿'));
  assert.equal(parseStockMetrics({ data: null }, 'ins1', TODAY).length, 0);
});
