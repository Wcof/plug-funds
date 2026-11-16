/**
 * 构建脚本：Host bundle + Web SPA 产物 + 自包含校验。
 *
 * - Host：core + server + DSH glue → targets/dsh/investment/index.js（ESM 单文件，仅依赖 node: 内置）
 * - Web：React SPA → targets/dsh/investment/web/{app.js, app.css, index.html}
 * - --check：产物存在 + index.js 无裸外部导入（安装器不装依赖，必须自包含）+ 清单文件齐全
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(pluginDir, '..');
const dshPkg = path.join(pluginDir, 'targets', 'dsh', 'investment');
const webSrc = path.join(pluginDir, 'web', 'src');

const checkOnly = process.argv.includes('--check');
const hostOnly = process.argv.includes('--host-only');

async function buildHost() {
  await build({
    entryPoints: [path.join(pluginDir, 'targets', 'dsh', 'host', 'glue.ts')],
    outfile: path.join(dshPkg, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: [
        '/*',
        ' * 个人投资工作站 · DeepSeek Harness 插件（构建产物，勿手改）',
        ' * 自包含 ESM：仅依赖 node: 内置模块；源码在仓库 plugin/ 下，npm run build 重新生成。',
        ' */',
      ].join('\n'),
    },
  });
  console.log('[build] host bundle → targets/dsh/investment/index.js');
}

async function buildWeb() {
  const entry = path.join(webSrc, 'main.tsx');
  if (!fs.existsSync(entry)) {
    console.warn('[build] web/src/main.tsx 不存在，跳过 web 构建');
    return;
  }
  await build({
    entryPoints: { app: entry },
    outdir: path.join(dshPkg, 'web'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
  });
  const html = path.join(webSrc, 'index.html');
  if (fs.existsSync(html)) {
    fs.copyFileSync(html, path.join(dshPkg, 'web', 'index.html'));
  }
  console.log('[build] web spa → targets/dsh/investment/web/');
}

/** MCP 适配层（targets/mcp）：同一套 server 层，stdio JSON-RPC 暴露为工具。 */
async function buildMcp() {
  const entry = path.join(pluginDir, 'targets', 'mcp', 'server.ts');
  if (!fs.existsSync(entry)) return;
  await build({
    entryPoints: [entry],
    outfile: path.join(pluginDir, 'targets', 'mcp', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    banner: {
      js: [
        '/*',
        ' * 个人投资工作站 · MCP 适配层（构建产物，勿手改）',
        ' * 自包含 ESM：仅依赖 node: 内置模块；源码在 plugin/targets/mcp/server.ts。',
        ' */',
      ].join('\n'),
    },
  });
  console.log('[build] mcp adapter → targets/mcp/index.js');
}

function selfContainedCheck() {
  const problems = [];
  const indexJs = path.join(dshPkg, 'index.js');
  if (!fs.existsSync(indexJs)) {
    problems.push('index.js 不存在（先运行构建）');
  } else {
    const code = fs.readFileSync(indexJs, 'utf8');
    const bareImports = [...code.matchAll(/(?:from\s*|import\s*)(["'])([^"']+)\1/g)]
      .map((m) => m[2])
      .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../'));
    // 字符串扫描会把 URL / 注释里的点号误报，这里只拦截真正的 import 语句形态
    const realBareImports = bareImports.filter((spec) => !/^(https?:|data:)/.test(spec));
    if (realBareImports.length > 0) {
      problems.push(`index.js 存在裸外部导入（安装器不装依赖）: ${realBareImports.join(', ')}`);
    }
  }
  const required = ['client.js', 'cordis.patch.yml', 'package.json', 'icon.svg', 'locale/zh.json', 'locale/en.json'];
  for (const rel of required) {
    if (!fs.existsSync(path.join(dshPkg, rel))) problems.push(`缺少 ${rel}`);
  }
  const webIndex = path.join(dshPkg, 'web', 'index.html');
  const hasWeb = fs.existsSync(webIndex);

  // MCP 适配层同样要求自包含（可作为独立 Node 进程被 Zcode 等宿主拉起）。
  const mcpIndex = path.join(pluginDir, 'targets', 'mcp', 'index.js');
  if (fs.existsSync(mcpIndex)) {
    const mcpCode = fs.readFileSync(mcpIndex, 'utf8');
    const mcpBare = [...mcpCode.matchAll(/(?:from\s*|import\s*)(["'])([^"']+)\1/g)]
      .map((m) => m[2])
      .filter((spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../') && !/^(https?:|data:)/.test(spec));
    if (mcpBare.length > 0) problems.push(`targets/mcp/index.js 存在裸外部导入: ${mcpBare.join(', ')}`);
  }
  const zcodeManifest = path.join(pluginDir, 'targets', 'zcode', 'manifest.json');
  if (!fs.existsSync(zcodeManifest)) problems.push('缺少 targets/zcode/manifest.json（Zcode 适配清单）');

  return { problems, hasWeb };
}

if (checkOnly) {
  const { problems, hasWeb } = selfContainedCheck();
  if (!hasWeb) problems.push('web/index.html 不存在（SPA 未构建或未生成）');
  if (problems.length > 0) {
    console.error('[check] 自包含校验失败：');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('[check] 自包含校验通过（host + web + 清单齐全，无裸外部导入）');
} else {
  await buildHost();
  if (!hostOnly) {
    await buildWeb();
    await buildMcp();
  }
  const { problems } = selfContainedCheck();
  if (problems.length > 0) {
    console.warn('[check] 自包含校验提示：');
    for (const problem of problems) console.warn(`  - ${problem}`);
  }
}
