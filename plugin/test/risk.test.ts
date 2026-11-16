/**
 * 风险统计回归：纯函数数学正确性 + RPC 口径（缺数据必须 null，不能用 0 冒充）。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openState, resolveStateDirs, type DbHandle } from '../server/src/db.ts';
import { createRegistry } from '../server/src/market/provider.ts';
import { dispatch } from '../server/src/api.ts';
import {
  annualizedVolatility, beta, correlation, equityRiskPremium, trackingError,
} from '../core/src/risk.ts';
import { DEFAULT_RISK_FREE_RATE } from '../server/src/services/risk.ts';
import type { ServiceContext } from '../server/src/context.ts';

const TODAY = '2026-11-13';

let handle!: DbHandle;
let ctx!: ServiceContext;

async function rpc<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const result = await dispatch(ctx, method, params);
  assert.equal(result.status, 200, `${method} 失败：${JSON.stringify(result.envelope.error)}`);
  return result.envelope.data as T;
}

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-risk-'));
  const dirs = resolveStateDirs({ PLUG_FUNDS_STATE_DIR: tmp } as NodeJS.ProcessEnv);
  handle = openState(dirs, { inMemory: true });
  ctx = { handle, dirs, registry: createRegistry([]), today: TODAY, hideAmount: false };
});

/* ---------------- 纯函数 ---------------- */

test('correlation：完全正相关 / 完全负相关 / 样本不足', () => {
  assert.equal(correlation([0.01, 0.02, 0.03, 0.04], [0.02, 0.04, 0.06, 0.08]), 1);
  assert.equal(correlation([0.01, 0.02, 0.03, 0.04], [0.04, 0.03, 0.02, 0.01]), -1);
  assert.equal(correlation([0.01], [0.02]), null);
  assert.equal(correlation([0.01, 0.02], [0.02, 0.01, 0.03]), null);
  // 常数序列没有方差 → 不能算相关系数
  assert.equal(correlation([0.01, 0.01], [0.02, 0.03]), null);
});

test('beta：同序列为 1，两倍波动为 2', () => {
  const bench = [0.01, -0.02, 0.03, -0.01];
  assert.equal(beta(bench, bench), 1);
  assert.equal(beta(bench.map((v) => v * 2), bench), 2);
  assert.equal(beta(bench, [0, 0, 0, 0]), null);
});

test('trackingError：完全跟踪为 0，偏离越大越高', () => {
  const bench = [0.01, -0.02, 0.03, -0.01];
  assert.equal(trackingError(bench, bench), 0);
  const loose = trackingError([0.02, -0.01, 0.01, 0.02], bench);
  assert.ok(loose !== null && loose > 0);
});

test('annualizedVolatility：样本不足返回 null', () => {
  assert.equal(annualizedVolatility([0.01]), null);
  const vol = annualizedVolatility([0.01, -0.01, 0.02, -0.02, 0.005]);
  assert.ok(vol !== null && vol > 0);
});

test('equityRiskPremium：1/PE - 无风险利率；PE 缺失为 null', () => {
  assert.equal(equityRiskPremium(10, 0.015), 0.085);
  assert.equal(equityRiskPremium(0, 0.015), null);
  assert.equal(equityRiskPremium(null, 0.015), null);
  assert.equal(equityRiskPremium(-5, 0.015), null);
});

/* ---------------- RPC ---------------- */

test('get_portfolio_risk：空库时风险指标为 null 并说明缺基准', async () => {
  const risk = await rpc<{
    volatility: number | null; beta: number | null; correlation: number | null;
    trackingError: number | null; erp: number | null;
    benchmark: { instrumentId: string | null }; note: string; riskFreeRate: number;
  }>('get_portfolio_risk', { range: '1y' });
  assert.equal(risk.volatility, null);
  assert.equal(risk.beta, null);
  assert.equal(risk.correlation, null);
  assert.equal(risk.trackingError, null);
  assert.equal(risk.benchmark.instrumentId, null);
  assert.equal(risk.riskFreeRate, DEFAULT_RISK_FREE_RATE);
  assert.match(risk.note, /基准/);
});

test('save_risk_settings：合法值写入并回读，越界报错', async () => {
  const saved = await rpc<{ riskFreeRate: number }>('save_risk_settings', { riskFreeRate: 0.025 });
  assert.equal(saved.riskFreeRate, 0.025);
  const risk = await rpc<{ riskFreeRate: number }>('get_portfolio_risk', {});
  assert.equal(risk.riskFreeRate, 0.025);

  const bad = await dispatch(ctx, 'save_risk_settings', { riskFreeRate: 0.9 });
  assert.equal(bad.status, 422);
  assert.equal(bad.envelope.error?.code, 'validation-error');
});

test('get_correlation_matrix：持仓不足 2 只时给出明确说明', async () => {
  const matrix = await rpc<{ codes: string[]; matrix: (number | null)[][]; note: string }>('get_correlation_matrix', {});
  assert.equal(matrix.codes.length, 0);
  assert.match(matrix.note, /少于 2 只|相关性/);
});
