import type { EventRecord, Evidence, GeneratedNarrative, RuleResult } from '@flightguard/contracts';

const riskLabel = { low: '低', medium: '中', high: '高', undetermined: '无法判断' } as const;

export function buildRuleNarrative(event: EventRecord, evidence: Evidence[], result: RuleResult): GeneratedNarrative {
  const basis = result.evidenceIds.filter((id) => evidence.some((item) => item.id === id)).slice(0, 6);
  const status = event.payload.formalDelay === true ? '已有正式延误信息' : event.payload.formalDelay === false ? '明确未收到正式延误信息' : '正式延误状态未知';
  const scope = `${event.payload.airportId}，${event.payload.eventTimeLabel}`;
  return {
    summary: `规则模式研判：风险等级为${riskLabel[result.risk]}。适用范围：${scope}。${status}。`,
    impact: result.stopped ? '来源条件触发停止机制，当前只列出核查方向，不形成确定性行动结论。' : '当前信息用于安排核查优先级，不等同于真实航班状态或安全结论。',
    assumptions: result.gaps.length ? result.gaps : ['仅在本次事件版本和已登记来源范围内有效'],
    explanations: [{ text: result.deltaPercentagePoints === null ? '当前指标与月度基线不可直接比较，保留历史背景但不计算异常差值。' : `与历史均值的差为 ${result.deltaPercentagePoints.toFixed(2)} 个百分点。`, evidenceIds: basis }],
    drafts: {
      operations: `【运营草案｜未执行】${result.actions.map((action) => action.text).join(' ')}请人工核验后决定。`,
      airport: `【机场协调草案｜未发送】请协助核对 ${event.payload.eventTimeLabel} 的运行限制、保障资源和下一更新时间。`,
      passenger: `【旅客信息草案｜未发送】当前正在核实可能影响，实际航班状态以正式通知为准。本草案须经人工审核。`,
    },
  };
}
