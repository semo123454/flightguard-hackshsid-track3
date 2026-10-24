import type { EventInput, RuleResult } from '@flightguard/contracts';
import { actionCatalog } from './actions.js';
import { isStrictFivePointAnomaly } from './baseline.js';

export interface RuleContext {
  event: EventInput;
  deltaPercentagePoints: number | null;
  verifiedSourceIds: string[];
  sourceConflict: boolean;
  unreliableSources: boolean;
  factEvidenceIds: string[];
  ruleEvidenceIds: Record<string, string>;
}

export function evaluateRules(context: RuleContext): RuleResult {
  const { event } = context;
  const anomaly = isStrictFivePointAnomaly(context.deltaPercentagePoints);
  const stop = context.sourceConflict || context.unreliableSources;
  const insufficientFacts = context.deltaPercentagePoints === null
    && event.knownFacts.length === 0
    && [event.weatherRisk, event.operatingPressure, event.formalDelay, event.resourceAdequate].every((value) => value === null);
  const signals = [anomaly, event.weatherRisk === true, event.operatingPressure === true, event.formalDelay === true, event.resourceAdequate === false].filter(Boolean).length;
  const ruleIds = new Set<string>(['RULE009', 'RULE010']);
  if (event.unknowns.length || [event.weatherRisk, event.operatingPressure, event.formalDelay, event.resourceAdequate].some((value) => value === null)) ruleIds.add('RULE001');
  if (event.weatherRisk === true) ruleIds.add('RULE002');
  if (anomaly) ruleIds.add('RULE003');
  if (event.operatingPressure === true) ruleIds.add('RULE004');
  if (signals > 0 && event.formalDelay !== true) ruleIds.add('RULE005');
  if (signals >= 2 && context.verifiedSourceIds.length >= 2) ruleIds.add('RULE008');
  if (stop) ruleIds.add('RULE012');

  const gaps = [...event.unknowns];
  if (event.weatherRisk === null) gaps.push('当前天气风险尚未确认');
  if (event.operatingPressure === null) gaps.push('运行压力尚未确认');
  if (event.formalDelay === null) gaps.push('正式延误状态尚未确认');
  if (event.resourceAdequate === null) gaps.push('现场资源是否充足尚未确认');
  if (context.deltaPercentagePoints === null) gaps.push('缺少与月度历史基线可比的当前按计划完成比例');
  if (context.unreliableSources) gaps.push('至少一个输入来源未登记或未核验');
  if (context.sourceConflict) gaps.push('同口径来源存在数值冲突');

  let risk: RuleResult['risk'];
  if (stop || insufficientFacts) risk = 'undetermined';
  else if (signals >= 2 && context.verifiedSourceIds.length >= 2) risk = 'high';
  else if (signals >= 1) risk = 'medium';
  else risk = 'low';

  const basisIds = context.factEvidenceIds.slice(0, 10);
  const actions = stop || insufficientFacts
    ? [actionCatalog.stopAndVerify(basisIds)]
    : [signals > 0 ? actionCatalog.verifyOperations(basisIds) : actionCatalog.monitor(basisIds), actionCatalog.prepareDrafts(basisIds)];
  const evidenceIds = [...basisIds, ...[...ruleIds].map((id) => context.ruleEvidenceIds[id]).filter((id): id is string => Boolean(id))];
  return {
    risk,
    stopped: stop,
    ruleIds: [...ruleIds],
    evidenceIds: [...new Set(evidenceIds)],
    gaps: [...new Set(gaps)],
    actions,
    escalationConditions: [
      '出现正式延误或运行限制通知',
      '两个以上独立风险信号同时成立且至少有两个已核验来源',
      '来源冲突、安全相关问题或关键事实无法核验',
    ],
    humanDecisions: ['取消、放行、调度、维修、赔付和正式发布必须由相应专业人员决定'],
    deltaPercentagePoints: context.deltaPercentagePoints,
  };
}
