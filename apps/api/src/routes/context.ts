import type { AppConfig } from '../config.js';
import type { Repository } from '../db/repositories.js';
import type { Orchestrator } from '../services/orchestrator.js';
import type { WeatherModel } from '../weather/contract.js';

export interface RouteContext {
  config: AppConfig;
  repository: Repository;
  orchestrator: Orchestrator;
  weatherModel: WeatherModel;
  weatherStatus: 'configured' | 'not_configured' | 'not_validated';
}
