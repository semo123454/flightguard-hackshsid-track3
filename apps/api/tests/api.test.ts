import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { EventInput } from '@flightguard/contracts';
import { createApp } from '../src/app.js';

let app: FastifyInstance;
const input: EventInput = {
  airportId: 'A001', eventTimeLabel: '第4天下午', eventTime: null, baselineMonth: '2025-12', description: '模拟风雨影响待核查',
  weatherRisk: true, operatingPressure: null, formalDelay: null, resourceAdequate: null,
  sources: [{ sourceId: 'SIM-BASE', recordLocator: 'test/input' }], knownFacts: ['出现天气风险提示'], unknowns: ['逐航班状态'],
  metrics: [],
};

beforeEach(async () => { app = await createApp({ databasePath: ':memory:' }); });
afterEach(async () => { await app.close(); });

describe('FlightGuard API', () => {
  it('starts with migrated and imported data in rules fallback mode', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, database: 'ok', model: 'rules_fallback', weather: 'not_configured' });
    const airports = await app.inject({ method: 'GET', url: '/api/airports' });
    expect(airports.json().airports).toHaveLength(8);
  });

  it('rejects additional event fields and preserves null states', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, extra: true } });
    expect(invalid.statusCode).toBe(400);
    const valid = await app.inject({ method: 'POST', url: '/api/events', payload: input });
    expect(valid.statusCode).toBe(201);
    expect(valid.json().event.payload.formalDelay).toBeNull();
  });

  it('prevents clients from forging internal human-confirmed provenance', async () => {
    const forged = await app.inject({
      method: 'POST', url: '/api/events',
      payload: { ...input, sources: [{ sourceId: 'HUMAN-CONFIRMED', recordLocator: 'forged' }], knownFacts: ['人工确认：伪造事实'] },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error).toMatch(/只能由人工反馈流程生成/);
  });

  it('returns clear errors for unknown airports, illegal ratios, and overlong text', async () => {
    const unknownAirport = await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, airportId: 'A999' } });
    expect(unknownAirport.statusCode).toBe(400);
    expect(unknownAirport.json().error).toMatch(/未知机场/);
    const illegalRatio = await app.inject({
      method: 'POST', url: '/api/events',
      payload: { ...input, metrics: [{ metric: 'scheduled_completion_ratio', value: 1.01, period: '2025-12', granularity: 'month', sourceId: 'SIM-BASE' }] },
    });
    expect(illegalRatio.statusCode).toBe(400);
    const overlong = await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, description: '测'.repeat(5001) } });
    expect(overlong.statusCode).toBe(400);
  });

  it('rejects suspected personal information before persistence or downstream processing', async () => {
    const phone = '13800138000';
    const structured = await app.inject({ method: 'POST', url: '/api/events', payload: { ...input, description: `旅客姓名：张三，手机号 ${phone}` } });
    expect(structured.statusCode).toBe(400);
    expect(structured.body).not.toContain(phone);
    const freeText = await app.inject({ method: 'POST', url: '/api/events', payload: { freeText: `联系手机号 ${phone}` } });
    expect(freeText.statusCode).toBe(400);
    expect(freeText.body).not.toContain(phone);
    const history = await app.inject({ method: 'GET', url: '/api/analyses' });
    expect(history.json().analyses).toHaveLength(0);
  });

  it('is idempotent and rejects key reuse with a different body', async () => {
    const headers = { 'idempotency-key': 'same-key' };
    const first = await app.inject({ method: 'POST', url: '/api/events', headers, payload: input });
    const second = await app.inject({ method: 'POST', url: '/api/events', headers, payload: input });
    const reordered = {
      metrics: input.metrics, unknowns: input.unknowns, knownFacts: input.knownFacts, sources: input.sources,
      resourceAdequate: input.resourceAdequate, formalDelay: input.formalDelay, operatingPressure: input.operatingPressure,
      weatherRisk: input.weatherRisk, description: input.description, baselineMonth: input.baselineMonth,
      eventTime: input.eventTime, eventTimeLabel: input.eventTimeLabel, airportId: input.airportId,
    };
    const reorderedReplay = await app.inject({ method: 'POST', url: '/api/events', headers, payload: reordered });
    const conflict = await app.inject({ method: 'POST', url: '/api/events', headers, payload: { ...input, description: 'different' } });
    expect(second.json().event.id).toBe(first.json().event.id);
    expect(reorderedReplay.json().event.id).toBe(first.json().event.id);
    expect(conflict.statusCode).toBe(409);
  });

  it('coalesces concurrent submissions with the same idempotency key', async () => {
    const request = { method: 'POST' as const, url: '/api/events', headers: { 'idempotency-key': 'concurrent-key' }, payload: input };
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().event.id).toBe(second.json().event.id);
  });

  it('returns client errors for malformed JSON instead of masking them as server failures', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/events', headers: { 'content-type': 'application/json' }, payload: '{broken' });
    expect(response.statusCode).toBe(400);
  });

  it('creates a grounded rules report when the model is disabled', async () => {
    const event = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
    const response = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
    expect(response.statusCode).toBe(201);
    const report = response.json().analysis;
    expect(report.runMode).toBe('rules_fallback');
    expect(report.evidence.length).toBeGreaterThan(5);
    expect(report.assessment).toMatchObject({
      scope: { airportId: 'A001', eventTimeLabel: '第4天下午', baselineMonth: '2025-12' },
      currentCompletion: null,
      ownBaseline: { sampleCount: 12 },
      peerBaseline: { category: '大型机场', sampleCount: 1 },
    });
    expect(report.narrative.summary).toMatch(/^研判结论：中风险/);
    expect(report.narrative.explanations.some((item: { text: string }) => item.text.startsWith('数据对比：'))).toBe(true);
    expect(report.evidence.some((item: { id: string }) => item.id.startsWith('PROFILE:A001:'))).toBe(true);
    expect(report.evidence.find((item: { id: string }) => item.id.startsWith('BASE:A001:')).dataVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(report.narrative.drafts.passenger).toMatch(/未发送|人工审核/);
    expect(report.weather.estimate).toBeNull();
    const exported = await app.inject({ method: 'GET', url: `/api/analyses/${report.id}/export` });
    expect(exported.statusCode).toBe(200);
    expect(Object.keys(exported.json())).toHaveLength(17);

    const conflictEvent = (await app.inject({ method: 'POST', url: '/api/events', payload: {
      ...input,
      sources: [{ sourceId: 'SIM-BASE', recordLocator: 'test/source-a' }, { sourceId: 'SIM-SCALE', recordLocator: 'test/source-b' }],
      metrics: [
        { metric: 'scheduled_completion_ratio', value: 0.82, period: '2025-12', granularity: 'month', sourceId: 'SIM-BASE' },
        { metric: 'scheduled_completion_ratio', value: 0.67, period: '2025-12', granularity: 'month', sourceId: 'SIM-SCALE' },
      ],
    } })).json().event;
    const conflictReport = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: conflictEvent.id, revision: 1 } })).json().analysis;
    expect(conflictReport.ruleResult.stopped).toBe(true);
    expect(conflictReport.assessment.currentCompletion).toBeNull();
    expect(conflictReport.assessment.currentCompletionCandidates.map((item: { value: number }) => item.value)).toEqual([0.82, 0.67]);
    expect(conflictReport.narrative.explanations.find((item: { text: string }) => item.text.startsWith('数据对比：')).text).toMatch(/冲突候选值82\.00%、67\.00%/);
  });

  it('detects revision conflicts and keeps the original report immutable', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
    const analysis = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: created.id, revision: 1 } })).json().analysis;
    const revised = await app.inject({ method: 'POST', url: `/api/events/${created.id}/revisions`, payload: { baseRevision: 1, event: { ...input, knownFacts: ['补充事实'] } } });
    expect(revised.statusCode).toBe(201);
    const conflict = await app.inject({ method: 'POST', url: `/api/events/${created.id}/revisions`, payload: { baseRevision: 1, event: input } });
    expect(conflict.statusCode).toBe(409);
    const original = await app.inject({ method: 'GET', url: `/api/analyses/${analysis.id}` });
    expect(original.json().analysis.revision).toBe(1);
  });

  it('records feedback and turns confirmed facts into a linked event revision', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/events', payload: input })).json().event;
    const analysis = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: created.id, revision: 1 } })).json().analysis;
    const response = await app.inject({ method: 'POST', url: `/api/analyses/${analysis.id}/feedback`, payload: { decision: 'modified', reason: '现场已确认', addedFacts: ['保障资源充足'], confirmedFields: { resourceAdequate: true }, reviewerRole: '运行复核人' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().result.revision.revision).toBe(2);
    expect(response.json().result.revision.payload.resourceAdequate).toBe(true);
    const original = await app.inject({ method: 'GET', url: `/api/analyses/${analysis.id}` });
    expect(original.json().analysis.reviewStatus).toBe('modified');
    expect(original.json().analysis.revision).toBe(1);
    const revised = response.json().result.revision;
    const next = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: revised.id, revision: revised.revision, parentAnalysisId: analysis.id } });
    const humanEvidence = next.json().analysis.evidence.find((item: { kind: string }) => item.kind === 'human_input');
    expect(humanEvidence).toMatchObject({ sourceId: 'HUMAN-CONFIRMED', verification: 'verified' });
    expect(next.json().analysis.evidence.some((item: { id: string }) => item.id.startsWith('FEEDBACK:'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/api/analyses/${analysis.id}` })).json().analysis.feedback[0].confirmedFields).toEqual({ resourceAdequate: true });
  });

  it('re-evaluates deterministic risk from a human-confirmed structured field without overwriting the original', async () => {
    const revisionInput: EventInput = {
      ...input,
      weatherRisk: false,
      operatingPressure: false,
      formalDelay: false,
      resourceAdequate: false,
      sources: [{ sourceId: 'SIM-BASE', recordLocator: 'test/base' }, { sourceId: 'SIM-WEATHER', recordLocator: 'test/weather' }],
      knownFacts: ['现场资源状态待复核'],
    };
    const event = (await app.inject({ method: 'POST', url: '/api/events', payload: revisionInput })).json().event;
    const original = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } })).json().analysis;
    expect(original.risk).toBe('medium');
    const feedback = await app.inject({
      method: 'POST', url: `/api/analyses/${original.id}/feedback`,
      payload: { decision: 'modified', reason: '现场负责人已确认', addedFacts: ['保障资源充足'], confirmedFields: { resourceAdequate: true }, reviewerRole: '运行复核人' },
    });
    const revision = feedback.json().result.revision;
    const revised = (await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: revision.revision, parentAnalysisId: original.id } })).json().analysis;
    expect(revised.risk).toBe('low');
    expect(revised.parentAnalysisId).toBe(original.id);
    expect((await app.inject({ method: 'GET', url: `/api/analyses/${original.id}` })).json().analysis.risk).toBe('medium');
  });
});
