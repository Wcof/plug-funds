# 投资工作站（@plug-funds/dsh-investment）

DeepSeek Harness 插件，自包含：Host ESM（`index.js`）+ Client 薄壳（`client.js`）+ 同源 SPA（`web/`）+ MCP 入口（`mcp/`），
运行时只依赖 Node 内置模块，安装器不需要安装任何依赖。

## 安装

```text
install_bundle target=<插件 tarball 的绝对路径>
```

开发期可用目录链接（改完源码重新构建并重启 DSH 窗口即生效）：

```text
install_bundle target=<plugin/targets/dsh/investment 的绝对路径>
```

安装后重启 DSH 窗口，侧栏出现「投资工作站」入口，主面板打开完整界面。
卸载：`remove_bundle target=@plug-funds/dsh-investment`（**不删除用户数据**）。

## 数据

- 数据根：`~/.plug-funds/`，权威库 `data/invest.db`（SQLite WAL）。
- 当前 `SCHEMA_VERSION = 3`；数据 schema 版本高于插件时拒绝打开（先升级插件，不降级写入）；迁移前自动备份。
- 交易流水是唯一事实源，持仓为回放投影；金额 i64 定点（金额 2 位、份额/净值/价格 4 位，ROUND_DOWN）；交易以 `requestId` 幂等。
- 流水导入支持 **CSV 与 .xlsx**（预览 / 错误行 / 单事务 / 失败整批回滚）；.xlsx 在自包含约束下自行解析 ZIP + XML，不装依赖；`.xls` 老格式请先另存为 .xlsx。
- JSON 全量备份恢复（校验 / 预览 / 恢复前自动备份当前库 / 一致性检查）。
- 测试与隔离运行用 `PLUG_FUNDS_STATE_DIR` 指向临时目录。

## 页面与接口

- Host 同源托管 `GET /plug-funds/`（静态 SPA）与 `POST /plug-funds/api/rpc`（JSON-RPC 风格方法表，60 个方法）。
- RPC 响应统一 `{ success, data, error, traceId }`；只接受同源 POST，响应 `Cache-Control: no-store`。
- 错误码：`422 validation-error`（输入 / 外部数据校验失败）、`404 not-found`、账本冲突 `422`、schema 冲突 `409`、未知方法 `404 unknown-method`、程序故障 `500 internal-error`。
- 「隐藏金额」只掩码展示类响应（含总资产 / 现金合计 / 覆盖市值）；导出 / 备份 / 配置 / AI / 导入 / 恢复等数据出口不受影响，导出的 JSON 始终含真实数值。
- 行情自动刷新由 Host `effect` 生命周期托管：默认 60 秒、可关闭、可配间隔（15–3600 秒）、可切换「仅交易时段」；定时器 `unref()`，不阻塞宿主退出，卸载时清理。交易时段判断走真实交易日历（指数日线反推，周末恒休市；样本不足时退回工作日并显式标注）。
- **决策就绪度**：`get_decision_readiness` 返回 9 个决策维度的完备度（OK / PARTIAL / MISSING）、现状、补齐动作与 0–100 分，并附集中度（Top1 / Top3 / HHI / 有效持仓数）；缺数据不按 0 处理，分数只描述信息完备度。
- **组合风险与配置**：现金账户、再平衡（目标权重 vs 实际权重，未设目标时全 HOLD，仅建议不下单）、相关性矩阵（皮尔逊，样本 <20 为 null）、风险参数（无风险利率 / Beta / 跟踪误差 / 年化波动 / ERP）。
- **「指数」页**：结构 / 样式 / 交互复刻 `touzid.com/indice/#/6`，16 项二级菜单全部可切换（列表 / 指标自定义 / ETF / 财务对比 / 历史涨跌幅 / 相关性 / RPS / 波动率 / 新高 / 新低 / 图形对比 / 定投 / 格雷厄姆 / 股债性价比 + 互联互通 / 两融空态）。数值只取本机 `type=INDEX` 标的的 `valuation_metrics` / `market_points`，不复制第三方行情；无 INDEX 标的时为「结构预览」，数值列恒为「—」；数据源未覆盖的视图写明「需要什么数据」而不是填 0。
- SPA 入口 `web/index.html` 加载 IIFE `app.js`，挂载由 `app.js` 内的 `createRoot()` 完成；favicon 为内联 data URI，不向宿主根请求 `/favicon.ico`。

## 行情与 AI

- **多源行情**：腾讯财经为主源（`qt.gtimg.cn` 实时 / `web.ifzq.gtimg.cn` K 线，覆盖 A 股 / ETF / 指数 / 港股 / 美股 / 场外基金最新净值），东财兜底（`push2` 报价与 K 线、`f10/lsjz` 与 `pingzhongdata` 场外基金净值、估值明细），手工价格保底。
- 多源交叉校验：同一标的同一天两个来源相对差 >1% 时标记 `CONFLICT` 并保留双方记录，不擅自选一个当正确答案。
- 有效价格统一口径 `MANUAL_PRICE > 当日 REALTIME > CLOSE / OFFICIAL_NAV`，同日多来源去重；`ESTIMATED_NAV` 不进入计价 / 表现指标序列。
- 缺数据显示「— / 样本不足」，不静默填 0；PE / PB 历史分位样本 <20 不写。
- 本机实测（2026-11-15）：腾讯、东财 `f10/lsjz`、`pingzhongdata` 可用；东财 `push2` / `push2his` 为 HTTP 000（网络环境相关），由腾讯主源承担；`fundgz` 盘中估算端点已下线（恒返回 404 页），估算链路当前不可用，不会写入伪造估值。
- **AI 分析**：仅手动触发，OpenAI 兼容；Key 存系统钥匙串（macOS `security` / Linux `secret-tool`），SQLite 只留哨兵 `__keychain__`，钥匙串不可用时降级并在 `secretBackend` 如实上报；老库明文在启动时自动迁移。

## MCP（Zcode 等 MCP 宿主）

- `mcp/index.js` 是 stdio MCP server（换行分隔 JSON-RPC 2.0，协议版本 `2024-11-05`），暴露 17 个工具，复用同一套 server 层，不复制业务逻辑、不产生第二份数据。
- `mcp/manifest.json` 声明 transport / entry / 协议版本 / 工具列表 / 权限（filesystem、network 域名），供 MCP 宿主读取。
- 启动横幅写 stderr，stdout 只输出 JSON-RPC，避免污染协议流。

## 从源码重建

在仓库根目录执行：

```bash
npm install
npm test                   # 162 个测试
npm run check              # 自包含校验（含 MCP 产物）+ web 产物静态断言 + 全部测试
npm run verify:web         # web 静态断言 + 真实 Chrome CDP 渲染验证（69 项）
npm run pack:dsh           # 产物：integrations/dsh/dist/*.tgz
npm run verify:install     # 解包 tarball + 安装契约（含 SPA 挂载 / 指数页 / MCP）+ 隔离 RPC（41 项，不写真实 ~/.dsh）
```
