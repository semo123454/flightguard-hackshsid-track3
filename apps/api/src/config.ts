import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  projectRoot: string;
  llm: {
    enabled: boolean;
    provider: 'openai' | 'deepseek';
    baseUrl: string;
    model: string | null;
    apiKey: string | null;
    reasoningEffort: 'none' | 'low' | 'high' | 'max' | null;
    timeoutMs: number;
    reportDeadlineMs: number;
    maxConcurrency: number;
    maxOutputTokens: number;
    dailyTokenLimit: number;
    cacheEnabled: boolean;
    inputPricePerMillion: number | null;
    outputPricePerMillion: number | null;
    priceCurrency: string;
  };
  weather: {
    enabled: boolean;
    modelPath: string | null;
    timeoutMs: number;
  };
}

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

function integer(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} 必须是不小于 ${minimum} 的整数`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} 必须为 true 或 false`);
}

function optionalPrice(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} 必须为非负数`);
  return value;
}

function optionalReasoningEffort(name: string, fallback: AppConfig['llm']['reasoningEffort']): AppConfig['llm']['reasoningEffort'] {
  const raw = process.env[name];
  if (!raw) return fallback;
  if (raw === 'none' || raw === 'low' || raw === 'high' || raw === 'max') return raw;
  throw new Error(`${name} 必须为 none、low、high 或 max`);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rawDatabasePath = process.env.DATABASE_PATH || './runtime/flightguard.sqlite';
  const llmEnabled = boolean('LLM_ENABLED', true);
  const llmProvider = process.env.LLM_PROVIDER || 'openai';
  if (llmProvider !== 'openai' && llmProvider !== 'deepseek') throw new Error('LLM_PROVIDER 当前仅支持 openai 或 deepseek');
  const defaultBaseUrl = llmProvider === 'deepseek' ? 'https://api.deepseek.com' : 'https://api.openai.com/v1';
  const providerApiKey = llmProvider === 'deepseek'
    ? process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY
    : process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  const config: AppConfig = {
    host: process.env.HOST || '127.0.0.1',
    port: integer('PORT', 4173, 1),
    databasePath: resolve(projectRoot, rawDatabasePath),
    projectRoot,
    llm: {
      enabled: llmEnabled,
      provider: llmProvider,
      baseUrl: (process.env.LLM_BASE_URL || defaultBaseUrl).replace(/\/$/, ''),
      model: process.env.LLM_MODEL || null,
      apiKey: providerApiKey || null,
      reasoningEffort: optionalReasoningEffort('LLM_REASONING_EFFORT', llmProvider === 'deepseek' ? 'none' : null),
      timeoutMs: integer('LLM_TIMEOUT_MS', 20_000, 100),
      reportDeadlineMs: integer('LLM_REPORT_DEADLINE_MS', 45_000, 1000),
      maxConcurrency: integer('LLM_MAX_CONCURRENCY', 2, 1),
      maxOutputTokens: integer('LLM_MAX_OUTPUT_TOKENS', 2000, 128),
      dailyTokenLimit: integer('LLM_DAILY_TOKEN_LIMIT', 200_000, 1000),
      cacheEnabled: boolean('LLM_CACHE_ENABLED', true),
      inputPricePerMillion: optionalPrice('LLM_INPUT_PRICE_PER_MILLION'),
      outputPricePerMillion: optionalPrice('LLM_OUTPUT_PRICE_PER_MILLION'),
      priceCurrency: process.env.LLM_PRICE_CURRENCY || 'CNY',
    },
    weather: {
      enabled: boolean('WEATHER_MODEL_ENABLED', false),
      modelPath: process.env.WEATHER_MODEL_PATH ? resolve(projectRoot, process.env.WEATHER_MODEL_PATH) : null,
      timeoutMs: integer('WEATHER_TIMEOUT_MS', 1000, 50),
    },
  };
  return { ...config, ...overrides };
}

export function modelConfigured(config: AppConfig): boolean {
  return config.llm.enabled && Boolean(config.llm.apiKey && config.llm.model);
}
