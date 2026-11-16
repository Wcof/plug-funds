/**
 * 指数「一键可用」回归（bootstrap_indices）。
 *
 * 背景：旧流程只有 seed_common_indices（建标的、不写数值），用户不点「刷新数据」就永远是
 * 满屏「—」，在界面上表现为「指数页没有数据」。bootstrap_indices 把「建标的 + 拉一次真实行情」
 * 合成一次调用；这里用 fixture 数据源锁定三件事：
 * 1. 建库与拉数都完成时，指数页立刻有真实数值；
 * 2. 数据源不可用时只报失败、不抛异常、不伪造 0；
 * 3. 重复调用幂等（不重复建标的）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry, type MarketProvider, type HistoryRequest } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import { listInstruments } from '../server/src/repo/instruments.ts';
import type { ServiceContext } from '../server/src/context.ts';
import type { Instrument, MarketPoint } from '../core/src/types.ts';

const TODAY = '2026-11-16';

/**
 * 单测禁止访问真实网络。
 * 中证官网接口在开发机上可达，若不拦住，fixture 断言会随当天真实行情漂移
 * （曾出现 13.4 被真实官方值 14.64 顶掉）。需要网络的验证放在 smoke / verify 脚本里。
 */
globalThis.fetch = (async () => {
  throw new Error('tests must not use network');
}) as typeof globalThis.fetch;

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

function openWith(registry: ServiceContext['registry']): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-idxboot-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry, today: TODAY, hideAmount: false };
}

/** 只覆盖指数的最小数据源：收盘 4000、PE 13.4、给 30 个交易日日线。 */
function fixtureProvider(): MarketProvider {
  const point = (instrumentId: string, date: string): MarketPoint => ({
    instrumentId,
    priceType: 'CLOSE_PRICE',
    value: '4000.0000',
    currency: 'CNY',
    tradingDate: date,
    observedAt: `${date}T07:00:00.000Z`,
    provider: 'fixture',
    quality: 'FRESH',
  });

  return {
    id: 'fixture',
    supports: (instrument: Instrument) => instrument.type === 'INDEX',
    async fetchQuote(instrument) {
      return { ...point(instrument.id, TODAY), priceType: 'REALTIME_PRICE' };
    },
    async fetchHistory(instrument, range: HistoryRequest) {
      const out: MarketPoint[] = [];
      const cursor = new Date(`${range.begin}T00:00:00Z`);
      while (out.length < 30 && cursor.toISOString().slice(0, 10) <= range.end) {
        if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) {
          out.push(point(instrument.id, cursor.toISOString().slice(0, 10)));
        }
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      return out;
    },
    async fetchMetrics(instrument) {
      return [{ metricKey: 'pe', value: '13.4', asOfDate: TODAY, quality: 'FRESH' as const }];
    },
  };
}

beforeEach(() => {
  openWith(createRegistry([]));
});

test('bootstrap_indices：无数据源时建库成功、拉数显式失败，不抛异常', async () => {
  const result = await rpc<{
    seeded: { created: string[]; total: number };
    refresh: { total: number; ok: number; failed: number; problems: { name: string; error: string }[] };
  }>('bootstrap_indices');

  assert.equal(result.seeded.created.length, 8);
  assert.equal(listInstruments(handle, { type: 'INDEX' }).length, 8);
  assert.equal(result.refresh.total, 8);
  assert.equal(result.refresh.ok, 0);
  assert.equal(result.refresh.failed, 8);
  assert.ok(result.refresh.problems.length > 0);
  assert.ok(result.refresh.problems[0].error.includes('无可用数据源'));

  const valuation = await rpc<{ rows: { close: number | null }[] }>('get_index_valuation');
  assert.equal(valuation.rows.length, 8);
  assert.ok(valuation.rows.every((row) => row.close === null), '没有数据源时不得伪造收盘点位');
});

test('bootstrap_indices：数据源可用时一次调用就能让指数页有真实数值', async () => {
  openWith(createRegistry([fixtureProvider()]));

  const result = await rpc<{
    seeded: { created: string[] };
    refresh: { total: number; ok: number; failed: number; problems: unknown[] };
    note: string;
  }>('bootstrap_indices');

  assert.equal(result.seeded.created.length, 8);
  assert.equal(result.refresh.total, 8);
  assert.equal(result.refresh.ok, 8);
  assert.equal(result.refresh.failed, 0);
  assert.equal(result.refresh.problems.length, 0);
  assert.ok(result.note.includes('已就绪'));

  const valuation = await rpc<{ rows: { code: string; close: number | null; pe: { current: number | null } }[] }>('get_index_valuation');
  assert.equal(valuation.rows.length, 8);
  for (const row of valuation.rows) {
    assert.equal(row.close, 4000, `${row.code} 收盘点位应来自数据源`);
    assert.equal(row.pe.current, 13.4, `${row.code} PE 应来自数据源`);
  }
});

test('bootstrap_indices：重复调用幂等，不重复建标的', async () => {
  openWith(createRegistry([fixtureProvider()]));

  await rpc('bootstrap_indices');
  const second = await rpc<{ seeded: { created: string[]; existing: string[]; total: number } }>('bootstrap_indices');

  assert.equal(second.seeded.created.length, 0);
  assert.equal(second.seeded.existing.length, 8);
  assert.equal(second.seeded.total, 8);
  assert.equal(listInstruments(handle, { type: 'INDEX' }).length, 8);
});
