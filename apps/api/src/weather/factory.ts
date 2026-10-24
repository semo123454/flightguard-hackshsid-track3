import type { AppConfig } from '../config.js';
import type { WeatherModel } from './contract.js';
import { DisabledWeatherModel } from './disabled.js';
import { JsonWeatherModel } from './json-model.js';
import { CircuitBreakerWeatherModel } from './circuit-breaker.js';

export function createWeatherService(config: AppConfig['weather']): { model: WeatherModel; status: 'configured' | 'not_configured' | 'not_validated' } {
  if (!config.enabled) return { model: new DisabledWeatherModel(), status: 'not_configured' };
  if (!config.modelPath) return { model: new DisabledWeatherModel('not_validated', 'WEATHER_MODEL_ENABLED=true，但未配置 WEATHER_MODEL_PATH'), status: 'not_validated' };
  try {
    const loaded = JsonWeatherModel.load(config.modelPath);
    return { model: new CircuitBreakerWeatherModel(loaded, config.timeoutMs), status: loaded.validated ? 'configured' : 'not_validated' };
  } catch (error) {
    return { model: new DisabledWeatherModel('not_validated', error instanceof Error ? error.message : '天气模型文件无效'), status: 'not_validated' };
  }
}
