import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WeatherEstimate } from '@flightguard/contracts';
import type { WeatherInput, WeatherModel } from '../src/weather/contract.js';
import { JsonWeatherModel } from '../src/weather/json-model.js';
import { CircuitBreakerWeatherModel } from '../src/weather/circuit-breaker.js';
import { createApp } from '../src/app.js';
import type { EventInput } from '@flightguard/contracts';

const directories: string[] = [];
afterEach(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });

const input: WeatherInput = {
  airportId: 'A001', targetMetric: 'airport_release_normal_ratio', periodStart: '2025-12', periodEnd: '2025-12',
  granularity: 'month', asOf: '2025-11-30T00:00:00+08:00', mode: 'historical',
  sourcePublishedAt: '2025-11-01T00:00:00+08:00',
  weather: { precipitationMm: 10, meanTemperatureC: 20, maxWindSpeedMps: 5, adverseWeatherDays: 2 },
  weatherBasis: 'fixture', sourceRefs: ['SIM-WEATHER'],
};

function modelFile(validated = true) {
  const directory = mkdtempSync(join(tmpdir(), 'flightguard-weather-'));
  directories.push(directory);
  const path = join(directory, 'model.json');
  writeFileSync(path, JSON.stringify({
    modelVersion: 'fixture-1', targetMetric: 'airport_release_normal_ratio', validated,
    trainingScope: 'fixture 2024-2025', validationSummary: 'fixture only', trainingDataChecksum: 'abc123',
    featureOrder: ['precipitationMm', 'meanTemperatureC', 'maxWindSpeedMps', 'adverseWeatherDays'],
    means: [0, 0, 0, 0], scales: [1, 1, 1, 1], coefficients: [0.01, 0.01, 0.01, 0.01], intercept: -1,
    link: 'logit', validRanges: { precipitationMm: [0, 100], meanTemperatureC: [-30, 50], maxWindSpeedMps: [0, 30], adverseWeatherDays: [0, 31] },
    airportIds: ['A001'],
  }));
  return path;
}

describe('optional weather model boundary', () => {
  it('loads an explicitly validated JSON model and returns a bounded estimate', async () => {
    const model = JsonWeatherModel.load(modelFile());
    const result = await model.estimate(input, new AbortController().signal);
    expect(result.status).toBe('ok');
    expect(result.estimate).toBeGreaterThan(0);
    expect(result.estimate).toBeLessThan(1);
    expect(result.predictionInterval).toBeNull();
  });

  it('does not fill missing weather with zero or enable an unvalidated model', async () => {
    const validated = JsonWeatherModel.load(modelFile());
    const missing = await validated.estimate({ ...input, weather: { ...input.weather, maxWindSpeedMps: null } }, new AbortController().signal);
    expect(missing).toMatchObject({ status: 'insufficient_data', estimate: null });
    const unvalidated = await JsonWeatherModel.load(modelFile(false)).estimate(input, new AbortController().signal);
    expect(unvalidated).toMatchObject({ status: 'not_validated', estimate: null });
  });

  it('rejects weather information published after the analysis cutoff', async () => {
    const model = JsonWeatherModel.load(modelFile());
    const result = await model.estimate({ ...input, sourcePublishedAt: '2025-12-01T00:00:00+08:00' }, new AbortController().signal);
    expect(result).toMatchObject({ status: 'out_of_scope', estimate: null });
    expect(result.reason).toMatch(/未来信息泄漏/);
  });

  it('opens for 60 seconds after three technical failures', async () => {
    let calls = 0;
    const failing: WeatherModel = { estimate: async () => { calls++; return failure(); } };
    let now = 1_000;
    const breaker = new CircuitBreakerWeatherModel(failing, 1000, () => now);
    await breaker.estimate(input, new AbortController().signal);
    await breaker.estimate(input, new AbortController().signal);
    await breaker.estimate(input, new AbortController().signal);
    const open = await breaker.estimate(input, new AbortController().signal);
    expect(calls).toBe(3);
    expect(open.reason).toMatch(/熔断/);
    now += 60_001;
    await breaker.estimate(input, new AbortController().signal);
    expect(calls).toBe(4);
  });

  it('adds a validated estimate as evidence and stops suggestion context on a verified same-metric conflict', async () => {
    const weatherModel: WeatherModel = { estimate: async () => ({
      status: 'ok', estimate: 0.7, predictionInterval: null, modelVersion: 'fixture-weather-1',
      trainingScope: 'fixture', validationSummary: 'fixture passed', reason: 'fixture estimate',
    }) };
    const app = await createApp({ databasePath: ':memory:', weatherModel });
    try {
      const eventInput: EventInput = {
        airportId: 'A001', eventTimeLabel: '第4天下午', eventTime: null, baselineMonth: '2025-12', description: '模拟同口径冲突',
        weatherRisk: null, operatingPressure: null, formalDelay: null, resourceAdequate: null,
        sources: [{ sourceId: 'SIM-BASE', recordLocator: 'fixture/current-release' }], knownFacts: [], unknowns: ['正式状态'],
        metrics: [{ metric: 'airport_release_normal_ratio', value: 0.9, period: '2025-12', granularity: 'month', sourceId: 'SIM-BASE' }],
      };
      const event = (await app.inject({ method: 'POST', url: '/api/events', payload: eventInput })).json().event;
      const response = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
      const report = response.json().analysis;
      expect(report.ruleResult.stopped).toBe(true);
      expect(report.weather.reason).toMatch(/相差超过 5 个百分点/);
      expect(report.evidence.find((item: { kind: string }) => item.kind === 'estimate')).toMatchObject({ verification: 'conflicting', sourceId: 'SIM-WEATHER' });
    } finally {
      await app.close();
    }
  });

  it('turns a contract-violating weather response into a null technical error without breaking the report', async () => {
    const invalidModel: WeatherModel = { estimate: async () => ({
      status: 'not_configured', estimate: 0.42, predictionInterval: null, modelVersion: null,
      trainingScope: null, validationSummary: null, reason: 'invalid fixture',
    }) };
    const app = await createApp({ databasePath: ':memory:', weatherModel: invalidModel });
    try {
      const eventInput: EventInput = {
        airportId: 'A001', eventTimeLabel: '第4天下午', eventTime: null, baselineMonth: '2025-12', description: '模拟天气输出契约错误',
        weatherRisk: true, operatingPressure: null, formalDelay: null, resourceAdequate: null,
        sources: [{ sourceId: 'SIM-WEATHER', recordLocator: 'fixture/weather' }], knownFacts: ['模拟天气提示'], unknowns: ['正式状态'], metrics: [],
      };
      const event = (await app.inject({ method: 'POST', url: '/api/events', payload: eventInput })).json().event;
      const response = await app.inject({ method: 'POST', url: '/api/analyses', payload: { eventId: event.id, revision: 1 } });
      expect(response.statusCode).toBe(201);
      expect(response.json().analysis.weather).toMatchObject({ status: 'error', estimate: null });
    } finally {
      await app.close();
    }
  });

  it('strictly validates the public weather endpoint and preserves the disabled response', async () => {
    const app = await createApp({ databasePath: ':memory:' });
    try {
      const valid = await app.inject({ method: 'POST', url: '/api/weather-release-rate/estimate', payload: input });
      expect(valid.statusCode).toBe(200);
      expect(valid.json()).toMatchObject({ status: 'not_configured', estimate: null });
      const extra = await app.inject({ method: 'POST', url: '/api/weather-release-rate/estimate', payload: { ...input, unexpected: true } });
      expect(extra.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

function failure(): WeatherEstimate {
  return { status: 'error', estimate: null, predictionInterval: null, modelVersion: null, trainingScope: null, validationSummary: null, reason: 'fixture failure' };
}
