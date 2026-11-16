/**
 * 打包 DSH 插件 tarball（npm pack 封装）：
 * 先执行完整构建与自包含校验，再在 targets/dsh/investment/ 下 npm pack，
 * 产物输出到 integrations/dsh/dist/。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(pluginDir, '..');
const dshPkg = path.join(pluginDir, 'targets', 'dsh', 'investment');
const distDir = path.join(repoRoot, 'integrations', 'dsh', 'dist');

execFileSync('node', [path.join(pluginDir, 'scripts', 'build.mjs')], { stdio: 'inherit' });

// 同一份产物同时承载两种宿主形态：DSH 插件（index.js + web）与 MCP（mcp/index.js）。
// 把 MCP 入口与 Zcode 清单搬进包内，安装一次即可被两类宿主发现。
const mcpSrc = path.join(pluginDir, 'targets', 'mcp', 'index.js');
const mcpDir = path.join(dshPkg, 'mcp');
fs.mkdirSync(mcpDir, { recursive: true });
fs.copyFileSync(mcpSrc, path.join(mcpDir, 'index.js'));
fs.copyFileSync(path.join(pluginDir, 'targets', 'zcode', 'manifest.json'), path.join(mcpDir, 'manifest.json'));

fs.mkdirSync(distDir, { recursive: true });
const out = execFileSync('npm', ['pack', dshPkg, '--pack-destination', distDir], {
  cwd: repoRoot,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});
// npm pack 最后一行是真实文件名；scoped 包不会带 @scope/ 前缀，不能用包名拼接。
const tarballName = out.trim().split('\n').at(-1)?.trim() ?? '';
const tarballPath = path.join(distDir, tarballName);
if (!tarballName.endsWith('.tgz') || !fs.existsSync(tarballPath)) {
  console.error(`[pack] 无法确定 tarball 文件名：${JSON.stringify(out)}`);
  process.exit(1);
}
console.log(`[pack] ${tarballName}`);
console.log(`[pack] 安装：install_bundle target=${tarballPath}`);
