import { createHash, randomUUID } from 'node:crypto';
import type { AnalysisReport, EventInput, Evidence, QuestionAnswer, WeatherEstimate } from '@flightguard/contracts';
import type { AppConfig } from '../config.js';
import type { Repository } from '../db/repositories.js';
import type { LlmProvider, LlmResult } from '../llm/provider.js';
import { LlmError } from '../llm/provider.js';
import { generateReport, repairReport } from '../llm/generate.js';
import { answerWithModel, repairAnswer } from '../llm/answer.js';
import { repairExtraction, requestExtraction, validateExtraction } from '../llm/extract.js';
import { buildEvidencePackage, getWeatherHistory, limitEvidence } from './retrieval.js';
import { evaluateRules } from '../domain/risk.js';
import { actionCatalog } from '../domain/actions.js';
import { buildRuleNarrative } from './rule-template.js';
import { validateNarrative, validateQuestionAnswer } from './output-validation.js';
import { buildAssessmentFrame } from './assessment-frame.js';
import { reconstructNarrative } from './report-structure.js';
import type { WeatherModel } from '../weather/contract.js';
import { reportPromptVersion } from '../prompts/report-v4.js';
import { answerPromptVersion } from '../prompts/answer-v1.js';
import { extractPromptVersion } from '../prompts/extract-v1.js';
import { redactText } from '../domain/privacy.js';
import { invalidWeatherEstimate, validateWeatherEstimate } from '../weather/validation.js';

export class Orchestrator {
  constructor(
    private readonly repository: Repository,
    private readonly config: AppConfig,
    private readonly provider: LlmProvider | null,
    private readonly weatherModel: WeatherModel,
  ) {}

  async analyze(eventId: string, revision: number, parentAnalysisId: string | null = null): Promise<AnalysisReport> {
    const event = this.repository.getEvent(eventId, revision);
    if (!event) throw new ServiceError(404, '找不到指定事件版本');
    const evidencePackage = buildEvidencePackage(this.repository, event);
    const ruleResult = evaluateRules({
      event: event.payload,
      deltaPercentagePoints: evidencePackage.deltaPercentagePoints,
      verifiedSourceIds: evidencePackage.verifiedSourceIds,
      sourceConflict: evidencePackage.sourceConflict,
      unreliableSources: evidencePackage.unreliableSources,
      factEvidenceIds: evidencePackage.evidence.filter((item) => item.kind !== 'rule').map((item) => item.id),
      ruleEvidenceIds: evidencePackage.ruleEvidenceIds,
    });
    const analysisId = randomUUID();
    const pendingRunIds: string[] = [];
    const deadline = AbortSignal.timeout(this.config.llm.reportDeadlineMs);
    const rawWeather = await this.getWeather(event.payload, deadline);
    const integratedWeather = integrateWeather(event.payload, evidencePackage.evidence, rawWeather);
    const evidence = integratedWeather.evidence;
    const weather = integratedWeather.weather;
    const availableEvidenceIds = new Set(evidence.map((item) => item.id));
    ruleResult.evidenceIds = ruleResult.evidenceIds.filter((id) => availableEvidenceIds.has(id));
    ruleResult.actions = ruleResult.actions.map((action) => ({ ...action, basisIds: action.basisIds.filter((id) => availableEvidenceIds.has(id)) }));
    if (integratedWeather.conflict) {
      ruleResult.stopped = true;
      if (!ruleResult.ruleIds.includes('RULE012')) ruleResult.ruleIds.push('RULE012');
      if (integratedWeather.evidenceId) ruleResult.evidenceIds = [...new Set([...ruleResult.evidenceIds, integratedWeather.evidenceId])];
      ruleResult.gaps = [...new Set([...ruleResult.gaps, '天气函数估计与已核验的同口径当前事实冲突'])];
      ruleResult.humanDecisions = [...new Set([...ruleResult.humanDecisions, '天气估计冲突必须由人工核对模型适用范围和当前事实来源'])];
      ruleResult.actions = [actionCatalog.stopAndVerify(ruleResult.evidenceIds.slice(0, 10))];
    }
    const assessment = buildAssessmentFrame(
      event,
      evidence,
      ruleResult,
      evidencePackage.baseline,
      evidencePackage.peerBaseline,
      evidencePackage.verifiedSourceIds,
    );
    let narrative = reconstructNarrative(buildRuleNarrative(event, evidence, ruleResult), assessment, evidence, ruleResult) as AnalysisReport['narrative'];
    let runMode: AnalysisReport['runMode'] = 'rules_fallback';
    let fallbackReason: string | null = this.provider ? null : '语言模型未配置，已使用确定性规则模板';
    let modelVersion: string | null = null;

    if (this.provider) {
      const payload = { event, evidence, assessment, ruleResult, allowedActions: ruleResult.actions, weather: integratedWeather.weatherForModel };
      const cacheKey = this.reportCacheKey(payload);
      try {
        const cached = this.config.llm.cacheEnabled ? this.repository.getCachedValue(cacheKey) : null;
        let checked;
        if (cached) {
          checked = validateNarrative(cached.value, evidence, event.payload, ruleResult);
          if (checked.ok) {
            modelVersion = cached.model;
            pendingRunIds.push(this.repository.saveLlmRun({ purpose: 'report', mode: 'cache', promptVersion: reportPromptVersion, model: cached.model, durationMs: 0, cacheHit: true }));
          }
        }
        if (!cached || !checked?.ok) {
          const first = await this.callAndLog('report', null, () => generateReport(this.provider!, payload, deadline), 'primary', pendingRunIds);
          modelVersion = first.model;
          checked = validateNarrative(reconstructNarrative(first.value, assessment, evidence, ruleResult), evidence, event.payload, ruleResult);
          if (!checked.ok) {
            if (deadline.aborted) throw new LlmError(`报告输出校验失败：${checked.errors.join('；')}`, 'format');
            const validationErrors = checked.errors;
            const repaired = await this.callAndLog('report', null, () => repairReport(this.provider!, payload, validationErrors, first.value, deadline), 'repair', pendingRunIds);
            modelVersion = repaired.model;
            checked = validateNarrative(reconstructNarrative(repaired.value, assessment, evidence, ruleResult), evidence, event.payload, ruleResult);
          }
        }
        if (!checked.ok) throw new LlmError(`报告输出校验失败：${checked.errors.join('；')}`, 'format');
        narrative = checked.value;
        runMode = 'llm';
        fallbackReason = null;
        if (this.config.llm.cacheEnabled) this.repository.saveCachedValue(cacheKey, 'report', narrative, modelVersion || 'unknown');
      } catch (error) {
        if (error instanceof LlmError && (error.category === 'concurrency' || error.category === 'budget')) throw new ServiceError(429, error.message);
        fallbackReason = error instanceof Error ? error.message : '语言模型不可用';
      }
    }

    const report: AnalysisReport = {
      id: analysisId, eventId, revision, parentAnalysisId, risk: ruleResult.risk, runMode, fallbackReason,
      ruleVersion: '1.0', promptVersion: reportPromptVersion, modelVersion, createdAt: new Date().toISOString(),
      evidence, ruleResult, assessment, narrative, weather, reviewStatus: 'pending',
    };
    this.repository.saveAnalysisWithRuns(report, pendingRunIds);
    return report;
  }

  async answer(analysisId: string, rawQuestion: string): Promise<QuestionAnswer & { runMode: AnalysisReport['runMode']; fallbackReason: string | null }> {
    const analysis = this.repository.getAnalysis(analysisId);
    if (!analysis) throw new ServiceError(404, '找不到分析报告');
    const redactedQuestion = redactText(rawQuestion);
    if (redactedQuestion.redacted) throw new ServiceError(400, '检测到疑似个人信息，请删除或匿名化后重新提交');
    const question = redactedQuestion.value.trim();
    if (!question) throw new ServiceError(400, '问题不能为空');
    const fallback = fallbackAnswer(question, analysis);
    if (!this.provider) return { ...fallback, runMode: 'rules_fallback', fallbackReason: '语言模型未配置' };
    const event = this.repository.getEvent(analysis.eventId, analysis.revision);
    if (!event) throw new ServiceError(404, '找不到报告绑定的事件版本');
    const signal = AbortSignal.timeout(this.config.llm.timeoutMs);
    const payload = { question, report: analysis, evidence: analysis.evidence };
    const cacheKey = createHash('sha256').update(JSON.stringify({
      payload,
      promptVersion: answerPromptVersion,
      provider: this.config.llm.provider,
      baseUrl: this.config.llm.baseUrl,
      model: this.config.llm.model,
      reasoningEffort: this.config.llm.reasoningEffort,
      maxOutputTokens: this.config.llm.maxOutputTokens,
    })).digest('hex');
    try {
      const cached = this.config.llm.cacheEnabled ? this.repository.getCachedValue(cacheKey) : null;
      if (cached) {
        const checked = validateQuestionAnswer(cached.value, analysis.evidence, event.payload, analysis.ruleResult);
        if (checked.ok) {
          this.repository.saveLlmRun({ analysisId, purpose: 'answer', mode: 'cache', promptVersion: answerPromptVersion, model: cached.model, durationMs: 0, cacheHit: true });
          return { ...checked.value, runMode: 'llm', fallbackReason: null };
        }
      }
      let result = await this.callAndLog('answer', analysisId, () => answerWithModel(this.provider!, payload, signal));
      let checked = validateQuestionAnswer(result.value, analysis.evidence, event.payload, analysis.ruleResult);
      if (!checked.ok && !signal.aborted) {
        const invalidOutput = result.value;
        const validationErrors = checked.errors;
        result = await this.callAndLog('answer', analysisId, () => repairAnswer(this.provider!, payload, validationErrors, invalidOutput, signal), 'repair');
        checked = validateQuestionAnswer(result.value, analysis.evidence, event.payload, analysis.ruleResult);
      }
      if (!checked.ok) throw new LlmError(`追问输出校验失败：${checked.errors.join('；')}`, 'format');
      if (this.config.llm.cacheEnabled) this.repository.saveCachedValue(cacheKey, 'answer', checked.value, result.model);
      return { ...checked.value, runMode: 'llm', fallbackReason: null };
    } catch (error) {
      return { ...fallback, runMode: 'rules_fallback', fallbackReason: error instanceof Error ? error.message : '模型追问失败' };
    }
  }

  async extractFreeText(text: string) {
    if (!this.provider) throw new ServiceError(422, '当前为规则模式，无法可靠解析自由文本；请使用结构化表单');
    const clean = redactText(text).value;
    const signal = AbortSignal.timeout(this.config.llm.timeoutMs);
    const payload = { text: clean, registeredAirports: this.repository.listAirports() };
    try {
      let result = await this.callAndLog('extract', null, () => requestExtraction(this.provider!, payload, signal));
      let checked = validateExtraction(result.value);
      if (!checked.ok && !signal.aborted) {
        const validationErrors = checked.errors;
        const invalidOutput = result.value;
        result = await this.callAndLog('extract', null, () => repairExtraction(this.provider!, payload, validationErrors, invalidOutput, signal), 'repair');
        checked = validateExtraction(result.value);
      }
      if (!checked.ok) throw new LlmError(`提取输出校验失败：${checked.errors.join('；')}`, 'format');
      return checked.value;
    } catch (error) { throw new ServiceError(422, error instanceof Error ? error.message : '自由文本解析失败'); }
  }

  private async getWeather(event: EventInput, signal: AbortSignal): Promise<WeatherEstimate> {
    const rows = getWeatherHistory(this.repository, event.airportId, event.baselineMonth, event.baselineMonth);
    const row = rows[0];
    const weatherSource = row ? this.repository.db.prepare('SELECT published_at FROM sources WHERE id = ?').get(String(row.source_id)) as { published_at: string | null } | undefined : undefined;
    const markedMissing = Number(row?.missing_flag) === 1;
    try {
      const raw = await this.weatherModel.estimate({
        airportId: event.airportId, targetMetric: 'airport_release_normal_ratio', periodStart: event.baselineMonth,
        periodEnd: event.baselineMonth, granularity: 'month', asOf: new Date().toISOString(), sourcePublishedAt: weatherSource?.published_at ?? null, mode: 'historical',
        weather: {
          precipitationMm: markedMissing ? null : numeric(row?.precipitation_mm), meanTemperatureC: markedMissing ? null : numeric(row?.mean_temperature_c),
          maxWindSpeedMps: markedMissing ? null : numeric(row?.max_wind_speed_mps), adverseWeatherDays: markedMissing ? null : numeric(row?.adverse_weather_days),
        },
        weatherBasis: row ? String(row.record_locator) : '无可用天气记录',
        sourceRefs: row ? [String(row.source_id)] : [],
      }, signal);
      const checked = validateWeatherEstimate(raw);
      return checked.ok ? checked.value : invalidWeatherEstimate(checked.reason);
    } catch (error) {
      return invalidWeatherEstimate(signal.aborted ? '天气模块调用超时' : error instanceof Error ? error.message : '天气模块失败', signal.aborted ? 'timeout' : 'error');
    }
  }

  private async callAndLog(purpose: 'extract' | 'report' | 'answer', analysisId: string | null, call: () => Promise<LlmResult>, mode = 'primary', pendingRunIds?: string[]) {
    const started = Date.now();
    try {
      const result = await call();
      const runId = this.logResult(purpose, analysisId, result, Date.now() - started, mode);
      if (pendingRunIds) pendingRunIds.push(runId);
      return result;
    } catch (error) {
      const runId = this.repository.saveLlmRun({ analysisId, purpose, mode, promptVersion: promptVersionFor(purpose), durationMs: Date.now() - started, errorCategory: error instanceof LlmError ? error.category : 'provider' });
      if (pendingRunIds) pendingRunIds.push(runId);
      throw error;
    }
  }

  private logResult(purpose: 'extract' | 'report' | 'answer', analysisId: string | null, result: LlmResult, durationMs: number, mode: string) {
    return this.repository.saveLlmRun({ analysisId, requestId: result.providerRequestId, purpose, mode, promptVersion: promptVersionFor(purpose), model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, durationMs });
  }

  private reportCacheKey(payload: unknown) {
    return createHash('sha256').update(JSON.stringify({
      payload,
      ruleVersion: '1.0',
      promptVersion: reportPromptVersion,
      provider: this.config.llm.provider,
      baseUrl: this.config.llm.baseUrl,
      model: this.config.llm.model,
      reasoningEffort: this.config.llm.reasoningEffort,
      maxOutputTokens: this.config.llm.maxOutputTokens,
    })).digest('hex');
  }
}

export class ServiceError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function promptVersionFor(purpose: 'extract' | 'report' | 'answer'): string {
  return purpose === 'extract' ? extractPromptVersion : purpose === 'report' ? reportPromptVersion : answerPromptVersion;
}

function integrateWeather(event: EventInput, baseEvidence: Evidence[], weather: WeatherEstimate): {
  evidence: Evidence[];
  evidenceId: string | null;
  conflict: boolean;
  weather: WeatherEstimate;
  weatherForModel: WeatherEstimate;
} {
  if (weather.status !== 'ok' || weather.estimate === null) return { evidence: baseEvidence, evidenceId: null, conflict: false, weather, weatherForModel: weather };
  const observed = event.metrics.find((metric) => metric.metric === 'airport_release_normal_ratio' && metric.granularity === 'month' && metric.period === event.baselineMonth);
  const observedEvidence = observed ? baseEvidence.find((item) => item.id.startsWith('CURRENT:') && item.id.includes(':airport_release_normal_ratio:')) : null;
  const conflict = Boolean(observed && observedEvidence?.verification === 'verified' && Math.abs(observed.value - weather.estimate) * 100 > 5 + 1e-9);
  const basis = baseEvidence.find((item) => item.id === `WEATHER:${event.airportId}:${event.baselineMonth}`);
  const evidenceId = `ESTIMATE:${event.airportId}:${event.baselineMonth}:${weather.modelVersion || 'unknown'}`;
  const interval = weather.predictionInterval ? `，校准区间 ${(weather.predictionInterval[0] * 100).toFixed(2)}%—${(weather.predictionInterval[1] * 100).toFixed(2)}%` : '';
  const estimateEvidence: Evidence = {
    id: evidenceId,
    kind: 'estimate',
    sourceId: basis?.sourceId ?? 'WEATHER-MODEL',
    recordLocator: `${basis?.recordLocator ?? `weather/${event.airportId}/${event.baselineMonth}`}#model:${weather.modelVersion || 'unknown'}`,
    text: `经验证天气模型对机场放行正常比例的月度回溯估计为 ${(weather.estimate * 100).toFixed(2)}%${interval}。该估计不覆盖规则风险，也不作为独立来源重复计数。`,
    periodStart: event.baselineMonth,
    periodEnd: event.baselineMonth,
    publishedAt: basis?.publishedAt ?? null,
    dataVersion: `weather-model:${weather.modelVersion || 'unknown'}`,
    verification: conflict ? 'conflicting' : 'verified',
    simulated: basis?.simulated ?? true,
  };
  const displayWeather = conflict ? { ...weather, reason: `${weather.reason}；与已核验同口径当前事实相差超过 5 个百分点，已停止将估计用于建议生成。` } : weather;
  const weatherForModel = conflict ? {
    ...weather,
    status: 'error' as const,
    estimate: null,
    predictionInterval: null,
    reason: '天气估计与已核验同口径当前事实冲突，已从建议生成上下文移除并等待人工复核。',
  } : weather;
  return { evidence: limitEvidence([...baseEvidence, estimateEvidence]), evidenceId, conflict, weather: displayWeather, weatherForModel };
}

function fallbackAnswer(question: string, analysis: AnalysisReport): QuestionAnswer {
  const ids = analysis.ruleResult.evidenceIds.slice(0, 8);
  const assessment = analysis.assessment;
  if (/(一定|必然|确定).*(延误|取消)|延误.*一定/.test(question)) {
    return { answer: `不能据此断言一定延误。当前风险为${analysis.risk}，正式航班状态${assessment?.signals.find((item) => item.key === 'formalDelay')?.state === 'present' ? '已确认' : '尚未确认'}；月度指标和天气只支持核查与升级，不等同于逐航班结果。`, evidenceIds: ids, needsRevision: false };
  }
  if (/(天气|导致).*(全部|所有)|全部.*(天气|异常)/.test(question)) {
    return { answer: '不能证明天气导致全部运行异常。当前只有天气风险信号与运行表现的关联线索，仍需逐航班原因、前序飞机位置、机组和地面保障状态来核查因果。', evidenceIds: ids, needsRevision: false };
  }
  if (/(两个来源|来源).*(不一致|冲突)|选择哪个/.test(question)) {
    return { answer: '两个来源不一致时不选择其中一个作为事实。应暂停确定性结论，先核对更新时间、统计口径、来源复核状态和原始记录；核实前保持 undetermined。', evidenceIds: ids, needsRevision: false };
  }
  if (/(运营人员|旅客).*(分别|写给)|分别写/.test(question)) {
    return { answer: '运营人员草案：按优先级核查受影响航班、资源、前序飞机和正式限制，并由负责人决定是否升级。\n旅客草案：当前正在核实可能影响，实际航班状态以正式通知和官方渠道为准；本草案未发送，须人工审核。', evidenceIds: ids, needsRevision: false };
  }
  if (/(前序飞机|位置).*(怎么办|没有)/.test(question)) {
    return { answer: '前序飞机位置属于当前信息缺口，不能虚构。请向运行控制或航空公司核查航班号、前序航段、最新位置和预计到达时间，再决定是否调整影响范围。', evidenceIds: ids, needsRevision: false };
  }
  if (/(现实|真实).*(机场|海陵|云川|临江)/.test(question)) {
    return { answer: '不是现实运行判断。本系统中的机场、事件、指标和来源均为赛事模拟数据，只用于测试研判流程，不能当作真实机场状态。', evidenceIds: ids, needsRevision: false };
  }
  if (/(来源可靠性|可靠性无法|无法判断来源)/.test(question)) {
    return { answer: '来源可靠性无法判断时，停止确定性结论和重大行动建议，升级人工复核；请核对来源登记、更新时间、统计口径和原始记录。当前报告保持 undetermined。', evidenceIds: ids, needsRevision: false };
  }
  if (/(拒绝|否决).*(建议|判断)|专业人员/.test(question)) {
    return { answer: '记录专业人员的否决决定、理由、角色和时间，保留原报告不覆盖；若有新事实，创建事件修订并重新生成报告，同时保留原报告与父子链接。', evidenceIds: ids, needsRevision: false };
  }
  if (/(哪个|什么).*(时段|时间|数据)/.test(question)) {
    const baseline = assessment?.ownBaseline;
    return { answer: `当前事件范围是${assessment?.scope.eventTimeLabel || '事件时间'}，参考月为${assessment?.scope.baselineMonth || '未提供'}；本机场历史基线使用参考月之前的${baseline?.sampleCount || 0}个月（${baseline?.periodStart || '未知'}至${baseline?.periodEnd || '未知'}），不把当前月混入历史均值。`, evidenceIds: ids, needsRevision: false };
  }
  if (/(新事件|新机场|临江).*(输入|处理)|输入临江/.test(question)) {
    return { answer: `已按当前事件的机场、时间、指标和来源重新计算，报告绑定事件版本 ${analysis.eventId}/修订${analysis.revision}；新事件不会回放固定答案，需用其自身证据和历史基线重新生成。`, evidenceIds: ids, needsRevision: false };
  }
  if (/(新增|补充|其实|现场|目前)/.test(question)) return { answer: '这可能是新增事实。请先创建事件修订，再针对新版本重新生成分析；当前报告不会被悄悄改写。', evidenceIds: ids, needsRevision: true };
  if (/(取消|发送|发布|执行)/.test(question)) return { answer: '系统只能整理信息和生成待审核草案，不能自动取消、放行、调度、维修、赔付或正式发送。', evidenceIds: ids, needsRevision: false };
  if (/(依据|为什么|证据)/.test(question)) return { answer: `当前判断由规则 ${analysis.ruleResult.ruleIds.join('、')} 和本报告证据包支持；证据包包含事件天气与运行描述、机场画像及参考月之前的历史基线，具体来源可通过 evidenceIds 追溯；风险为 ${analysis.risk}，信息缺口包括：${analysis.ruleResult.gaps.join('；') || '无新增缺口'}。`, evidenceIds: ids, needsRevision: false };
  return { answer: `基于当前报告：${analysis.narrative.summary} 如问题包含新的运行事实，请先创建事件修订。`, evidenceIds: ids, needsRevision: false };
}
