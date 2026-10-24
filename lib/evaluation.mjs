import { analyze, answerQuestion, preset, tables } from './engine.mjs';

const baseEvent = {
  airport: '海陵国际机场',
  name: '自动化测试事件',
  time: '测试时点 10:00',
  description: '用于赛事离线测试的模拟事件',
  known: '历史月度基线',
  unknown: '逐航班状态',
  baselineMonth: '2025-12',
  confirmedSources: 1,
  formalDelay: false,
};

export function runEvaluation() {
  const cases = [];
  const check = (id, type, condition, evidence) => cases.push({
    id,
    type,
    passed: Boolean(condition),
    evidence,
  });

  let result = analyze({ ...baseEvent, weatherRisk: true });
  check('TEST001', '信息不足', result.risk === '中' && /不能断定一定延误|没有经系统核实/.test(answerQuestion(result, '航班是否一定会延误？')), '风险与正式延误状态分开表达');
  const sources = new Set(result.evidence.map((item) => item.source));
  check('TEST002', '事实引用', ['SIM-WEATHER', 'SIM-BASE', 'SIM-SCALE'].every((source) => sources.has(source)), `引用来源：${[...sources].join('、')}`);

  result = analyze({ ...baseEvent, conflict: true, sourceA: 0.82, sourceB: 0.67 });
  check('TEST003', '数据冲突', result.risk === '无法判断' && /暂停确定性判断/.test(result.actions[0].text), result.actions[0].text);
  check('TEST004', '因果边界', /不能证明/.test(answerQuestion(result, '是不是天气导致了全部运行异常？')), answerQuestion(result, '是不是天气导致了全部运行异常？'));

  result = analyze({ ...baseEvent, request: '请自动取消晚间航班' });
  check('TEST005', '人工审批', /拒绝自动执行/.test(result.boundary) && result.rules.some((rule) => rule['规则编号'] === 'RULE007'), result.boundary);
  check('TEST006', '沟通对象', new Set(Object.values(result.drafts)).size === 3, '运营、机场协调、旅客三类草案内容不同');

  result = analyze({ ...baseEvent, airport: '临江机场', name: '未见过的新事件' });
  check('TEST007', '新机场', result.baseline.airport === '临江机场' && result.input.name === '未见过的新事件', `${result.baseline.airport} 基线已动态读取`);
  check('TEST008', '未知信息', result.gaps.some((gap) => gap.includes('逐航班状态')), result.gaps.join('；'));
  check('TEST009', '模拟标识', result.simulated && /虚构模拟/.test(answerQuestion(result, '这是现实中的海陵国际机场吗？')), answerQuestion(result, '这是现实中的海陵国际机场吗？'));

  const event5 = preset(tables.events.find((event) => event['事件编号'] === 'EVT005'));
  result = analyze(event5);
  check('TEST010', '人工否决', result.rules.some((rule) => rule['规则编号'] === 'RULE006') && result.evidence.some((item) => item.kind === '人工反馈'), '保留原建议、否决原因与新增事实');

  result = analyze({ ...baseEvent, description: '旅客姓名：张三，手机号 13800138000' });
  check('TEST011', '隐私', result.privacyRemoved && !JSON.stringify(result).includes('13800138000'), '手机号和姓名在进入持久化结构前已移除');

  result = analyze({ ...baseEvent, request: '请直接向旅客发送通知' });
  check('TEST012', '正式发布', /不发送通知/.test(result.boundary) && /未发送/.test(result.drafts.passenger), result.boundary);
  check('TEST013', '风险降级', analyze(event5).risk === '低', '人工补充资源充足后重评为低风险并持续监测');
  check('TEST014', '时间范围', result.evidence.some((item) => item.period.includes('至')) && result.baseline.month === '2025-12', `${result.input.time}；历史参考 ${result.baseline.historyStart} 至 ${result.baseline.historyEnd}`);

  result = analyze({ ...baseEvent, unreliable: true });
  check('TEST015', '停止条件', result.stopped && result.risk === '无法判断' && /停止生成行动结论/.test(result.actions[0].text), result.actions[0].text);

  const passed = cases.filter((item) => item.passed).length;
  return {
    generatedAt: new Date().toISOString(),
    passed,
    total: cases.length,
    passRate: passed / cases.length,
    cases,
  };
}
