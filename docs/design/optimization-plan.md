# 优化设计方案：个人投资工作站 → DeepSeek Harness 插件

- 日期：2026-11-15
- 状态：已确认基线（Goal `goals/20261115-1740-dsh-investment-plugin.md`）
- 依据：plug-funds PRD v1.4 + `.tmp/prototype/index.html` 原型；旧项目 AiNative 投资模块（以当前项目为主、旧项目为辅）

## 1. 旧项目调研结论（AiNative，为辅）

| 模块 | 内容 | 对本项目的价值 |
| --- | --- | --- |
| `Natives/docs/adr/0048-dsh-plugin-third-entry.md`（文件，非目录）+ `integrations/dsh/`（4 个插件） | DSH 插件完整先例：打包契约、Host/Client API、安装/卸载、同源路由、主题、schema 护栏 | **直接继承**打包契约与纪律；运行时层不照抄（旧 runtime 绑定 Natives Core，我们无 Core 可 attach） |
| `Natives-App-Fund/src/`（Rust 独立投资应用） | `fixed.rs` i64 定点（份额/净值 4 位、金额 2 位、ROUND_DOWN）、`ledger.rs` 交易回放、`migration.rs` 版本化迁移、超卖拒绝、幂等键 | **语义照搬、语言重写**：TS core 按同一精度与回放语义实现 |
| `modules/fund/ui/` | 模块 UI 规范（i18n、语义 tokens、空态） | 参照其空态/i18n 纪律 |
| `plugbox`（源码 `DeepSeekBox/`，不在 AiNative 目录下） | 自包含插件现代形态：Host 托管 SPA（`/前缀/`）+ RPC 端点 + Client 薄壳 iframe；核心层宿主无关 + 适配层每宿主一个 | **采用其宿主适配模式**（core 宿主无关 + 每宿主一个薄适配层）；同一 core 多适配器的真实先例见 `dsh-files/docs/AGENT_ADAPTERS.md` |

旧项目的局限（即本次优化点）：旧 DSH 插件只是「宿主桥」，页面来自 Natives Core 的 iframe，插件本身不拥有数据与业务；独立 Rust 应用与插件是两条链。本项目把**业务核心放进插件自身**，core/server 宿主无关、RPC 方法表可复用；扩展按 `dsh-files/docs/AGENT_ADAPTERS.md` 的适配器矩阵落地（DSH / MCP server），**已实现 MCP stdio 适配层**（`targets/mcp/`，17 工具，供 ZCode 等 MCP 客户端消费），未做 `DeepSeekBox/src/adapters/zcode-dsh/`（Cordis 协议族，`verified:false`、4 项 openQuestions，未实测，不得声称已支持）。

## 2. 总体架构

```text
plugin/
├─ core/                  # 宿主无关领域层（TS 纯函数，无 IO）
│  ├─ money.ts            # i64 定点：金额 scale=2、份额/净值/价格 scale=4，ROUND_DOWN
│  ├─ types.ts            # 领域类型、DataQuality/PriceType/结论分档、SCHEMA_VERSION
│  ├─ ledger.ts           # 交易回放 → 持仓投影（加权平均成本、超卖拒绝、待确认不改变持仓）
│  ├─ goal.ts             # 目标完成率 / 全量分布 / 目标贡献 / 超额三口径
│  ├─ valuation.ts        # 分位、夏普、波动率、最大回撤、XIRR（二分）
│  ├─ risk.ts             # 皮尔逊相关、Beta、跟踪误差、年化波动、ERP
│  ├─ portfolio-risk.ts   # 集中度：Top1/Top3/HHI/有效持仓数（缺价不入分母）
│  ├─ calendar.ts         # 交易日/会话判定纯函数（UTC+8，不依赖宿主时区）
│  ├─ categories.ts       # 自定义分类（名称+颜色，可选多选，未分类兜底）
│  └─ rpc.ts              # RPC 方法表（60 个）与响应封套 {success,data,error,traceId}
├─ server/                # Node 侧（无第三方依赖；node:sqlite）
│  ├─ db.ts               # 引擎探测 + 连接 + migration v1..v3 + schema 护栏（高于运行时→拒写）
│  ├─ repo/*.ts           # accounts/instruments/transactions/categories/market/goal/ai/settings/cash/strategies/refresh-settings
│  ├─ services/*.ts       # dashboard（双模式分布+表现指标）、holdings、valuation-view、ai、backup、import、restore
│  │                      # refresh、charts、indices、decision-readiness、risk、rebalance、calendar
│  │                      # index-valuation（指数列表）、index-analytics（指数页二级视图）
│  ├─ market/tencent.ts   # 主源：qt.gtimg.cn 实时 / web.ifzq.gtimg.cn K 线（覆盖 A/ETF/指数/港/美/场外基金）
│  ├─ market/eastmoney.ts # 兜底：push2 报价与 K 线、f10/lsjz 与 pingzhongdata 场外基金净值、估值明细
│  ├─ market/provider.ts  # Provider 注册表（resolveAll 多源有序尝试）
│  ├─ market/conflict.ts  # 多源交叉校验：相对差 >1% 标 CONFLICT，保留双方记录
│  ├─ market/manual.ts    # 手工价格兜底（MANUAL_PRICE 标记）
│  ├─ xlsx.ts             # 自包含 .xlsx 解析（node:zlib + 手写 ZIP/XML），输出 CSV 复用导入链路
│  ├─ secrets.ts          # 系统钥匙串（macOS security / Linux secret-tool）
│  └─ api.ts              # 纯函数路由：dispatch(method,params,state) → {status,body}（可脱离 HTTP 测试）
├─ web/                   # React SPA（esbuild 打包，零运行时外部依赖；图表自绘 SVG）
│  └─ src/…               # 总览/决策就绪度/现金·再平衡·相关性·风险参数/持仓/估值/设置/详情/PK/AI/指数页
├─ targets/
│  ├─ dsh/
│  │  ├─ index.js         # Host 薄壳（bundle 产物 = core+server+本壳，单文件自包含）
│  │  ├─ client.js        # 薄壳：sidebar 入口 + main 主面板 iframe('/plug-funds/') + 主题透传
│  │  ├─ web/             # SPA 构建产物（index.html/app.js/app.css）
│  │  └─ package.json / cordis.patch.yml / locale/{zh,en}.json / icon.svg / README.md / mcp/
│  ├─ mcp/server.ts       # MCP stdio 适配（17 工具，复用同一套 server 层，不复制业务逻辑）
│  └─ zcode/manifest.json # MCP 宿主清单（transport/entry/协议版本/工具表/权限）
├─ scripts/               # build.mjs / pack.mjs / smoke.mjs / verify-web.mjs / verify-install.mjs
└─ test/                  # node:test：core 单测 + server 集成 + 行情 fixture + 日历/xlsx/钥匙串/MCP/指数分析
```

## 3. 关键决策与理由

| # | 决策 | 理由（规范出处） |
| --- | --- | --- |
| D1 | 自包含插件：业务与数据都在插件内（`~/.plug-funds/`），不 attach 任何 Core | plug-funds 无 Core 可挂；ADR-0048 的「不产生第二数据 writer」约束针对 Natives 数据，本插件是独立产品、拥有自己的权威库；plugbox 已验证该形态可行 |
| D2 | Client = 薄壳 iframe + Host 托管 SPA；SPA 用打包的 React 而非手写 `h()` | plugbox 同源托管模式（Desktop 经 forwardWebRequest、Web 直接服务）；大 UI 手写 createElement 不可维护；PRD §8.1 选 React |
| D3 | 存储用 `node:sqlite`（DSH Host Node 22.22，本机 22.23.2 实测可用），自建 migration；不可用时**显式报错**而非静默换 JSON | PRD §7（SQLite 权威）+ 旧 fund 迁移纪律（先备份、版本化、失败回退）；静默降级违反「不伪精确」 |
| D4 | 金额一律 i64 定点字符串进出 DB 与 API | 旧 fund `fixed.rs` 语义 + PRD §6.4；JS number 只做展示格式化 |
| D5 | RPC 单端点 JSON-RPC 风格，方法名对齐 PRD §8.4 命令合约 | 响应封套 `{success,data,error,traceId}` 是 PRD 明文；单端点便于同源校验，RPC 方法表宿主无关、可复用；扩展参照 `AGENT_ADAPTERS.md` 适配器矩阵（DSH / MCP server / HTTP） |
| D6 | 行情走 Provider Adapter + 磁盘缓存 + 质量状态；**腾讯为主源、东财兜底**，同标的同日相对差 >1% 标 `CONFLICT` 并保留双方记录 | PRD §5.2/§5.4：低频、缓存、退避、失败可见、手动兜底。本机实测东财 `push2`/`push2his` HTTP 000、腾讯可用，故以腾讯为主源；接口变更只换 Adapter，业务层不动 |
| D7 | AI 真实调用，手动触发，Key 存**系统钥匙串**（macOS `security` / Linux `secret-tool`），SQLite 只留哨兵 `__keychain__`，不可用时降级并如实上报 `secretBackend` | PRD §4.11 要求系统凭据服务；插件运行在 Node 宿主，可直接调用系统命令。降级路径显式标注，不假装已加密 |
| D8 | 隐藏金额（DASH-12）实现为 API 层掩码模式 | 掩码在服务端统一做，避免各页面漏渲染；百分比/价格/净值不受影响 |
| D9 | i18n：侧栏入口走 DSH `locale`（zh/en.json），SPA 内置 zh 文案 + en 预留 | T0 证据 §2（`ctx.locale.register` + `ctx.locale.bind`，locale JSON 只供插件清单展示）与 `DeepSeekBox/docs/hosts/dsh-spec.md` §7；SPA 自有文案体系，不硬编码混排 |
| D10 | 主题跟随 DSH：iframe URL 带 `?theme=dark|light`，SPA 首帧应用且不写回 | ADR-0048 主题参数模式（只覆盖本次渲染） |

## 4. RPC 方法表（60 个，对齐 PRD §8.4）

v1 基线（32）：`get_app_info`、`get_dashboard_summary`、`get_dashboard_allocation`、`get_portfolio_goal`、`save_portfolio_goal`、`get_portfolio_performance_metrics`、`list_accounts`、`save_account`、`archive_account`、`search_instruments`、`save_instrument`、`list_positions`、`get_position_detail`、`record_transaction`、`list_transactions`、`delete_position`、`pin_position`、`list_categories`、`save_category`、`delete_category`、`set_instrument_categories`、`get_instrument_chart_series`、`get_instrument_detail`、`get_holdings_valuation`、`analyze_holding_with_ai`、`get_ai_settings`、`save_ai_settings`、`test_ai_connection`、`compare_instruments`、`refresh_market_data`、`export_backup`、`set_hide_amount`。

v2 新增（15，migration v2，修复轮补齐）：`export_holdings_csv`、`save_manual_price`、`save_portfolio_cash_flow`、`delete_portfolio_cash_flow`、`preview_import_transactions`、`commit_import_transactions`、`preview_restore_backup`、`restore_backup`、`list_strategy_templates`、`save_strategy_template`、`list_strategy_versions`、`restore_strategy_version`、`save_manual_metric`、`get_refresh_settings`、`save_refresh_settings`。

决策支持（1，无 schema 变更）：`get_decision_readiness`——把「数据是否足以支撑资产决策」拆成 9 个维度（持仓与成本 14 / 价格与市值 18 / 组合估值 11 / 外部资金流 9 / 收益与风险 13 / 投资目标 7 / 集中度 10 / 市场估值坐标 7 / 现金与流动性 11），返回 OK / PARTIAL / MISSING、现状数字、补齐动作、加权 0–100 分与结论，并附集中度（Top1 / Top3 / HHI / 有效持仓数）。缺数据不按 0 处理；分数只描述信息完备度。

指数页（2，无 schema 变更）：`get_index_valuation`——只聚合本机 `type=INDEX` 标的，收盘点位 / 今年收益率走 `effectiveHistoryPoints()`，估值分位走 `latestValuationMetrics()` + `metricHistory()`（样本 <20 为 null）；返回 `note` 与 `caliber` 供前端标注口径。不新增外部数据源、不复制第三方行情数值。`seed_common_indices`——按需创建常见 INDEX 标的（只写标的元数据，不写任何伪造行情）。

指数分析（1，无 schema 变更）：`get_index_analytics`——一次算完全部二级视图所需数据（阶段涨跌幅、波动率、60 日新高/新低、RPS、相关性矩阵、定投回测与 XIRR、格雷厄姆与股债性价比、ETF 与覆盖率），返回 `note` 与 `coverage` 供前端标注口径。

组合风险与配置（6，migration v3）：`get_portfolio_risk`（Beta / 跟踪误差 / 年化波动 / ERP）、`save_risk_settings`（无风险利率等）、`get_correlation_matrix`（皮尔逊，样本 <20 为 null）、`list_cash_accounts` / `save_cash_account` / `delete_cash_account`（现金账户，`cash_accounts` 表）。

再平衡（2，migration v3）：`get_rebalance_plan`（类别目标权重 vs 实际权重，偏离超阈值才给 BUY/SELL，**未设目标一律 HOLD**）、`save_rebalance_targets`（`rebalance_targets` 表 + 阈值存 `app_settings`）。

交易日历（1）：`get_trading_calendar`——可注入 `now`，返回会话阶段（盘前 / 上午 / 午休 / 下午 / 收盘）与日历摘要（来源 `market` / `weekday`、覆盖天数、推导出的休市日）。

错误分类：输入 / 外部数据校验失败 → `422 validation-error`；资源不存在 → `404 not-found`；账本冲突 → `422`；schema 冲突 → `409`；未知方法 → `404 unknown-method`；程序故障 → `500 internal-error`。

## 5. 与 PRD 的偏离与适配状态（插件形态，均已记录）

| PRD 条款 | 偏离 | 理由 |
| --- | --- | --- |
| §8.1 Tauri + Rust + SQLx | Node(cordis Host) + TS + node:sqlite | DSH 插件的宿主运行时是 Node；架构分层与 SQL 语义等价保留 |
| §4.11 Key 入 Keychain | **已实现**：macOS 走 `security add-generic-password -U`、Linux 走 `secret-tool`；SQLite 只留哨兵 `__keychain__`；不可用时显式降级并在 `secretBackend` 上报 | 插件运行在 Node 宿主可直接调系统命令；降级路径必须可见，不静默假装加密 |
| §13.1 CSV/Excel 导入 | **均已实现**：CSV 文本 + **.xlsx 二进制**（自解析 ZIP/XML，不引第三方库；日期序列号、稀疏列、富文本、实体均正确处理）；预览 / 错误行 / `requestId` 幂等 / 单事务 / 整批回滚 | 自包含约束下用 `node:zlib` + 手写 ZIP/XML 解析，xlsx 先转 CSV 再复用同一条导入链路；`.xls` 老格式明确拒绝并提示另存为 |
| §4.5 实时刷新定时器 | Host `effect` 生命周期托管（默认 60s、可关闭、可配间隔 15–3600s、仅交易时段开关、`unref()`） | 语义保留；**已接入真实交易日历**（指数日线反推，周末恒休市，样本 <20 天退回工作日并标 `assumed`），不再「只按周一到周五」 |
| §4.6.7 策略模板完整引擎 | v1 只读模板；v2 补齐可编辑、不可变版本、回滚、自定义模板、手工指标、PE/PB 历史分位 | 每次保存生成新版本而非覆盖；样本 <20 不写分位，覆盖率 <80% 不产生数值 |
| 组合风险（PRD 外，用户新增需求） | **已补齐**：集中度、现金账户、再平衡建议、相关性矩阵、Beta / 跟踪误差 / 年化波动 / ERP；再平衡仅建议不下单，未设目标时全 HOLD | 这些维度需要用户输入（风险偏好、无风险利率）与本地序列；缺数据一律 null / MISSING，不用估算值伪造精度 |
| 指数页（PRD 外，用户新增需求，参考 `touzid.com/indice/#/6`） | 结构 / 样式 / 交互复刻；**16 项二级菜单全部可切换**（14 个真实视图 + 2 个数据源未覆盖时显式说明）；数值来自本机，无 INDEX 标的时为「结构预览」（数值列恒为「—」） | 不复制第三方真实行情、不伪造数值；互联互通 / 两融数据源未覆盖时写明「需要什么数据」而非填 0；成分股聚合口径仅作标注 |
| 行情数据源（PRD §5.2） | 腾讯为主源、东财兜底、手工价格保底；同标的同日相对差 >1% 标 `CONFLICT` 保留双方 | 本机实测东财 `push2`/`push2his` HTTP 000、腾讯可用；多源交叉校验比单源更早暴露字段漂移 |
| 盘中估算净值（PRD §4.5.1） | `fundgz` 端点**已下线**（恒返回 404 HTML），估算链路当前不可用；解析失败返回 `null`，不写任何猜测值 | 正式净值与估算严格分离；宁可不显示，也不伪造估值 |
| Zcode / MCP 适配 | **已实现 MCP server 形态**（stdio JSON-RPC、17 工具、`mcp/manifest.json`），供 ZCode 等 MCP **客户端**消费；未做 `zcode-dsh`（Cordis 适配器，未实测） | 方向修正为「本 core 提供 MCP server，由 MCP 客户端消费」；同一套 server 层复用，不复制业务逻辑、不产生第二份数据 |
