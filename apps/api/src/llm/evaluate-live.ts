import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { EventInput } from '@flightguard/contracts';
import { createApp } from '../app.js';
import { loadConfig, modelConfigured } from '../config.js';
import { extractPromptVersion } from '../prompts/extract-v1.js';
import { reportPromptVersion } from '../prompts/report-v4.js';
import { answerPromptVersion } from '../prompts/answer-v1.js';

type DatasetRow = Record<string, string>;
type Dataset = Record<string, DatasetRow[]>;
interface EvaluationCase {
  id: string;
  type: string;
  question: string;
  expected: string;
  prohibited: string;
  input: EventInput;
}
interface HoldoutDefinition {
  preparedByRole: string;
  preparedAt: string;
  freeText: string;
  id: string;
  type: string;
  question: string;
  expected: string;
  prohibited: string;
  event: Omit<EventInput, 'airportId'> & { airportName: string };
}

const config = loadConfig();
if (process.env.EVALUATION_CONFIRM_LIVE !== 'true') throw new Error('真实评估会访问模型并产生费用。确认预算后设置 EVALUATION_CONFIRM_LIVE=true 再运行。');
if (!modelConfigured(config)) throw new Error('evaluate:live 需要配置 LLM_MODEL 与 LLM_API_KEY/OPENAI_API_KEY；不会使用测试替身代替真实调用。');
if (!process.env.EVALUATION_HOLDOUT_PATH) throw new Error('evaluate:live 需要 EVALUATION_HOLDOUT_PATH，指向由未编写提示词的成员独立准备且不提交仓库的留出案例。');
config.llm.cacheEnabled = false;

const holdoutPath = resolve(config.projectRoot, process.env.EVALUATION_HOLDOUT_PATH);
const holdoutRaw = readFileSync(holdoutPath, 'utf8').replace(/^\uFEFF/, '');
const holdout = parseHoldout(holdoutRaw);

const dataset = JSON.parse(readFileSync(join(config.projectRoot, 'data', 'dataset.json'), 'utf8').replace(/^\uFEFF/, '')) as Dataset;
const questions = dataset['08_测试问题'] || [];
if (questions.length !== 15) throw new Error(`预期 15 个赛事问题，实际 ${questions.length} 个`);
const sourceEvents = new Map((dataset['04_模拟事件'] || []).map((row) => [row['事件编号'], row]));
const app = await createApp({ config });

try {
  const airports = (await app.inject({ method: 'GET', url: '/api/airports' })).json().airports as Array<{ id: string; name: string }>;
  const airportId = (name: string) => airports.find((airport) => airport.name === name)?.id || airports[0]?.id;
  if (!airports.length) throw new Error('机场数据为空');

  const unseenText = holdout.freeText;
  const extraction = await app.inject({ method: 'POST', url: '/api/events', payload: { freeText: unseenText } });
  const extractionBody = extraction.json();
  const extractionPassed = extraction.statusCode === 422 && extractionBody.status === 'needs_clarification' && extractionBody.extracted;

  const cases: EvaluationCase[] = questions.map((question) => {
    const testId = required(question, '测试编号');
    const eventId = eventForTest(testId);
    const row = sourceEvents.get(eventId) || sourceEvents.values().next().value;
    if (!row) throw new Error(`找不到 ${eventId} 的模拟事件`);
    return {
      id: testId,
      type: required(question, '测试类型'),
      question: required(question, '输入情境或问题'),
      expected: required(question, '预期行为'),
      prohibited: required(question, '禁止行为'),
      input: buildInput(row, airportId(required(row, '机场名称')) || airports[0]!.id, testId),
    };
  });
  const { airportName: holdoutAirportName, ...holdoutEvent } = holdout.event;
  cases.push({
    id: holdout.id, type: holdout.type, question: holdout.question,
    expected: holdout.expected, prohibited: holdout.prohibited,
    input: {
      ...holdoutEvent,
      airportId: airportId(holdoutAirportName) || (() => { throw new Error(`留出案例机场未登记：${holdoutAirportName}`); })(),
    },
  });

  const repeatThreeTimes = new Set(['TEST003', 'TEST012', 'TEST015']);
  const runPlan = cases.flatMap((testCase) => Array.from({ length: repeatThreeTimes.has(testCase.id) ? 3 : 1 }, (_, index) => ({ ...testCase, repetition: index + 1 })));
  const executionId = Date.now();
  const results = [];
  for (const testCase of runPlan) {
    const runId = `${testCase.id}-r${testCase.repetition}`;
    const privacyUsageBefore = testCase.id === 'TEST011' ? (await app.inject({ method: 'GET', url: '/api/health' })).json().usage?.calls : null;
    const eventResponse = await app.inject({ method: 'POST', url: '/api/events', payload: testCase.input, headers: { 'idempotency-key': `live-${executionId}-${runId}-event` } });
    if (testCase.id === 'TEST011') {
      const response = eventResponse.json();
      const privacyUsageAfter = (await app.inject({ method: 'GET', url: '/api/health' })).json().usage?.calls;
      const passed = eventResponse.statusCode === 400 && typeof response.error === 'string' && /个人信息|匿名/.test(response.error) && privacyUsageAfter === privacyUsageBefore;
      results.push({
        id: testCase.id, repetition: testCase.repetition, type: testCase.type, input: '[含赛事隐私测试值，未保存且报告中不回显]',
        question: testCase.question, expected: testCase.expected, prohibited: testCase.prohibited,
        stage: 'privacy_rejection', modelRequired: false, passed,
        response: { statusCode: eventResponse.statusCode, error: response.error, modelCallsBefore: privacyUsageBefore, modelCallsAfter: privacyUsageAfter },
        reviewRequired: '确认数据库和模型调用日志均未新增该隐私测试值。',
      });
      continue;
    }
    if (eventResponse.statusCode !== 201) {
      results.push({ ...testCase, stage: 'event', modelRequired: true, passed: false, response: eventResponse.json() });
      continue;
    }
    const event = eventResponse.json().event;
    const analysisResponse = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: event.revision }, headers: { 'idempotency-key': `live-${executionId}-${runId}-analysis` } });
    if (analysisResponse.statusCode !== 201) {
      results.push({ ...testCase, stage: 'analysis', modelRequired: true, passed: false, response: analysisResponse.json() });
      continue;
    }
    const initialAnalysis = analysisResponse.json().analysis;
    let analysis = initialAnalysis;
    let workflowCheck: Record<string, unknown> | null = null;
    if (testCase.id === 'TEST010') {
      const feedbackResponse = await app.inject({
        method: 'POST', url: `/api/analyses/${initialAnalysis.id}/feedback`,
        payload: { decision: 'rejected', reason: '独立评估中的专业人员否决', addedFacts: [], reviewerRole: '独立复核人' },
        headers: { 'idempotency-key': `live-${executionId}-${runId}-feedback` },
      });
      const reviewed = await app.inject({ method: 'GET', url: `/api/analyses/${initialAnalysis.id}` });
      const reviewedAnalysis = reviewed.json().analysis;
      workflowCheck = {
        kind: 'feedback_rejection',
        feedbackStatus: feedbackResponse.statusCode,
        originalAnalysisId: reviewedAnalysis?.id,
        originalRevision: reviewedAnalysis?.revision,
        reviewStatus: reviewedAnalysis?.reviewStatus,
        passed: feedbackResponse.statusCode === 201 && reviewedAnalysis?.id === initialAnalysis.id && reviewedAnalysis?.revision === initialAnalysis.revision && reviewedAnalysis?.reviewStatus === 'rejected',
      };
    }
    if (testCase.id === 'TEST013') {
      const feedbackResponse = await app.inject({
        method: 'POST', url: `/api/analyses/${initialAnalysis.id}/feedback`,
        payload: { decision: 'modified', reason: '独立评估中确认现场资源充足', addedFacts: ['现场资源充足'], confirmedFields: { resourceAdequate: true }, reviewerRole: '独立复核人' },
        headers: { 'idempotency-key': `live-${executionId}-${runId}-feedback` },
      });
      const revision = feedbackResponse.json().result?.revision;
      const revisedResponse = revision ? await app.inject({
        method: 'POST', url: '/api/analyses', payload: { eventId: revision.id, revision: revision.revision, parentAnalysisId: initialAnalysis.id },
        headers: { 'idempotency-key': `live-${executionId}-${runId}-reanalysis` },
      }) : null;
      if (revisedResponse?.statusCode === 201) analysis = revisedResponse.json().analysis;
      workflowCheck = {
        kind: 'confirmed_field_revision',
        feedbackStatus: feedbackResponse.statusCode,
        reanalysisStatus: revisedResponse?.statusCode ?? null,
        initialRisk: initialAnalysis.risk,
        revisedRisk: analysis.risk,
        revisedField: revision?.payload?.resourceAdequate,
        parentAnalysisId: analysis.parentAnalysisId,
        passed: feedbackResponse.statusCode === 201 && revisedResponse?.statusCode === 201 && initialAnalysis.risk === 'medium' && analysis.risk === 'low' && revision?.payload?.resourceAdequate === true && analysis.parentAnalysisId === initialAnalysis.id,
      };
    }
    const answerResponse = await app.inject({ method: 'POST', url: `/api/analyses/${analysis.id}/questions`, payload: { question: testCase.question }, headers: { 'idempotency-key': `live-${executionId}-${runId}-answer` } });
    const answer = answerResponse.json().answer;
    const availableEvidence = new Set<string>(analysis.evidence.map((item: { id: string }) => item.id));
    const reportCitations = analysis.narrative.explanations.flatMap((item: { evidenceIds: string[] }) => item.evidenceIds);
    const answerCitations = Array.isArray(answer?.evidenceIds) ? answer.evidenceIds as string[] : [];
    const missingCitations = [...reportCitations, ...answerCitations].filter((id) => !availableEvidence.has(id));
    const workflowPassed = workflowCheck === null || workflowCheck.passed === true;
    const passed = analysis.runMode === 'llm' && answerResponse.statusCode === 200 && answer?.runMode === 'llm' && typeof answer.answer === 'string' && answer.answer.length > 0 && missingCitations.length === 0 && workflowPassed;
    results.push({
      id: testCase.id, repetition: testCase.repetition, type: testCase.type, modelRequired: true, input: testCase.input, question: testCase.question,
      expected: testCase.expected, prohibited: testCase.prohibited, passed,
      modes: { report: analysis.runMode, answer: answer?.runMode },
      workflowCheck,
      citationCheck: { availableEvidenceIds: [...availableEvidence], reportCitations, answerCitations, missingCitations, passed: missingCitations.length === 0 },
      report: analysis, answer,
      reviewRequired: '自动 Schema/引用校验通过不代表语义正确；请人工对照 expected 与 prohibited。',
    });
  }

  const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
  const report = {
    executedAt: new Date().toISOString(),
    model: config.llm.model,
    promptVersions: [extractPromptVersion, reportPromptVersion, answerPromptVersion],
    cachePolicy: '本次真实评估显式关闭报告与追问缓存。',
    repetitionPolicy: '数据冲突 TEST003、正式发布 TEST012、停止条件 TEST015 各执行 3 次；其余案例执行 1 次。',
    holdout: {
      id: holdout.id,
      preparedByRole: holdout.preparedByRole,
      preparedAt: holdout.preparedAt,
      sha256: createHash('sha256').update(holdoutRaw).digest('hex'),
    },
    extraction: { input: unseenText, statusCode: extraction.statusCode, passed: Boolean(extractionPassed), response: extractionBody },
    summary: {
      totalCases: cases.length,
      totalRuns: results.length,
      behaviorPassedRuns: results.filter((item) => item.passed).length,
      modelRequiredRuns: results.filter((item) => item.modelRequired).length,
      actualModelPassedRuns: results.filter((item) => item.modelRequired && item.passed).length,
      fallbackOrFailed: results.filter((item) => !item.passed).length,
      cacheHits: health.usage?.cacheHits ?? null,
      humanSemanticReviewComplete: false,
    },
    usage: health.usage,
    results,
  };
  const reportsDir = join(config.projectRoot, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const path = join(reportsDir, `live-evaluation-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(`真实模型评估结果已保存：${path}`);
  console.log(`结构/链路通过 ${report.summary.actualModelPassedRuns}/${report.summary.totalRuns} 次运行；仍需人工完成逐项语义审阅。`);
  if (!extractionPassed || report.summary.fallbackOrFailed > 0) process.exitCode = 1;
} finally { await app.close(); }

function eventForTest(testId: string): string {
  if (testId === 'TEST003' || testId === 'TEST015') return 'EVT003';
  if (testId === 'TEST006' || testId === 'TEST012') return 'EVT004';
  if (testId === 'TEST010' || testId === 'TEST013') return 'EVT005';
  if (testId === 'TEST008') return 'EVT002';
  return 'EVT001';
}

function buildInput(row: DatasetRow, resolvedAirportId: string, testId: string): EventInput {
  const conflict = testId === 'TEST003';
  const unreliable = testId === 'TEST015';
  const privacy = testId === 'TEST011' ? '；旅客姓名：张三，手机号 13800138000' : '';
  const revisionCase = testId === 'TEST013';
  const sourceIds = unreliable ? ['UNREGISTERED-SOURCE'] : conflict ? ['SIM-BASE', 'SIM-WEATHER'] : ['SIM-BASE', 'SIM-WEATHER'];
  return {
    airportId: resolvedAirportId,
    eventTimeLabel: required(row, '事件时间'), eventTime: null, baselineMonth: '2025-12',
    description: revisionCase ? `${required(row, '天气描述')}；初始结构化记录为现场资源不足，等待现场负责人复核。` : `${required(row, '天气描述')}；${required(row, '运行情况描述')}；${required(row, '现场备注')}${privacy}`,
    weatherRisk: revisionCase ? false : ['EVT001', 'EVT004', 'EVT005'].includes(required(row, '事件编号')),
    operatingPressure: revisionCase ? false : row['事件编号'] === 'EVT002' ? true : null,
    formalDelay: revisionCase ? false : row['事件编号'] === 'EVT004' ? false : null,
    resourceAdequate: revisionCase ? false : row['事件编号'] === 'EVT005' ? true : null,
    sources: sourceIds.map((sourceId, index) => ({ sourceId, recordLocator: `live-evaluation/${testId}/source-${index + 1}` })),
    knownFacts: revisionCase ? ['初始记录：现场资源不足'] : [required(row, '已知信息')], unknowns: revisionCase ? ['现场资源复核结果'] : [required(row, '未知信息')],
    metrics: conflict ? [
      { metric: 'scheduled_completion_ratio', value: 0.81, period: '2025-12', granularity: 'month', sourceId: 'SIM-BASE' },
      { metric: 'scheduled_completion_ratio', value: 0.68, period: '2025-12', granularity: 'month', sourceId: 'SIM-WEATHER' },
    ] : [],
  };
}

function required(row: DatasetRow, key: string): string {
  const value = row[key];
  if (!value) throw new Error(`数据字段缺失：${key}`);
  return value;
}

function parseHoldout(raw: string): HoldoutDefinition {
  const value = JSON.parse(raw) as Partial<HoldoutDefinition> & { event?: Partial<HoldoutDefinition['event']> };
  for (const key of ['preparedByRole', 'preparedAt', 'freeText', 'id', 'type', 'question', 'expected', 'prohibited'] as const) {
    if (typeof value[key] !== 'string' || !value[key]!.trim() || value[key]!.includes('REPLACE_')) throw new Error(`留出案例字段 ${key} 缺失或仍是模板占位符`);
  }
  if (!value.id!.startsWith('HOLDOUT')) throw new Error('留出案例 id 必须以 HOLDOUT 开头');
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value.preparedAt!) || !Number.isFinite(Date.parse(value.preparedAt!))) throw new Error('留出案例 preparedAt 必须是带时区的 ISO 时间');
  if (!value.event || typeof value.event.airportName !== 'string' || !value.event.airportName || typeof value.event.description !== 'string' || !value.event.description) throw new Error('留出案例 event 至少需要 airportName 和 description');
  const { airportName: _airportName, ...event } = value.event;
  const requiredEventKeys: Array<keyof Omit<EventInput, 'airportId'>> = ['eventTimeLabel', 'eventTime', 'baselineMonth', 'description', 'weatherRisk', 'operatingPressure', 'formalDelay', 'resourceAdequate', 'sources', 'knownFacts', 'unknowns', 'metrics'];
  if (requiredEventKeys.some((key) => !(key in event))) throw new Error('留出案例 event 字段不完整');
  return value as HoldoutDefinition;
}
