/**
 * AI 分析服务（PRD §4.11）。
 *
 * - 仅用户手动触发；OpenAI 兼容 /chat/completions；30s 有界超时；
 * - 发送范围：标的摘要（名称/代码/类型/金额/份额/成本/收益/区间表现/分类标签），不发送交易明细与他人持仓；
 * - Key 存系统钥匙串（不可用时才退回 SQLite 明文，并通过 secretBackend 如实上报）；日志与返回一律脱敏；
 * - 每次分析写 ai_analysis_records（scope + 结果），可回看。
 */
import { SCALE_AMOUNT, SCALE_QTY, formatFixed, parseFixed } from '../../../core/src/money.ts';
import type { AiSettings } from '../../../core/src/types.ts';
import type { ServiceContext } from '../context.ts';
import { getAiSettings, saveAiRecord, saveAiSettings, maskApiKey } from '../repo/settings.ts';
import { currentSecretBackend } from '../secrets.ts';
import { getInstrument } from '../repo/instruments.ts';
import { listHoldings } from './holdings.ts';
import { getInstrumentChartSeries } from './charts.ts';

export const AI_TIMEOUT_MS = 30_000;

export function aiConfigured(settings: AiSettings): boolean {
  return Boolean(settings.baseUrl && settings.apiKey && settings.model);
}

export function getAiStatus(ctx: ServiceContext): { configured: boolean; masked: AiSettings; secretBackend: string; scope: string } {
  const settings = getAiSettings(ctx.handle);
  return {
    configured: aiConfigured(settings),
    masked: { ...settings, apiKey: maskApiKey(settings.apiKey) },
    secretBackend: currentSecretBackend(),
    scope: '标的名称与代码、资产类型、账户（脱敏）、持有金额 / 份额 / 成本 / 收益、近 1 年走势摘要、自定义分类标签。不发送：交易流水明细、其他标的持仓、账户余额。',
  };
}

export function updateAiSettings(
  ctx: ServiceContext,
  input: { baseUrl?: string; apiKey?: string; model?: string },
): { configured: boolean; masked: AiSettings; secretBackend: string } {
  const next = saveAiSettings(ctx.handle, input);
  return {
    configured: aiConfigured(next),
    masked: { ...next, apiKey: maskApiKey(next.apiKey) },
    secretBackend: currentSecretBackend(),
  };
}

async function chatCompletion(
  ctx: ServiceContext,
  settings: AiSettings,
  messages: { role: string; content: string }[],
  maxTokens = 1200,
): Promise<string> {
  const url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: 0.4,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI 服务返回 ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    const payload = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('AI 服务未返回内容');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function testAiConnection(ctx: ServiceContext): Promise<{ ok: boolean; message: string }> {
  const settings = getAiSettings(ctx.handle);
  if (!aiConfigured(settings)) return { ok: false, message: '请先完整填写 Base URL、Key 与模型' };
  try {
    const reply = await chatCompletion(ctx, settings, [{ role: 'user', content: '请只回复两个字：连通' }], 16);
    return { ok: true, message: `连接成功（模型回复：${reply.slice(0, 20).replace(/\s+/g, ' ')}）` };
  } catch (error) {
    return { ok: false, message: `连接失败：${String((error as Error).message)}` };
  }
}

export interface AiAnalysisResult {
  instrumentId: string;
  code: string;
  name: string;
  model: string;
  source: 'REAL';
  content: string;
  recordId: string;
}

export async function analyzeHolding(ctx: ServiceContext, positionId: string): Promise<AiAnalysisResult> {
  const settings = getAiSettings(ctx.handle);
  if (!aiConfigured(settings)) {
    throw new Error('AI_NOT_CONFIGURED: 请先在「设置 → AI 配置」填写 Base URL、Key 与模型');
  }
  const [accountId, instrumentId] = positionId.split(':');
  const instrument = getInstrument(ctx.handle, instrumentId);
  if (!instrument) throw new Error(`instrument not found: ${instrumentId}`);
  const holdings = listHoldings(ctx, { accountId });
  const holding = holdings.rows.find((r) => r.instrumentId === instrumentId);
  if (!holding) throw new Error(`holding not found: ${positionId}`);

  // 近 1 年走势摘要（不发送原始明细）
  let trendSummary = '无历史数据';
  try {
    const chart = await getInstrumentChartSeries(ctx, { instrumentId, tab: 'perf', period: '1y', compare: 'none' });
    if (chart.series.length >= 2) {
      const first = Number(chart.series[0].value);
      const last = Number(chart.series[chart.series.length - 1].value);
      trendSummary = `近 1 年 ${chart.series[0].date} → ${chart.series[chart.series.length - 1].date}，${first} → ${last}（${(((last / first) - 1) * 100).toFixed(1)}%），共 ${chart.series.length} 个交易日`;
    }
  } catch {
    /* 摘要失败不阻塞分析 */
  }

  const categoriesText = holding.categories.names.length > 0 ? holding.categories.names.join('、') : '未分类';
  const scope = {
    name: instrument.name,
    code: instrument.code,
    type: instrument.type,
    accountMasked: `${holding.accountName.slice(0, 2)}**`,
    marketValue: holding.marketValue,
    qty: holding.qty,
    unitCost: holding.unitCost,
    costTotal: holding.costTotal,
    pnl: holding.pnl,
    pnlRate: holding.pnlRate,
    portfolioWeight: holding.weight === null ? null : `${(holding.weight * 100).toFixed(2)}%`,
    trend1y: trendSummary,
    categories: categoriesText,
  };

  const prompt = [
    '你是个人投资研究助手。基于用户提供的单一持仓摘要，给出结构化分析，包含：整体评价、值得关注的点（2-3 条）、风险提示（2-3 条）、参考结论。',
    '要求：中文；客观；不构成投资建议；不预测具体价格；最后必须附一行免责声明。',
    `持仓摘要（JSON）：${JSON.stringify(scope)}`,
  ].join('\n');

  const content = await chatCompletion(ctx, settings, [
    { role: 'system', content: '你是严谨的个人投资分析助手，输出简体中文，始终附免责声明。' },
    { role: 'user', content: prompt },
  ]);

  const record = saveAiRecord(ctx.handle, {
    instrumentId,
    model: settings.model,
    source: 'REAL',
    promptScope: JSON.stringify(scope),
    result: content,
  });

  return {
    instrumentId,
    code: instrument.code,
    name: instrument.name,
    model: settings.model,
    source: 'REAL',
    content,
    recordId: record.id,
  };
}
