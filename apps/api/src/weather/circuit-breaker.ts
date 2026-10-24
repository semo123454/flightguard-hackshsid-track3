import type { WeatherEstimate } from '@flightguard/contracts';
import type { WeatherInput, WeatherModel } from './contract.js';
import { invalidWeatherEstimate, validateWeatherEstimate } from './validation.js';

export class CircuitBreakerWeatherModel implements WeatherModel {
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly inner: WeatherModel, private readonly timeoutMs: number, private readonly now = () => Date.now()) {}

  async estimate(input: WeatherInput, signal: AbortSignal): Promise<WeatherEstimate> {
    if (this.now() < this.openUntil) return failure('error', '天气模块因连续技术失败暂时熔断，稍后自动恢复探测');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
    try {
      const result = await this.inner.estimate(input, bounded);
      const checked = validateWeatherEstimate(result);
      if (!checked.ok) {
        this.recordFailure();
        return invalidWeatherEstimate(checked.reason);
      }
      if (checked.value.status === 'error' || checked.value.status === 'timeout') this.recordFailure();
      else this.consecutiveFailures = 0;
      return checked.value;
    } catch (error) {
      this.recordFailure();
      return failure(bounded.aborted ? 'timeout' : 'error', error instanceof Error ? error.message : '天气模块技术失败');
    }
  }

  private recordFailure() {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) {
      this.openUntil = this.now() + 60_000;
      this.consecutiveFailures = 0;
    }
  }
}

function failure(status: 'timeout' | 'error', reason: string): WeatherEstimate {
  return { status, estimate: null, predictionInterval: null, modelVersion: null, trainingScope: null, validationSummary: null, reason };
}
