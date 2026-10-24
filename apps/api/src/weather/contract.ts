import type { WeatherEstimate } from '@flightguard/contracts';

export interface WeatherInput {
  airportId: string;
  targetMetric: 'airport_release_normal_ratio';
  periodStart: string;
  periodEnd: string;
  granularity: 'month';
  asOf: string;
  sourcePublishedAt: string | null;
  mode: 'historical' | 'forecast';
  weather: {
    precipitationMm: number | null;
    meanTemperatureC: number | null;
    maxWindSpeedMps: number | null;
    adverseWeatherDays: number | null;
  };
  weatherBasis: string;
  sourceRefs: string[];
}

export interface WeatherModel {
  estimate(input: WeatherInput, signal: AbortSignal): Promise<WeatherEstimate>;
}

export function validateWeatherInput(value: unknown): { ok: true; value: WeatherInput } | { ok: false; reason: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '天气估计输入必须为对象' };
  const input = value as Partial<WeatherInput> & Record<string, unknown>;
  const allowedKeys = new Set(['airportId', 'targetMetric', 'periodStart', 'periodEnd', 'granularity', 'asOf', 'sourcePublishedAt', 'mode', 'weather', 'weatherBasis', 'sourceRefs']);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return { ok: false, reason: '天气估计输入包含未允许字段' };
  if (typeof input.airportId !== 'string' || !input.airportId || input.targetMetric !== 'airport_release_normal_ratio' || input.granularity !== 'month') return { ok: false, reason: '机场、目标指标或时间粒度无效' };
  if (!month(input.periodStart) || !month(input.periodEnd) || input.periodStart > input.periodEnd) return { ok: false, reason: '天气估计期间必须为有效且有序的 YYYY-MM' };
  if (!zonedDateTime(input.asOf)) return { ok: false, reason: 'asOf 必须为带时区的有效时间' };
  if (input.sourcePublishedAt !== null && !zonedDateTime(input.sourcePublishedAt)) return { ok: false, reason: 'sourcePublishedAt 必须为带时区的有效时间或 null' };
  if (input.mode !== 'historical' && input.mode !== 'forecast') return { ok: false, reason: 'mode 仅支持 historical 或 forecast' };
  if (typeof input.weatherBasis !== 'string' || !input.weatherBasis || !Array.isArray(input.sourceRefs) || !input.sourceRefs.every((item) => typeof item === 'string')) return { ok: false, reason: '天气依据或来源引用无效' };
  if (!input.weather || typeof input.weather !== 'object' || Array.isArray(input.weather)) return { ok: false, reason: 'weather 必须为对象' };
  const weather = input.weather as Record<string, unknown>;
  const weatherKeys = ['precipitationMm', 'meanTemperatureC', 'maxWindSpeedMps', 'adverseWeatherDays'];
  if (Object.keys(weather).some((key) => !weatherKeys.includes(key)) || weatherKeys.some((key) => !(key in weather))) return { ok: false, reason: 'weather 字段不完整或包含额外字段' };
  if (weatherKeys.some((key) => weather[key] !== null && (typeof weather[key] !== 'number' || !Number.isFinite(weather[key])))) return { ok: false, reason: '天气特征必须为有限数值或 null' };
  return { ok: true, value: input as WeatherInput };
}

function month(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function zonedDateTime(value: unknown): value is string {
  return typeof value === 'string' && /T/.test(value) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
