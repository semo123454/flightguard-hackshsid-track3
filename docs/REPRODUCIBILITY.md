# FlightGuard 复现说明

更新日期：2026-10-23

## 环境

- Node.js 24.x；
- npm 11.x；
- Windows、macOS 或 Linux；
- 首次浏览器测试需要 Playwright Chromium，Windows 也可使用已安装的 Edge Chromium 内核；
- 只有真实模型评估需要网络、模型 ID、后端 API 密钥和明确调用预算。

`better-sqlite3` 包含本机模块。无法下载预编译包时，需要 Python 和 C++ 编译工具链。

## 从干净目录运行

```powershell
npm ci
npm run db:migrate
npm run data:import
npm run build
npm start
```

打开 `http://127.0.0.1:4173`。生产启动由 Fastify 同源托管前端构建，不使用 Vite 开发服务器。

默认数据库是 `runtime/flightguard.sqlite`。迁移启用外键、WAL 与忙等待；数据导入记录 SHA-256、来源定位和校验报告。重复导入不会增加记录。

## 自动验证

```powershell
npm run typecheck
npm test
$env:PLAYWRIGHT_CHANNEL='msedge' # 仅在使用本机 Edge 时需要
npm run test:e2e
npm run build
```

测试数据库使用系统临时目录，不连接主演示库。当前自动验证结果记录在 `reports/TEST_REPORT.md`，不能替代真实模型评估。

## 真实模型评估

1. 复制 `.env.example` 为 `.env`，配置 `LLM_MODEL` 和 `LLM_API_KEY`；
2. 由未编写提示词的成员复制 `tests/fixtures/live-holdout.template.json` 为 `live-holdout.local.json` 并填写；
3. 在 `.env` 设置 `EVALUATION_HOLDOUT_PATH=./tests/fixtures/live-holdout.local.json`；
4. 确认调用预算后运行：

```powershell
$env:EVALUATION_CONFIRM_LIVE='true'
npm run evaluate:live
```

评估关闭缓存，执行 15 项赛事行为、1 个独立留出案例、关键案例三次重复及一次自由文本提取。输出保存到 `reports/live-evaluation-*.json`，须由人工对照 `expected` 与 `prohibited` 完成语义审核。

## 数据保护与备份

- `.env`、运行数据库、本地留出案例和真实评估输出默认不进入交付包；
- 疑似个人信息会在入库和模型调用前被拒绝；
- 运行中备份使用 `npm run db:backup`，不要只复制 SQLite 主文件而遗漏 WAL；
- 服务默认只绑定 `127.0.0.1`。公开部署前必须另加身份认证与事件级授权。

## 当前接口

- `GET /api/health`
- `GET /api/airports`
- `POST /api/events`
- `POST /api/events/:id/revisions`
- `POST /api/analyses`
- `GET /api/analyses` 与 `GET /api/analyses/:id`
- `POST /api/analyses/:id/questions`
- `POST /api/analyses/:id/feedback`
- `GET /api/analyses/:id/export`
- `POST /api/weather-release-rate/estimate`

完整配置和运行边界见根目录 `README.md`。
