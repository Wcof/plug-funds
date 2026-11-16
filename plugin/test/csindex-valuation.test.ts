/**
 * 中证官方估值 JSON 解析测试（fixture，无网络）。
 *
 * 锁定格式与日期校验、重复日冲突、口径边界（静态与滚动 PE 分开），
 * 以及官方滚动 PE / PB 的写入键位。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPeTtmHistory,
  fetchValuationSnapshot,
  normalizeTradeDate,
  parsePeTtmHistory,
  parseValuationSnapshot,
  snapshotToMetrics,
} from '../server/src/market/csindex-valuation.ts';

test('normalizeTradeDate：YYYYMMDD → YYYY-MM-DD，其余一律 null', () => {
  assert.equal(normalizeTradeDate('20261111'), '2026-11-11');
  assert.equal(normalizeTradeDate(' 20261111 '), '2026-11-11');
  assert.equal(normalizeTradeDate('2026-11-11'), null);
  assert.equal(normalizeTradeDate('2026111'), null);
  assert.equal(normalizeTradeDate(20261111), null);
});

test('normalizeTradeDate：拒绝不存在的日期，并按公历规则校验闰日', () => {
  assert.equal(normalizeTradeDate('20240229'), '2024-02-29');
  assert.equal(normalizeTradeDate('20000229'), '2000-02-29');
  for (const invalid of ['20260229', '19000229', '20260231', '20260431', '20261301', '20260010', '20260100', '00000000']) {
    assert.equal(normalizeTradeDate(invalid), null, invalid);
  }
});

test('parseValuationSnapshot：静态/滚动 PE 分开，PB 缺失为 null，非正数丢弃', () => {
  const rows = parseValuationSnapshot({
    code: '200',
    data: {
      tradeDate: '20261111',
      indexValuations: [
        { tradeDate: '20261111', indexName: '沪深300', pe: 13.83, peg: 13.14, pb: 1.29, dp: 3.03, peLastYear: 14.5, pegLastYear: 14.1, pbLastYear: 1.4 },
        { tradeDate: '20261111', indexName: '科创50', pe: 0, peg: 0, pb: 0, dp: 0 },
        { tradeDate: '20261111', indexName: '中证500', pe: '26.03', peg: '22.48', pb: '1.94', dp: '1.58' },
        { tradeDate: 'bad', indexName: '坏日期' },
        { tradeDate: '20260231', indexName: '不存在的日期', peg: 12 },
        { tradeDate: '20261111' },
      ],
    },
  });
  assert.equal(rows.length, 3, '坏日期与缺名称的行应被丢弃');

  assert.equal(rows[0].indexName, '沪深300');
  assert.equal(rows[0].pe, 13.83);
  assert.equal(rows[0].peTtm, 13.14);
  assert.equal(rows[0].pb, 1.29);
  assert.equal(rows[0].dividendYield, 3.03);

  assert.equal(rows[1].indexName, '科创50');
  assert.equal(rows[1].pe, null, '0 表示未计算，不能当有效值');
  assert.equal(rows[1].peTtm, null);
  assert.equal(rows[1].pb, null);
  assert.equal(rows[1].dividendYield, 0, '不分红的指数股息率可以是 0');

  assert.equal(rows[2].pe, 26.03, '字符串数值应被接受');
  assert.equal(rows[2].peTtm, 22.48);
});

test('parseValuationSnapshot：空白数值保持缺失，只有明确的 0 才表示零股息率', () => {
  for (const value of [undefined, null, '', '   ', '\t\n']) {
    const [row] = parseValuationSnapshot({ data: { indexValuations: [
      { tradeDate: '20261116', indexName: '沪深300', pe: value, peg: value, pb: value, dp: value },
    ] } });
    assert.equal(row.pe, null);
    assert.equal(row.peTtm, null);
    assert.equal(row.pb, null);
    assert.equal(row.dividendYield, null);
    assert.deepEqual(snapshotToMetrics(row), [], '缺失值不得写成 0');
  }
  for (const dp of [0, '0']) {
    const [row] = parseValuationSnapshot({ data: { indexValuations: [
      { tradeDate: '20261116', indexName: '沪深300', dp },
    ] } });
    assert.equal(row.dividendYield, 0);
  }
});

test('parseValuationSnapshot：封套日期无效或与行日期冲突时明确拒绝', () => {
  assert.throws(() => parseValuationSnapshot({ data: {
    tradeDate: '20261116', indexValuations: [
      { tradeDate: '20261113', indexName: '沪深300', peg: 13.07 },
    ],
  } }), { code: 'SOURCE_INVALID', message: /日期冲突.*2026-11-16.*2026-11-13/ });
  assert.throws(() => parseValuationSnapshot({ data: {
    tradeDate: '20260231', indexValuations: [
      { tradeDate: '20261116', indexName: '沪深300', peg: 13.05 },
    ],
  } }), { code: 'SOURCE_INVALID', message: /日期无效/ });
});

test('parseValuationSnapshot：结构不符时返回空数组而不是抛错', () => {
  assert.deepEqual(parseValuationSnapshot(null), []);
  assert.deepEqual(parseValuationSnapshot({}), []);
  assert.deepEqual(parseValuationSnapshot({ data: { indexValuations: 'oops' } }), []);
});

test('parsePeTtmHistory：过滤非法行并按日期升序', () => {
  const points = parsePeTtmHistory({
    data: [
      { tradeDate: '20261111', indexName: '沪深300', peg: 13.14 },
      { tradeDate: '20261110', indexName: '沪深300', peg: 13.13 },
      { tradeDate: '20261109', indexName: '沪深300', peg: 13.17 },
      { tradeDate: '20261108', indexName: '沪深300', peg: 0 },
      { tradeDate: 'x', indexName: '沪深300', peg: 12 },
      { tradeDate: '20260231', indexName: '沪深300', peg: 12 },
    ],
  });
  assert.deepEqual(points.map((p) => p.tradeDate), ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.equal(points[2].peTtm, 13.14);
  assert.deepEqual(parsePeTtmHistory({ data: [] }), [], '国证系列返回空数组属正常边界');
  assert.deepEqual(parsePeTtmHistory({ data: null }), []);
});

test('parsePeTtmHistory：同日同值去重，不重复增加分位样本', () => {
  assert.deepEqual(parsePeTtmHistory({ data: [
    { tradeDate: '20261116', peg: 13.05 },
    { tradeDate: '20261113', peg: 13.07 },
    { tradeDate: '20261116', peg: '13.050' },
  ] }), [
    { tradeDate: '2026-11-13', peTtm: 13.07 },
    { tradeDate: '2026-11-16', peTtm: 13.05 },
  ]);
});

test('parsePeTtmHistory：同日异值明确报源数据冲突，不按响应顺序取舍', () => {
  for (const values of [[13.05, 99.99], [99.99, 13.05]]) {
    assert.throws(() => parsePeTtmHistory({ data: values.map((peg) => ({ tradeDate: '20261116', peg })) }), {
      code: 'SOURCE_INVALID', message: /同日数值冲突.*2026-11-16/,
    });
  }
});

test('fetch 入口传播源数据冲突，调用方可报告失败而不是当作未覆盖', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const data = String(input).includes('indexValuation')
      ? { tradeDate: '20261116', indexValuations: [{ tradeDate: '20261113', indexName: '沪深300', peg: 13.07 }] }
      : [{ tradeDate: '20261116', peg: 13.05 }, { tradeDate: '20261116', peg: 99.99 }];
    return new Response(JSON.stringify({ code: '200', data }), { status: 200 });
  });
  await assert.rejects(fetchPeTtmHistory('000300'), { code: 'SOURCE_INVALID' });
  await assert.rejects(fetchValuationSnapshot(), { code: 'SOURCE_INVALID' });
});

test('snapshotToMetrics：官方滚动 PE 写主键 pe，静态 PE 落独立键', () => {
  const metrics = snapshotToMetrics({
    tradeDate: '2026-11-11', indexName: '沪深300',
    pe: 13.83, peTtm: 13.14, pb: 1.29, dividendYield: 3.03,
    peLastYear: 14.5, peTtmLastYear: 14.1, pbLastYear: 1.4,
  });
  const byKey = new Map(metrics.map((m) => [m.metricKey, m.value]));
  assert.equal(byKey.get('pe'), '13.14', '滚动口径写 pe，供分位与横向比较统一使用');
  assert.equal(byKey.get('pe_official_static'), '13.83');
  assert.equal(byKey.get('pb'), '1.29');
  assert.equal(byKey.get('dividend_yield'), '3.03');
  assert.ok(metrics.every((m) => m.asOfDate === '2026-11-11' && m.quality === 'FRESH'));

  // 只有滚动 PE、没有 PB / 股息率时，不能凭空造 PB
  const partial = snapshotToMetrics({
    tradeDate: '2026-11-11', indexName: '科创50',
    pe: null, peTtm: 57.31, pb: null, dividendYield: null,
    peLastYear: null, peTtmLastYear: null, pbLastYear: null,
  });
  assert.deepEqual(partial.map((m) => m.metricKey), ['pe']);
});
