import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { EventInput, Evidence, GeneratedNarrative } from '@flightguard/contracts';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { LlmError, type LlmProvider, type LlmResult } from '../src/llm/provider.js';
import { openDatabase } from '../src/db/connection.js';

const input: EventInput = {
  airportId: 'A001', eventTimeLabel: '第4天下午', eventTime: null, baselineMonth: '2025-12', description: '模拟天气风险',
  weatherRisk: true, operatingPressure: null, formalDelay: null, resourceAdequate: null,
  sources: [{ sourceId: 'SIM-WEATHER', recordLocator: 'fixture/new-event' }], knownFacts: ['收到模拟天气提示'], unknowns: ['正式状态'], metrics: [],
};

class FakeProvider implements LlmProvider {
  calls = 0;
  constructor(private readonly handler: (call: number, args: Parameters<LlmProvider['generateJson']>[0]) => unknown) {}
  async generateJson(args: Parameters<LlmProvider['generateJson']>[0]): Promise<LlmResult> {
    this.calls++;
    const value = this.handler(this.calls, args);
    if (value instanceof Error) throw value;
    return { value, model: 'fixture-model', inputTokens: 120, outputTokens: 80, providerRequestId: `fixture-${this.calls}` };
  }
}

function validNarrative(args: Parameters<LlmProvider['generateJson']>[0]): GeneratedNarrative {
  const payload = args.payload as { evidence: Evidence[] };
  return {
    summary: '模型在规则边界内整理了本次模拟事件。',
    impact: '当前只安排核查优先级，不代表正式航班状态。',
    assumptions: ['正式状态仍待核实'],
    explanations: [{ text: '依据本次事件证据形成表达。', evidenceIds: [payload.evidence[0]!.id] }],
    drafts: {
      operations: '【运营草案｜未执行】请人工核验运行状态。',
      airport: '【机场协调草案｜未发送】请协助核实保障情况。',
      passenger: '【旅客信息草案｜未发送】实际状态以正式通知为准，须人工审核。',
    },
  };
}

async function createAndAnalyze(app: FastifyInstance) {
  const created = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
  return app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: created.id, revision: 1 } });
}

describe('model orchestration and validation', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => { if (app) await app.close(); app = null; });

  it('accepts a grounded model report, binds logs, and reuses only validated cache', async () => {
    const provider = new FakeProvider((_call, args) => validNarrative(args));
    const directory = mkdtempSync(join(tmpdir(), 'flightguard-llm-'));
    const databasePath = join(directory, 'test.sqlite');
    app = await createApp({ databasePath, provider });
    const event = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
    const first = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
    const second = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
    expect(first.json().analysis.runMode).toBe('llm');
    expect(second.json().analysis.runMode).toBe('llm');
    expect(first.json().analysis.promptVersion).toBe('report-v4');
    expect(first.json().analysis.assessment).toMatchObject({
      scope: { airportId: 'A001', eventTimeLabel: '第4天下午', baselineMonth: '2025-12' },
      triggeredReasons: expect.arrayContaining(['天气风险已确认']),
    });
    expect(first.json().analysis.narrative.summary).toMatch(/^研判结论：中风险/);
    expect(first.json().analysis.narrative.explanations.map((item: { text: string }) => item.text).join('')).toMatch(/已知事实|数据对比|规则结论/);
    expect(provider.calls).toBe(1);
    const history = await app.inject({ method: 'GET', url: '/api/analyses' });
    expect(history.json().analyses).toHaveLength(2);
    await app.close(); app = null;
    const db = openDatabase(databasePath);
    const runs = db.prepare('SELECT analysis_id, cache_hit, prompt_version FROM llm_runs ORDER BY created_at').all() as Array<{ analysis_id: string | null; cache_hit: number; prompt_version: string | null }>;
    expect(runs).toHaveLength(2);
    expect(runs.every((row) => row.analysis_id)).toBe(true);
    expect(runs.map((row) => row.cache_hit)).toEqual([0, 1]);
    expect(runs.map((row) => row.prompt_version)).toEqual(['report-v4', 'report-v4']);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('can disable model output caching for reproducible live evaluation', async () => {
    const provider = new FakeProvider((_call, args) => validNarrative(args));
    const config = loadConfig({ databasePath: ':memory:' });
    config.llm.cacheEnabled = false;
    app = await createApp({ config, provider });
    const event = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
    await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
    await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
    expect(provider.calls).toBe(2);
  });

  it('coalesces repeated free-text extraction with the same idempotency key', async () => {
    const provider = new FakeProvider(() => ({
      airportCandidate: { value: '海陵国际机场', origin: 'model_candidate', span: '海陵国际机场' },
      eventTimeLabel: { value: '次日上午', origin: 'model_candidate', span: '次日上午' },
      weatherRisk: { value: true, origin: 'model_candidate', span: '持续降水' },
      operatingPressure: { value: null, origin: 'model_candidate', span: null },
      formalDelay: { value: null, origin: 'model_candidate', span: null },
      resourceAdequate: { value: null, origin: 'model_candidate', span: null },
      unknowns: ['正式状态'],
    }));
    app = await createApp({ databasePath: ':memory:', provider });
    const request = { method: 'POST' as const, url: '/api/events', headers: { 'idempotency-key': 'extract-once' }, payload: { freeText: '海陵国际机场次日上午持续降水，正式状态未知。' } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.statusCode).toBe(422);
    expect(second.statusCode).toBe(422);
    expect(second.headers['idempotency-replayed']).toBe('true');
    expect(provider.calls).toBe(1);
  });

  it('repairs one schema-invalid extraction before returning candidate fields', async () => {
    const valid = {
      airportCandidate: { value: '海陵国际机场', origin: 'model_candidate', span: '海陵国际机场' },
      eventTimeLabel: { value: null, origin: 'model_candidate', span: null },
      weatherRisk: { value: true, origin: 'model_candidate', span: '风雨' },
      operatingPressure: { value: null, origin: 'model_candidate', span: null },
      formalDelay: { value: null, origin: 'model_candidate', span: null },
      resourceAdequate: { value: null, origin: 'model_candidate', span: null },
      unknowns: ['事件时间', '正式状态'],
    };
    const provider = new FakeProvider((call) => call === 1 ? { airportCandidate: 'invalid' } : valid);
    app = await createApp({ databasePath: ':memory:', provider });
    const response = await app.inject({ method: 'POST', url: '/api/events', payload: { freeText: '海陵国际机场出现风雨，其他信息未知。' } });
    expect(response.statusCode).toBe(422);
    expect(response.json().extracted).toEqual(valid);
    expect(provider.calls).toBe(2);
  });

  it('reconstructs vague core text and repairs one invalid audience draft', async () => {
    const provider = new FakeProvider((call, args) => call === 1
      ? { ...validNarrative(args), summary: '需关注相关情况。', drafts: { ...validNarrative(args).drafts, operations: '请人工核验。' } }
      : validNarrative(args));
    app = await createApp({ databasePath: ':memory:', provider });
    const response = await createAndAnalyze(app);
    expect(response.json().analysis.runMode).toBe('llm');
    expect(response.json().analysis.narrative.summary).toMatch(/^研判结论：/);
    expect(provider.calls).toBe(2);
  });

  it('caches only a validated grounded answer for the same report and question', async () => {
    const provider = new FakeProvider((_call, args) => {
      if (args.purpose === 'report') return validNarrative(args);
      const payload = args.payload as { evidence: Evidence[] };
      return { answer: '依据当前证据，正式状态仍需人工核实。', evidenceIds: [payload.evidence[0]!.id], needsRevision: false };
    });
    app = await createApp({ databasePath: ':memory:', provider });
    const generated = await createAndAnalyze(app);
    const id = generated.json().analysis.id;
    const first = await app.inject({ method: 'POST', url: `/api/analyses/${id}/questions`, payload: { question: '依据是什么？' } });
    const second = await app.inject({ method: 'POST', url: `/api/analyses/${id}/questions`, payload: { question: '依据是什么？' } });
    expect(first.json().answer.runMode).toBe('llm');
    expect(second.json().answer.runMode).toBe('llm');
    expect(provider.calls).toBe(2);
  });

  it('repairs a hallucinated answer once before returning it', async () => {
    const provider = new FakeProvider((call, args) => {
      if (args.purpose === 'report') return validNarrative(args);
      const payload = args.payload as { evidence: Evidence[] };
      if (call === 2) return { answer: 'A999 已确认延误 37.77%，并且已经取消航班。', evidenceIds: [payload.evidence[0]!.id], needsRevision: false };
      return { answer: '依据当前证据，只能继续核实正式状态。', evidenceIds: [payload.evidence[0]!.id], needsRevision: false };
    });
    app = await createApp({ databasePath: ':memory:', provider });
    const generated = await createAndAnalyze(app);
    const response = await app.inject({ method: 'POST', url: `/api/analyses/${generated.json().analysis.id}/questions`, payload: { question: '当前结论是什么？' } });
    expect(response.json().answer).toMatchObject({ runMode: 'llm', answer: '依据当前证据，只能继续核实正式状态。' });
    expect(provider.calls).toBe(3);
  });

  it('falls back when the single answer repair still violates grounding rules', async () => {
    const provider = new FakeProvider((_call, args) => {
      if (args.purpose === 'report') return validNarrative(args);
      const payload = args.payload as { evidence: Evidence[] };
      return { answer: '无证据显示 88.88%，且已经取消航班。', evidenceIds: [payload.evidence[0]!.id], needsRevision: false };
    });
    app = await createApp({ databasePath: ':memory:', provider });
    const generated = await createAndAnalyze(app);
    const response = await app.inject({ method: 'POST', url: `/api/analyses/${generated.json().analysis.id}/questions`, payload: { question: '当前结论是什么？' } });
    expect(response.json().answer.runMode).toBe('rules_fallback');
    expect(response.json().answer.fallbackReason).toMatch(/追问输出校验失败/);
    expect(provider.calls).toBe(3);
  });

  it('falls back after the single repair also fails validation', async () => {
    const provider = new FakeProvider((_call, args) => ({ ...validNarrative(args), drafts: { ...validNarrative(args).drafts, operations: '请人工核验。' } }));
    app = await createApp({ databasePath: ':memory:', provider });
    const response = await createAndAnalyze(app);
    expect(response.statusCode).toBe(201);
    expect(response.json().analysis.runMode).toBe('rules_fallback');
    expect(response.json().analysis.fallbackReason).toMatch(/校验失败/);
    expect(provider.calls).toBe(2);
  });

  it('falls back on timeout but returns 429 for local admission limits', async () => {
    const timeoutProvider = new FakeProvider(() => new LlmError('模拟超时', 'timeout'));
    app = await createApp({ databasePath: ':memory:', provider: timeoutProvider });
    const fallback = await createAndAnalyze(app);
    expect(fallback.statusCode).toBe(201);
    expect(fallback.json().analysis.runMode).toBe('rules_fallback');
    await app.close(); app = null;

    const limitedProvider = new FakeProvider(() => new LlmError('并发已满', 'concurrency'));
    app = await createApp({ databasePath: ':memory:', provider: limitedProvider });
    const limited = await createAndAnalyze(app);
    expect(limited.statusCode).toBe(429);
  });

  it('blocks fabricated percentages and claims that a restricted action already happened', async () => {
    const provider = new FakeProvider((_call, args) => ({
      ...validNarrative(args),
      drafts: {
        ...validNarrative(args).drafts,
        passenger: '草案（未发送）：没有证据的 37.77% 数字、2027-03 日期和 A999 机场，且已经取消航班。',
      },
    }));
    app = await createApp({ databasePath: ':memory:', provider });
    const response = await createAndAnalyze(app);
    expect(response.json().analysis.runMode).toBe('rules_fallback');
    expect(response.json().analysis.fallbackReason).toMatch(/比例|日期|机场|受限动作/);
  });
});
