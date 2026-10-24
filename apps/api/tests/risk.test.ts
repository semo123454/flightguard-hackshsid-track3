import { describe, expect, it } from 'vitest';
import type { EventInput } from '@flightguard/contracts';
import { calculateBaseline, comparableDelta, isStrictFivePointAnomaly } from '../src/domain/baseline.js';
import { evaluateRules } from '../src/domain/risk.js';

const event: EventInput = {
  airportId: 'A001', eventTimeLabel: '第4天下午', eventTime: null, baselineMonth: '2025-12', description: '测试事件',
  weatherRisk: null, operatingPressure: null, formalDelay: null, resourceAdequate: null,
  sources: [{ sourceId: 'SIM-BASE', recordLocator: 'test' }], knownFacts: [], unknowns: [], metrics: [],
};

describe('baseline and deterministic risk', () => {
  it('excludes the reference month and keeps only the previous 12 calendar months', () => {
    const rows = Array.from({ length: 14 }, (_, index) => {
      const date = new Date(Date.UTC(2025, index, 1));
      return {
        month: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`,
        completionRatio: 0.9, releaseNormalRatio: 0.92, sourceId: 'SIM', recordLocator: String(index),
      };
    });
    const result = calculateBaseline(rows, 'scheduled_completion_ratio', '2026-02');
    expect(result.sampleCount).toBe(12);
    expect(result.periodStart).toBe('2025-02');
    expect(result.periodEnd).toBe('2026-01');
  });

  it('reports missing months instead of filling the window with older records', () => {
    const months = ['2024-11', '2024-12', '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11'];
    const rows = months.map((month) => ({ month, completionRatio: 0.9, releaseNormalRatio: 0.92, sourceId: 'SIM', recordLocator: month }));
    const result = calculateBaseline(rows, 'scheduled_completion_ratio', '2025-12');
    expect(result.sampleCount).toBe(11);
    expect(result.periodStart).toBe('2024-12');
    expect(result.records.some((row) => row.month === '2024-11')).toBe(false);
  });

  it('treats exactly -5pp as not crossing the strict boundary', () => {
    expect(isStrictFivePointAnomaly(-5)).toBe(false);
    expect(isStrictFivePointAnomaly(-5.01)).toBe(true);
  });

  it('does not compare an intraday value with a monthly baseline', () => {
    const baseline = calculateBaseline([{ month: '2025-11', completionRatio: 0.9, releaseNormalRatio: 0.9, sourceId: 'S', recordLocator: '1' }], 'scheduled_completion_ratio', '2025-12');
    expect(comparableDelta({ metric: 'scheduled_completion_ratio', value: 0.5, period: '第4天下午', granularity: 'intra_day' }, baseline)).toBeNull();
    expect(comparableDelta({ metric: 'scheduled_completion_ratio', value: 0.5, period: '2025-11', granularity: 'month' }, baseline)).toBeNull();
  });

  it('keeps unknown values as gaps rather than no-risk evidence', () => {
    const result = evaluateRules({ event, deltaPercentagePoints: null, verifiedSourceIds: ['SIM-BASE'], sourceConflict: false, unreliableSources: false, factEvidenceIds: ['E1'], ruleEvidenceIds: {} });
    expect(result.risk).toBe('undetermined');
    expect(result.gaps).toContain('当前天气风险尚未确认');
  });

  it('requires two verified sources for high risk and stops on conflict', () => {
    const risky = { ...event, weatherRisk: true, operatingPressure: true };
    expect(evaluateRules({ event: risky, deltaPercentagePoints: null, verifiedSourceIds: ['S1'], sourceConflict: false, unreliableSources: false, factEvidenceIds: [], ruleEvidenceIds: {} }).risk).toBe('medium');
    expect(evaluateRules({ event: risky, deltaPercentagePoints: null, verifiedSourceIds: ['S1', 'S2'], sourceConflict: false, unreliableSources: false, factEvidenceIds: [], ruleEvidenceIds: {} }).risk).toBe('high');
    expect(evaluateRules({ event: risky, deltaPercentagePoints: null, verifiedSourceIds: ['S1', 'S2'], sourceConflict: true, unreliableSources: false, factEvidenceIds: [], ruleEvidenceIds: {} }).risk).toBe('undetermined');
  });
});
