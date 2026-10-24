import type { FastifyInstance } from 'fastify';
import { modelConfigured } from '../config.js';
import type { RouteContext } from './context.js';

export async function registerHealthRoutes(app: FastifyInstance, context: RouteContext) {
  app.get('/api/health', async () => {
    context.repository.db.prepare('SELECT 1').get();
    const usage = context.repository.getLlmUsageSummaryToday();
    const prices = context.config.llm;
    const estimatedCost = usage.unknownUsageRuns === 0 && prices.inputPricePerMillion !== null && prices.outputPricePerMillion !== null && usage.inputTokens !== null && usage.outputTokens !== null
      ? usage.inputTokens / 1_000_000 * prices.inputPricePerMillion + usage.outputTokens / 1_000_000 * prices.outputPricePerMillion
      : null;
    return {
      ok: true,
      service: '航策 FlightGuard',
      database: 'ok',
      model: modelConfigured(context.config) ? 'configured' : 'rules_fallback',
      weather: context.weatherStatus,
      usage: { ...usage, estimatedCost, currency: estimatedCost === null ? null : prices.priceCurrency },
    };
  });

  app.get('/api/airports', async () => ({ airports: context.repository.listAirports() }));
}
