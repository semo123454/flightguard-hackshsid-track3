import type { AssessmentFrame, EventRecord, Evidence, RuleResult } from '@flightguard/contracts';
import type { BaselineResult } from '../domain/baseline.js';
import type { PeerBaseline } from './retrieval.js';

const riskLabel = { low: '低', medium: '中', high: '高', undetermined: '无法判断' } as const;

export function buildAssessmentFrame(
  event: EventRecord,
  evidence: Evidence[],
  rules: RuleResult,
  baseline: BaselineResult,
  peer: PeerBaseline,
  verifiedSourceIds: string[],
): AssessmentFrame {
  const existingIds = new Set(evidence.map((item) => item.id));
  const observationIds = evidence.filter((item) => item.kind === 'observation' || item.kind === 'human_input').map((item) => item.id).slice(0, 8);
  const factId = (index: number) => `EVENT:${event.id}:R${event.revision}:FACT:${index + 1}`;
  const currentCompletionCandidates = event.payload.metrics.flatMap((item, index) => {
    if (item.metric !== 'scheduled_completion_ratio') return [];
    const id = `CURRENT:${event.id}:R${event.revision}:scheduled_completion_ratio:${index + 1}`;
    return [{ ...item, evidenceId: existingIds.has(id) ? id : null }];
  });
  const distinctCurrentValues = new Set(currentCompletionCandidates.map((item) => item.value));
  const current = currentCompletionCandidates.length === 1 && distinctCurrentValues.size === 1 ? currentCompletionCandidates[0]! : null;
  const baselineEvidenceId = existingIds.has(`CALC:${event.payload.airportId}:${event.payload.baselineMonth}:completion-12m`)
    ? `CALC:${event.payload.airportId}:${event.payload.baselineMonth}:completion-12m`
    : null;
  const peerEvidenceId = peer.evidenceId && existingIds.has(peer.evidenceId) ? peer.evidenceId : null;

  const triggeredReasons: string[] = [];
  if (rules.deltaPercentagePoints !== null && rules.deltaPercentagePoints < -5 - 1e-9) {
    triggeredReasons.push(`当前按计划完成比例低于本机场历史均值 ${Math.abs(rules.deltaPercentagePoints).toFixed(2)} 个百分点`);
  }
  if (event.payload.weatherRisk === true) triggeredReasons.push('天气风险已确认');
  if (event.payload.operatingPressure === true) triggeredReasons.push('运行压力已确认');
  if (event.payload.formalDelay === true) triggeredReasons.push('已有正式延误状态');
  if (event.payload.resourceAdequate === false) triggeredReasons.push('保障资源已确认不足');
  if (rules.stopped) triggeredReasons.push('来源冲突或可靠性不足，停止确定性判断');
  if (rules.risk === 'undetermined' && !rules.stopped) triggeredReasons.push('关键事实不足，无法形成确定性结论');
  if (!triggeredReasons.length) triggeredReasons.push('当前已核验项未触发风险升级条件');

  const conclusion = `研判结论：${riskLabel[rules.risk]}风险。${triggeredReasons.slice(0, 3).join('；')}。`;
  const evidenceForSignals = observationIds.length ? observationIds : evidence.filter((item) => item.kind === 'rule').map((item) => item.id).slice(0, 2);
  return {
    scope: {
      airportId: event.payload.airportId,
      eventTimeLabel: event.payload.eventTimeLabel,
      baselineMonth: event.payload.baselineMonth,
    },
    conclusion,
    knownFacts: event.payload.knownFacts.map((text, index) => ({
      text,
      evidenceIds: existingIds.has(factId(index)) ? [factId(index)] : [],
    })),
    signals: [
      signal('weatherRisk', '天气风险', event.payload.weatherRisk, false, evidenceForSignals),
      signal('operatingPressure', '运行压力', event.payload.operatingPressure, false, evidenceForSignals),
      signal('formalDelay', '正式延误', event.payload.formalDelay, false, evidenceForSignals),
      signal('resourceAdequate', '保障资源充足', event.payload.resourceAdequate, true, evidenceForSignals),
    ],
    currentCompletion: current ? {
      value: current.value,
      period: current.period,
      granularity: current.granularity,
      evidenceId: current.evidenceId,
    } : null,
    currentCompletionCandidates,
    ownBaseline: baseline.mean === null ? null : {
      mean: baseline.mean,
      sampleCount: baseline.sampleCount,
      periodStart: baseline.periodStart,
      periodEnd: baseline.periodEnd,
      evidenceId: baselineEvidenceId,
    },
    peerBaseline: peer.mean === null || !peer.category ? null : {
      category: peer.category,
      mean: peer.mean,
      sampleCount: peer.sampleCount,
      period: peer.period,
      evidenceId: peerEvidenceId,
    },
    deltaPercentagePoints: rules.deltaPercentagePoints,
    anomalyTriggered: rules.deltaPercentagePoints !== null && rules.deltaPercentagePoints < -5 - 1e-9,
    triggeredReasons,
    unknowns: rules.gaps,
    verifiedSourceIds,
  };
}

function signal(
  key: AssessmentFrame['signals'][number]['key'],
  label: string,
  value: boolean | null,
  positiveMeansSafe: boolean,
  evidenceIds: string[],
): AssessmentFrame['signals'][number] {
  const state = value === null ? 'unknown' : positiveMeansSafe ? (value ? 'absent' : 'present') : (value ? 'present' : 'absent');
  return { key, label, state, evidenceIds };
}
