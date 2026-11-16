/**
 * MCP 适配层回归：用真实子进程跑 stdio JSON-RPC，验证工具清单与调用链路。
 *
 * 这一层是「同一套 server 层给不同宿主用」的证明：DSH 走 webServer，Zcode 走 MCP，
 * 业务逻辑不重复实现。测试直接跑 .ts（Node 22 原生类型擦除），不依赖构建产物。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const serverEntry = path.join(pluginDir, 'targets', 'mcp', 'server.ts');
const manifestPath = path.join(pluginDir, 'targets', 'zcode', 'manifest.json');
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plug-funds-mcp-'));

const child = spawn(process.execPath, [serverEntry], {
  env: { ...process.env, PLUG_FUNDS_STATE_DIR: stateDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let seq = 0;
const pending = new Map<number, (msg: Record<string, unknown>) => void>();
const stderr: string[] = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line !== '') {
      const message = JSON.parse(line) as Record<string, unknown>;
      const id = message.id as number;
      const resolve = pending.get(id);
      if (resolve) { pending.delete(id); resolve(message); }
    }
    index = buffer.indexOf('\n');
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => stderr.push(chunk));

after(() => {
  try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
});

interface RpcReply {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function send(method: string, params: Record<string, unknown> = {}): Promise<RpcReply> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP 超时：${method}`)); }, 15_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message as RpcReply); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string }> {
  const reply = await send('tools/call', { name, arguments: args });
  const result = reply.result as { content: { text: string }[]; isError: boolean };
  return { isError: result.isError, text: result.content[0].text };
}

/* ---------------- 1. 握手 ---------------- */

test('initialize 返回协议版本与 serverInfo', async () => {
  const reply = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  const result = reply.result as { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: unknown } };
  assert.equal(result.protocolVersion, '2024-11-05');
  assert.equal(result.serverInfo.name, 'plug-funds');
  assert.deepEqual(result.capabilities.tools, { listChanged: false });
});

/* ---------------- 2. 工具清单 ---------------- */

test('tools/list 暴露 17 个工具，且每个都有 inputSchema', async () => {
  const reply = await send('tools/list');
  const tools = (reply.result as { tools: { name: string; description: string; inputSchema: { type: string } }[] }).tools;
  assert.equal(tools.length, 17);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} 缺少 object schema`);
    assert.ok(tool.description.length > 8, `${tool.name} 描述过短`);
  }
  const names = tools.map((t) => t.name);
  for (const expected of ['get_dashboard_summary', 'get_index_analytics', 'get_decision_readiness', 'record_transaction']) {
    assert.ok(names.includes(expected), `缺少工具 ${expected}`);
  }
});

test('Zcode manifest 与实际工具清单一致（防清单漂移）', async () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    id: string; kinds: string[]; runtime: { command: string; transport: string; args: string[] };
    tools: { name: string; readOnly: boolean }[];
  };
  const reply = await send('tools/list');
  const tools = (reply.result as { tools: { name: string }[] }).tools.map((t) => t.name);
  assert.equal(manifest.id, 'plug-funds');
  assert.deepEqual(manifest.kinds, ['mcp-stdio']);
  assert.equal(manifest.runtime.transport, 'stdio');
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), [...tools].sort());
});

/* ---------------- 3. 工具调用 ---------------- */

test('只读工具能返回本机真实数据（空库也不报错）', async () => {
  const positions = await callTool('list_positions');
  assert.equal(positions.isError, false, positions.text);
  const parsed = JSON.parse(positions.text) as { rows: unknown[]; totalMarketValue: string };
  assert.deepEqual(parsed.rows, []);
  assert.equal(parsed.totalMarketValue, '0');

  const readiness = await callTool('get_decision_readiness');
  assert.equal(readiness.isError, false, readiness.text);
  const score = JSON.parse(readiness.text) as { score: number; verdict: string; items: unknown[] };
  assert.ok(score.score >= 0 && score.score <= 100);
  assert.equal(score.items.length, 9);
  assert.equal(score.verdict, 'INSUFFICIENT');
});

test('写入工具落库后可被只读工具读回（同一进程内状态共享）', async () => {
  const saved = await callTool('save_cash_account', { name: 'MCP 现金', balance: '1234.5' });
  assert.equal(saved.isError, false, saved.text);

  const listed = await callTool('list_cash_accounts');
  const accounts = JSON.parse(listed.text) as { accounts: { name: string; balance: string }[] };
  assert.equal(accounts.accounts.length, 1);
  assert.equal(accounts.accounts[0].name, 'MCP 现金');
  assert.equal(accounts.accounts[0].balance, '1234.5');
});

test('参数校验失败时返回 isError 而不是崩溃', async () => {
  const bad = await callTool('save_cash_account', { name: '', balance: '10' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /validation-error|名称不能为空/);
});

test('未知工具与未知方法都给出明确错误', async () => {
  const unknownTool = await callTool('no_such_tool');
  assert.equal(unknownTool.isError, true);
  assert.match(unknownTool.text, /未知工具/);

  const unknownMethod = await send('no/such/method');
  assert.equal(unknownMethod.error?.code, -32601);
});

test('ping 可用（宿主健康检查）', async () => {
  const reply = await send('ping');
  assert.deepEqual(reply.result, {});
});

test('启动横幅走 stderr，不污染 stdout 的 JSON-RPC 流', () => {
  assert.ok(stderr.join('').includes('MCP server ready'), stderr.join(''));
});
