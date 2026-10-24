import type { FastifyInstance } from 'fastify';
import { feedbackInputSchema, type ConfirmedFieldUpdates, type FeedbackDecision } from '@flightguard/contracts';
import type { RouteContext } from './context.js';
import { ajv, assertValid } from '../services/validation.js';
import { redactEvent } from '../domain/privacy.js';
import { withIdempotency } from './helpers.js';

interface FeedbackInput { decision: FeedbackDecision; reason: string; addedFacts: string[]; reviewerRole: string; confirmedFields?: ConfirmedFieldUpdates }
const validateFeedback = ajv.compile<FeedbackInput>(feedbackInputSchema);

export async function registerFeedbackRoutes(app: FastifyInstance, context: RouteContext) {
  app.post('/api/analyses/:id/feedback', async (request, reply) => {
    const analysisId = (request.params as { id: string }).id;
    if (!context.repository.getAnalysis(analysisId)) return reply.code(404).send({ error: '找不到分析报告' });
    const sanitized = redactEvent(request.body);
    if (sanitized.redacted) return reply.code(400).send({ error: '检测到疑似个人信息，请删除或匿名化后重新提交' });
    const value = sanitized.value;
    assertValid(validateFeedback, value, '反馈');
    if (value.decision !== 'accepted' && !value.reason.trim()) return reply.code(400).send({ error: '修改或拒绝时必须填写原因' });
    const result = await withIdempotency(request, reply, context.repository, `POST:/api/analyses/${analysisId}/feedback`, value, () => ({
      statusCode: 201,
      response: { result: context.repository.addFeedbackWithRevision(analysisId, value), privacyRedacted: sanitized.redacted },
    }));
    return reply.code(result.statusCode).send(result.response);
  });
}
