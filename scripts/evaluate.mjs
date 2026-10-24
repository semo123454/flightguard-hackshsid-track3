import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runEvaluation } from '../lib/evaluation.mjs';

const report = runEvaluation();
const reportDir = fileURLToPath(new URL('../reports', import.meta.url));
mkdirSync(reportDir, { recursive: true });
writeFileSync(`${reportDir}/test-results.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
const rows = report.cases.map((item) => `| ${item.id} | ${item.type} | ${item.passed ? '通过' : '失败'} | ${item.evidence.replace(/\|/g, '\\|')} |`).join('\n');
const markdown = `# 事件测试报告\n\n生成时间：${report.generatedAt}\n\n结果：${report.passed}/${report.total} 通过（${(report.passRate * 100).toFixed(1)}%）\n\n| 测试编号 | 类型 | 结果 | 验证证据 |\n| --- | --- | --- | --- |\n${rows}\n\n## 说明\n\n测试覆盖信息不足、引用、冲突、因果边界、人工审批、对象化沟通、新事件泛化、未知信息、模拟标识、人工否决、隐私、正式发布、风险降级、时间范围和停止条件。所有数据与事件均为赛事模拟。\n`;
writeFileSync(`${reportDir}/TEST_REPORT.md`, markdown, 'utf8');
console.log(`${report.passed}/${report.total} tests passed`);
if (report.passed !== report.total) process.exitCode = 1;
