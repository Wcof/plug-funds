# 个人投资工作站（plug-funds）· DeepSeek Harness 插件

本地优先的个人投资工作站，以 **DeepSeek Harness（DSH / DeepSeekBox）插件**形态交付：账本、行情、估值观察、组合风险与 AI 分析。数据默认保存在本机；用户手动触发并确认 AI 外发范围后，所选持仓摘要会发送到配置的模型服务。项目不连接券商，不自动交易。

产品口径与需求见 PRD v1.4（`/Users/ldh/Downloads/investment-workstation-prd-v1.1.md`，文件名保留 v1.1）；架构决策见 `docs/design/optimization-plan.md`。

数据补齐及逐项校验见 [2026-11-17 指数历史与身份核验报告](/Users/ldh/Downloads/project/plug-funds/docs/reports/2026-11-17-index-history-review.md) ，前次资料快照见 [官方指数资料核验报告](/Users/ldh/Downloads/project/plug-funds/docs/reports/2026-11-17-index-data-review.md) ；AI 链路的规则和验证见 [2026-11-16 数据与 AI 校验报告](/Users/ldh/Downloads/project/plug-funds/docs/reports/2026-11-16-data-ai-review.md) 。

## 安装（DSH ≥ 0.2.1-rc.3）

构建产物是自包含 npm tarball（无外部依赖，安装器不装依赖也能用）：

```bash
# 从源码构建 + 打包
npm install
npm run pack:dsh
# 产物：integrations/dsh/dist/plug-funds-dsh-investment-0.1.6.tgz

# 安装到 DSH（在 DSH 的插件安装入口 / plugin_manager 中执行）
install_bundle target=/绝对路径/integrations/dsh/dist/plug-funds-dsh-investment-0.1.6.tgz
```

开发迭代用目录链接（改代码后重启 DSH 窗口即生效）：

```bash
install_bundle target=/绝对路径/plug-funds/plugin/targets/dsh/investment
remove_bundle target=@plug-funds/dsh-investment   # 卸载（不删用户数据）
```

安装后重启 DSH 窗口，侧栏出现「投资工作站」入口，主面板内打开完整界面。

## 功能

- **总览**：总资产 / 总市值 / 现金占比、当日与累计收益；双模式资产分布（全量分布 / 目标达成 + 灰色待达成扇区）；一级→二级图与配置表联动；表现指标卡（XIRR / 最大回撤 / 夏普 / 组合 PE·PB，样本不足或覆盖率 <80% 显式标注「—」）；策略机会摘要；隐藏金额开关（DASH-12：只掩码展示类响应，导出 / 备份 / 配置 / AI / 导入 / 恢复等数据出口不受污染）。
- **决策就绪度**：把「当前数据够不够做资产决策」摊平成 **9 个维度**（持仓与成本 14 / 价格与市值 18 / 组合估值 11 / 外部资金流 9 / 收益与风险 13 / 投资目标 7 / 集中度 10 / 市场估值坐标 7 / 现金与流动性 11，合计 100），逐项给出 OK · 部分 · 缺失、现状数字与**可执行的补齐动作**，并汇总 0–100 分与明确结论。缺数据一律记缺失，不用 0 冒充。分数只表示信息完备度，不代表标的优劣。
- **组合风险与配置**：集中度（单一持仓 / 前三大 / HHI / 有效持仓数 / 类别集中，缺价持仓不入分母）；现金账户（活期 / 货币基金 / 逆回购等，按类别汇总）；再平衡（类别目标权重 vs 实际权重，偏离超阈值才给 BUY / SELL，**未设目标时一律 HOLD**，避免把「没填」当成「目标为 0」而建议清仓）；持仓相关性矩阵（皮尔逊，样本 <20 为 null）；风险参数（无风险利率 / Beta / 跟踪误差 / 年化波动率 / ERP）。
- **持仓**：三个子视图（当前持仓 / 交易流水 / 持仓估值）。单击标的进标的详情、双击进持仓详情；行内 AI 分析 + ⋯ 菜单（置顶 / 修改持仓 / 修改分组 / PK / 删除）；持仓估值视图不含收益列（夏普 / PE / PB / 股息率 / ROE / 波动率 / 回撤 / 策略结论）。
- **持仓详情**：九项基础信息（含当日 / 昨日收益、已持天数）；三 Tab 折线图（关联板块 / 业绩走势 / 我的收益＝累计收益金额）+ 成本线 / 保本线 + 买卖红绿标记 + 对比指数（默认沪深300）+ 周期筛选联动列表。
- **估值**：内置 4 模板 + 自定义模板，可编辑、每次保存生成不可变版本、可回滚；规则评分 0–100（规则匹配度，非涨跌概率）；必需指标缺失 → 数据不足；支持手工补录估值指标并标注 MANUAL；PE / PB 历史分位以对应基础指标的日期为终点回看 3 年，须同时满足至少 20 个有效样本与 180 天跨度，不随刷新日期漂移。分位或基础指标过期、存在冲突或日期不一致时，该分位不参与当前评分。**列表覆盖全部标的**（`scope=all`：股票 / ETF / 场外基金 / 指数，含无持仓的观察标的，持仓优先排序并标「持仓」），按资产类别筛选 + 「仅持仓」开关；缺指标的行保留并显示「数据不足」，不因没有持仓而消失。
- **账本与数据**：交易流水唯一事实源、`requestId` 幂等；**CSV 与 Excel（.xlsx）流水导入**（预览 / 错误行可见 / 单事务提交 / 失败整批回滚；xlsx 在自包含约束下自解析 ZIP + XML，不引第三方库，并正确还原日期序列号、稀疏列、富文本与实体）；JSON 全量备份恢复（schema 校验 / 恢复前自动备份当前库 / 外键与回放一致性 / 失败回滚）；组合外部资金流水驱动 XIRR；每日组合与持仓快照、数据源运行记录。
- **指数**：参考 `touzid.com/indice/#/6` 复刻「指数列表」-- 两行二级菜单、筛选工具条、双层分组表头、36 列高密度表格、左侧两列 sticky、排序 / 行选中 / 关注星标 / 导出 / 指标定义弹窗、桌面响应式；二级菜单 **16 项全部可切换**：列表 / 指标自定义 / ETF / 财务对比 / 历史涨跌幅 / 相关性 / RPS / 波动率 / 新高 / 新低 / 图形对比 / 定投 / 格雷厄姆 / 股债性价比 + **互联互通与两融**（数据源未覆盖时显示「需要什么数据」而非填 0）。数值一律取自本机 `valuation_metrics` / `market_points`（有效价格口径）；列表分位按选定年限回看至对应基础指标的日期，有效样本少于 20 个或跨度不足 180 天时显示「—」；**不复制第三方真实行情**。首次打开指数页时自动执行 `bootstrap_indices`：建 8 个常用宽基指数标的（只写代码 / 名称 / 数据源映射）并立刻从腾讯 / 东财拉一次真实行情与估值，避免「装了插件却满屏 —」；拉不到就按标的显示失败原因，不填 0。本机确实无 `type=INDEX` 标的数据时仍启用「结构预览」，数值列全部为「—」并显式标注。**指数标的可按目录批量导入**：`npm run import:indices -- --apply` 从公开目录建 000（中证/上证）与 399（深证/国证）系列；表格默认每页 50 行（可切 100/200/500），避免 500+ 行 × 36 列一次渲染卡顿。「市值」列取自报价端「总市值 X 亿」原文解析；「发布时间」取中证 / 国证基本资料及经校验的官方单张，关联基金列显示官方目录代码数及其日期；抓取受阻、分类不完整或数据存疑时明确记录原因，参考资料可用 `collect:reference` 与 `backfill:reference` 续补。
- **设置**：分类管理（名称 + 颜色、括号计数、直接改名、删除）；AI 配置（Base URL / Key / 模型，OpenAI 兼容，手动触发，**Key 存系统钥匙串**）；行情自动刷新（默认 60 秒、可关闭、可配间隔、仅交易时段开关）；交易日历与当前时段展示；JSON / CSV 导出与备份恢复；隐藏金额。
- **行情**：**腾讯财经为主源**（`qt.gtimg.cn` 实时 / `web.ifzq.gtimg.cn` K 线，覆盖 A 股 / ETF / 指数 / 港股 / 美股 / 场外基金最新净值）+ **东财兜底**（`push2` 报价与 K 线、`f10/lsjz` 场外基金历史净值、`pingzhongdata` 全量净值、`f10` 估值明细）+ **中证指数官网官方估值**（已接入 JSON 快照中的静态 PE / 滚动 PE / **PB** / 股息率，以及逐日滚动 PE 历史；覆盖因指数和字段而异，部分历史可回溯到 2011 年；`indicator.xls` 作为补充，403 等抓取失败单独记录）+ 手工价格；有效价格统一口径 `MANUAL_PRICE > 当日 REALTIME > CLOSE / OFFICIAL_NAV`，同日多来源去重；**多源交叉校验**：同一标的、同一交易日、同一价格类型的两个来源相对差 >1% 时标记 `CONFLICT` 并保留双方记录，不擅自选一个当正确答案；正式净值与盘中估算严格分离，估算不参与计价。
- **估值指标口径**：个股 `pe`（PE-TTM）/ `pb` 优先取腾讯报价，东财 `push2` 补充 `pe` / `pb` / `roe` / 毛利率 / 净利率（f164 / f167 / f173 / f187 / f188），可比数据用于交叉校验。已确认取得中证官方滚动 PE 的指数以该口径作为 `pe`，报价端数值保留在 `pe_quote`；静态 PE 用 `pe_official_static`，PE1 / PE2 用各自独立键。已接入的中证端点可提供部分指数的 `pb` 与 `dividend_yield`，不表示官方其他渠道或其他来源没有数据。国证自编目录提供深证成指、创业板指等指数的滚动 PE / 静态 PE / PB；中证月度单张可补部分 PB，并保留统计日和陈旧状态。未取得的字段按实际返回区分「端点未覆盖」「抓取失败」或「待核实」，不借用其他指数数值。不同日期、股本口径或计算方法的差异不能直接认定为数值错误；无法确认可比性的报价与官方值并列留证，不混入同一历史分位序列。核查命令：`node plugin/scripts/audit-metrics.mjs`（腾讯 / 东财 / 中证来源并列与偏差记录）。
- **MCP（Zcode 等 MCP 宿主）**：同一套 server 层以 MCP 工具形式暴露（`mcp/index.js` + `mcp/manifest.json`，stdio + 换行分隔 JSON-RPC 2.0，17 个工具），不复制业务逻辑、不产生第二份数据。

## 数据与隐私

- 数据根：`~/.plug-funds/`（`data/invest.db` 为 SQLite，WAL；`PLUG_FUNDS_STATE_DIR` 可隔离）；当前 `SCHEMA_VERSION = 4`（迁移前自动备份，高版本库拒绝打开）；v4 把 `valuation_metrics` 改为复合主键 + WITHOUT ROWID（去掉只写不读的 uuid 主键），指标表占用 176.9 MB → 57.4 MB。
- 交易流水是唯一事实源，持仓为回放投影；金额 i64 定点（金额 2 位、份额净值 4 位、ROUND_DOWN）。
- **交易日历**：优先用本机指数日线（`000300` 优先）反推真实交易日，周末恒休市；区间内「工作日但无行情」判为休市并计入推导出的节假日；样本 <20 天或尚无指数日线时退回「工作日即交易日」并显式标注 `weekday`（节假日可能误判）。时间一律按 UTC+8 计算，不依赖宿主时区。
- **AI Key**：优先写 macOS 钥匙串（`security`）/ Linux `secret-tool`；SQLite 只保留哨兵值 `__keychain__`，不落明文。钥匙串不可用时显式降级到 SQLite 并通过 `secretBackend` 如实上报，启动时自动把老库明文迁移到钥匙串。
- **AI 分析**：先保存配置并测试连接，首次分析前确认接收地址、模型和发送范围。摘要含所选持仓、账户内权重的分母、有效价格区间及可用估值的日期/来源/质量，空值保持缺失。仅完整文本响应写入本地记录；配置变化需重新测试和确认。当前能力是持仓文本分析，不包含图片或截图 OCR 识别。
- **数据校验**：日期或口径不一致的指标只并列留证，不直接判错；指数已取得的官方滚动 PE 与报价值分键留档。用于评分的 PE / PB 分位以基础指标日期为终点回看 3 年，须同时满足至少 20 个有效样本、180 天跨度，且与基础指标同日。超过 7 个自然日的分位，或质量为 `STALE` / `CONFLICT` / `MISSING`、与基础指标错期的派生值，不用于当前评分。指数列表展示最新有效点位及类型、日期，实时报价不会标为收盘价。
- 卸载插件不删除 `~/.plug-funds/` 数据。

## 开发

```bash
npm install
npm test          # core / API / 行情 / AI / 指数分析与审计回归
npm run build     # 构建宿主 bundle + web SPA + MCP 入口 → plugin/targets/dsh/investment/
npm run check     # 构建产物自包含校验 + web 产物静态断言 + 全部测试
node plugin/scripts/smoke.mjs   # E2E 冒烟：mock cordis ctx + 真实 HTTP 全链路（21 项）
npm run pack:dsh  # 构建 + 打包 tarball → integrations/dsh/dist/
npm run verify:install  # 解包 tarball + 静态契约（含 SPA 挂载 / 指数页 / MCP）+ 隔离 HTTP/RPC（45 项）
npm run verify:web      # web 静态断言 + 真实 Chrome CDP 渲染与 AI 交互验证
npm run backfill:metrics # 中证官方估值回填（默认只体检；--apply 落库，写前先备份）
npm run backfill:cnindex # 国证完整目录滚动 PE / 静态 PE / PB / 市值（默认 dry-run）
npm run backfill:history -- --evidence .tmp/index-history # 官方收盘历史与年末基准回填（默认 dry-run）
npm run collect:reference -- --evidence .tmp/index-reference # 只读采集发布日期、关联目录、官方单张
npm run backfill:reference -- --evidence .tmp/index-reference # 校验原文 SHA-256 后生成补齐计划
npm run audit:metrics   # 估值指标多源核查（库内 / 腾讯 / 东财 / 中证官方并列对比）
npm run audit:indices   # active INDEX 全字段 JSON/CSV 审计（缺失、来源、口径冲突、修正记录）
npm run import:indices  # 导入沪深指数目录（000/399，默认 dry-run）
npm run import:indices -- --apply # 确认写入目录标识，不写行情数值
npm run refresh:indices # 批量刷新全部指数（分批调用同一刷新链路）
node plugin/scripts/verify-web.mjs           # 只跑静态层（无需 Chrome，适合 CI）
```

国证目录估值已接入常规行情刷新，每轮共享一次完整目录快照；只采纳目录确认的国证自编指数。官方主序列优先级为中证、国证、经校验的中证月度单张，PE / PB 的报价留在独立键，历史统计只使用同源数据。月度单张保留统计日与 `STALE` 标记，不当作最新日频估值；发布日期取中证 / 国证基本资料，必要时用已核验单张补充。关联基金列按官方目录产品代码计数，明确统计日或观察日；没有列表、代码存疑或分类不完整时保留空值，空数组只表示该目录列出 0 条。

参考资料通过上述离线脚本更新。`backfill:reference` 的 PDF 解析需要 Python 3 与 `pypdf`，可用 `--python /绝对路径/python3` 指定解释器；运行插件不需要 Python 或额外依赖。回填命令均须加 `--apply` 才写库，并在写入前备份。采集原文保存在所指定的 `.tmp/` 目录中，包含 URL、采集时间与 SHA-256，重放不把旧资料标成新采集。字段缺失、来源日期和缺样本原因同步到指数页及 CSV 导出。

指数历史刷新会检查上年末基准：报价源长区间被截断时单独请求上年 12 月 17 日至 31 日，再尝试中证 / 国证官方日线；已有合格基准时不重复补取。官方日线校验代码、日期、收盘价及 OHLC，新增来源与已有同日收盘对照，差异超过 1% 保留双方并标冲突。`backfill:history` 支持 `--codes`、`--begin`、`--end` 和 `--offline`，离线模式核对已采集原文的 URL 与 SHA-256；连续 403 后停止对应来源，失败不解释为没有历史。

错误码：用户输入 / 外部数据校验失败为 `422 validation-error`，资源不存在为 `404 not-found`，账本冲突为 `422`，schema 冲突为 `409`；程序内部故障仍为 `500 internal-error`。

结构与 DSH 适配边界见 `docs/design/optimization-plan.md`；执行约束见 `AGENTS.md`。
