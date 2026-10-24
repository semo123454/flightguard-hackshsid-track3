import type { Metric } from '@flightguard/contracts';

export interface MonthlyMetricRow {
  month: string;
  completionRatio: number | null;
  releaseNormalRatio: number | null;
  sourceId: string;
  recordLocator: string;
}

export interface BaselineResult {
  metric: Metric;
  referenceMonth: string;
  mean: number | null;
  sampleCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  records: MonthlyMetricRow[];
}

export function calculateBaseline(rows: MonthlyMetricRow[], metric: Metric, referenceMonth: string): BaselineResult {
  const valueOf = (row: MonthlyMetricRow) => metric === 'scheduled_completion_ratio' ? row.completionRatio : row.releaseNormalRatio;
  const windowStart = shiftMonth(referenceMonth, -12);
  const records = rows
    .filter((row) => row.month >= windowStart && row.month < referenceMonth && valueOf(row) !== null)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-12);
  const values = records.map(valueOf).filter((value): value is number => value !== null);
  return {
    metric,
    referenceMonth,
    mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    sampleCount: values.length,
    periodStart: records[0]?.month ?? null,
    periodEnd: records.at(-1)?.month ?? null,
    records,
  };
}

export function shiftMonth(month: string, offset: number): string {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new Error(`无效月份：${month}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function comparableDelta(current: { metric: Metric; value: number; period: string; granularity: string } | null, baseline: BaselineResult): number | null {
  if (!current || current.metric !== baseline.metric || current.granularity !== 'month' || current.period !== baseline.referenceMonth || baseline.mean === null) return null;
  return (current.value - baseline.mean) * 100;
}

export function isStrictFivePointAnomaly(deltaPercentagePoints: number | null): boolean {
  return deltaPercentagePoints !== null && deltaPercentagePoints < -5 - 1e-9;
}
