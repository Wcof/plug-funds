# AGENTS.md — 个人投资工作站（plug-funds）

## 项目定位

本地优先的个人投资工作站，以 **DeepSeek Harness（DSH / DeepSeekBox）插件**形态交付：管理 A 股、场内 ETF、场外公募基金的账本、行情、估值观察、组合风险与 AI 分析。不接券商交易、不上传云端、不自动下单；金额一律 i64 定点（金额 2 位、份额净值 4 位、ROUND_DOWN）。

## 文档

- 产品需求与架构（唯一内容源）：`/Users/ldh/Downloads/investment-workstation-prd-v1.1.md`（文件名保留 v1.1，内容版本以文内修订记录为准，当前 v1.4）
- 架构与旧项目对照：`docs/design/optimization-plan.md`
- 进度快照：`ROADMAP.md`
- Goal 施工清单与交付记录：`goals/20261115-1740-dsh-investment-plugin.md`
- UI 原型（样式确认完成，保留参照）：`.tmp/prototype/index.html`

## 工程结构

```text
plugin/
├─ core/        # 宿主无关领域层（TS 纯函数：money/ledger/goal/valuation/risk/portfolio-risk/calendar/categories/strategy/rpc）
├─ server/      # Node 侧（node:sqlite 存储、migration、仓库层、服务层、api.ts 分发）
│  ├─ market/   # Provider Adapter：tencent（主源）/ eastmoney（兜底 + 基金净值）/ provider 注册表 / conflict 冲突检测
│  ├─ services/ # dashboard / holdings / valuation-view / refresh / backup / import / restore / ai / indices
│  │            # decision-readiness / risk / rebalance / calendar / index-valuation / index-analytics
│  ├─ repo/     # accounts/instruments/transactions/categories/market/goal/ai/settings/cash/strategies/refresh-settings
│  ├─ xlsx.ts   # 自包含 .xlsx 解析（ZIP + XML，复用 CSV 导入链路）
│  └─ secrets.ts# 系统钥匙串读写（macOS security / Linux secret-tool）
├─ web/         # React SPA（esbuild 打包，自绘 SVG 图表，零运行时外部依赖）
│  └─ src/      # pages / features / portfolio（现金·再平衡·相关性·风险参数）/ index-page / index-views
├─ targets/
│  ├─ dsh/      # DSH 适配（host/glue.ts + client.js + 清单文件；构建产物在 investment/ 下）
│  ├─ mcp/      # MCP stdio 适配（17 工具，复用 server 层）
│  └─ zcode/    # MCP 宿主清单（manifest.json）
├─ scripts/     # build.mjs / pack.mjs / smoke.mjs / verify-web.mjs / verify-install.mjs
└─ test/        # node:test（core 单测 / API 集成 / 行情 fixture / 日历 / xlsx / 钥匙串 / MCP / 指数分析）
```

## 核心约定

- **DSH 适配知识只允许出现在 `plugin/targets/dsh/`**：core 与 server 不 import 任何 DSH API，宿主无关、RPC 方法表可复用。MCP 适配（`targets/mcp/`）与 DSH 适配并列，同样只做协议转换、不复制业务逻辑；ZCode 是 MCP **客户端**消费方，不得反过来做成 server（`HOST_CAPABILITIES.md` §4「不建议接」，`DeepSeekBox/src/adapters/zcode-dsh/` 未实测）。
- 插件包必须自包含（安装器不装依赖）：构建产物 `index.js` / `web/*` / `mcp/index.js` 只依赖 `node:` 内置；`npm run check` 校验。
- DSH 纪律（ADR-0048 / 交接文档 §8「坑与纪律」）：不自建 webview、不反代其他产品、不产生 .app / 固定端口 / 第二数据权威；XFO/CSP 禁止的是对无 grant 响应改写或剥离（带签名 embed grant 的 HTML 可设 `frame-ancestors` 并省略 XFO，本项目同源自托管 SPA 不涉及 grant）；client 用 `window.__ModuleLoader__.load`，React 取宿主 `require('react')`。
- **Client 工厂 id 必须等于包名**：`client.js` 的 `window.__ModuleLoader__.load({ id })` 要写 `@plug-funds/dsh-investment`（= `package.json` 的 `name`），**不是** `cordis.patch.yml` 的 row id（`plugfunds-investment`）。宿主按包名从客户端模块图取 factory，写错只会让浏览器侧报 `client-modules: no registered factory for "<包名>"` 并**静默丢弃整块侧栏入口**——Host 半边照常跑（`~/.plug-funds/data` 生成、`/plug-funds/` 路由 200）、安装器也报成功，很容易误判成「装上了但没界面」。`npm run verify:install` 已加断言锁死这一点。
- **插件展示名来自 locale JSON 的嵌套 `meta`**：`locale/{zh,en}.json` 必须是 `{ "meta": { "title": ..., "description": ... } }`；扁平 `"meta.title"` 键不会被读取，插件管理器会退回显示包名。`package.json` 的 `dsh.meta` 在 0.2.2-rc.3 中未被读取，不要指望它。
- 数据权威：`~/.plug-funds/data/invest.db`（SQLite WAL，当前 schema v3）；流水唯一事实源；schema 高于运行时 → 拒绝打开；测试一律 `PLUG_FUNDS_STATE_DIR` 隔离。
- 有效价格口径：所有历史序列一律走 `repo/market.ts` 的 `effectiveHistoryPoints()`（`MANUAL_PRICE > 当日 REALTIME > CLOSE / OFFICIAL_NAV`，同日去重）；`ESTIMATED_NAV` 永不进入计价 / 表现指标；禁止按单一 priceType 自行读历史，避免手工价格不参与 XIRR。
- 隐藏金额豁免：`api.ts` 的 `MASK_EXEMPT` 覆盖导出 / 备份 / 配置 / AI / 导入 / 恢复等数据出口；任何新增写数据或导出类 RPC 必须先判断是否豁免，绝不把掩码值写回持久化数据。新增金额类展示字段（含 `cashTotal` / `totalAssets` / `coveredValue` / `balance`）必须同步 `MASKED_KEYS`。
- 输入错误分类：用户 / 外部数据问题用 `ValidationError`（422）、资源不存在用 `NotFoundError`（404），不得落回 500 internal-error。
- 单击持仓列表 = 标的详情、双击 = 持仓详情；行内 AI 分析 + ⋯ 菜单；分类仅「名称 + 颜色」可选非必填。
- AI 分析仅手动触发、OpenAI 兼容、来源标识；正式净值与估算严格分离；百分比必须标注分母口径。
- 不用模拟数据冒充真实行情 / 真实 AI；缺数据显示「— / 样本不足」，不静默填 0。
- **SPA 挂载入口**：`web/index.html` 只加载 esbuild 产出的 IIFE `app.js`，不会自动渲染；`web/src/main.tsx` 必须保留 `createRoot(document.getElementById('root')).render(<App />)`。HTTP 200 / RPC 全绿不代表页面可见，改 web 后必须跑 `npm run verify:web`（真实 Chrome CDP）。`index.html` 的 favicon 用内联 data URI，避免浏览器向宿主根请求 `/favicon.ico` 产生 404。
- **静态资源不许 immutable**：构建产物文件名没有 content hash（`app.js` / `app.css`），宿主必须用 `no-cache` + `ETag` / `Last-Modified` 协商缓存（HTML / JSON 用 `no-store`）。写成 `immutable, max-age=1y` 会让升级后的插件继续跑旧 bundle，现象是「功能改了但界面没变」，且重启也未必能解决。
- **决策就绪度口径**：9 维度（持仓与成本 14 / 价格与市值 18 / 组合估值 11 / 外部资金流 9 / 收益与风险 13 / 投资目标 7 / 集中度 10 / 市场估值坐标 7 / 现金与流动性 11）。缺数据必须记 `MISSING` / `PARTIAL`，绝不用 0 或估算值凑数；分数只描述「信息完备度」，不得表述成收益预期或投资建议。集中度缺价持仓不进入占比分母，单独计入 `missingCount`。
- **再平衡语义**：只有设置了目标权重才产生 `BUY` / `SELL`；未设目标一律 `HOLD`（把「没填」当「目标为 0」会给出全仓卖出的假建议）。建议只是提示，不下单。
- **交易日历**：一律走 `services/calendar.ts`（指数日线反推，`000300` 优先）与 `core/src/calendar.ts`（纯函数）。时间按 UTC+8 计算，禁止用 `new Date().toISOString().slice(0,10)` 当「今天」——那会在北京时间 00:00–08:00 差一天。样本 <20 天退回工作日并标 `assumed`，不得声称已含节假日。
- **行情多源**：`createDefaultRegistry()` = 腾讯主源 + 东财兜底，业务层只用 `resolveAll()` 逐个尝试；同一标的同日同类型相对差 >1% 标 `CONFLICT` 并保留双方记录。新增 Provider 必须实现 `MarketProvider` 且解析函数为纯函数、由 fixture 锁定。
- **公开接口易变**：东财场外基金净值端点是 `/f10/lsjz`（不是 `lsjnz`），且服务端硬性每页 20 条（传 400 直接 0 行）；全量历史走 `fund.eastmoney.com/pingzhongdata/<code>.js`。改动适配器时先跑真实抽验，不要把接口缺陷记成「网络不可达」。
- **估算净值**：`fundgz` 端点已下线（恒返回 404 HTML），`parseFundGz` 解析失败返回 `null`，不得回填任何猜测值。
- **「指数」页边界**：只复刻 `touzid.com/indice/#/6` 的结构 / 样式 / 交互；数值只取本机 `type=INDEX` 标的的 `valuation_metrics` / `market_points`，绝不复制第三方真实行情；无数据时必须用「结构预览」显式标注且数值列恒为「—」；参考页成分股聚合口径仅作标注，不声称等价实现；数据源未覆盖的视图（互联互通 / 两融）必须写明「需要什么数据」，不得填 0。
- **指数页首次可用**：进入指数页且本机无 INDEX 标的 / 无任何收盘点位时，前端自动调 `bootstrap_indices`（建 8 个常用宽基指数 + 立刻拉一次真实行情）。该入口只写标的元数据（代码 / 名称 / secid），价格与估值一律由 `refresh_market_data` 从数据源拉取；单个标的失败只回传原因，禁止填 0 或伪造数值，也不得把「自动建标的」做成静默的后台预填。
- **钥匙串**：AI Key 优先存系统钥匙串，SQLite 只留 `__keychain__` 哨兵；不可用时降级并在 `secretBackend` 如实上报，不得静默假装已加密。测试用 `PLUG_FUNDS_DISABLE_KEYCHAIN=1` 关闭。

## 验证入口

```bash
npm test                      # 162 个测试
npm run check                 # 自包含校验（含 MCP 产物）+ web 产物静态断言 + 全部测试
node plugin/scripts/smoke.mjs # E2E 冒烟（隔离状态目录 + 真实 HTTP 全链路，21 项）
npm run pack:dsh              # 构建 + 打包 tarball → integrations/dsh/dist/
npm run verify:install        # 解包 tarball + 安装契约（SPA 挂载 / 指数页 / MCP）+ 隔离 RPC（41 项）
npm run verify:web            # web 静态断言 + 真实 Chrome CDP 渲染（69 项）
node plugin/scripts/verify-web.mjs  # 仅静态层（无需 Chrome，可进 CI）
```

行情真实连通性：腾讯 `qt.gtimg.cn`、东财 `f10/lsjz`、`pingzhongdata` 本机实测可用；东财 `push2` / `push2his` 本机 HTTP 000（网络环境相关），由腾讯主源覆盖。接入真实 DSH 安装验证属人工目视项。

## 执行纪律

- 改 core / server 后必须 `npm test`；改 web / targets 后必须 `npm run check` **并** `npm run verify:web`（真实浏览器渲染，防止 bundle 存在但页面空白）。
- 修改 `plugin/targets/dsh/host/glue.ts` 时对照 ADR-0048 禁止事项，不放宽。
- `.tmp/` 为临时文件区；构建产物（index.js / web/ / mcp/index.js / dist/）不入库。
- 不 commit / push / 发布 npm —— 用户明确要求提交时才执行。
