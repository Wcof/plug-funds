# 个人投资工作站（plug-funds）· DeepSeek Harness 插件

本地优先的个人投资工作站，以 **DeepSeek Harness（DSH / DeepSeekBox）插件**形态交付：账本、行情、估值观察、组合风险与 AI 分析，全部数据保存在本机，不上传云端，不连接券商，不自动交易。

产品口径与需求见 PRD v1.4（`/Users/ldh/Downloads/investment-workstation-prd-v1.1.md`，文件名保留 v1.1）；架构决策见 `docs/design/optimization-plan.md`。

## 安装（DSH ≥ 0.2.1-rc.3）

构建产物是自包含 npm tarball（无外部依赖，安装器不装依赖也能用）：

```bash
# 从源码构建 + 打包
npm install
npm run pack:dsh
# 产物：integrations/dsh/dist/plug-funds-dsh-investment-0.1.0.tgz

# 安装到 DSH（在 DSH 的插件安装入口 / plugin_manager 中执行）
install_bundle target=/绝对路径/integrations/dsh/dist/plug-funds-dsh-investment-0.1.0.tgz
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
- **估值**：内置 4 模板 + 自定义模板，可编辑、每次保存生成不可变版本、可回滚；规则评分 0–100（规则匹配度，非涨跌概率）；必需指标缺失 → 数据不足；支持手工补录估值指标并标注 MANUAL；刷新时按近 3 年截面计算 PE / PB 历史分位（样本 <20 不写）。
- **账本与数据**：交易流水唯一事实源、`requestId` 幂等；**CSV 与 Excel（.xlsx）流水导入**（预览 / 错误行可见 / 单事务提交 / 失败整批回滚；xlsx 在自包含约束下自解析 ZIP + XML，不引第三方库，并正确还原日期序列号、稀疏列、富文本与实体）；JSON 全量备份恢复（schema 校验 / 恢复前自动备份当前库 / 外键与回放一致性 / 失败回滚）；组合外部资金流水驱动 XIRR；每日组合与持仓快照、数据源运行记录。
- **指数**：参考 `touzid.com/indice/#/6` 复刻「指数列表」——两行二级菜单、筛选工具条、双层分组表头、36 列高密度表格、左侧两列 sticky、排序 / 行选中 / 关注星标 / 导出 / 指标定义弹窗、桌面响应式；二级菜单 **16 项全部可切换**：列表 / 指标自定义 / ETF / 财务对比 / 历史涨跌幅 / 相关性 / RPS / 波动率 / 新高 / 新低 / 图形对比 / 定投 / 格雷厄姆 / 股债性价比 + **互联互通与两融**（数据源未覆盖时显示「需要什么数据」而非填 0）。数值一律取自本机 `valuation_metrics` / `market_points`（有效价格口径），分位点样本 <20 显示「—」；**不复制第三方真实行情**。本机无 `type=INDEX` 标的时启用「结构预览」，数值列全部为「—」并显式标注。
- **设置**：分类管理（名称 + 颜色、括号计数、直接改名、删除）；AI 配置（Base URL / Key / 模型，OpenAI 兼容，手动触发，**Key 存系统钥匙串**）；行情自动刷新（默认 60 秒、可关闭、可配间隔、仅交易时段开关）；交易日历与当前时段展示；JSON / CSV 导出与备份恢复；隐藏金额。
- **行情**：**腾讯财经为主源**（`qt.gtimg.cn` 实时 / `web.ifzq.gtimg.cn` K 线，覆盖 A 股 / ETF / 指数 / 港股 / 美股 / 场外基金最新净值）+ **东财兜底**（`push2` 报价与 K 线、`f10/lsjz` 场外基金历史净值、`pingzhongdata` 全量净值、`f10` 估值明细）+ 手工价格；有效价格统一口径 `MANUAL_PRICE > 当日 REALTIME > CLOSE / OFFICIAL_NAV`，同日多来源去重；**多源交叉校验**：同一标的同一天两个来源相对差 >1% 时标记 `CONFLICT` 并保留双方记录，不擅自选一个当正确答案；正式净值与盘中估算严格分离，估算不参与计价。
- **MCP（Zcode 等 MCP 宿主）**：同一套 server 层以 MCP 工具形式暴露（`mcp/index.js` + `mcp/manifest.json`，stdio + 换行分隔 JSON-RPC 2.0，17 个工具），不复制业务逻辑、不产生第二份数据。

## 数据与隐私

- 数据根：`~/.plug-funds/`（`data/invest.db` 为 SQLite，WAL；`PLUG_FUNDS_STATE_DIR` 可隔离）；当前 `SCHEMA_VERSION = 3`（迁移前自动备份，高版本库拒绝打开）。
- 交易流水是唯一事实源，持仓为回放投影；金额 i64 定点（金额 2 位、份额净值 4 位、ROUND_DOWN）。
- **交易日历**：优先用本机指数日线（`000300` 优先）反推真实交易日，周末恒休市；区间内「工作日但无行情」判为休市并计入推导出的节假日；样本 <20 天或尚无指数日线时退回「工作日即交易日」并显式标注 `weekday`（节假日可能误判）。时间一律按 UTC+8 计算，不依赖宿主时区。
- **AI Key**：优先写 macOS 钥匙串（`security`）/ Linux `secret-tool`；SQLite 只保留哨兵值 `__keychain__`，不落明文。钥匙串不可用时显式降级到 SQLite 并通过 `secretBackend` 如实上报，启动时自动把老库明文迁移到钥匙串。
- 卸载插件不删除 `~/.plug-funds/` 数据。

## 开发

```bash
npm install
npm test          # 162 个测试（core 单测 + API 集成 + 行情 fixture + 日历 + xlsx + 钥匙串 + MCP + 指数分析）
npm run build     # 构建宿主 bundle + web SPA + MCP 入口 → plugin/targets/dsh/investment/
npm run check     # 构建产物自包含校验 + web 产物静态断言 + 全部测试
node plugin/scripts/smoke.mjs   # E2E 冒烟：mock cordis ctx + 真实 HTTP 全链路（21 项）
npm run pack:dsh  # 构建 + 打包 tarball → integrations/dsh/dist/
npm run verify:install  # 解包 tarball + 静态契约（含 SPA 挂载 / 指数页 / MCP）+ 隔离 HTTP/RPC（41 项）
npm run verify:web      # web 产物静态断言 + 真实 Chrome CDP 渲染验证（69 项 = 静态 29 + 浏览器 40）
node plugin/scripts/verify-web.mjs           # 只跑静态层（无需 Chrome，适合 CI）
```

错误码：用户输入 / 外部数据校验失败为 `422 validation-error`，资源不存在为 `404 not-found`，账本冲突为 `422`，schema 冲突为 `409`；程序内部故障仍为 `500 internal-error`。

结构与 DSH 适配边界见 `docs/design/optimization-plan.md`；执行约束见 `AGENTS.md`。
