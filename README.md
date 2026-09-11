# BlueRegion Usage

面向 LLM API 网关最终用户的**轻量级个人运营小系统**：用户只需持有自己的 API Key，即可查询个人 Token 用量、趋势、模型分布等数据，并通过一个零构建的静态 HTML 面板可视化呈现。

整套方案**不新增任何基础设施**——复用 API 网关 + 函数服务 + 监控数据链路即可跑通。

## 快速开始

**在线版**：<https://zyxzyxzyx.github.io/BlueRegionUsage/>（GitHub Pages 托管，首次打开同样进入引导视图，填入网关地址与 API Key 即可；网关地址填根地址，不要带 `/compatible` 等路径前缀）。

1. 下载或克隆本仓库；
2. **双击打开 [`panel/index.html`](panel/index.html)——这就是看板入口**，纯静态页面，无需构建、无需启动任何服务；
3. 首次打开会进入引导视图，填入你的**网关地址**（`gatewayBaseUrl`）和**个人 API Key**，勾选「记住配置」即进入看板；
   - 也可以预先复制 `panel/config.example.js` 为 `panel/config.js` 并填写同样两项，之后双击 `index.html` 直达看板；
   - `panel/config.js` 含你的私有凭证，已被 `.gitignore` 忽略，请勿提交或截图分享。

> 提示：通过 `http://` 打开页面时 API Key 会以明文随请求传输，建议使用 `file://` 直接双击或 `https://` 托管访问。

## 为什么做这个项目

OpenAI、Anthropic 等大厂的用量查询均要求管理级 Key（Admin Key），普通推理 Key 无法查询自己的用量。"**用自己的 API Key 查自己的用量**"是 OpenRouter、LiteLLM、new-api 等网关验证过的标杆能力，也是个人开发者最朴素的需求。本项目把这套能力以最小成本落地，并开源给生态伙伴共同完善。

## 总体架构

```
用户浏览器（静态 HTML 面板，config.js 配置自己的 API Key）
   │  Authorization: Bearer <用户自己的 API Key>
   ▼
API 网关（独立路由，key-auth 认证 + 限流，鉴权通过后注入消费者 ID）
   ▼  仅携带消费者 ID，用户凭证不离开网关鉴权层
函数服务 Webserver 函数
   ▼  Prometheus HTTP API（Instant Query，平台内部服务间授权，无需凭证）
托管 Prometheus（网关访问日志聚合后的用量指标）
```

- **身份即凭证，凭证止于网关**：网关 key-auth 校验通过后，将消费者 ID 注入请求传给函数；函数仅以消费者 ID 作为指标查询的 consumer 过滤值，用户天然只能查到自己的数据。用户 API Key 全程不进入函数服务——对函数而言，这只是一次普通的网关调用。
- **全链路零凭证流转**：函数查询监控数据源走云平台内部服务间授权（VeFaaS ↔ VMP），无需配置、传递任何访问凭证，也没有凭证可能泄露。
- 当前实现基于火山引擎（VeFaaS 函数服务 + APIG 网关 + VMP 托管 Prometheus），思路可平移到任意"网关 + 函数 + Prometheus 兼容数据源"的组合。

## 目录结构

```text
functions/
└── ops/             # /v1/usage/* 个人用量查询 API（summary / daily / hourly / by-model / by-provider / performance）
    ├── vefaas_ops.py
    └── run.sh
panel/               # 零构建静态可视化面板（原生 JS + ECharts CDN）
├── index.html       # ★ 看板入口：双击打开即用（引导视图 + 面板视图）
├── config.js        # 用户私有配置（gitignore，由 config.example.js 复制而来）
├── config.example.js
├── css/  js/
```

## 面板功能

- 今日 / 本周 / 本月（UTC+8 日历对齐）三周期切换，KPI 环比徽章（较昨日 / 上周 / 上月）
- Credit 用量估算：按日分段计量（每日总 Tokens × 当日生效系数 ÷ 百万），跨系数变更自动分段；系数缺失自动降级
- 输入 Tokens 按 OpenAI 规范拆分：缓存未命中 / 缓存命中 / 输出分别展示
- Credit 限额提醒：可配置每日 / 每周 / 每月限额（config.js 或页面内「配置限额」），Credit 卡显示离限额差额（未超绿 / 超出红）；本月 pacing 进度条按「月限额÷当月天数×第几天」衡量消耗进度，超额橙色告警（设计见 docs/credit-quota-design.md）
- 每日趋势、今日分时、模型分布、供应商分布图表，模型明细表排序 + CSV 导出
- 手动刷新（10s 冷却），浅色 / 深色 / 跟随系统主题，纯静态零构建

## 配套 /v1/models 端点（需自建）

面板除 `/v1/usage/*` 外还调用网关上现有的 `GET /v1/models`（OpenAI 兼容模型列表），用于连通性检测与 Credit 计量。本项目使用的定制版与具体模型目录、计量系数耦合，未包含在本仓库。如需完整体验，请自建返回如下形状的端点：

```json
{
  "object": "list",
  "consumer": "api-key-xxxxxxxx",
  "data": [
    {"id": "your-model", "object": "model", "created": 1700000000, "owned_by": "you",
     "credit": 1.23,
     "credit_history": [{"from": "2026-08-01", "credit": 1.23}]}
  ]
}
```

- `consumer`：回显当前消费者 ID（网关在 key-auth 通过后注入身份头，函数回显即可）；
- `credit` / `credit_history`（可选）：模型计量系数及其版本历史（区间语义 `[from, 下一条 from)`），面板据此按日分段估算 Credit 用量。

缺少 `consumer` / `credit` 字段时面板自动降级（用量查询不受影响，连通徽标与 Credit 展示降级为 `--`）。

## Roadmap

- [x] `/v1/usage/*` 个人用量查询函数（已实现并上线运行，内置 mock 模式可无依赖本地开发）
- [x] `panel/` 零构建静态可视化面板（已实现，与 usage API 联调通过）
- [ ] `/v1/quota`、`/v1/announcements` 等更多个人运营接口
- [ ] 其他网关 / 函数平台 / Prometheus 兼容数据源的适配

## 部署前提

1. 支持 Webserver 模式的函数服务（本示例使用火山引擎 VeFaaS）：函数以 `python3 vefaas_*.py` 启动，监听 `VEFAAS_PORT` 环境变量指定的端口；
2. API 网关：为函数配置路由转发，用量类接口需绑定 key-auth 类认证插件与限流插件；
3. Prometheus 兼容数据源：存有带 `consumer` 标签的用量指标（本方案指标由网关访问日志经日志服务定时 SQL 聚合写入）；函数到数据源采用云平台内部服务间授权（如火山 VeFaaS ↔ VMP），无需配置访问凭证。

## 安全约定

- 本仓库**不包含、也不接受**任何真实凭证（API Key、AK/SK、域名、实例 ID）。方案本身运行时也不依赖任何凭证配置：用户凭证止于网关鉴权层，函数到数据源走平台内部服务间授权。
- `panel/config.js`（用户私有配置）已在 `.gitignore` 中忽略，请勿强制提交。
- 提交前建议运行 `gitleaks` 等工具自查。

## 参与贡献

欢迎生态伙伴一起完善：更多个人运营接口、面板体验优化、其他网关/函数平台的适配。请通过 Issue 交流想法、PR 提交代码。

## License

[Apache-2.0](LICENSE)
