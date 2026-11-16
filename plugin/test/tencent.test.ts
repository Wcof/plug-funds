/**
 * 腾讯财经适配器解析回归（fixture 锁定，不联网）。
 *
 * 真实响应为 GBK 编码，这里保存已解码文本；重点锁定：
 * - A 股 / 指数 / ETF / 港股 / 美股的字段位次差异（PB 只在 A 股取）；
 * - 三种时间格式归一；
 * - PB=0 / PE 空值必须落 null，不能当 0；
 * - 场外基金走 OFFICIAL_NAV，不是 REALTIME。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeTencentFields, decodeTencentFundFields, normalizeTencentDate,
  parseTencentFields, parseTencentFundQuote, parseTencentKline, parseTencentMetrics,
  parseTencentQuote, tencentSymbol,
} from '../server/src/market/tencent.ts';
import type { Instrument } from '../core/src/types.ts';

const TODAY = '2026-11-13';

const FIXTURE = {
  stock: 'v_sh600519="1~贵州茅台~600519~1435.26~1410.27~1404.00~41780~22449~19331~1435.00~1~1434.80~1~1434.68~1~1434.60~1~1434.55~1~1435.26~2~1435.27~3~1435.38~6~1435.49~9~1435.50~9~~20261113161455~24.99~1.77~1437.69~1394.00~1435.26/41780/5954834070~41780~595483~0.33~21.84~~1437.69~1394.00~3.10~17941.92~17941.92~6.62~1551.30~1269.24~1.28~-24~1425.29~20.87~21.80~~~-0.04~595483.4070~200.9364~14~   A~GP-A";',
  index: 'v_sh000300="1~沪深300~000300~4016.29~4043.93~4047.77~179341998~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261113161409~-27.64~-0.68~4052.06~4004.50~4016.29/179341998/460245657531~179341998~46024566~0.53~13.44~~4052.06~4004.50~1.18~481800.65~508401.26~0.00~-1~-1~1.07~0~4029.50";',
  etf: 'v_sh510300="1~沪深300ETF华泰柏瑞~510300~4.083~4.114~4.124~8510502~3600583~4909919~4.082~2886~4.081~1905~4.080~2441~4.079~3238~4.078~4218~4.083~7052~4.084~2138~4.085~18563~4.086~2095~4.087~1631~~20261113161447~-0.031~-0.75~4.127~4.076~4.083/8510502/3489035672~8510502~348904~1.87~~~4.127~4.076~1.24~1862.80~1862.80~0.00~4.525~3.703~0.74~-16791~4.100";',
  hk: 'v_hk00700="100~腾讯控股~00700~386.600~398.800~393.000~31493353.0~0~0~386.600~0~0~0~0~0~0~0~0~0~386.600~0~0~0~0~0~0~0~0~0~31493353.0~2026/11/13 16:08:22~-12.200~-3.06~395.200~385.600~386.600~31493353.0~12251162809.622~0~14.12~~0~0~2.41~35152.1649~35152.1649~TENCENT~1.37";',
  us: 'v_usAAPL="200~苹果~AAPL.OQ~356.27~354.88~357.96~40027467~0~0~355.33~40~0~0~0~0~0~0~0~0~355.40~120~0~0~0~0~0~0~0~0~~2026-11-13 16:00:01~1.39~0.39~360.83~355.75~USD~40027467~14318623506~0.28~39.67~~39.67~~1.43~51741.48713~51773.80481~Apple Inc.~8.98";',
  fund: 'v_jj110022="110022~易方达消费行业股票~0.0000~0.0000~~2.9800~2.9800~1.8107~2026-11-13~";',
};

const KLINE_FIXTURE = {
  code: 0,
  msg: '',
  data: {
    sh510300: {
      qfqday: [
        ['2026-11-11', '4.125', '4.150', '4.162', '4.109', '10560363.000'],
        ['2026-11-12', '4.145', '4.114', '4.177', '4.108', '11631446.000'],
        ['2026-11-13', '4.124', '4.083', '4.127', '4.076', '8510502.000'],
      ],
      qt: {},
    },
  },
};

function instrument(partial: Partial<Instrument>): Instrument {
  return {
    id: 'i1', code: '600519', name: 'x', type: 'STOCK', market: 'SH',
    currency: 'CNY', active: true, createdAt: TODAY, updatedAt: TODAY,
    ...partial,
  } as Instrument;
}

test('字段切分：能从 v_xxx="..." 中取出 ~ 分隔字段', () => {
  const fields = parseTencentFields(FIXTURE.stock);
  assert.ok(fields);
  assert.equal(fields[1], '贵州茅台');
  assert.equal(fields[2], '600519');
});

test('A 股：价格 / PE / PB / 换手 / 总市值 全部解析', () => {
  const decoded = decodeTencentFields(parseTencentFields(FIXTURE.stock)!);
  assert.ok(decoded);
  assert.equal(decoded.marketFlag, '1');
  assert.equal(decoded.price, 1435.26);
  assert.equal(decoded.prevClose, 1410.27);
  assert.equal(decoded.tradingDate, '2026-11-13');
  assert.equal(decoded.pe, 21.84);
  assert.equal(decoded.pb, 6.62);
  assert.equal(decoded.turnoverRate, 0.33);
  assert.equal(decoded.totalCapYi, 17941.92);
});

test('指数：PE 可取，PB=0 必须落 null（不能当 0）', () => {
  const decoded = decodeTencentFields(parseTencentFields(FIXTURE.index)!);
  assert.ok(decoded);
  assert.equal(decoded.price, 4016.29);
  assert.equal(decoded.pe, 13.44);
  assert.equal(decoded.pb, null);
});

test('ETF：PE / PB 缺失时为 null，价格仍可用', () => {
  const decoded = decodeTencentFields(parseTencentFields(FIXTURE.etf)!);
  assert.ok(decoded);
  assert.equal(decoded.price, 4.083);
  assert.equal(decoded.pe, null);
  assert.equal(decoded.pb, null);
});

test('港股：斜杠时间归一，PB 位是名称不能误取', () => {
  const decoded = decodeTencentFields(parseTencentFields(FIXTURE.hk)!);
  assert.ok(decoded);
  assert.equal(decoded.marketFlag, '100');
  assert.equal(decoded.tradingDate, '2026-11-13');
  assert.equal(decoded.pe, 14.12);
  assert.equal(decoded.pb, null);
  assert.equal(decoded.totalCapYi, 35152.1649);
});

test('美股：短横线时间归一，PB 位是公司名不能误取', () => {
  const decoded = decodeTencentFields(parseTencentFields(FIXTURE.us)!);
  assert.ok(decoded);
  assert.equal(decoded.marketFlag, '200');
  assert.equal(decoded.tradingDate, '2026-11-13');
  assert.equal(decoded.pe, 39.67);
  assert.equal(decoded.pb, null);
});

test('时间归一：三种格式一致，非法输入返回 null', () => {
  assert.equal(normalizeTencentDate('20261113161455'), '2026-11-13');
  assert.equal(normalizeTencentDate('2026/11/13 16:08:22'), '2026-11-13');
  assert.equal(normalizeTencentDate('2026-11-13 16:00:01'), '2026-11-13');
  assert.equal(normalizeTencentDate(''), null);
  assert.equal(normalizeTencentDate('2026-13-40'), null);
});

test('场外基金：净值走 OFFICIAL_NAV，不是实时价', () => {
  const decoded = decodeTencentFundFields(parseTencentFields(FIXTURE.fund)!);
  assert.ok(decoded);
  assert.equal(decoded.nav, 2.98);
  assert.equal(decoded.tradingDate, '2026-11-13');

  const quote = parseTencentFundQuote(FIXTURE.fund, 'f1', TODAY);
  assert.ok(quote);
  assert.equal(quote.priceType, 'OFFICIAL_NAV');
  assert.equal(Number(quote.value), 2.98);
  assert.equal(quote.provider, 'tencent');
});

test('实时价：交易日等于今天为 REALTIME，否则 CLOSE', () => {
  const today = parseTencentQuote(FIXTURE.stock, 'i1', TODAY);
  assert.equal(today?.priceType, 'REALTIME_PRICE');
  const past = parseTencentQuote(FIXTURE.stock, 'i1', '2026-11-20');
  assert.equal(past?.priceType, 'CLOSE_PRICE');
  assert.equal(past?.quality, 'DELAYED');
});

test('K 线：取收盘价，跳过非法行', () => {
  const points = parseTencentKline(KLINE_FIXTURE, 'sh510300', 'i1');
  assert.equal(points.length, 3);
  assert.equal(points[0].tradingDate, '2026-11-11');
  assert.equal(Number(points[0].value), 4.15);
  assert.equal(Number(points[2].value), 4.083);

  const broken = parseTencentKline({ data: { sh510300: { qfqday: [['bad', '1', '2'], ['2026-11-13', '1', '0']] } } }, 'sh510300', 'i1');
  assert.equal(broken.length, 0);
});

test('估值指标：A 股产出 pe / pb / turnover_rate / scale_info', () => {
  const metrics = parseTencentMetrics(FIXTURE.stock, 'i1', TODAY);
  const byKey = new Map(metrics.map((m) => [m.metricKey, m.value]));
  assert.equal(byKey.get('pe'), '21.84');
  assert.equal(byKey.get('pb'), '6.62');
  assert.equal(byKey.get('turnover_rate'), '0.33');
  assert.match(byKey.get('scale_info') ?? '', /总市值 \d+ 亿/);

  // 指数只有 PE，不产生 pb
  const indexMetrics = parseTencentMetrics(FIXTURE.index, 'idx', TODAY);
  assert.ok(!indexMetrics.some((m) => m.metricKey === 'pb'));
});

test('代码映射：SH / SZ / HK / US / 场外基金 / 东财 secid', () => {
  assert.equal(tencentSymbol(instrument({ market: 'SH', code: '600519' })), 'sh600519');
  assert.equal(tencentSymbol(instrument({ market: 'SZ', code: '000001' })), 'sz000001');
  assert.equal(tencentSymbol(instrument({ market: 'HK', code: '00700' })), 'hk00700');
  assert.equal(tencentSymbol(instrument({ market: 'US', code: 'AAPL' })), 'usAAPL');
  assert.equal(
    tencentSymbol(instrument({ type: 'OPEN_END_FUND', fundCode: '110022', market: 'OTC' })),
    'jj110022',
  );
  assert.equal(
    tencentSymbol(instrument({ secid: '1.600519', market: 'SH' })),
    'sh600519',
  );
  assert.equal(
    tencentSymbol(instrument({ secid: '116.00700', market: 'HK' })),
    'hk00700',
  );
  assert.equal(tencentSymbol(instrument({ market: 'OTC', code: 'X' })), null);
});
