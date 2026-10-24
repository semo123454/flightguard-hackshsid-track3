import { readFileSync } from 'node:fs';
import type { WeatherEstimate } from '@flightguard/contracts';
import type { WeatherInput, WeatherModel } from './contract.js';

type FeatureName = 'precipitationMm' | 'meanTemperatureC' | 'maxWindSpeedMps' | 'adverseWeatherDays';

interface ExportedWeatherModel {
  modelVersion: string;
  targetMetric: 'airport_release_normal_ratio';
  validated: boolean;
  trainingScope: string;
  validationSummary: string;
  trainingDataChecksum: string;
  featureOrder: FeatureName[];
  means: number[];
  scales: number[];
  coefficients: number[];
  intercept: number;
  link: 'identity' | 'logit';
  validRanges: Partial<Record<FeatureName, [number, number]>>;
  airportIds: string[] | null;
}

export class JsonWeatherModel implements WeatherModel {
  private constructor(private readonly model: ExportedWeatherModel) {}

  get validated() { return this.model.validated; }

  static load(path: string): JsonWeatherModel {
    const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    assertModel(value);
    return new JsonWeatherModel(value);
  }

  async estimate(input: WeatherInput, _signal: AbortSignal): Promise<WeatherEstimate> {
    if (!this.model.validated) return unavailable('not_validated', '模型文件尚未标记为通过独立验证', this.model);
    if (input.targetMetric !== this.model.targetMetric || input.granularity !== 'month') return unavailable('out_of_scope', '目标指标或时间粒度超出模型范围', this.model);
    if (this.model.airportIds && !this.model.airportIds.includes(input.airportId)) return unavailable('out_of_scope', '机场不在模型已验证范围内', this.model);
    if (input.sourcePublishedAt && Date.parse(input.sourcePublishedAt) > Date.parse(input.asOf)) return unavailable('out_of_scope', '天气来源发布时间晚于分析时点，已阻止未来信息泄漏', this.model);
    const features = this.model.featureOrder.map((name) => input.weather[name]);
    if (features.some((value) => value === null)) return unavailable('insufficient_data', '天气特征存在缺失值，未使用 0 填补', this.model);
    const completeFeatures = features as number[];
    for (let index = 0; index < this.model.featureOrder.length; index++) {
      const name = this.model.featureOrder[index]!;
      const value = completeFeatures[index]!;
      const range = this.model.validRanges[name];
      if (range && (value! < range[0] || value! > range[1])) return unavailable('out_of_scope', `${name} 超出模型验证范围`, this.model);
    }
    const linear = completeFeatures.reduce<number>((sum, raw, index) => sum + ((raw - this.model.means[index]!) / this.model.scales[index]!) * this.model.coefficients[index]!, this.model.intercept);
    const estimate = this.model.link === 'logit' ? 1 / (1 + Math.exp(-linear)) : Math.min(1, Math.max(0, linear));
    return {
      status: 'ok', estimate, predictionInterval: null, modelVersion: this.model.modelVersion,
      trainingScope: this.model.trainingScope, validationSummary: this.model.validationSummary,
      reason: '已按验证模型计算；估计仅作为独立证据，不覆盖规则风险',
    };
  }
}

function assertModel(value: unknown): asserts value is ExportedWeatherModel {
  if (!value || typeof value !== 'object') throw new Error('天气模型文件必须为 JSON 对象');
  const model = value as Partial<ExportedWeatherModel>;
  const allowed = new Set<FeatureName>(['precipitationMm', 'meanTemperatureC', 'maxWindSpeedMps', 'adverseWeatherDays']);
  if (typeof model.modelVersion !== 'string' || model.targetMetric !== 'airport_release_normal_ratio' || typeof model.validated !== 'boolean') throw new Error('天气模型元数据无效');
  if (!Array.isArray(model.featureOrder) || !model.featureOrder.length || !model.featureOrder.every((item) => allowed.has(item))) throw new Error('天气模型特征顺序无效');
  for (const vector of [model.means, model.scales, model.coefficients]) if (!Array.isArray(vector) || vector.length !== model.featureOrder.length || !vector.every(Number.isFinite)) throw new Error('天气模型向量维度或数值无效');
  if (model.scales!.some((value) => value <= 0) || !Number.isFinite(model.intercept) || !['identity', 'logit'].includes(model.link || '')) throw new Error('天气模型缩放或链接函数无效');
  if (typeof model.trainingScope !== 'string' || typeof model.validationSummary !== 'string' || typeof model.trainingDataChecksum !== 'string') throw new Error('天气模型卡信息不完整');
  if (model.airportIds !== null && (!Array.isArray(model.airportIds) || !model.airportIds.every((item) => typeof item === 'string'))) throw new Error('天气模型机场范围无效');
  if (!model.validRanges || typeof model.validRanges !== 'object') throw new Error('天气模型有效范围缺失');
}

function unavailable(status: WeatherEstimate['status'], reason: string, model: ExportedWeatherModel): WeatherEstimate {
  return { status, estimate: null, predictionInterval: null, modelVersion: model.modelVersion, trainingScope: model.trainingScope, validationSummary: model.validationSummary, reason };
}
