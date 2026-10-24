# 航策 FlightGuard：分步骤技术实现文档

版本：1.0 · 日期：2026年10月22日

本文件按全新项目设计，不依赖现有代码结构。文件所在目录仅用于存放文档。下面的目录、接口、代码片段和命令是待实施方案，不代表已经创建或运行验证。

交付目标：一个实际接入语言模型、能够处理新事件、引用证据、生成三类草案并保留人工反馈的网页应用。天气与放行率函数是可选模块；研究没有结果时，核心系统仍完整可用。

## 1. 技术栈与架构决策

| 层级 | 选用技术 | 用途与范围 |
| --- | --- | --- |
| 运行环境 | Node.js 24 系列，团队统一具体补丁版本 | 前后端构建及后端服务 |
| 包管理 | npm workspaces + package-lock.json | 管理前端、后端、共享契约；复现用 npm ci |
| 开发语言 | TypeScript，strict 模式 | 前端和后端共享领域类型 |
| 前端 | React + Vite，react-ts 模板 | 事件输入、研判、追问、反馈与历史页面 |
| 样式与图表 | CSS Modules + Recharts | 组件样式、历史趋势与研究结果展示 |
| 后端 | Fastify 5 + TypeScript | HTTP 接口、请求生命周期、日志 |
| 数据契约 | JSON Schema draft-07 + Ajv 8 | 校验用户输入、模型输出、统计接口输出 |
| 数据库 | SQLite + better-sqlite3，参数化 SQL | 本地单进程演示的数据、报告、反馈及调用记录 |
| 迁移 | 编号 SQL 文件 + 自编迁移执行脚本 | 可重复建表，schema_migrations 记录版本 |
| 模型调用 | 后端原生 fetch + 供应商适配器 | 实际调用一个选定的语言模型服务 |
| 资料检索 | SQLite 精确查询 + 小规模关键词检索 | 机场、月份、规则、历史反馈匹配 |
| 单元与接口测试 | Vitest + Fastify inject | 规则、契约、故障分支和 API 测试 |
| 浏览器测试 | Playwright | 输入事件、追问、反馈与模式切换 |
| 可选研究环境 | Python 3.12 + uv；pandas、openpyxl、scikit-learn、matplotlib | 离线天气数据整理、拟合、验证和作图 |
| 部署 | 单台电脑；生产构建由 Fastify 静态托管 | 比赛本地演示；首版不引入容器集群或消息队列 |

Vite 的 react-ts 脚手架和 Node 环境要求见[官方入门文档](https://vite.dev/guide/)。Fastify 5 的运行环境要求见[官方迁移说明](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)。安装时选稳定版并提交锁文件，不将本文的技术选择理解为已验证的依赖组合，不默认安装预发布版本。

首版不用 LangChain、向量数据库、Redis 或多智能体编排。当前资料量小，按机场和月份检索更容易检查正确性；模型流程由后端显式编排。后续资料增多时再评估语义检索。

运行结构：浏览器 → Fastify → 输入校验与事件版本 → 数据检索与规则引擎 → 语言模型 → 输出校验 → SQLite → 浏览器。天气函数从数据与规则阶段旁路调用，可整体关闭。

## 2. 步骤一：创建工程和配置

新工程建议命名为 `flightguard`，与已有项目独立。以下是目标目录：

```text
flightguard/
  apps/
    web/                        React 前端
      src/pages/                Events、Analysis、History、Settings
      src/components/           输入表单、证据、草案、反馈、模式状态
      src/api/client.ts
      src/styles/
    api/
      src/app.ts                创建 Fastify 实例，不监听端口
      src/server.ts             启动服务
      src/config.ts             读取并校验环境配置
      src/routes/               events、analyses、questions、feedback、health
      src/domain/               事件、证据、规则、版本处理
      src/services/             编排、检索、输出校验、反馈
      src/llm/                  provider、extract、generate、answer
      src/weather/              contract、disabled、json-model
      src/db/                   connection、repositories、migrate
      src/prompts/              extract-v1、report-v1、answer-v1
      migrations/
  packages/contracts/           JSON Schema、TypeScript 类型和状态枚举
  data/raw/                     不修改的赛事源文件
  data/normalized/              规范化 JSON 与来源清单
  research/                     可选 Python 项目及模型输出
  scripts/                      导入、基准检查、评估、打包
  tests/fixtures/               脱敏固定案例、模型模拟响应
  tests/e2e/
  reports/                      运行后生成的评估报告
  runtime/                      SQLite、日志，不进入提交代码
  .env.example
  package.json
  package-lock.json
```

初始化时先创建根 package.json，设 `private: true`、`workspaces: ["apps/*", "packages/*"]`。再建立 api 和 contracts 的 package.json，分别命名为 `@flightguard/api`、`@flightguard/contracts`，前端设为 `@flightguard/web`。后端使用 ESM，TypeScript 设置 `module/moduleResolution: NodeNext`，前端沿用 Vite 模板配置。共享包先编译，再编译消费者；开发时同时监听共享包构建。

在上述 workspace 清单就绪后执行：

```powershell
npm create vite@latest apps/web -- --template react-ts
npm install -w apps/web recharts
npm install -w apps/api fastify@5 @fastify/static better-sqlite3 ajv@8
npm install -D -w apps/api typescript tsx @types/node @types/better-sqlite3
npm install -D typescript vitest @playwright/test concurrently
npx playwright install chromium
```

按 Fastify 主版本选择兼容的 @fastify/static 版本，完成安装后检查 peer dependency 警告。better-sqlite3 含本机模块，应在演示电脑提前验证安装和启动，不在展示当天临时更换 Node 版本。

配置文件草案如下；数值为首版工程默认值，实测后调整：

```dotenv
HOST=127.0.0.1
PORT=4173
DATABASE_PATH=./runtime/flightguard.sqlite
LLM_ENABLED=true
LLM_PROVIDER=selected-provider
LLM_BASE_URL=
LLM_MODEL=
LLM_API_KEY=
LLM_TIMEOUT_MS=20000
LLM_REPORT_DEADLINE_MS=45000
LLM_MAX_CONCURRENCY=2
LLM_MAX_OUTPUT_TOKENS=2000
LLM_DAILY_TOKEN_LIMIT=200000
WEATHER_MODEL_ENABLED=false
WEATHER_MODEL_PATH=
WEATHER_TIMEOUT_MS=1000
```

供应商、实际模型 ID、API 路径、鉴权方式及结构化输出参数在接入日依据其官方文档填写，并记录一次实际调用测试。不同供应商只实现统一适配器，不假设所有服务兼容同一种 API。密钥仅放后端环境中，禁止使用 `VITE_` 前缀存储密钥。

根目录需实现 `dev`、`typecheck`、`test`、`test:e2e`、`build`、`start`、`db:migrate`、`data:import`、`evaluate:live` 命令。`dev` 同时启动前端与 API，Vite 将 `/api` 代理到 4173；`start` 运行已编译 API 并提供前端 dist，同源访问。

完成标准：健康接口返回成功；前端能请求健康接口；空数据库能自动迁移；未配置密钥时能启动并明确显示规则模式。

## 3. 步骤二：先定义领域类型与数据契约

先写 contracts，再写业务逻辑。业务字段使用 camelCase；所有时间保存带时区的 ISO 字符串，月度键使用 `YYYY-MM`。赛事“第4天下午”保留为原始标签，缺少真实日期时不擅自转成日历日期。

必须区分三种状态：true 表示明确有，false 表示明确没有，null 表示未知。不能把“没有资料说明延误”转换为“确认未延误”。

```ts
type TriState = true | false | null;
type Risk = 'low' | 'medium' | 'high' | 'undetermined';
type RunMode = 'llm' | 'rules_fallback';

interface Evidence {
  id: string;
  kind: 'observation' | 'history' | 'rule' | 'human_input' | 'estimate';
  sourceId: string;
  recordLocator: string;
  text: string;
  periodStart: string | null;
  periodEnd: string | null;
  publishedAt: string | null;
  verification: 'verified' | 'unverified' | 'conflicting';
  simulated: boolean;
}
```

事件类型至少包括：id、revision、airportId、eventTimeLabel、eventTime、baselineMonth、description、weatherRisk、operatingPressure、formalDelay、resourceAdequate、sources、knownFacts、unknowns。比例字段必须附 metric、period、granularity 和 sourceId，禁止传入无法判断含义的裸 `rate`。

核心指标枚举分开定义：`scheduled_completion_ratio`（按计划完成比例）、`airport_release_normal_ratio`（放行正常比例）。两个指标不能共用阈值计算输入。

每个关键提取字段附 `origin` 和原文 span。来源是否可靠、是否正式确认不能仅由模型声明。模型文本提取后只形成候选字段，后端依据来源登记或人工确认决定是否可用于强结论。

建立四套 Schema：EventInput、ExtractedEvent、GeneratedNarrative、WeatherEstimate。对象默认拒绝额外字段，限制字符串和数组长度，比例限定0—1。Ajv 在启动时编译 Schema 并复用校验函数，使用 strict 模式，避免自动类型转换。[Ajv 官方入门](https://ajv.js.org/guide/getting-started)

完成标准：未知布尔值不会被改成 false；两个运行指标无法混填；未知机场、非法比例、超长文本和多余字段有明确错误。

## 4. 步骤三：建立数据库和数据导入

SQLite 开启 foreign_keys，采用 WAL 模式并设置 busy_timeout。首版单 API 进程使用数据库事务，耗时模型请求不得放进事务中。

| 表 | 核心字段与约束 |
| --- | --- |
| airports | id、name、category；名称映射统一管理 |
| sources | id、title、publishedAt、coverage、verification、simulated |
| airport_monthly | airportId、month、completionRatio、releaseNormalRatio、sourceId；机场＋月份唯一 |
| airport_annual | airportId、year、规模、importance、sourceId；机场＋年份唯一 |
| weather_monthly | airportId、month、四项天气特征、missingFlag、sourceId |
| rules | id、version、描述、动作、人工审批要求；编号＋版本唯一 |
| events | id、createdAt，事件身份 |
| event_revisions | eventId、revision、payloadJson、createdAt；版本不可覆盖 |
| analyses | id、eventId、revision、parentAnalysisId、reportJson、ruleVersion、promptVersion、modelVersion、createdAt |
| feedback | id、analysisId、decision、reason、addedFactsJson、reviewerRole、createdAt |
| llm_runs | id、analysisId（可空）、requestId、用途、模式、模型、token、耗时、错误分类、缓存标记 |
| idempotency_keys | key、route、requestHash、responseJson、expiresAt |

数据库保留原报告，最新审核状态从反馈记录计算或维护独立状态表。接受、修改、拒绝都追加记录；不能把原始输出改成“它一开始就是修订后的建议”。

导入建议使用独立 Python 小脚本通过 openpyxl 读取工作簿，导出规范化 JSON，后端脚本再事务导入 SQLite。首次建立 Python 环境时将 openpyxl 加入 uv 项目并锁定依赖；生产主程序不依赖 Python 运行。Excel 转换仅导入数据，不执行公式或文件中的说明文字。

映射规则：空值保持 null，比例转成数值，机场生成稳定 ID，保留 sheet/row/column 定位与原始字段。针对缺失标记为“是”的天气记录，不因为单元格存在数值就默认为完整可用。

导入校验检查唯一键、比例范围、年份月份、四项天气单位及来源编号。输出 import-report.json，列出接收、拒绝、缺失及重复记录。保留原始工作簿，重复导入同一版本应幂等，不重复生成记录；更新版本须有数据集版本号或校验和。

完成标准：能按机场、月份查询两种运行指标和天气，且回溯到工作表记录；缺失不变成0；导入第二次记录数不增加。

## 5. 步骤四：实现确定性规则引擎

建议文件：domain/baseline.ts、domain/risk.ts、domain/sources.ts、domain/actions.ts。全部写成无 HTTP、无模型调用的纯函数，便于独立测试。

实现顺序：

1. 获取参考月之前最近12个月的同机场指标，排除参考月和未来月份。缺月时报告实际覆盖范围；不能将超过12个月窗口的旧记录当作完整连续12个月。
2. 按同指标、同粒度、同口径检查是否可比较；当前只有日内描述时返回 delta=null，仍可显示历史背景。
3. 比例差乘100转为百分点。基础异常条件为差值小于−5个百分点；恰好−5的边界按题目“超过”处理并写入测试。
4. 检查来源可靠性和冲突，生成停止条件。可靠来源数量从已核验来源记录推导，不接受用户直接填写数量作为证据。
5. 根据天气、运行压力、正式状态、现场资源生成规则信号；unknown 不作为无风险证据。
6. 形成 risk、ruleIds、evidenceIds、gaps、actions、escalationConditions 和 humanDecisions。

规则优先级：停止条件优先；其次来源冲突和关键缺口；其后才分级。高风险要求满足已定义的独立信号和来源条件。天气函数即使可用也不能覆盖停止条件。

每条 action 包含 id、priority、ownerRole、text、basisIds、requiresHumanReview。模型只能解释或在允许集合中组织动作，不能新增“执行取消”等动作。低风险也须说明有效信息范围，不等于已确认安全。

完成标准：函数模块和语言模型都关闭时，能够生成有证据、可复核的基础研判。先通过停止条件、阈值、未知值、时间粒度和来源独立性的测试，再接模型。

## 6. 步骤五：建立检索和证据包

实现 services/retrieval.ts，提供以下内部函数：

| 函数 | 输入 | 返回 |
| --- | --- | --- |
| getAirportProfile | airportId、asOf | 机场背景及来源 |
| getBaseline | airportId、metric、referenceMonth | 均值、样本数、区间及原记录引用 |
| getWeatherHistory | airportId、月份范围 | 天气记录与缺失标记 |
| getApplicableRules | event、ruleVersion | 适用规则；停止及人工边界规则始终包含 |
| getPriorFeedback | eventId、revision | 同事件已存在的反馈和修订关系 |

按机场与月份精确查询，规则采用可检查的条件映射。历史反馈只检索同一事件，跨事件案例只能标为示例，不能作为本次事件的事实。

为每条记录生成稳定 evidenceId，例如 `BASE:A001:2025-08:release`。证据包包括输入事实、历史记录、程序计算结果、规则结果以及可选估计。保留记录定位、数据版本、时间和模拟属性。

首版上下文限制：最多30条证据、每条正文不超过1000字符，不能截断数字的口径、时间或停止规则。超限时优先删除不相关历史，不能删去规则限制以腾出空间。

完成标准：任意模型事实引用都可以在本次证据包中找到；不能引用另一个机场或未来月份作为当前事实。

## 7. 步骤六：接入语言模型

### 7.1 先做一个可替换适配器

```ts
interface LlmProvider {
  generateJson(args: {
    purpose: 'extract' | 'report' | 'answer';
    system: string;
    payload: unknown;
    schema: object;
    signal: AbortSignal;
  }): Promise<{
    value: unknown;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    providerRequestId: string | null;
  }>;
}
```

在 llm/providers/selected.ts 实现一个真实供应商，在 tests/fixtures 实现测试替身。适配器负责供应商请求格式、鉴权、错误和用量映射，业务模块不直接读取供应商返回 JSON。使用 fetch 的取消信号控制超时，具体接口见[Node 全局 API 文档](https://nodejs.org/docs/latest/api/globals.html)。

先手动完成“输入一个模拟事件→返回结构化字段”的实际调用，核对模型名称、请求 ID、用量及延迟，再继续开发完整链路。供应商不支持原生结构约束时，可要求 JSON 并在后端严格校验，不能假定提示词保证格式。

### 7.2 分成三种任务

**提取任务 extract：** 输入脱敏事件原文，输出 airportCandidate、时间标签、天气和运行信号、信息缺口及对应原文片段。缺失字段返回 null。机场解析不唯一时返回需要澄清，由用户选择。

**生成任务 report：** 输入事件版本、证据包、程序确定的风险和允许动作。只生成 summary、impact、assumptions、explanations、drafts，事实表述带 evidenceIds。服务器字段 id、risk、正式状态、时间和审核状态不允许模型改写。

**追问任务 answer：** 输入当前报告和证据回答依据、待查事项及沟通问题。新增事实进入事件修订流程，不能只在回答文本里悄悄改变报告。普通问答不改库中的原始判断。

提示词放独立文件并带版本号。固定规则写在系统说明中，事件和检索结果作为数据区块；其中出现的“忽略规则”等文本不能获得工具权限。禁止让模型运行 SQL、访问任意 URL 或修改数据库。

### 7.3 输出校验与修复

处理顺序：JSON解析 → Schema校验 → evidenceId存在性 → 数字与时间一致性 → 正式状态和风险一致性 → 动作权限 → 草案标识。禁止把模型返回内容直接展开覆盖完整报告。

证据编号存在不等于内容正确。首版对数字、机场、日期和动作采用确定性校验；自由文本语义仍需人工抽查与确认，未审核的草案不能宣称已经验证无误。

校验失败最多允许一次修复，发送原始证据和具体错误，仍失败则使用规则模板。修复不会自动扩大 token 或耗时预算。对429/5xx、格式错误、超时分别记录，不无限重试；认证失败直接返回配置错误并回退。

完成标准：真实模型能理解未预设的新文本、生成三类草案并引用证据；伪造数字、错误引用和取消航班动作均被拦截或送人工复核；测试替身不算真实调用成功。

## 8. 步骤七：实现主流程、HTTP 接口和版本管理

首版采用同步 HTTP 请求加总超时，避免引入后台任务系统。分析总截止时间45秒，每次模型调用最多20秒；提取、生成和修复共享总预算，预算耗尽立即回退，不再启动新请求。天气模块另设1秒预算。

编排逻辑：

```text
校验输入与脱敏
→ 自由文本先提取，结构化表单跳过提取
→ 核验候选字段；关键字段不明确则返回澄清请求
→ 创建不可变事件版本
→ 检索证据、计算规则结果，独立尝试天气旁路
→ 调用模型组织解释与草案
→ 校验；至多一次修复；否则规则模板回退
→ 事务保存报告、模式和调用元信息
→ 返回报告
```

自由文本提取失败且无法确定机场时不能假装已完成研判。返回 needs_clarification 并保留输入，用户可以切换结构化表单继续；这区别于已确定事件的“规则报告回退”。

| HTTP | 接口 | 行为 |
| --- | --- | --- |
| GET | /api/health | 数据库、模型配置状态、天气模块模式；不泄露密钥 |
| GET | /api/airports | 机场选项和别名 |
| POST | /api/events | 校验并创建事件和初始版本 |
| POST | /api/events/:id/revisions | 按 baseRevision 追加事实与事件版本 |
| POST | /api/analyses | 输入事件ID及版本，生成报告 |
| GET | /api/analyses/:id | 查询指定报告和关联反馈 |
| POST | /api/analyses/:id/questions | 回答针对该报告的追问 |
| POST | /api/analyses/:id/feedback | 接受、修改或拒绝，追加记录 |
| GET | /api/analyses/:id/export | 导出赛事17字段 |
| POST | /api/weather-release-rate/estimate | 预留只读计算接口，默认返回未配置 |

新增事实调用 revisions，再调用 analyses。修改或拒绝建议不自动意味着风险降低。反馈中的事实作为 human_input，可靠性和审核状态继续记录；只有确认的信息才影响对应规则。

写接口接受 Idempotency-Key，相同 key 和请求体返回原结果，相同 key 不同请求体返回409。事件更新必须带 baseRevision，版本已变化返回409，避免两个人同时补充时互相覆盖。每个分析绑定确定事件版本，迟到模型结果不能覆盖更新版本。

HTTP状态约定：400非法请求、404不存在、409版本冲突、422需要补充关键字段、429本地并发或预算限制、503无法生成任何可用结果。模型故障但已成功生成规则报告时返回201，报告中的 runMode 和 fallbackReason 明确说明。

完成标准：重复提交不会重复保存或重复计费；旧报告可查询；补充事实后生成新报告并关联旧报告；错误反馈不会被当成新事实自动降级。

## 9. 步骤八：天气函数备用接口与冗余

首先实现 weather/disabled.ts，主系统必须在此状态下通过验收。无需等待研究开始，更不能先写一个固定数字冒充预测。

统一输入：airportId、targetMetric、periodStart、periodEnd、granularity、asOf、mode、weather、weatherBasis、sourceRefs。targetMetric 固定 `airport_release_normal_ratio`，初版 granularity 仅 `month`。

weather 四项：precipitationMm、meanTemperatureC、maxWindSpeedMps、adverseWeatherDays。单位随字段固定，null为缺失，不能通过0填补。输入预测时点和来源发布时间用于防止未来信息泄漏。

输出示例：

```json
{
  "status": "not_configured",
  "estimate": null,
  "predictionInterval": null,
  "modelVersion": null,
  "trainingScope": null,
  "validationSummary": null,
  "reason": "尚无通过验证的天气与放行率模型"
}
```

status允许：ok、not_configured、not_validated、insufficient_data、out_of_scope、timeout、error。非ok时estimate必须为null。区间仅在另行校准后提供。

主流程通过有界调用取得旁路结果，任何异常转换成结构化状态。连续3次技术失败后暂时熔断60秒，再尝试一次恢复探测；这是首版可调整默认值。研究未验证和范围不符不属于技术失败，不需要反复重试。

估计作为 evidence.kind=estimate 单独显示，不覆盖规则风险。估计与正式事实冲突时退出建议生成上下文并提示复核，保留诊断记录。函数与天气观测共享来源，不能重复计算为两个独立证据。

| 情况 | 核心系统行为 |
| --- | --- |
| 找不到可靠函数 | 使用历史参照、天气规则和模型解释；不提供放行率预测 |
| 函数缺数据或超范围 | 列出原因，继续主流程 |
| 函数超时或抛错 | 超时预算内退出，记录技术状态 |
| 语言模型也失败 | 已有事件使用规则与模板；未解析事件转结构化补充 |
| 基线和现场事实也不足 | 输出无法判断、信息缺口及人工核查方向 |

完成标准：移除天气模型文件、关闭接口或制造超时，核心研判、问答回退和人工反馈仍可使用；不出现0%之类伪预测。

## 10. 步骤九：可选天气研究与模型接入

此步骤与主系统开发独立进行，时间预算最多两个工作日用于首轮验证。未得到有效结果就提交研究结论，保持接口关闭。

创建独立 research uv 项目：

```powershell
uv init research
Set-Location research
uv python pin 3.12
uv add pandas openpyxl scikit-learn matplotlib
```

按顺序实现 prepare.py、train.py、evaluate.py、export_model.py：

1. 按机场和年月关联天气与放行正常比例，记录单位、来源和缺失。模拟数据与真实数据分别建集；没有真实机场映射时不混合训练。
2. 确认任务是月度回溯估计。没有历史预报发布时间数据时不称为提前预测，也不推断未来六小时状态。
3. 建立只含机场背景和季节项的基准，再加入天气变量比较。最多192条月度记录时优先简洁模型，不先堆复杂神经网络。
4. 示例切分：2024年训练、2025年1—6月验证、2025年7—12月最终测试；在训练和验证中确定参数后可以用截至2025年6月的数据重新拟合，但最终测试不参与选择。
5. 所有机场同月份进入同一时间分区。若做滚动验证，先切分唯一月份，再映射回所有机场行，不能直接对机场混排的行使用时间切分。时间顺序验证的原则见[scikit-learn TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)。
6. 缺失处理、标准化和类别编码仅在训练数据拟合，验证与测试复用。未见机场能力另做留出机场实验，不从普通时间测试推断泛化。
7. 先试带正则化的简单回归。若采用比例的logit变换，预先记录边界裁剪epsilon及变换方法，不能把连续比例直接当二分类标签交给分类器。MAE、RMSE都在还原的0—1比例上计算，再转成百分点报告。
8. 保存基准与天气模型的分机场、分时段误差及样本数。先在验证集确定最低可接受改善标准，再看最终测试；最终测试失败则不启用，不反复调参污染同一测试集。

得到可靠简洁函数后导出 JSON：模型版本、目标指标、训练范围、特征顺序、均值和尺度、机场编码、系数、截距、链接函数、有效输入范围和验证报告校验和。Node 侧读取JSON做推断，无需启动Python服务。

用固定输入对照Python与Node结果，容差预先定义，例如绝对比例误差1e-8。模型类别无法安全导出时保持关闭，另行评估服务化；不能为接入而删掉重要预处理。

完成标准：允许结果为“未找到可靠关系”；若启用，则需模型卡、数据切分记录、基准对照、跨语言数值一致性和适用范围验证。

## 11. 步骤十：实现前端页面

前端先用契约合法的模拟响应开发组件，再连接真实API。所有模拟响应仅存在开发测试环境，页面明显标识，不混入正式评估。

| 页面/组件 | 具体内容 |
| --- | --- |
| 事件输入 | 自由文本＋结构化表单；机场、事件时间、已知、未知和来源 |
| 研判总览 | 风险、适用范围、规则/模型模式、停止原因、待复核状态 |
| 证据区 | 事实、历史、假设、未知分开；来源和时间可展开 |
| 历史图表 | 完成比例与放行正常比例可切换，轴及图例写清指标 |
| 行动清单 | 优先级、负责岗位、依据、人工决定事项 |
| 三类草案 | 运营、机场、旅客分标签；复制和导出；无自动发送按钮 |
| 追问区 | 绑定当前报告；新增事实跳转修订流程 |
| 人工反馈 | 接受、修改、拒绝；后两者必填原因；展示前后版本 |
| 可选统计卡 | 天气模型可用时展示估计及范围；未启用时说明原因 |
| 历史记录 | 事件版本、报告关联、审核记录和导出 |

使用React普通文本节点渲染模型文本，不使用dangerouslySetInnerHTML。首版不用模型Markdown的任意HTML渲染。提交期间禁用重复按钮；错误提示保留表单；切换报告时清空或切换追问上下文，防止串事件。

“事件风险”与“系统模式”分别显示。函数不存在不会显示红色航班告警。模型处理时可以显示正在研判，但只有后端返回结果后才能显示成功；不播放假进度掩盖错误。

完成标准：从输入新事件到反馈修订能完整操作；模型与函数同时关闭仍可走结构化输入的规则流程；宽屏和普通笔记本尺寸均可读。

## 12. 步骤十一：调用成本、日志和数据保留

记录每次模型调用的用途、模型版本、提示词版本、耗时、实际用量、成功或失败、回退原因。供应商不返回token时记null，不填0；预算未知用量按预留上限保守处理。费用使用配置的真实单价和计价单位，单价未配置就显示“未核算”。

调用前预留预计最大用量，完成后用实际用量结算，防止两个并发请求同时突破每日预算。并发初始限制2，超额返回明确可重试状态。错误重试和修复均计入同一预算。

缓存key包含事件版本、证据包hash、规则版本、提示词版本、模型ID及生成参数。只缓存通过校验的结果。新增事实或版本变化后不可复用旧结果；实测重复性测试必须关闭缓存。

日志默认不记录密钥、Authorization头或原始个人信息。脱敏在入库和出站模型请求之前执行；正则脱敏并不保证识别所有姓名，输入界面提示仅填模拟或汇总信息，对疑似敏感内容要求移除后再提交。

数据库报错时明确报告，不能静默创建空状态覆盖旧库。提交前通过SQLite备份机制或停服后备份，不在写入中仅复制主数据库文件忽略WAL。比赛本地模式绑定127.0.0.1；若后来公开部署，需另行增加用户鉴权和事件访问控制，不直接暴露本地演示服务。

## 13. 步骤十二：测试与验收顺序

按“纯函数 → API → 前端 → 实际模型 → 故障演练”执行。测试数据库使用临时路径，不连接演示数据库。

| 测试层 | 必测内容 |
| --- | --- |
| 规则单元测试 | −5边界、历史缺月、当前月排除、未知不等于否、指标混用、来源冲突 |
| 数据与契约 | 唯一键、null保留、来源定位、额外字段、天气返回状态与数值约束 |
| 模型模拟测试 | 无效JSON、错引用、伪造数字、超时、429、认证失败、修复失败 |
| API集成 | 正常报告、事件版本冲突、幂等、反馈事务、原报告不可变 |
| 浏览器测试 | 新事件、追问、反馈、导出、错误保留输入、模式标签 |
| 真实模型评估 | 赛事15项问题＋独立准备的未见案例，保存实际输入输出和引用核查 |
| 重复性 | 冲突、停止、正式状态等关键案例至少3次实际调用，关闭缓存 |
| 冗余测试 | 关闭函数、无有效函数、函数超时、函数冲突、模型失败、两者同时失败 |

独立留出案例由未编写提示词的成员准备。对比规则模板和语言模型模式的事实正确性、表达差异、人工修改量及耗时。自动Schema通过只证明结构，不证明含义正确，关键样例需人工逐项审阅。

命令建议顺序（需先实现对应npm scripts）：

```powershell
npm run typecheck
npm test
npm run test:e2e
npm run evaluate:live
npm run build
```

evaluate:live 明确需要网络、模型密钥和调用预算；不能混入默认单元测试并意外产生费用。报告分开统计真实调用、缓存、测试替身和规则回退，不把回退算作模型成功。

验收门槛：核心15项行为要求通过；关键事实有依据；无自动执行或正式发送声明；反馈完整留痕；真实模型链路通过；关闭天气函数仍全部可用。有效天气函数不是必需验收项。

## 14. 步骤十三：构建、交付与团队安排

构建先编译共享契约，再编译API和前端。通过 @fastify/static 托管 web/dist，API路由优先，未知API返回JSON 404；仅浏览器页面路径回退到index.html。正式演示不使用Vite开发服务器作为部署服务。

首次运行依次执行 npm ci、数据库迁移、数据导入、构建和启动。配置.env由后端启动命令明确加载，例如Node的env-file参数；环境变量未加载时应提示配置缺失。将完整命令写入新工程README，不能依赖开发者电脑的隐式全局配置。

交付包包括源代码、锁文件、迁移、模拟数据、配置示例、提示词、规则版本、测试报告及运行说明；不包含密钥、node_modules和未脱敏日志。天气模块交付disabled实现与接口说明；只有研究成功才追加模型文件和验证报告。

建议四人分工：

| 人员 | 主责 | 首要产物 |
| --- | --- | --- |
| A：后端与数据 | 数据库、导入、规则、证据检索 | 无模型也可运行的研判API |
| B：模型与编排 | 适配器、提取、生成、追问、校验、预算 | 实际模型完整链路 |
| C：前端与体验 | 页面、交互、反馈、导出、模式展示 | 可操作的新事件演示 |
| D：测试与研究 | 留出案例、故障演练、天气研究、交付报告 | 独立验收证据及可选研究结论 |

建议顺序：第1日统一契约、建库和模型试调用；第2日打通规则检索与最小页面；第3日打通模型、反馈和接口回退；第4日测试与修正；第5日冻结版本、另一台电脑复现、准备演示。天气研究不占据主流程的前置依赖。

最终分别报告三项状态：核心助手完成情况、冗余接口完成情况、天气函数研究结果。允许第三项为“暂未发现可靠关系”，但前两项必须有可运行实现和测试证据。

## 技术参考

- [Vite 入门及项目模板](https://vite.dev/guide/)
- [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [Fastify 5 运行要求](https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/)
- [Ajv Schema 校验](https://ajv.js.org/guide/getting-started)
- [Node.js fetch 与取消信号](https://nodejs.org/docs/latest/api/globals.html)
- [scikit-learn 时间顺序验证](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)

上述参考用于技术能力与用法核对；具体技术组合、目录、超时、预算、切分和任务分工是本项目设计，需要在实现时验证。
