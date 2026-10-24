import AjvModule from 'ajv';
import { weatherEstimateSchema, type WeatherEstimate } from '@flightguard/contracts';

const validateSchema = new AjvModule.default({ strict: true, allErrors: true }).compile<WeatherEstimate>(weatherEstimateSchema);

export function validateWeatherEstimate(value: unknown): { ok: true; value: WeatherEstimate } | { ok: false; reason: string } {
  if (!validateSchema(value)) {
    const reason = (validateSchema.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || '校验失败'}`).join('；');
    return { ok: false, reason: `天气模块输出不符合 Schema：${reason}` };
  }
  const estimate = value as WeatherEstimate;
  if (estimate.status === 'ok' && estimate.estimate === null) return { ok: false, reason: '天气模块 status=ok 时 estimate 不能为空' };
  if (estimate.status !== 'ok' && estimate.estimate !== null) return { ok: false, reason: '天气模块非 ok 状态不得返回估计值' };
  if (estimate.predictionInterval && estimate.predictionInterval[0] > estimate.predictionInterval[1]) return { ok: false, reason: '天气模块预测区间下界大于上界' };
  if (estimate.estimate !== null && estimate.predictionInterval && (estimate.estimate < estimate.predictionInterval[0] || estimate.estimate > estimate.predictionInterval[1])) {
    return { ok: false, reason: '天气模块估计值不在预测区间内' };
  }
  return { ok: true, value: estimate };
}

export function invalidWeatherEstimate(reason: string, status: 'error' | 'timeout' = 'error'): WeatherEstimate {
  return { status, estimate: null, predictionInterval: null, modelVersion: null, trainingScope: null, validationSummary: null, reason };
}
