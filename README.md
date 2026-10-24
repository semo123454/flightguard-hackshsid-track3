# 航策 FlightGuard

根据 `docs/IMPLEMENTATION_GUIDE.md` 落地的可解释航班运行事件研判应用。当前实现采用 npm workspaces、TypeScript、Fastify 5、React/Vite、Ajv 与 SQLite；没有模型密钥时会明确进入规则回退模式，核心流程仍可运行。

当前 `report-v4` 把研判核心改为服务端按证据与规则确定生成：分别展示当前值、本机场历史、同期同类机场参照、已知事实、未知项、触发规则和适用边界；冲突数据保留全部候选值且在解决前不计算差值。语言模型只生成分受众的受控沟通草案，不能改写风险等级或核心事实。

> 所有机场、事件和数值均为赛事模拟，不能用于真实航班运行。系统只生成核查建议和待审核草案，不会自动取消、放行、调度、维修、赔付或正式发送。

## 环境要求

- Node.js 24.x
- npm 11.x
- 首次浏览器测试需安装 Playwright Chromium：`npx playwright install chromium`

`better-sqlite3` 含本机模块。锁文件通常会下载对应 Node 24 的预编译包；若网络失败并回退本地编译，电脑还需 Python 与 Visual Studio C++ Build Tools。

## 首次运行

```powershell
Set-Location track3
npm ci
npm run db:migrate
npm run data:import
npm run build
npm start
```

浏览器打开 `http://127.0.0.1:4173`。生产模式由 Fastify 同源托管 `apps/web/dist`，不是 Vite 开发服务器。

开发模式：

```powershell
npm run dev
```

Vite 默认运行在 `http://127.0.0.1:5173`，并将 `/api` 代理到 4173。可用 `VITE_API_TARGET` 覆盖代理目标。

## 配置语言模型

复制 `.env.example` 为 `.env`，至少填写：

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=openai
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=你的模型ID
LLM_API_KEY=你的密钥
```

DeepSeek 可直接使用同一套 Responses API 适配器：

```dotenv
LLM_ENABLED=true
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_API_KEY=你的DeepSeek密钥
LLM_REASONING_EFFORT=none
LLM_MAX_OUTPUT_TOKENS=4096
```

也可将 DeepSeek 密钥写入 `DEEPSEEK_API_KEY`。FlightGuard 默认对 DeepSeek 使用 `none`，避免结构化决策报告被不必要的思考 token 截断；需要研究推理行为时可显式改为 `low`、`high` 或 `max`。

密钥只在后端读取，禁止改成 `VITE_` 环境变量。适配器使用 OpenAI-compatible Responses API 的严格 JSON Schema 输出，当前支持 OpenAI 与 DeepSeek；服务器仍会用 Ajv、证据 ID、数字、正式状态和动作权限进行二次校验。一次修复仍失败时自动回退规则模板。

不配置 `LLM_MODEL` 或密钥时：

- 结构化事件、基线、规则报告、追问回退、反馈、修订、导出均可用；
- 自由文本提取返回 422，提示改用结构化表单；
- 页面将系统模式显示为“规则回退”，不会伪装成模型成功。

## 数据库与导入

迁移位于 `apps/api/migrations/`。默认数据库为 `runtime/flightguard.sqlite`，启动时会自动迁移；空库会自动导入 `data/dataset.json`。

手动导入：

```powershell
npm run data:import
```

导入报告写入 `data/normalized/import-report.json`。重复导入使用唯一键保持幂等；空值不会转换成 0。

运行中备份请使用 SQLite 备份 API，不要只复制主文件而遗漏 WAL：

```powershell
npm run db:backup
```

备份写入 `runtime/backups/`。

## 验证

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run build
```

如果尚未下载 Playwright 自带 Chromium，但 Windows 已安装 Edge，可运行：

```powershell
$env:PLAYWRIGHT_CHANNEL='msedge'
npm run test:e2e
```

真实模型评估会产生实际网络调用和费用，因此不会包含在默认测试中：

```powershell
Copy-Item tests/fixtures/live-holdout.template.json tests/fixtures/live-holdout.local.json
# 由未编写提示词的成员填写上述本地留出案例，然后在 .env 中配置：
# EVALUATION_HOLDOUT_PATH=./tests/fixtures/live-holdout.local.json
$env:EVALUATION_CONFIRM_LIVE='true'
npm run evaluate:live
```

该命令必须先配置模型、密钥、独立留出案例，并显式确认费用预算。它会关闭模型输出缓存，运行赛事 15 项问题、1 个独立未见案例及一次自由文本提取；数据冲突、正式发布和停止条件各重复 3 次，因此共执行 22 轮行为验证，其中隐私案例应在模型调用前被拒绝，其余 21 轮执行报告与追问。结果写入 `reports/live-evaluation-*.json`，包含输入、输出、证据引用核查、留出文件校验和与用量；测试替身或规则回退不会被计为真实模型成功，自动校验后仍需人工逐项语义审阅。

当前面向评审问题的真实模型补测、失败修正记录、量化结果和局限说明见 `reports/EVALUATION_RESULTS.md`。

## 核心 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/health` | 数据库、模型模式与天气状态 |
| GET | `/api/airports` | 已登记机场与别名 |
| POST | `/api/events` | 创建不可变事件首版；或提交自由文本提取候选 |
| POST | `/api/events/:id/revisions` | 以 `baseRevision` 追加版本 |
| POST | `/api/analyses` | 对指定事件版本生成报告 |
| GET | `/api/analyses/:id` | 查询报告与反馈 |
| POST | `/api/analyses/:id/questions` | 对当前报告追问 |
| POST | `/api/analyses/:id/feedback` | 接受、修改或拒绝；确认事实进入新修订 |
| GET | `/api/analyses/:id/export` | 导出赛事 17 字段 |
| POST | `/api/weather-release-rate/estimate` | 天气函数旁路；默认返回未配置 |

写接口支持 `Idempotency-Key`。相同键与相同请求体返回原结果；相同键对应不同请求体返回 409。事件修订使用乐观版本检查，旧 `baseRevision` 返回 409。

## 新工程结构

```text
track3/
  apps/
    api/                    Fastify、SQLite、规则、模型适配器、天气旁路
    web/                    React/Vite 页面与组件
  packages/contracts/      TypeScript 类型与 JSON Schema
  data/                    原始赛事 JSON 与规范化导入报告
  tests/e2e/               Playwright 完整流程
  runtime/                 SQLite 运行数据（不提交）
  reports/                 评估输出
  docs/                    设计、风险与实施文档
```

根目录旧版 `server.mjs`、`lib/` 与 `public/` 保留作原型对照，但新的 npm scripts 均指向 `apps/` 和 `packages/` 下的实现。

## 当前边界

- 已接入 `research/real-data/processed/weather_function_model.json` 天气旁路；它使用 BTS 完成率作为放行正常比例代理，当前仅为探索性辅助估计，必须保留人工复核和独立留出集验证。
- 真实模型链路已实现但必须由使用者提供模型 ID、密钥和调用预算后才能执行网络评估。
- 首版是单机单 API 进程；若公开部署，需要另行增加用户认证与事件级访问控制。
