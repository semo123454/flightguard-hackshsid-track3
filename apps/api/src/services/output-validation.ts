import AjvModule, { type ErrorObject } from 'ajv';
import type { Evidence, EventInput, GeneratedNarrative, QuestionAnswer, RuleResult } from '@flightguard/contracts';
import { generatedNarrativeSchema, questionAnswerSchema } from '@flightguard/contracts';

const ajv = new AjvModule.default({ strict: true, allErrors: true });
const validateGenerated = ajv.compile<GeneratedNarrative>(generatedNarrativeSchema);
const validateAnswerSchema = ajv.compile<QuestionAnswer>(questionAnswerSchema);
// “天气预警已发布” is a factual observation, not an action performed by
// FlightGuard. Block operational actions while allowing that evidence phrase.
const forbidden = /(已经|已)(取消|放行|调度|维修|赔付|发送)|已发布(?:通知|公告|旅客|运行限制|航班状态)|自动取消|立即取消/;

export function validateNarrative(value: unknown, evidence: Evidence[], event: EventInput, rules: RuleResult): { ok: true; value: GeneratedNarrative } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!validateGenerated(value)) errors.push(...formatAjvErrors(validateGenerated.errors));
  if (errors.length) return { ok: false, errors };
  const narrative = value as GeneratedNarrative;
  if (!/草案/.test(narrative.drafts.operations) || !/未执行/.test(narrative.drafts.operations)) errors.push('运营草案必须明确标识为草案且未执行');
  if (!/草案/.test(narrative.drafts.airport) || !/未发送/.test(narrative.drafts.airport)) errors.push('机场协调草案必须明确标识为草案且未发送');
  if (!/草案/.test(narrative.drafts.passenger) || !/未发送/.test(narrative.drafts.passenger)) errors.push('旅客草案必须明确标识为草案且未发送');
  const allowedIds = new Set(evidence.map((item) => item.id));
  for (const explanation of narrative.explanations) {
    for (const id of explanation.evidenceIds) if (!allowedIds.has(id)) errors.push(`不存在的 evidenceId：${id}`);
  }
  const text = JSON.stringify(narrative);
  // Facts may legitimately say that a weather warning was issued. Restrict
  // the action-safety check to the three generated drafts, where an
  // operational claim would actually instruct or announce an action.
  const draftText = Object.values(narrative.drafts).join(' ');
  if (forbidden.test(draftText)) errors.push('草案声称已执行受限动作');
  if (event.formalDelay !== true && /(已确认延误|确认发生延误|航班已延误)/.test(text)) errors.push('正式延误状态与事件事实不一致');
  const supportedPercentages = new Set(evidence.flatMap((item) => item.text.match(/\d+(?:\.\d+)?%/g) || []));
  for (const token of text.match(/\d+(?:\.\d+)?%/g) || []) if (!supportedPercentages.has(token)) errors.push(`无证据支持的比例：${token}`);
  const supportedDateText = [event.baselineMonth, event.eventTime || '', ...evidence.flatMap((item) => [item.text, item.periodStart || '', item.periodEnd || '', item.publishedAt || ''])].join(' ');
  for (const token of text.match(/\b\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?\b/g) || []) if (!supportedDateText.includes(token)) errors.push(`无证据支持的日期：${token}`);
  for (const airportId of text.match(/\bA\d{3}\b/g) || []) if (airportId !== event.airportId) errors.push(`机场与事件不一致：${airportId}`);
  const assertedRisk = text.match(/(?:风险等级(?:为|是)|判定为)(低|中|高|无法判断)(?:风险)?/)?.[1];
  const expectedRisk = { low: '低', medium: '中', high: '高', undetermined: '无法判断' }[rules.risk];
  if (assertedRisk && assertedRisk !== expectedRisk) errors.push(`风险等级与服务器规则结果不一致：${assertedRisk}`);
  const actionTexts = new Set(rules.actions.map((action) => action.text));
  if (/(执行取消|调整真实航班|直接发送)/.test(text) && ![...actionTexts].some((action) => text.includes(action))) errors.push('草案包含允许集合之外的动作');
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, value: narrative };
}

export function validateQuestionAnswer(value: unknown, evidence: Evidence[], event: EventInput, rules: RuleResult): { ok: true; value: QuestionAnswer } | { ok: false; errors: string[] } {
  if (!validateAnswerSchema(value)) return { ok: false, errors: formatAjvErrors(validateAnswerSchema.errors) };
  const answer = value as QuestionAnswer;
  const allowedIds = new Set(evidence.map((item) => item.id));
  const errors = answer.evidenceIds.filter((id) => !allowedIds.has(id)).map((id) => `不存在的 evidenceId：${id}`);
  errors.push(...groundingErrors(answer.answer, evidence, event, rules));
  return errors.length ? { ok: false, errors: [...new Set(errors)] } : { ok: true, value: answer };
}

function groundingErrors(text: string, evidence: Evidence[], event: EventInput, rules: RuleResult): string[] {
  const errors: string[] = [];
  if (forbidden.test(text)) errors.push('回答声称已执行受限动作');
  if (event.formalDelay !== true && /(已确认延误|确认发生延误|航班已延误)/.test(text)) errors.push('正式延误状态与事件事实不一致');
  const supportedPercentages = new Set(evidence.flatMap((item) => item.text.match(/\d+(?:\.\d+)?%/g) || []));
  for (const token of text.match(/\d+(?:\.\d+)?%/g) || []) if (!supportedPercentages.has(token)) errors.push(`无证据支持的比例：${token}`);
  const supportedDateText = [event.baselineMonth, event.eventTime || '', ...evidence.flatMap((item) => [item.text, item.periodStart || '', item.periodEnd || '', item.publishedAt || ''])].join(' ');
  for (const token of text.match(/\b\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?\b/g) || []) if (!supportedDateText.includes(token)) errors.push(`无证据支持的日期：${token}`);
  for (const airportId of text.match(/\bA\d{3}\b/g) || []) if (airportId !== event.airportId) errors.push(`机场与事件不一致：${airportId}`);
  const assertedRisk = text.match(/(?:风险等级(?:为|是)|判定为)(低|中|高|无法判断)(?:风险)?/)?.[1];
  const expectedRisk = { low: '低', medium: '中', high: '高', undetermined: '无法判断' }[rules.risk];
  if (assertedRisk && assertedRisk !== expectedRisk) errors.push(`风险等级与服务器规则结果不一致：${assertedRisk}`);
  return errors;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => `${error.instancePath || '/'} ${error.message || '校验失败'}`);
}
