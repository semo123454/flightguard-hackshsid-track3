import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, modelConfigured, type AppConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { importDataset } from './db/import-data.js';
import { Repository } from './db/repositories.js';
import { OpenAiResponsesProvider } from './llm/providers/openai.js';
import type { LlmProvider } from './llm/provider.js';
import type { WeatherModel } from './weather/contract.js';
import { createWeatherService } from './weather/factory.js';
import { Orchestrator, ServiceError } from './services/orchestrator.js';
import { ValidationError } from './services/validation.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerEventRoutes } from './routes/events.js';
import { registerAnalysisRoutes } from './routes/analyses.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerWeatherRoutes } from './routes/weather.js';

export interface CreateAppOptions {
  config?: AppConfig;
  databasePath?: string;
  logger?: boolean;
  provider?: LlmProvider | null;
  weatherModel?: WeatherModel;
}

export async function createApp(options: CreateAppOptions = {}) {
  const config = options.config || loadConfig(options.databasePath ? { databasePath: options.databasePath } : {});
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 1_000_000, trustProxy: false });
  const db = openDatabase(config.databasePath);
  migrate(db);
  if (!(db.prepare('SELECT 1 FROM airports LIMIT 1').get())) importDataset(db, join(config.projectRoot, 'data', 'dataset.json'));
  const repository = new Repository(db);
  const provider = options.provider !== undefined
    ? options.provider
    : modelConfigured(config)
      ? new OpenAiResponsesProvider(config.llm, repository.getLlmTokenUsageToday(config.llm.maxOutputTokens * 2))
      : null;
  const weatherService = options.weatherModel
    ? { model: options.weatherModel, status: 'configured' as const }
    : createWeatherService(config.weather);
  const weatherModel = weatherService.model;
  const orchestrator = new Orchestrator(repository, config, provider, weatherModel);
  const context = { config, repository, orchestrator, weatherModel, weatherStatus: weatherService.status };

  await registerHealthRoutes(app, context);
  await registerEventRoutes(app, context);
  await registerAnalysisRoutes(app, context);
  await registerFeedbackRoutes(app, context);
  await registerWeatherRoutes(app, context);

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
    return payload;
  });

  const webDist = join(config.projectRoot, 'apps', 'web', 'dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: '接口不存在' });
    if (existsSync(join(webDist, 'index.html'))) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: '前端尚未构建，请运行 npm run build 或使用 npm run dev' });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ValidationError) return reply.code(400).send({ error: error.message, details: error.details });
    if (error instanceof ServiceError) return reply.code(error.statusCode).send({ error: error.message });
    const upstreamStatus = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : null;
    if (upstreamStatus && upstreamStatus >= 400 && upstreamStatus < 500) return reply.code(upstreamStatus).send({ error: error instanceof Error ? error.message : '请求无效' });
    app.log.error(error);
    const detail = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: '服务器处理失败', detail: process.env.NODE_ENV === 'production' ? undefined : detail });
  });

  app.addHook('onClose', async () => db.close());
  return app;
}
