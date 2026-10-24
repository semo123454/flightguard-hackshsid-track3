import type { AssessmentFrame, Evidence, GeneratedNarrative, RuleResult } from '@flightguard/contracts';

const riskImpact = {
  low: '现有已核验项未触发升级，但不预测未来航班状态',
  medium: '已出现需要复核的风险信号，应先确认影响对象和现场条件',
  high: '多个独立风险信号同时成立，应优先确认逐航班状态、运行限制和保障资源',
  undetermined: '证据不足或存在冲突，不能确定影响范围或给出确定性行动结论',
} as const;

export function reconstructNarrative(
  candidate: unknown,
  assessment: AssessmentFrame,
  evidence: Evidence[],
  rules: RuleResult,
): unknown {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
  const value = candidate as Partial<GeneratedNarrative>;
  return {
    ...value,
    summary: assessment.conclusion,
    impact: `影响判断：${riskImpact[rules.risk]}。${formalStatus(assessment)}。`,
    assumptions: [
      `本报告仅适用于 ${assessment.scope.airportId}、${assessment.scope.eventTimeLabel} 和当前事件版本`,
      '月度历史与同类机场只用于背景对比，不代表单个航班状态',
      '未明确提供或未核验的信息保持未知，不作肯定推断',
    ],
    explanations: buildExplanations(assessment, evidence, rules),
  };
}

function buildExplanations(assessment: AssessmentFrame, evidence: Evidence[], rules: RuleResult): GeneratedNarrative['explanations'] {
  const available = new Set(evidence.map((item) => item.id));
  const result: GeneratedNarrative['explanations'] = [];
  const knownIds = assessment.knownFacts.flatMap((item) => item.evidenceIds).filter((id) => available.has(id)).slice(0, 3);
  const descriptionId = evidence.find((item) => item.id.includes(':DESCRIPTION'))?.id;
  if (assessment.knownFacts.length) {
    result.push({ text: `已知事实：${assessment.knownFacts.slice(0, 3).map((item) => item.text).join('；')}。`, evidenceIds: knownIds.length ? knownIds : descriptionId ? [descriptionId] : rules.evidenceIds.slice(0, 1) });
  } else {
    result.push({ text: '当前没有独立确认的现场事实，事件描述仅作待核查输入。', evidenceIds: descriptionId ? [descriptionId] : rules.evidenceIds.slice(0, 1) });
  }

  const candidateIds = assessment.currentCompletionCandidates.map((item) => item.evidenceId).filter((id): id is string => Boolean(id && available.has(id)));
  const comparisonIds = [...candidateIds, assessment.ownBaseline?.evidenceId, assessment.peerBaseline?.evidenceId]
    .filter((id): id is string => Boolean(id && available.has(id))).slice(0, 3);
  if (comparisonIds.length) {
    const hasConflict = new Set(assessment.currentCompletionCandidates.map((item) => item.value)).size > 1;
    const currentText = hasConflict
      ? `当前冲突候选值${assessment.currentCompletionCandidates.map((item) => `${(item.value * 100).toFixed(2)}%`).join('、')}，冲突未解决前不计算差值`
      : assessment.currentCompletion ? `当前${(assessment.currentCompletion.value * 100).toFixed(2)}%` : null;
    const parts = [
      currentText,
      assessment.ownBaseline ? `本机场前${assessment.ownBaseline.sampleCount}个月均值${(assessment.ownBaseline.mean * 100).toFixed(2)}%` : null,
      !hasConflict && assessment.peerBaseline ? `同期同类（${assessment.peerBaseline.category}）均值${(assessment.peerBaseline.mean * 100).toFixed(2)}%` : null,
    ].filter(Boolean);
    result.push({ text: `数据对比：${parts.join('；')}。`, evidenceIds: comparisonIds });
  }

  const rulePriority = ['RULE012', 'RULE008', 'RULE003', 'RULE002', 'RULE004', 'RULE005', 'RULE001', 'RULE009', 'RULE010'];
  const rankRule = (id: string) => {
    const rank = rulePriority.indexOf(id);
    return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
  };
  const orderedRuleIds = [...rules.ruleIds].sort((a, b) => rankRule(a) - rankRule(b));
  const ruleIds = orderedRuleIds.map((id) => evidence.find((item) => item.id.startsWith(`RULE:${id}:`))?.id).filter((id): id is string => Boolean(id)).slice(0, 3);
  if (ruleIds.length) result.push({ text: `规则结论：${assessment.triggeredReasons.slice(0, 3).join('；')}。`, evidenceIds: ruleIds });

  if (assessment.unknowns.length) {
    const gapRule = evidence.find((item) => item.id.startsWith('RULE:RULE001:'))?.id ?? ruleIds[0];
    if (gapRule) result.push({ text: `仍需核查：${assessment.unknowns.slice(0, 3).join('；')}。`, evidenceIds: [gapRule] });
  }
  return result.slice(0, 4);
}

function formalStatus(assessment: AssessmentFrame): string {
  const state = assessment.signals.find((item) => item.key === 'formalDelay')?.state;
  if (state === 'present') return '当前输入已确认正式延误';
  if (state === 'absent') return '当前输入明确未收到正式延误状态';
  return '正式延误状态尚未确认';
}
