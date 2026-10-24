import type { FastifyInstance } from 'fastify';
import { eventInputSchema, type EventInput } from '@flightguard/contracts';
import { redactEvent } from '../domain/privacy.js';
import { ajv, assertValid } from '../services/validation.js';
import type { RouteContext } from './context.js';
import { withIdempotency } from './helpers.js';

const validateEvent = ajv.compile<EventInput>(eventInputSchema);

export async function registerEventRoutes(app: FastifyInstance, context: RouteContext) {
  app.post('/api/events', async (request, reply) => {
    const body = request.body as unknown;
    if (isFreeText(body)) {
      const sanitized = redactEvent(body);
      if (sanitized.redacted) return reply.code(400).send({ error: '检测到疑似个人信息，请删除或匿名化后重新提交' });
      const cleanBody = sanitized.value;
      const result = await withIdempotency(request, reply, context.repository, 'POST:/api/events:extract', cleanBody, async () => {
        const extracted = await context.orchestrator.extractFreeText(cleanBody.freeText);
        const matchedAirport = extracted.airportCandidate.value ? context.repository.resolveAirport(extracted.airportCandidate.value) : null;
        return { statusCode: 422, response: { status: 'needs_clarification', message: '模型提取结果仅为候选字段，请在结构化表单中核对后提交。', extracted, matchedAirport } };
      });
      return reply.code(result.statusCode).send(result.response);
    }
    const sanitized = redactEvent(body);
    if (sanitized.redacted) return reply.code(400).send({ error: '检测到疑似个人信息，请删除或匿名化后重新提交' });
    const value = sanitized.value;
    assertValid(validateEvent, value, '事件');
    if (containsReservedProvenance(value)) return reply.code(400).send({ error: '内部确认来源只能由人工反馈流程生成' });
    if (!context.repository.hasAirport(value.airportId)) return reply.code(400).send({ error: '未知机场' });
    const result = await withIdempotency(request, reply, context.repository, 'POST:/api/events', value, () => ({ statusCode: 201, response: { event: context.repository.createEvent(value), privacyRedacted: sanitized.redacted } }));
    return reply.code(result.statusCode).send(result.response);
  });

  app.get('/api/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const revisionRaw = (request.query as { revision?: string }).revision;
    const event = context.repository.getEvent(id, revisionRaw ? Number(revisionRaw) : undefined);
    return event ? { event } : reply.code(404).send({ error: '找不到事件' });
  });

  app.post('/api/events/:id/revisions', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { baseRevision?: unknown; event?: unknown };
    if (!Number.isInteger(body?.baseRevision)) return reply.code(400).send({ error: 'baseRevision 必须为整数' });
    const sanitized = redactEvent(body.event);
    if (sanitized.redacted) return reply.code(400).send({ error: '检测到疑似个人信息，请删除或匿名化后重新提交' });
    const value = sanitized.value;
    assertValid(validateEvent, value, '事件修订');
    const previous = context.repository.getEvent(id, body.baseRevision as number);
    if (!previous) return reply.code(409).send({ error: '事件版本已变化，请刷新后重试' });
    if (changesReservedProvenance(previous.payload, value)) return reply.code(400).send({ error: '内部确认来源和人工确认事实只能由反馈流程追加' });
    if (!context.repository.hasAirport(value.airportId)) return reply.code(400).send({ error: '未知机场' });
    const result = await withIdempotency(request, reply, context.repository, `POST:/api/events/${id}/revisions`, body, () => {
      const event = context.repository.addRevision(id, body.baseRevision as number, value);
      return event ? { statusCode: 201, response: { event, privacyRedacted: sanitized.redacted } } : { statusCode: 409, response: { error: '事件版本已变化，请刷新后重试' } };
    });
    return reply.code(result.statusCode).send(result.response);
  });
}

function isFreeText(body: unknown): body is { freeText: string } {
  return Boolean(body && typeof body === 'object' && Object.keys(body).length === 1 && typeof (body as { freeText?: unknown }).freeText === 'string');
}

const reservedSourceIds = new Set(['HUMAN-CONFIRMED', 'SYSTEM-CALC', 'RULESET-1.0', 'EVENT-INPUT']);

function containsReservedProvenance(event: EventInput): boolean {
  return event.sources.some((source) => reservedSourceIds.has(source.sourceId)) || event.knownFacts.some((fact) => fact.startsWith('人工确认：'));
}

function changesReservedProvenance(previous: EventInput, next: EventInput): boolean {
  const previousSources = previous.sources.filter((source) => reservedSourceIds.has(source.sourceId)).map((source) => JSON.stringify(source)).sort();
  const nextSources = next.sources.filter((source) => reservedSourceIds.has(source.sourceId)).map((source) => JSON.stringify(source)).sort();
  const previousFacts = previous.knownFacts.filter((fact) => fact.startsWith('人工确认：')).sort();
  const nextFacts = next.knownFacts.filter((fact) => fact.startsWith('人工确认：')).sort();
  return JSON.stringify(previousSources) !== JSON.stringify(nextSources) || JSON.stringify(previousFacts) !== JSON.stringify(nextFacts);
}
