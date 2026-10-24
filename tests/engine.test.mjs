import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, answerQuestion, baselineFor, preset, standardOutput, tables } from '../lib/engine.mjs';
import { runEvaluation } from '../lib/evaluation.mjs';

const base = {
  airport: '海陵国际机场',
  baselineMonth: '2025-12',
  name: '单元测试',
  time: '测试时点',
  known: '月度基线',
  unknown: '逐航班状态',
  confirmedSources: 1,
  formalDelay: false,
};

test('baseline uses the previous 12 months and excludes reference month', () => {
  const result = baselineFor('海陵国际机场', '2025-12');
  assert.equal(result.historyCount, 12);
  assert.equal(result.historyStart, '2024-12');
  assert.equal(result.historyEnd, '2025-11');
  assert.ok(result.mean > 0 && result.mean < 1);
});

test('more than five percentage points below history triggers anomaly', () => {
  const history = baselineFor(base.airport, base.baselineMonth);
  const result = analyze({ ...base, currentRate: history.mean - 0.051 });
  assert.equal(result.anomaly, true);
  assert.ok(result.rules.some((rule) => rule['规则编号'] === 'RULE003'));
});

test('exactly five percentage points does not cross strict threshold', () => {
  const history = baselineFor(base.airport, base.baselineMonth);
  assert.equal(analyze({ ...base, currentRate: history.mean - 0.05 }).anomaly, false);
});

test('high risk requires multiple signals and two confirmed sources', () => {
  assert.equal(analyze({ ...base, weatherRisk: true, operatingPressure: true, confirmedSources: 2 }).risk, '高');
  assert.equal(analyze({ ...base, weatherRisk: true, operatingPressure: true, confirmedSources: 1 }).risk, '中');
});

test('conflicting sources suspend determinate assessment', () => {
  const result = analyze({ ...base, sourceA: 0.81, sourceB: 0.68 });
  assert.equal(result.conflict, true);
  assert.equal(result.risk, '无法判断');
  assert.match(result.actions[0].text, /暂停确定性判断/);
});

test('unreliable source activates stop rule', () => {
  const result = analyze({ ...base, unreliable: true });
  assert.equal(result.stopped, true);
  assert.ok(result.rules.some((rule) => rule['规则编号'] === 'RULE012'));
});

test('identity data is removed before result can be persisted', () => {
  const result = analyze({ ...base, description: '旅客姓名：张三 手机号 13800138000，邮箱 a@example.com' });
  assert.equal(result.privacyRemoved, true);
  assert.doesNotMatch(JSON.stringify(result), /13800138000|a@example\.com|张三/);
});

test('major operational request is refused and routed to humans', () => {
  const result = analyze({ ...base, request: '立即取消晚间航班' });
  assert.match(result.boundary, /拒绝自动执行重大运行决定/);
  assert.ok(result.rules.some((rule) => rule['规则编号'] === 'RULE007'));
});

test('human rejection preserves reason and can lower risk using new fact', () => {
  const event = preset(tables.events.find((item) => item['事件编号'] === 'EVT005'));
  const result = analyze(event);
  assert.equal(result.risk, '低');
  assert.ok(result.evidence.some((item) => item.kind === '人工反馈'));
  assert.match(result.actions[0].text, /保留原建议与否决原因/);
});

test('audience drafts are distinct and passenger message remains a draft', () => {
  const result = analyze({ ...base, weatherRisk: true });
  assert.equal(new Set(Object.values(result.drafts)).size, 3);
  assert.match(result.drafts.passenger, /未发送/);
  assert.match(result.drafts.passenger, /人工审核/);
});

test('question answering respects causality and simulation boundaries', () => {
  const result = analyze(base);
  assert.match(answerQuestion(result, '是不是天气导致了全部运行异常？'), /不能证明/);
  assert.match(answerQuestion(result, '这是现实中的机场吗？'), /虚构模拟/);
});

test('standard output contains every organizer field', () => {
  const output = standardOutput(analyze(base));
  const required = ['事件编号', '生成时间', '风险等级', '适用机场与时间', '判断依据', '可能影响', '待核查假设', '信息缺口', '第一步行动', '后续行动', '升级条件', '必须人工决定事项', '内部运营提示', '机场协调信息', '旅客信息草案', '引用来源', '输出状态'];
  assert.deepEqual(Object.keys(output), required);
});

test('all 15 official scenarios pass automated evaluation', () => {
  const report = runEvaluation();
  assert.equal(report.total, 15);
  assert.equal(report.passed, 15);
});
