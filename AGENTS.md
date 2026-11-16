# AGENTS.md — 个人投资工作站（plug-funds）

## 项目定位

本地优先的个人投资工作站，以 **DeepSeek Harness（DSH / DeepSeekBox）插件**形态交付：管理 A 股、场内 ETF、场外公募基金的账本、行情、估值观察、组合风险与 AI 分析。默认本地存储；AI 分析经用户手动触发与首次范围确认后向所配置服务发送摘要。不接券商交易、不自动下单；金额一律 i64 定点（金额 2 位、份额净值 4 位、ROUND_DOWN）。

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
│  │            # csindex（官网 xls）/ csindex-valuation（官网 JSON）/ cnindex（国证目录）/ index-reference（资料解析）
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
- 数据权威：`~/.plug-funds/data/invest.db`（SQLite WAL，当前 schema v4）；流水唯一事实源；schema 高于运行时 → 拒绝打开；测试一律 `PLUG_FUNDS_STATE_DIR` 隔离。
- 有效价格口径：所有历史序列一律走 `repo/market.ts` 的 `effectiveHistoryPoints()`（`MANUAL_PRICE > 当日 REALTIME > CLOSE / OFFICIAL_NAV`，同日去重）；`ESTIMATED_NAV` 永不进入计价 / 表现指标；禁止按单一 priceType 自行读历史，避免手工价格不参与 XIRR。
- 隐藏金额豁免：`api.ts` 的 `MASK_EXEMPT` 覆盖导出 / 备份 / 配置 / AI / 导入 / 恢复等数据出口；任何新增写数据或导出类 RPC 必须先判断是否豁免，绝不把掩码值写回持久化数据。新增金额类展示字段（含 `cashTotal` / `totalAssets` / `coveredValue` / `balance`）必须同步 `MASKED_KEYS`。
- 输入错误分类：用户 / 外部数据问题用 `ValidationError`（422）、资源不存在用 `NotFoundError`（404），不得落回 500 internal-error。
- 单击持仓列表 = 标的详情、双击 = 持仓详情；行内 AI 分析 + ⋯ 菜单；分类仅「名称 + 颜色」可选非必填。
- AI 分析仅手动触发；配置须测试连接成功，首次外发须确认接收服务和范围，配置或范围变化使授权失效。提示词须携带可用估值及价格的来源、日期、质量和分母，缺失不编造；非文本、截断、拒绝或无效响应不得记为成功分析。测试禁用系统钥匙串并使用隔离状态和本地假上游。
- 正式净值与估算严格分离；百分比必须标注分母口径。
- 不用模拟数据冒充真实行情 / 真实 AI；缺数据显示「— / 样本不足」，不静默填 0。
- **SPA 挂载入口**：`web/index.html` 只加载 esbuild 产出的 IIFE `app.js`，不会自动渲染；`web/src/main.tsx` 必须保留 `createRoot(document.getElementById('root')).render(<App />)`。HTTP 200 / RPC 全绿不代表页面可见，改 web 后必须跑 `npm run verify:web`（真实 Chrome CDP）。`index.html` 的 favicon 用内联 data URI，避免浏览器向宿主根请求 `/favicon.ico` 产生 404。
- **静态资源不许 immutable**：构建产物文件名没有 content hash（`app.js` / `app.css`），宿主必须用 `no-cache` + `ETag` / `Last-Modified` 协商缓存（HTML / JSON 用 `no-store`）。写成 `immutable, max-age=1y` 会让升级后的插件继续跑旧 bundle，现象是「功能改了但界面没变」，且重启也未必能解决。
- **决策就绪度口径**：9 维度（持仓与成本 14 / 价格与市值 18 / 组合估值 11 / 外部资金流 9 / 收益与风险 13 / 投资目标 7 / 集中度 10 / 市场估值坐标 7 / 现金与流动性 11）。缺数据必须记 `MISSING` / `PARTIAL`，绝不用 0 或估算值凑数；分数只描述「信息完备度」，不得表述成收益预期或投资建议。集中度缺价持仓不进入占比分母，单独计入 `missingCount`。
- **再平衡语义**：只有设置了目标权重才产生 `BUY` / `SELL`；未设目标一律 `HOLD`（把「没填」当「目标为 0」会给出全仓卖出的假建议）。建议只是提示，不下单。
- **交易日历**：一律走 `services/calendar.ts`（指数日线反推，`000300` 优先）与 `core/src/calendar.ts`（纯函数）。时间按 UTC+8 计算，禁止用 `new Date().toISOString().slice(0,10)` 当「今天」——那会在北京时间 00:00–08:00 差一天。样本 <20 天退回工作日并标 `assumed`，不得声称已含节假日。
- **行情多源**：`createDefaultRegistry()` = 腾讯主源 + 东财兜底 + 官方指数日线兜底，业务层只用 `resolveAll()` 逐个尝试；同一标的同日同类型相对差 >1% 标 `CONFLICT` 并保留双方记录。新增 Provider 必须实现 `MarketProvider` 且解析函数为纯函数、由 fixture 锁定。
- **指数年末基准和历史核对**：报价端宽区间可能被条数上限截断；缺基准时独立请求上年 12 月 17 日至 31 日，再尝试官方日线，已有合格基准不重复请求。INDEX 历史统一经 `services/index-history.ts` 对照同日收盘并保留冲突与原值证据；预览与落库必须一致，新增冲突可使已有基准失效。中证 / 国证日线分别核验响应身份、日期区间和 OHLC，403 为请求失败，运行时退避 15 分钟、离线采集连续三次 403 后停止该源。
- **公开接口易变**：东财场外基金净值端点是 `/f10/lsjz`（不是 `lsjnz`），且服务端硬性每页 20 条（传 400 直接 0 行）；全量历史走 `fund.eastmoney.com/pingzhongdata/<code>.js`。改动适配器时先跑真实抽验，不要把接口缺陷记成「网络不可达」。
- **估算净值**：`fundgz` 端点已下线（恒返回 404 HTML），`parseFundGz` 解析失败返回 `null`，不得回填任何猜测值。
- **「指数」页边界**：只复刻 `touzid.com/indice/#/6` 的结构 / 样式 / 交互；数值只取本机 `type=INDEX` 标的的 `valuation_metrics` / `market_points`，绝不复制第三方真实行情；无数据时必须用「结构预览」显式标注且数值列恒为「—」；参考页成分股聚合口径仅作标注，不声称等价实现；数据源未覆盖的视图（互联互通 / 两融）必须写明「需要什么数据」，不得填 0。
- **指数页首次可用**：进入指数页且本机无 INDEX 标的 / 无任何收盘点位时，前端自动调 `bootstrap_indices`（建 8 个常用宽基指数 + 立刻拉一次真实行情）。该入口只写标的元数据（代码 / 名称 / secid），价格与估值一律由 `refresh_market_data` 从数据源拉取；单个标的失败只回传原因，禁止填 0 或伪造数值，也不得把「自动建标的」做成静默的后台预填。
- **估值页要列全部标的**：`get_holdings_valuation` 的 `scope` 决定口径——`holdings`（默认，总览 / 持仓页用）只出持仓；`all`（估值页用）出全部 `active` 标的并按「持仓优先」排序。缺指标的行必须留在列表里显示「数据不足」，不许因为没有持仓 / 没有 PE 就把它过滤掉；风险指标直接读库内 `effectiveHistoryPoints`，不要为了拿波动率去调 `getInstrumentChartSeries`（那会为每只标的重放一遍全部流水）。
- **页面渲染不能整站白屏**：前端任何一页在渲染期抛错，React 18 会卸载整棵树，用户只看到空白且侧栏一起消失。`main.tsx` 的 `PageBoundary` 兜住这种情况并显示错误正文；新增页面若出现「点开就是白屏」，先查渲染期异常（典型如 `useCallback` / `useEffect` 依赖数组里写了作用域外的变量——`[range]` 写进 `ValuationPage` 就是这个坑，esbuild 不报错，只有浏览器里崩）。`npm run verify:web` 已加断言：点「估值」「设置」必须出内容且全程不出现错误横幅。
- **估值指标口径不许混用**：报价端 PE、中证滚动 PE、静态 PE、PE2 计算用股本和 PE1 总股本分别保留来源与日期。不同日期或未证明同一口径的值标 `NOT_COMPARABLE`，不得按百分差直接宣布错误或冲突。只有同日、同口径才能做数值校验；覆盖原值、迁移报价和清理派生值须保留审计证据。核查入口为 `audit:metrics` 与 `audit:indices`。
- **指数 PE 主序列**：有中证官方滚动 PE 历史时，`pe` 采用 `indexCsiDsPe`，报价端值独立保存在 `pe_quote`，不得混入官方历史。尚未取得官方主值时可保留报价端 `pe`，明确标注口径待核实。跨口径或跨日期差异不能证明报价数值错误。静态 PE 落 `pe_official_static`；其他股本口径各用独立键。新增估值来源时先核对定义、日期和覆盖范围。
- **国证官方与主序列选择**：`cnindex.ts` 校验完整目录总数、重复代码及抓取前后 `queryDay` 一致，只采纳 `399` 六位代码且 `indexsource=1` 的自编指数；`peDynamic` 为官网滚动 PE，`peStatic` 为静态 PE，市值原始单位为元。一轮刷新共享一次快照或失败，不逐标的重复请求。PE / PB 官方优先级为 `csindex > cnindex > csindex-factsheet`；报价隔离在 `pe_quote` / `pb_quote`，分位历史只取所选同源序列，不跨源拼接。
- **官方月度单张**：离线脚本接受资料目录指向，或官网固定资料目录中可验证身份的人民币价格指数 `factsheet.pdf`；核对实际指数代码、统计日、计算用股本说明及原文 SHA-256，目录请求失败必须另留原因。月度来源为 `csindex-factsheet`，保留实际日期与陈旧状态，不替代更高优先级主值；PE 和股息率单张对照值使用独立键。Python / pypdf 仅用于离线采集重放，不加入插件运行依赖。
- **指数代码对应关系须有官方证据**：`index-identities.ts` 只记录已证实的同一指数代码映射，不能借用其他指数。`000974 → H30086` 由官方单张中的指数码及彭博代码 SH000974 证明；`399903 → 000903` 由中证 A100 编制方案并列代码证明。存储与报价保留原交易所代码，官方请求和响应身份按映射校验；名称纠正与映射依据留档。
- **指数参考资料**：`app_settings` 的 `index_reference:<instrumentId>` 保存发布日期、官方关联目录统计、观察日、缺失依据及 URL / SHA-256。发布日期不能用基日替代；基金数按官方境内产品代码计，有明确上市交易所为场内，未上市的指数/联接/指数增强类型为场外，不推断合并份额。产品地域按上市交易所或明确境外基金类型判断，`coverage` 是跟踪指数地域，不能用于排除境外产品。`399001` 也可为合法基金代码，不得按指数代码前缀拒绝基金；类型缺失仅在完整产品名明确为联接基金时分类，其他未知类型保留存疑。空数组只表示该目录为 0；`data:null`、身份无法确认或分类不完整保留 null，历史统计或无统计日须明确标注。PS、财年 ROE 不由 PE / PB 比值推算。
- **股息率口径分开**：XLS 股息率2写 `dividend_yield_calc_share`，股息率1写 `dividend_yield_total_share`；JSON 主值写 `dividend_yield`。非 JSON 覆盖时 XLS 可兜底主值，但 provider 必须为 `csindex-xls-calc-share`；已知或已有 JSON 覆盖时，失败/缺行不能以 XLS 覆盖主值。当前少量样本相等不能证明两个接口始终同口径。
- **中证官方估值优先 JSON**：`market/csindex-valuation.ts` 使用 `https://www.csindex.com.cn/csindex-home/data-service/indexValuation`（快照：静态 PE / 滚动 PE / PB / 股息率）与 `/perf/indexCsiDsPe?indexCode=`（逐日滚动 PE 历史）。快照当前返回 8 只仪表盘指数，其他指数的 PB 在该接口中缺失，不代表所有公开来源均无数据。OSS `indicator/<code>indicator.xls` 作为补充来源，可能被 WAF 拦截；403 必须记录为请求失败，不能当成接口下线或指数没有数据。空数组、网络失败和解析失败分别记录，不推算或借用其他指数补空。
- **收盘价只在收盘后写**：K 线接口盘中会返回「当日未完成 bar」，把它当 `CLOSE_PRICE` 入库等于用盘中价冒充收盘价（同一天还有一条真的 `REALTIME_PRICE`）。`refresh.ts` 的 `dropUnsettledClose()` 按会话阶段判断：只有 `after`（≥15:00）或 `closed-day` 才写当日收盘价，**午休（`lunch`）也不算收盘**——`session.open === false` 不等于收盘。回填历史时若发现当日 CLOSE 与 REALTIME 同时存在，先判断写入时刻再决定删哪条。
- **增量回填要按来源取水位**：判断「官方序列已到哪天」必须用 `latestMetricDate(handle, id, 'pe', 'csindex')`，不能取 `metricHistory` 的最后一条——报价端可能写了一条更新的 `pe`，会把官方历史整体判成「已是最新」而永不回填。另外**先写历史、再写快照**：快照那条「最新日」会把水位顶到最新，导致首次接入只写 1 条（已由 `csindex-refresh.test.ts` 锁死）。
- **分位必须有跨度守卫**：`pe_percentile` / `pb_percentile` 的语义是「近 3 年分位」。样本数 ≥20 但时间跨度 <180 天时（例如刚从中证官网导入 20 个交易日），算出来的是「近 1 月分位」，套用模板阈值会产生看似确定、实则无意义的结论 —— 宁可不写、让 UI 显示「数据不足」。`MIN_PERCENTILE_SPAN_DAYS` 是这个守卫，不允许为了提高评分覆盖率而放宽。
- **中证官网 xls 是 OLE2 + BIFF8**：`market/csindex.ts` 自带最小解析器（`readOleWorkbook` + `parseBiffCells`），按表头关键字定位列而不是写死列号。只覆盖中证 / 上证系列，深证成指 / 创业板指（国证发布）返回 404 → 空数组 + 如实标注「数据源未覆盖」。该 OSS 有 WAF 限流，短时间密集请求会返回 403 HTML，必须低频 + 失败显式，不得把 HTML 当数据解析。
- **钥匙串**：AI Key 优先存系统钥匙串，SQLite 只留 `__keychain__` 哨兵；不可用时降级并在 `secretBackend` 如实上报，不得静默假装已加密。测试用 `PLUG_FUNDS_DISABLE_KEYCHAIN=1` 关闭。
- **指数目录导入只拿标识**：`scripts/import-index-catalog.mjs` 从东财公开目录取 `code / name / market` 三项，**不取它的行情数值**——价格与估值仍由 provider 与中证官网各自提供，避免目录源变成第二份数据权威。范围只含 `000`（中证/上证）与 `399`（深证/国证）；`395xxx` 是深证市场的**成交统计**（总成交 / 债券现货 / REITs / ETF），不是指数，不得导入；同名多码（如 `000300` 与 `399300` 都叫沪深300）保留有官方估值覆盖的 000 码，删掉深市镜像。
- **刷新成本约束**：中证官方快照一轮只拉一次（`getOfficialSnapshot()` 缓存），常规刷新只对「000 前缀或已验证覆盖清单」请求中证接口。覆盖清单存在 `app_settings.csindex_covered_codes`（`market/csindex-coverage.ts`）；399 代码不能直接推定为国证来源。只有成功拿到数据才写清单，403、网络失败和未尝试均不能当成「没有覆盖」；全量回填可探测全部代码并保留请求证据。
- **总市值取 scale_info 原文**：报价端把「总市值 507797 亿」写成文本指标，`metricHistory` 会把它转数字后过滤掉，必须单独按原文取（`getIndexValuation` 里一条批量查询），解析成数值供「市值」列；解析失败保持 null，不填 0。
- **出网走代理时 Node fetch 不读 env**：本机（及不少公司网络）设了 `HTTPS_PROXY`，`curl` 默认读、Node 的 fetch/undici **不读**，直连会报 `UND_ERR_SOCKET` / `fetch failed`。排查「接口不可达」前先确认是不是这个原因——同一 URL 用 curl 通、用 Node 不通，就是代理没被 Node 继承。一次性脚本可改用 curl（见 `import-index-catalog.mjs`）。

## 存储布局（schema v4 起）

- `valuation_metrics` 是 `WITHOUT ROWID` 的复合主键表 `(instrument_id, metric_key, as_of_date)`，**没有 `id` 列**。历史版本用 `id TEXT` 做主键，只写不读却要多维护一棵 38 MB 的索引；79 万行时实测 176.9 MB → 57.4 MB。写库统一走 `saveValuationMetric()`，SQL 里不要再出现 `id`。
- **迁移必须与插件升级同步**：v4 之后旧插件的 `INSERT ... (id, ...)` 会因列数不匹配直接失败（不会写坏数据，但指标停止更新）。升级顺序：先装新插件，或先迁移再立刻重启。
- 大批量写入（回填 / 目录刷新）之后跑 `ANALYZE` 或脚本里的 `PRAGMA optimize`：缺统计信息会让 521 行指数页从 0.7s 退化到 2.4s（读放大，不是表结构问题）。

## 验证入口

```bash
npm test                      # core / API / provider / AI / 数据审计回归
npm run check                 # 自包含校验（含 MCP 产物）+ web 产物静态断言 + 全部测试
node plugin/scripts/smoke.mjs # E2E 冒烟（隔离状态目录 + 真实 HTTP 全链路，21 项）
npm run pack:dsh              # 构建 + 打包 tarball → integrations/dsh/dist/
npm run verify:install        # 解包 tarball + 安装契约（SPA 挂载 / 指数页 / MCP）+ 隔离 RPC（45 项）
npm run verify:web            # web 静态断言 + 真实 Chrome CDP 渲染与 AI 交互
node plugin/scripts/audit-metrics.mjs  # 估值指标多源核查（腾讯 / 东财 / 中证官方，只读副本）
npm run backfill:metrics      # 官方估值回填（默认 dry-run；--apply 落库，写前先备份 ~/.plug-funds/data）
npm run backfill:cnindex      # 国证目录估值回填（默认 dry-run；--apply 写前备份）
npm run backfill:history      # 官方指数收盘对照及回填（默认 dry-run；--offline 重放原文，--apply 写前备份）
npm run collect:reference -- --evidence .tmp/index-reference # 官方参考资料只读采集、断点续采
npm run backfill:reference -- --evidence .tmp/index-reference # 校验原文并生成计划，--apply 写前备份
npm run import:indices        # 导入沪深指数目录（000/399，默认 dry-run；--apply 只建标的、不写数值）
npm run refresh:indices       # 批量刷新全部指数（分批调用同一 refreshMarketData）
npm run fill:dates            # 补指数发布日期（中证 basic-info，遇 403 自动退避 / 中止）
node plugin/scripts/verify-web.mjs  # 仅静态层（无需 Chrome，可进 CI）
npm run audit:indices        # 全量字段、日期、来源、缺失原因和修正证据（只读）
npm run audit:metrics         # 估值指标多源核查（腾讯 / 东财 / 中证官方，只读副本）
```

行情真实连通性：腾讯 `qt.gtimg.cn`、东财 `f10/lsjz`、`pingzhongdata` 本机实测可用；东财 `push2` / `push2his` 本机 HTTP 000（网络环境相关），由腾讯主源覆盖。接入真实 DSH 安装验证属人工目视项。

## 执行纪律

- 改 core / server 后必须 `npm test`；改 web / targets 后必须 `npm run check` **并** `npm run verify:web`（真实浏览器渲染，防止 bundle 存在但页面空白）。
- 修改 `plugin/targets/dsh/host/glue.ts` 时对照 ADR-0048 禁止事项，不放宽。
- `.tmp/` 为临时文件区；`integrations/dsh/dist/` 不入库。**DSH 组合包产物（`index.js` / `web/` / `mcp/index.js`）必须随仓库提交**——宿主从 git 安装时不执行构建，缺产物装不起来（见 `.gitignore` 注释）。
- 不 commit / push / 发布 npm —— 用户明确要求提交时才执行。
