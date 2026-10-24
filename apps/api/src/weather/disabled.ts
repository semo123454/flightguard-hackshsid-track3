import type { WeatherEstimate } from '@flightguard/contracts';
import type { WeatherInput, WeatherModel } from './contract.js';

export class DisabledWeatherModel implements WeatherModel {
  constructor(
    private readonly status: WeatherEstimate['status'] = 'not_configured',
    private readonly reason = '尚无通过验证的天气与放行率模型',
  ) {}

  async estimate(_input: WeatherInput, _signal: AbortSignal): Promise<WeatherEstimate> {
    return {
      status: this.status, estimate: null, predictionInterval: null, modelVersion: null,
      trainingScope: null, validationSummary: null, reason: this.reason,
    };
  }
}
