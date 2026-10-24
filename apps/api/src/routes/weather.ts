import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';
import { invalidWeatherEstimate, validateWeatherEstimate } from '../weather/validation.js';
import { validateWeatherInput } from '../weather/contract.js';

export async function registerWeatherRoutes(app: FastifyInstance, context: RouteContext) {
  app.post('/api/weather-release-rate/estimate', async (request, reply) => {
    const checkedInput = validateWeatherInput(request.body);
    if (!checkedInput.ok) return reply.code(400).send({ error: checkedInput.reason });
    try {
      const raw = await context.weatherModel.estimate(checkedInput.value, AbortSignal.timeout(context.config.weather.timeoutMs));
      const checked = validateWeatherEstimate(raw);
      return checked.ok ? checked.value : invalidWeatherEstimate(checked.reason);
    } catch (error) {
      return invalidWeatherEstimate(error instanceof Error ? error.message : '天气模块技术失败');
    }
  });
}
