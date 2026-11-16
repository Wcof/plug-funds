# ROADMAP — 个人投资工作站（plug-funds）

## 当前状态（2026-11-15 22:50 CST，全量补齐 + 东财真实接口修复后）

- **除「真实 DSH 装机目视验收」外，此前所有待办均已实现并纳入门禁**：现金 / 再平衡 / 相关性 / 风险参数、真实交易日历、xlsx 二进制导入、系统钥匙串、指数页 16 项二级菜单、MCP（Zcode）适配层、多源行情（腾讯主源 + 东财兜底 + 冲突标记）。
- **本轮修掉两个真实接口缺陷**（不是「网络不可达」）：
  1. 东财场外基金历史净值端点拼错：`/f10/lsjnz` → `/f10/lsjz`。错写时接口返回 `{"Data":null,"ErrCode":4,"ErrMsg":"404"}`，此前被误记为「接口 404 / 接口变更」。
  2. 该接口服务端把每页硬性截到 20 条（`pageSize=400` 直接返回 0 行），原实现按 400 请求恒得 0 条 → 基金历史永远为空。现改为 `pingzhongdata` 单请求取全量（本机实测 4437 条 / 617 KB）并按 UTC+8 折算交易日，`lsjz` 分页（固定 20 条 / 最多 40 页）作兜底。
- **实测结论（本机 2026-11-15）**：腾讯 `qt.gtimg.cn` 正常（招商银行 42.93）；东财 `f10/lsjz`、`pingzhongdata` 正常（易方达优质精选 4.0421，69 个交易日序列一次拉全）；东财 `push2` / `push2his` 仍为 HTTP 000（本机网络不可达），由腾讯主源承担，多源兜底按设计生效；`fundgz` 估算净值端点**已下线**（任何基金都返回 404 HTML 页），估算链路当前不可用。
- **自动化门禁全绿**：`npm test` 162/162、`npm run check`（自包含 + web 静态 29 项 + 全部测试）、E2E 冒烟 21/21、`verify:web` 69/69（静态 29 + 真实浏览器 40，控制台零错误 / 零 4xx）、`verify:install` 41/41（解包 tarball 后隔离加载）、tarball 13 文件 / 235.9 kB 且仅依赖 `node:` 内置模块。
- **仍非「已上线可用」**：唯一未做的是真实 DSH 装机目视验收（用户明确排除自动执行）。不得把自动化通过等同于真实宿主可用。

## 最近完成

- 2026-11-15 22:50 **东财真实接口修复 + 文档台账同步**：
  - 端点纠错：`/f10/lsjnz` → `/f10/lsjz`（`fetchQuote` / `fetchHistory` 两处），并用源码级测试锁死，防止回退。
  - 基金历史：改为 `pingzhongdata/<code>.js` 的 `Data_netWorthTrend` 单请求全量（手写括号配对切数组，避开大数据量正则），`lsjz` 固定 20 条分页兜底（≤40 页）；实测从 0 条恢复为 69 条。
  - 质量标记：非当日净值标 `DELAYED`，不再把三天前的净值标成 `FRESH`；`today` 统一按 UTC+8，修掉北京时间 00:00–08:00 把「当天」算成昨天的问题。
  - 去重：`INDEX_SECIDS` 原先在 `market/eastmoney.ts` 与 `services/charts.ts` 各存一份，合并为单一定义；删掉 `_unusedNowIso` 假导出与未调用的局部函数。
  - 测试：`eastmoney.test.ts` 增 3 项（`sliceJsArray` 括号配对、`parsePingzhongNav` 时区与过滤、端点 / 分页常量守卫），共 162 项。
- 2026-11-15 22:20 **此前待办集中补齐**（承接「除 DSH 装机验收外全部做完」）：
  - 前端：现金账户、再平衡、相关性矩阵、风险参数四个面板接入总览页（`web/src/portfolio.tsx` + `.pf-*` / `.corr-*` 样式）；再平衡未设目标时全 HOLD。
  - 交易日历：`core/src/calendar.ts` 纯函数 + `services/calendar.ts` 用指数日线反推，`get_refresh_settings` 返回 `session` + `calendar`，定时刷新改走 `isMarketOpen()`。
  - xlsx 导入：`server/src/xlsx.ts` 自解析 ZIP + XML（`node:zlib` inflate、EOCD/CEN/LOC、sharedStrings、styles 日期判定、稀疏列、实体与富文本），复用 CSV 预览 / 提交链路。
  - 钥匙串：`server/src/secrets.ts`（macOS `security` / Linux `secret-tool`），SQLite 只留 `__keychain__`，启动自动迁移，`secretBackend` 如实上报。
  - 指数页：16 项二级菜单全部可切换，14 个真实视图 + 2 个数据源未覆盖时显式说明（互联互通 / 两融），列表列可自定义。
  - MCP：`targets/mcp/server.ts` + `targets/zcode/manifest.json`，17 工具、stdio JSON-RPC、`tools/list` 与清单一致性由测试守护。
  - 多源：`market/tencent.ts`（腾讯主源）+ `market/conflict.ts`（相对差 >1% 标 CONFLICT）。
- 2026-11-15 21:30 **决策就绪度 + 集中度补齐**：9 维度加权 0–100（现金维度后补）、集中度（Top1 / Top3 / HHI / 有效持仓数）、`coveredValue` 掩码。
- 2026-11-15 20:48 **指数页复刻 + SPA 挂载修复**：`main.tsx` 补 `createRoot().render(<App />)`（此前真实浏览器恒空白）；新增 `verify-web.mjs` 双层门禁。
- 2026-11-15 19:55 **v0.2 修复轮**：`MASK_EXEMPT` 掩码豁免、`effectiveHistoryPoints()` 统一口径、CSV 导入 / JSON 恢复 / 策略模板版本化、`ValidationError` 422 / `NotFoundError` 404、`verify-install.mjs`。
- 2026-11-15 18:35 首版 DSH 插件 v0.1.0（core / server / web / 适配壳 / tarball）。

## 进行中（人工验收项）

- [ ] **真实 DSH 装机目视验收**（用户明确排除自动执行）：侧栏入口、主面板 iframe 渲染、主题跟随 / 明暗切换、自动刷新在交易时段的实际行为。命令见 README「安装」节。
- [ ] 让「指数」页显示真实数值：需录入 `type=INDEX` 标的并补齐 `market_points` / `valuation_metrics`；在此之前保持「结构预览」，数值列均为「—」。

## 已知偏离（不谎称已实现）

- [ ] **东财 `push2` / `push2his` 本机不可达**（HTTP 000，带 Referer 亦同）。不影响可用性：个股 / ETF / 指数 / 港美股报价与 K 线由腾讯主源覆盖，东财仅作兜底与基金净值来源。若换到可直连的网络环境，东财会自动参与并触发多源交叉校验。
- [ ] **盘中估算净值不可用**：`fundgz.1234567.com.cn` 已下线（任何基金都返回 404 HTML 页面，HTTP 200 + 错误页）。`parseFundGz` 解析失败即返回 `null`，不会写入伪造估值；`ESTIMATED_NAV` 永不参与计价。
- [ ] **互联互通 / 两融**：数据源未覆盖，页面显示「需要什么数据」而不是填 0。
- [ ] 「指数」页的成分股聚合口径（加权 / 等权 / 算数 / 中位数）仅作标注，未做等价实现。
- [ ] 场外基金净值只有日频（正式净值），无盘中估值；主动基金无实时穿透。

## 已知风险

- 真实 DSH 未安装 ⇒ 宿主 API（`slots.inject` / `webServer.register` / `effect` 清理语义）只按 ADR-0048、plugbox 与 fund 先例静态核对，未经真机验证。
- 公开接口无 SLA：字段位次与路径会变（本轮 `lsjnz → lsjz` 即是实例）。已用 fixture + 源码守卫锁住已知形态；接口再次变更时只替换适配器，不影响业务层。
- 基金全量净值单文件 600 KB 量级，弱网下首次刷新较慢；已按标的有界超时，失败回退分页。
- 超大目标 / 特殊 CSV 编码边界未做穷尽测试；导入以 UTF-8（含 BOM）与 .xlsx 为准，不接受 .xls。

## 验证记录

- 2026-11-15 22:50 全量复跑（当前）：`npm test` 162 通过 / 0 失败；`npm run check` 通过（自包含 + web 静态 29 项）；`npm run verify:web` 69/69（含指数二级视图与组合面板）；`node plugin/scripts/smoke.mjs` 21/21；`npm run pack:dsh` 13 文件 / 235.9 kB；`npm run verify:install` 41/41。
- 2026-11-15 21:30 全量复跑（历史）：`npm test` 82/82；`verify:web` 43/43；`verify:install` 28/28；tarball 11 文件 / 140.6 kB。
- 2026-11-15 20:48 全量复跑（历史）：`npm test` 73/73；`verify:web` 35/35；`verify:install` 26/26；tarball 11 文件 / 134.2 kB。
- 2026-11-15 19:55 全量复跑（历史）：`npm test` 68/68；`verify:install` 22/22；tarball 11 文件 / 83.5 kB。
- 验证对象：`plugin/` 全部代码 + 解包后的 tarball 产物 + 真实浏览器渲染 + 真实行情接口抽验（腾讯 / 东财 `lsjz` / `pingzhongdata`）。
