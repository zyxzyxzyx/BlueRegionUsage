# Credit 限额与月度 pacing 进度条 设计文档

## 1. 背景与目标

现有 BlueRegion Usage 面板以「估算 Credit 用量」为核心指标，但没有限额观念。本次迭代新增两个诉求：

1. 为每日 / 每周 / 每月 Credit 用量配置**独立限额**（`dailyCreditLimit` / `weeklyCreditLimit` / `monthlyCreditLimit`）。
2. 在「Credit 用量（估算）」卡片上，按当前分页（今日 / 本周 / 本月）展示**离对应限额还差多少**：未超绿色、超出红色。
3. 新增一条**横置进度条**，衡量「本月累计用量」相对「按月均速度到今天的可用额」的消耗比例：未超绿色、超出黄色闪烁。

## 2. 现状分析（代码逻辑）

### 2.1 面板架构

`panel/` 是零构建静态页：`index.html` + 原生 JS。无打包、无框架，各 JS 以 IIFE 挂载到全局 `window.BRU.*`：

- `js/config.js`：配置读取 / 校验 / localStorage 覆盖（优先级 localStorage > `config.js` → `DEFAULTS`）。
- `js/api.js`：`fetch` 封装 + 业务接口（`summary` / `daily` / `hourly` / `byModel` / `byProvider` / `performance` / `models`）。
- `js/app.js`：视图切换、取数编排（`fetchAll` / `loadAll`）、KPI 与图表渲染。
- `js/format.js`：数字 / 百分比 / Credit 格式化（`F.credit`）。
- `js/charts.js`：ECharts 封装。

### 2.2 Credit 计算链路

- Credit 是**估算值**，由 `by-model` 响应逐行计算：`modelCreditUsage(r)`（`app.js`）按 `daily` 逐日明细 × 当日生效 Credit 系数 ÷ 1e6 分段求和，系数来自 `/v1/models` 的 `credit` / `credit_history`（`state.creditMap` / `state.creditHistMap`）。
- 「Credit 用量（估算）」卡片 `#kpi-credit` 由 `renderCreditKpi(list)` 渲染，列表为当前分页窗口的 `by-model` 数据。

### 2.3 分页（今日 / 本周 / 本月）

- `state.period` 驱动，切换后 `loadAll()` 重新取数。
- `periodParams(key)` 计算 `window`（`today`/`week`/`month`）与 `days`/`hours`。
- `summary(window)` 返回窗口合计 + 环比 `compare`；`by-model(window)` 返回当前窗口按模型拆分。

### 2.4 配置体系

- `panel/config.example.js` → `window.APP_CONFIG`，字段：`gatewayBaseUrl`、`apiKey`、`trendDays`、`theme`、`numberStyle`。
- `panel/js/config.js` 的 `DEFAULTS` / `keys` / `validate` / `load` 决定字段生效与校验；设置抽屉可编辑并写入 localStorage（`saveLocal`）。

关键点：**月视图数据与 Credit 系数在非「本月」分页时并不在当前取数结果中**，月度进度条需要额外取一次本月窗口的 `by-model`。

## 3. 需求拆解

| # | 需求 | 触发维度 | 展示位置 |
|---|------|----------|----------|
| 1 | 三类限额配置 | config.js / localStorage | `config.example.js` + 首次登录页 + 进度条卡片「配置限额」菜单 + 设置抽屉 |
| 2 | 剩余额度提示（差额 + 绿/红）与 `/限额` 小字 | 跟随分页 | Credit KPI 卡片子行 |
| 3 | 月 pacing 进度条（百分比 + 淡黄/橙色闪烁） | 恒为「本月」 | 独立卡片 |

## 4. 方案设计

### 4.1 配置扩展

- `config.example.js` / `DEFAULTS` / `load` 的 `keys` 增加三个字段，均**可选、独立**：

```js
dailyCreditLimit   // number|null 每日 Credit 限额
weeklyCreditLimit  // number|null 每周 Credit 限额
monthlyCreditLimit // number|null 每月 Credit 限额
```

- `validate` 增加校验：为空（`''` / `null` / `undefined`）表示未配置；否则必须是非负数字。
- **首次登录（onboarding）**新增三个 number 输入框，随 `gatewayBaseUrl`/`apiKey` 一起写入 `cfg` 并（确认后）`saveLocal`。
- **进度条卡片**内新增「配置限额」小按钮，展开三段内联输入，保存时经 `applyLimits` 只更新限额字段（合并已有 localStorage，不覆盖 `gatewayBaseUrl`/`apiKey`）。
- 设置抽屉新增三个 number 输入框，`drawerCollect` 收集并 `saveLocal`；`state.cfg` 统一以 `toNum()` 归一化（非法/空 → `null`）。
- `config.example.js` 示例默认 `null`（纯模板，避免用户未配置时被示例值误限）。
- 语义约定：**留空 = 不启用该维度限额**（卡片显示 `--` 且不显示差额/进度）。

### 4.2 Credit 卡片剩余额度子行（需求 2）

- `#kpi-credit` 下方新增 `#kpi-credit-remain` 子行。
- 计算：`limit = periodLimit()`（按 `state.period` 取对应字段）；`used = sumCredit(list)`（当前分页窗口 Credit 用量）。
- 文案与配色：

| 状态 | 文案 | class | 颜色 |
|------|------|-------|------|
| 未超（`used < limit`） | `离{每日|每周|每月}限额还差 {diff}` | `kpi-remain-ok` | 绿 `#2ea043` |
| 恰达（`used == limit`） | `离…还差 0.00` | `kpi-remain-ok` | 绿 |
| 超限（`used > limit`） | `已超出…限额 {diff}` | `kpi-remain-over` | 红 `var(--danger)` |
| 未配限额 / 无系数 | 空 | `kpi-remain` | — |

- 与现有 `KPI_IDS`/`setKpiState` 生命周期一致：loading/error 时清空子行。
- 用量数值右侧附加小字 `/限额`（如 `82.59 /500`），限额用紧凑格式（整数不带小数，如 `500` 而非 `500.00`）；今日/本周/本月各自取对应限额。

### 4.3 月 pacing 进度条（需求 3，独立于分页）

- 新增卡片 `#card-quota`，位于 KPI 网格之后、图表网格之前，恒展示「本月」维度。
- 口径（已与需求方确认）：

```
日均可用 = monthlyCreditLimit ÷ 本月实际天数        // 本月实际天数 = 当月 28/29/30/31
月均累计可用 = 日均可用 × 本月第几(now.getDate())
进度 pct  = 本月实际 Credit 用量 ÷ 月均累计可用 × 100%
```

- 文本口径：`本月日均可用累计额 1,333.33 Credit(月限额 5,000.00/30天 * 本月第 8 天)`；`已用 X` 归入底部备注行。
- 渲染：

| 状态 | 表现 |
|------|------|
| `used <= 月均累计可用` | 进度条已用部分青色（供应商分布第 2 名 `#36cfc9`）；备注「已用 X · 已消费日均累计值的 xx.x%」 |
| `used > 月均累计可用` | 进度条已用部分橙色闪烁（CSS 动画），备注「已用 X · 已超出日均累计值 xx.x%」 |
| 未配月限额 | 显示「配置限额」提示条 +「尚未配置每月 Credit 限额」，进度条清空 |
| 有调用但无 Credit 系数 | 提示「模型目录未返回 Credit 系数」，进度条清空 |

- 轨道背景蓝色（供应商分布第 1 名 `#4c9aff`），已用部分青色（第 2 名 `#36cfc9`），超额橙色（保持不变），均通过 CSS 变量适配深浅主题。
- 进度条最大宽度封顶 100%（超出时仍 100% 但橙色闪烁），实际百分比记在备注中。

### 4.4 取数编排（月度数据）

- `fetchAll` 由数组索引改为**命名对象**，便于扩展、消除索引漂移。
- 非「本月」分页时**额外**并发拉取 `byModel(month)`，作为 `byModelMonth`；「本月」分页时直接复用 `byModel`（即窗口 = `month`）。
- `loadAll` 将结果写入 `state.cache.byModelMonth`，再调用 `renderQuotaBar(...)`。

```text
fetchAll(cfg)
 ├─ summary(window)           // 当前分页 KPI + 环比
 ├─ byModel(window)           // 当前分页 Credit + 明细
 ├─ byProvider(window)
 ├─ performance(hours)
 ├─ daily(days)
 ├─ hourly()                  // 仅今日
 └─ byModel('month')          // 仅当 period !== 'month'，供进度条
```

### 4.5 竞态处理

`Credit` 系数来自 `/v1/models`（`refreshConnBadge` 异步），与 `by-model` 并行返回，存在先于系数落库的竞态。方案：`setModelCatalog` 完成后，若已有缓存的 `byModel` / `byModelMonth`，则**补渲染** `renderCreditKpi` / `renderQuotaBar`。

## 5. 文件改动清单

| 文件 | 改动 |
|------|------|
| `docs/credit-quota-design.md` | 本文档 |
| `panel/config.example.js` | 新增三个限额字段（默认 null）及注释 |
| `panel/js/config.js` | `DEFAULTS`/`keys`/`validate` 增加限额字段；导出 `readLocal` |
| `panel/index.html` | 首次登录页加限额输入；Credit 卡加子行；进度条卡片加「配置限额」按钮/提示/内联表单；抽屉加三个限额输入 |
| `panel/js/app.js` | `sumCredit`/`toNum`/`compactCredit`/`periodLimit`/`renderCreditRemain`/`renderQuotaBar`/`applyLimits`/`initQuotaCard`/`numField`；`fetchAll` 命名化并追加 `byModelMonth`；`loadAll` 存储与渲染；`refreshConnBadge` 补渲染；`init`/`initOnboarding`/`openDrawer`/`drawerCollect` 集成限额 |
| `panel/css/style.css` | `.kpi-remain*`、`.kpi-credit-limit`、`.quota-*`（head/hint/form/track/fill）及 `quota-blink` 关键帧、配额色变量 |

## 6. 验收要点（供测试）

1. **配置**：首次登录页 / 进度条「配置限额」菜单 / 设置抽屉三处均可填三类限额并写入配置；留空某维度则该项不提示；`config.js` 填值亦生效。
2. **剩余额度**：切换今日/本周/本月，Credit 卡子行分别显示「离每日/每周/每月限额还差 X」，数值下附加 `/限额` 小字；构造用量超限（把限额调小）时变红显示「已超出…」。
3. **进度条**：无分页依赖，恒为月 pacing；未超淡黄、超过 100% 橙色闪烁；百分比 = 本月用量 ÷（月限额÷当月天数×第几天）；文本为「本月日均可用累计额 X Credit(月限额 Y/Z天 * 本月第 N 天)」。
4. **降级**：仅配月限额时不显示日/周差额；未配月限额时进度条卡片显示提示条与「配置限额」按钮；mock 模型缺 `credit` 时相应位置显示 `--` 或提示。
5. **回归**：原有 Credit KPI、趋势/分时/模型/供应商图、明细表、CSV 导出、主题切换均不受影响。

## 7. 边界与降级

- 限额为**估算口径**（与 Credit 用量同源），不改变后端任何接口，仅面板侧展示。
- 进度条百分比基于「自然月均摊」，月末日数差异（28/29/30/31）会影响日均值，符合口径约定。
- 浏览器时区非 UTC+8 时，`getDate()` 取自本地；与现有「今日/本周/本月」前端口径保持一致（后端按 UTC+8 切分，前端信任本地时间）。