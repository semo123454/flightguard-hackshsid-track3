import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const dataset = JSON.parse(
  readFileSync(new URL('../data/dataset.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''),
);

export const tables = {
  baseline: dataset['01_机场月度运行基线'],
  scale: dataset['02_机场年度规模'],
  weather: dataset['03_机场天气月度'],
  events: dataset['04_模拟事件'],
  rules: dataset['05_运营规则'],
  sampleOutputs: dataset['06_智能助手输出'],
  sampleFeedback: dataset['07_人工反馈'],
  tests: dataset['08_测试问题'],
  fields: dataset['09_字段说明'],
  sources: dataset['10_数据来源登记'],
  quality: dataset['11_数据质量问题'],
  checklist: dataset['12_提交材料检查表'],
};

export const airports = [...new Set(tables.baseline.map((row) => row['机场名称']))];

const booleanFields = [
  'weatherRisk', 'operatingPressure', 'conflict', 'unreliable', 'safetyIssue',
  'resourceAdequate', 'humanRejected', 'formalDelay',
];
const textFields = ['description', 'known', 'unknown', 'time', 'request', 'humanReason', 'name'];
const allowedFields = [
  'airport', 'eventId', 'name', 'time', 'description', 'known', 'unknown',
  'baselineMonth', 'currentRate', 'sourceA', 'sourceB', 'confirmedSources',
  ...booleanFields, 'humanReason', 'request',
];

export const redact = (value) => (typeof value === 'string'
  ? value
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, '[手机号已移除]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱已移除]')
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号已移除]')
    .replace(/(?:姓名|旅客|乘客|员工)\s*[:：]\s*[^，,。；;\s]{1,20}/g, '[姓名已移除]')
  : value);

export function sanitize(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请输入事件对象');
  if (!airports.includes(input.airport)) throw new Error('请选择数据包中的机场');
  for (const field of booleanFields) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error(`${field} 必须为布尔值`);
  }
  for (const field of ['currentRate', 'sourceA', 'sourceB']) {
    if (input[field] !== undefined && input[field] !== null
      && (typeof input[field] !== 'number' || !Number.isFinite(input[field]) || input[field] < 0 || input[field] > 1)) {
      throw new Error(`${field} 必须是 0 到 1 之间的比例`);
    }
  }
  if (input.confirmedSources !== undefined
    && (!Number.isInteger(input.confirmedSources) || input.confirmedSources < 0 || input.confirmedSources > 5)) {
    throw new Error('confirmedSources 必须是 0 到 5 的整数');
  }
  if (input.baselineMonth && !/^202[45]-(0[1-9]|1[0-2])$/.test(input.baselineMonth)) {
    throw new Error('历史参考月必须在 2024-01 至 2025-12 之间');
  }
  for (const field of textFields) {
    if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 5000)) {
      throw new Error(`${field} 必须为不超过 5000 字的文本`);
    }
  }
  if (input.humanRejected && !input.humanReason?.trim()) throw new Error('人工否决时必须填写原因');
}

export function preset(event) {
  const id = event['事件编号'];
  return {
    eventId: id,
    airport: event['机场名称'],
    name: event['事件名称'],
    time: event['事件时间'],
    description: `${event['天气描述']}；${event['运行情况描述']}；${event['现场备注']}`,
    known: event['已知信息'],
    unknown: event['未知信息'],
    baselineMonth: '2025-12',
    weatherRisk: ['EVT001', 'EVT004', 'EVT005'].includes(id),
    operatingPressure: id === 'EVT002',
    conflict: id === 'EVT003',
    unreliable: false,
    safetyIssue: false,
    humanRejected: id === 'EVT005',
    humanReason: id === 'EVT005' ? '运营人员补充现场资源充足且风速尚在可控范围' : '',
    resourceAdequate: id === 'EVT005',
    formalDelay: false,
    confirmedSources: 1,
    request: '',
  };
}

const pct = (value) => `${(value * 100).toFixed(2)}%`;
const monthKey = (row) => Number(row['年份']) * 12 + Number(row['月份']);
const rowMonth = (row) => `${row['年份']}-${String(row['月份']).padStart(2, '0')}`;

export function baselineFor(airport, month = '2025-12') {
  if (!airports.includes(airport)) throw new Error('找不到该机场的历史基线');
  const rows = tables.baseline.filter((row) => row['机场名称'] === airport).sort((a, b) => monthKey(a) - monthKey(b));
  const [year, numericMonth] = month.split('-').map(Number);
  const reference = rows.find((row) => Number(row['年份']) === year && Number(row['月份']) === numericMonth);
  if (!reference) throw new Error('找不到所选月份的历史基线');
  const history = rows.filter((row) => monthKey(row) < year * 12 + numericMonth).slice(-12);
  const mean = history.length
    ? history.reduce((sum, row) => sum + Number(row['按计划完成航班的比例']), 0) / history.length
    : null;
  const weather = tables.weather.find((row) => row['机场名称'] === airport
    && Number(row['年份']) === year && Number(row['月份']) === numericMonth);
  const scale = tables.scale.find((row) => row['机场名称'] === airport && Number(row['年份']) === year);
  return {
    airport,
    month,
    referenceRate: Number(reference['按计划完成航班的比例']),
    peerRate: Number(reference['同类机场平均比例']),
    providedMean: Number(reference['该机场过去12个月平均比例']),
    mean,
    historyCount: history.length,
    historyStart: history.length ? rowMonth(history[0]) : null,
    historyEnd: history.length ? rowMonth(history.at(-1)) : null,
    weatherMissing: !weather || weather['是否缺少数据'] === '是',
    weather: weather ? {
      adverseDays: Number(weather['明显不利天气天数']),
      maxWind: Number(weather['最大风速（米/秒）']),
      precipitation: Number(weather['降水量（毫米）']),
      missing: weather['是否缺少数据'] === '是',
    } : null,
    trend: rows.map((row) => ({
      month: rowMonth(row),
      rate: Number(row['按计划完成航班的比例']),
      peerRate: Number(row['同类机场平均比例']),
    })),
    scale,
  };
}

const ruleById = (id) => tables.rules.find((row) => row['规则编号'] === id);
const addUnique = (list, value) => { if (value && !list.includes(value)) list.push(value); };

export function analyze(raw) {
  validate(raw);
  const sanitized = sanitize(raw);
  const privacyRemoved = JSON.stringify(raw) !== JSON.stringify(sanitized);
  const event = Object.fromEntries(allowedFields.filter((key) => sanitized[key] !== undefined)
    .map((key) => [key, sanitized[key]]));
  event.baselineMonth ||= '2025-12';
  event.confirmedSources ??= 0;

  const base = baselineFor(event.airport, event.baselineMonth);
  const evidence = [];
  const gaps = [];
  const rules = new Set(['RULE009', 'RULE010']);
  const addEvidence = (kind, text, source, period) => evidence.push({ kind, text, source, period });

  addEvidence('事实', `所有机场、历史数据和事件均为赛事模拟；当前事件时间为 ${event.time || '未提供'}。`, 'EVENT-INPUT', event.time || '未提供');
  if (event.description) addEvidence('事实', event.description, 'EVENT-INPUT', event.time || '未提供');
  if (event.known) addEvidence('事实', `输入列明的已知信息：${event.known}。`, 'EVENT-INPUT', event.time || '未提供');
  addEvidence('历史背景', `${base.month} 按计划完成航班比例 ${pct(base.referenceRate)}，同类机场平均 ${pct(base.peerRate)}。`, 'SIM-BASE', base.month);
  if (base.mean !== null) {
    addEvidence('历史背景', `系统重新计算前 ${base.historyCount} 个月均值 ${pct(base.mean)}，不包含参考月。`, 'SIM-BASE', `${base.historyStart} 至 ${base.historyEnd}`);
  }
  addEvidence('事实', `机场分类：${base.scale['机场分类']}；航空公司业务重要程度：${base.scale['航空公司业务重要程度']}。规模只影响核查优先级。`, 'SIM-SCALE', base.month.slice(0, 4));
  if (base.weather) {
    addEvidence('历史背景', base.weather.missing
      ? `${base.month} 的历史天气记录标记为缺失。`
      : `${base.month} 历史月度天气记录：明显不利天气 ${base.weather.adverseDays} 天，最大风速 ${base.weather.maxWind} 米/秒。历史天气不能证明当前延误因果。`, 'SIM-WEATHER', base.month);
  }

  const delta = event.currentRate != null && base.mean !== null ? (event.currentRate - base.mean) * 100 : null;
  // A tiny tolerance prevents binary floating-point noise from turning exactly -5.00pp
  // into a false "more than five percentage points" breach.
  const anomaly = delta !== null && delta < -5 - 1e-9;
  if (delta !== null) {
    addEvidence('事实', `输入的当前完成比例 ${pct(event.currentRate)}，比历史均值${delta >= 0 ? '高' : '低'} ${Math.abs(delta).toFixed(2)} 个百分点。当前时段与月度基线粒度不同，只作筛查线索。`, 'EVENT-INPUT / SIM-BASE', `${event.time || '当前时段未提供'}；基线 ${base.historyStart} 至 ${base.historyEnd}`);
    if (anomaly) rules.add('RULE003');
  } else addUnique(gaps, '缺少当前时段可比较的完成比例，不能从“下降”等描述虚构百分比');

  addUnique(gaps, event.unknown || '逐航班计划、前序飞机位置、机组和地面保障状态尚未提供');
  if (base.weatherMissing) {
    addUnique(gaps, `${base.month} 的历史天气记录缺失，不能按零天气风险处理`);
    rules.add('RULE001');
  }

  const sourceDifference = event.sourceA != null && event.sourceB != null ? Math.abs(event.sourceA - event.sourceB) : null;
  const conflict = Boolean(event.conflict) || (sourceDifference !== null && sourceDifference >= 0.01);
  if (event.sourceA != null || event.sourceB != null) {
    addEvidence('事实', `来源甲：${event.sourceA == null ? '未提供' : pct(event.sourceA)}；来源乙：${event.sourceB == null ? '未提供' : pct(event.sourceB)}。未提供更新时间和口径时，系统不自动选择来源。`, 'EVENT-INPUT', event.time || '未提供');
  }

  const stopped = Boolean(event.unreliable) || Boolean(event.safetyIssue);
  const signals = [];
  if (event.weatherRisk) signals.push('天气风险');
  if (event.operatingPressure || anomaly) signals.push('运行压力');
  if (event.formalDelay) signals.push('正式延误状态');
  let risk = '低';
  if (stopped || conflict) risk = '无法判断';
  else if (signals.length >= 2 && event.confirmedSources >= 2) risk = '高';
  else if (signals.length) risk = '中';

  const actions = [];
  const addAction = (owner, text, gate = '无需系统自动执行') => actions.push({ owner, text, gate });
  if (stopped) {
    rules.add('RULE012'); rules.add('RULE001');
    addUnique(gaps, '来源可靠性无法确定或涉及安全问题，必须由专业人员复核');
    addAction('运营负责人 / 安全专业负责人', '停止生成行动结论，整理已知信息和信息缺口，立即提交人工复核。', '补充可靠来源并由专业人员解除停止状态');
  } else if (conflict) {
    rules.add('RULE001');
    addUnique(gaps, '来源冲突：待核查更新时间、统计口径、复核状态和覆盖范围');
    addAction('运营分析人员', '暂停确定性判断，核查两个来源的更新时间、统计口径、覆盖范围和复核状态。', '冲突解决并留下复核记录');
    addAction('运营负责人', '根据复核后的同口径数据重新评估；系统不得自动选择其中一个来源。');
  } else {
    if (event.weatherRisk) {
      rules.add('RULE002');
      addAction('机场协调团队', '核查天气更新时间与机场最新保障能力；天气风险不等于正式延误。');
    }
    if (event.operatingPressure || anomaly) {
      rules.add('RULE004');
      addAction('运营人员', '依次核查前序飞机、后续任务集中程度、登机口与地面保障压力。');
    }
    addAction('运营分析人员', '核查当前指标完整性与时间范围，并与机场自身历史及同类机场比较。');
    if (risk === '高') {
      rules.add('RULE008');
      addAction('运营负责人', '多个风险信号已由至少两个来源确认，请人工决定是否升级响应。', '必须由运营负责人审批');
    } else {
      addAction('运营负责人', signals.length > 1
        ? '多个风险信号存在，但可靠来源不足两个；补充独立证据后再决定是否升级。'
        : '持续监测；如保障能力下降并出现经核实的运行异常，人工决定是否升级。');
    }
  }

  if (signals.length > 1) rules.add('RULE008');
  if (!event.formalDelay) {
    rules.add('RULE005');
    addUnique(gaps, '尚无正式航班延误状态及预计恢复时间');
  } else addEvidence('事实', '输入标记存在正式延误状态，仍需复核对应航班、发布方与更新时间。', 'EVENT-INPUT', event.time || '未提供');

  if (event.humanRejected) {
    rules.add('RULE006');
    addEvidence('人工反馈', `专业人员否决原因：${event.humanReason}。${event.resourceAdequate ? '补充事实：现场资源充足。' : '现场资源是否充足仍未确认。'}`, 'HUMAN-INPUT', event.time || '人工反馈时点');
    if (event.resourceAdequate && !stopped && !conflict) risk = '低';
    if (!stopped && !conflict) {
      actions.unshift({
        owner: '专业复核人',
        text: event.resourceAdequate
          ? '依据新增的现场资源事实调整为持续监测；保留原建议与否决原因。'
          : '保留原建议与否决原因，核查补充事实后重新评估；否决本身不代表风险消失。',
        gate: '记录复核人和新增事实',
      });
    }
  }

  const request = event.request || '';
  const majorRequest = /取消|放行|调度|维修|赔付|起飞|降落/.test(request);
  const publishRequest = /发送|发布|推送/.test(request);
  if (majorRequest) rules.add('RULE007');
  if (privacyRemoved || /姓名|手机号|身份证|个人信息/.test(request)) rules.add('RULE011');
  const boundary = stopped
    ? '停止行动结论，仅整理信息并升级人工复核。'
    : majorRequest
      ? '拒绝自动执行重大运行决定，仅整理所需信息并交给相应专业负责人。'
      : publishRequest
        ? '仅生成待人工审核的草案，不发送通知。'
        : '所有建议待人工复核；系统不执行航班变更或发布通知。';
  const impact = stopped || conflict
    ? '证据尚不足以确定影响范围。'
    : signals.length
      ? '机场保障与后续运行可能承压，具体航班和旅客影响仍待核查。'
      : '当前输入未确认显著异常；低风险不代表已确认安全。';
  const summary = `${event.airport}：${risk}。${impact}${boundary}`;
  const firstAction = actions[0]?.text || '提交人工复核。';
  const drafts = {
    operations: `【模拟 · 内部运营草案 · 待复核】${summary} 首要事项：${firstAction} 信息缺口：${gaps.join('；')}。`,
    coordination: `【模拟 · 机场协调草案 · 待复核】请协助复核 ${event.airport} 在 ${event.time || '待确认时段'} 的运行状态、天气更新时间、保障能力和数据口径。${stopped || conflict ? '当前无法形成确定判断，请反馈经复核的信息。' : '请说明后续任务是否集中及资源是否承压。'}`,
    passenger: `【模拟 · 旅客信息草案 · 未发送 · 须人工审核】${event.airport} 的相关信息正在核实。${event.formalDelay ? '输入提示存在延误信息，具体航班状态须经航空公司复核。' : '目前尚无经本系统核实的正式航班延误信息。'}请以航空公司正式通知为准；预计恢复时间尚待确认。`,
  };
  const confidence = stopped || conflict ? '低' : event.confirmedSources >= 2 && gaps.length <= 2 ? '高' : '中';
  return {
    id: randomUUID(), generatedAt: new Date().toISOString(), simulated: true,
    mode: '可解释规则分析', status: '待复核', input: event, risk, confidence, summary, impact,
    disruptionDefinition: '当当前完成比例较机场前12个月均值低超过5个百分点，或出现经输入确认的天气、运行压力或正式延误信号时，标记为异常候选；高风险还要求至少两个可靠来源确认多个独立信号。',
    baseline: base, delta, anomaly, signals, stopped, conflict, privacyRemoved, evidence,
    assumptions: ['天气与历史波动只提供关联线索，不能证明延误因果', '月度模拟基线用于历史背景，不能替代逐航班实时运行数据'],
    gaps,
    actions: actions.map((action, index) => ({ ...action, priority: index + 1 })),
    escalation: stopped ? '立即提交人工复核；补充可靠来源前保持停止状态。' : '保障能力下降且出现经核实的运行异常，或多个独立风险得到至少两个可靠来源确认时，由运营负责人决定是否升级。',
    humanDecisions: ['飞行安全', '航班放行', '取消', '调度', '维修', '赔付', '正式旅客通知'],
    rules: [...rules].map(ruleById).filter(Boolean), drafts, boundary,
  };
}

export function answerQuestion(result, rawQuestion) {
  const question = redact(String(rawQuestion || '').trim());
  if (!question) throw new Error('请输入问题');
  const prefix = '【模拟 · 决策支持】';
  if (/现实|真实机场/.test(question)) return `${prefix} 不是。本系统中的机场、事件和数值均为赛事方生成的虚构模拟内容（RULE010）。`;
  if (/一定.*延误|会不会.*延误|是否.*延误/.test(question)) return `${prefix} 不能断定一定延误。${result.input.formalDelay ? '输入标记存在正式延误状态，但仍需核对航班、发布方和更新时间。' : '当前没有经系统核实的正式航班延误状态。'} 已知风险与正式状态必须区分。`;
  if (/来源|数字不一致|冲突|选哪个/.test(question)) return `${prefix} 不自动选择任一来源。先核查更新时间、统计口径、覆盖范围和复核状态；冲突解决前暂停确定性结论（RULE001）。`;
  if (/天气.*导致|因果|全部运行异常/.test(question)) return `${prefix} 现有信息只能显示关联线索，缺少逐航班原因数据，不能证明天气导致全部运行异常。`;
  if (/取消|放行|调度|维修|赔付|起飞|降落/.test(question)) return `${prefix} 我不能执行或替代该重大运行决定。系统只整理核查信息，并提交相应专业负责人审批（RULE007）。`;
  if (/姓名|手机号|身份证|个人信息/.test(question)) return `${prefix} 请删除或匿名化个人信息。系统只需要机场、时段和汇总运行信息，不保存身份字段（RULE011）。`;
  if (/发送|发布|推送/.test(question)) return `${prefix} 只能生成清楚标注的草案，不能声称已发送；旅客信息必须经过人工审核（RULE005）。`;
  if (/人工.*拒绝|人工.*否决|专业人员.*拒绝/.test(question)) return `${prefix} 记录拒绝原因和补充事实，保留原建议，再用新事实重评；不得覆盖人工意见（RULE006）。`;
  if (/前序飞机|未知|缺少/.test(question)) return `${prefix} 将其列为信息缺口并指定核查负责人，不能虚构补齐。当前信息缺口：${result.gaps.join('；')}。`;
  if (/哪个时段|时间范围|什么时间/.test(question)) return `${prefix} 当前事件时段为 ${result.input.time || '未提供'}；历史参考月为 ${result.baseline.month}，前12个月均值覆盖 ${result.baseline.historyStart} 至 ${result.baseline.historyEnd}。两种粒度不直接等同。`;
  if (/为什么|依据|证据/.test(question)) {
    const sources = [...new Set(result.evidence.map((item) => item.source))].join('、');
    return `${prefix} ${result.summary} 依据来源为 ${sources}。主要信号：${result.signals.join('、') || '未确认异常信号'}；信息缺口：${result.gaps.join('；')}。`;
  }
  return `${prefix} ${result.summary} 首要核查：${result.actions[0]?.text || '提交人工复核。'} 该答复不替代专业人员决定。`;
}

export function standardOutput(result) {
  return {
    事件编号: result.input.eventId || result.id,
    生成时间: result.generatedAt,
    风险等级: result.risk,
    适用机场与时间: `${result.input.airport}；${result.input.time || '未提供'}`,
    判断依据: result.evidence.map((item) => `${item.text} [${item.source}; ${item.period}]`).join('\n'),
    可能影响: result.impact,
    待核查假设: result.assumptions.join('\n'),
    信息缺口: result.gaps.join('\n'),
    第一步行动: result.actions[0]?.text || '提交人工复核',
    后续行动: result.actions.slice(1).map((item) => item.text).join('\n'),
    升级条件: result.escalation,
    必须人工决定事项: result.humanDecisions.join('、'),
    内部运营提示: result.drafts.operations,
    机场协调信息: result.drafts.coordination,
    旅客信息草案: result.drafts.passenger,
    引用来源: [...new Set([...result.evidence.map((item) => item.source), ...result.rules.map((rule) => rule['规则编号'])])].join('；'),
    输出状态: result.status,
  };
}
