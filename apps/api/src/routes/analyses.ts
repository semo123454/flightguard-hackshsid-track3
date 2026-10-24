import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';
import { withIdempotency } from './helpers.js';

export async function registerAnalysisRoutes(app: FastifyInstance, context: RouteContext) {
  app.post('/api/analyses', async (request, reply) => {
    const body = request.body as { eventId?: unknown; revision?: unknown; parentAnalysisId?: unknown };
    if (!body || typeof body !== 'object' || Object.keys(body).some((key) => !['eventId', 'revision', 'parentAnalysisId'].includes(key)) || typeof body.eventId !== 'string' || !Number.isInteger(body.revision) || body.parentAnalysisId !== undefined && body.parentAnalysisId !== null && typeof body.parentAnalysisId !== 'string') {
      return reply.code(400).send({ error: 'eventId、revision 或 parentAnalysisId 格式错误' });
    }
    if (typeof body.parentAnalysisId === 'string') {
      const parent = context.repository.getAnalysis(body.parentAnalysisId);
      if (!parent) return reply.code(404).send({ error: '找不到父报告' });
      if (parent.eventId !== body.eventId || parent.revision > (body.revision as number)) return reply.code(400).send({ error: '父报告必须属于同一事件且版本不能晚于新报告' });
    }
    const result = await withIdempotency(request, reply, context.repository, 'POST:/api/analyses', body, async () => ({
      statusCode: 201,
      response: { analysis: await context.orchestrator.analyze(body.eventId as string, body.revision as number, (body.parentAnalysisId as string | null | undefined) ?? null) },
    }));
    return reply.code(result.statusCode).send(result.response);
  });

  app.get('/api/analyses', async () => ({ analyses: context.repository.listAnalyses() }));

  app.get('/api/analyses/:id', async (request, reply) => {
    const analysis = context.repository.getAnalysis((request.params as { id: string }).id);
    return analysis ? { analysis } : reply.code(404).send({ error: '找不到分析报告' });
  });

  app.post('/api/analyses/:id/questions', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const questionBody = request.body as { question?: unknown };
    if (!questionBody || typeof questionBody !== 'object' || Object.keys(questionBody).some((key) => key !== 'question')) return reply.code(400).send({ error: '追问请求包含未允许字段' });
    const question = questionBody.question;
    if (typeof question !== 'string' || question.length > 5000) return reply.code(400).send({ error: 'question 必须为不超过 5000 字的文本' });
    const result = await withIdempotency(request, reply, context.repository, `POST:/api/analyses/${id}/questions`, request.body, async () => ({ statusCode: 200, response: { answer: await context.orchestrator.answer(id, question) } }));
    return reply.code(result.statusCode).send(result.response);
  });

  app.get('/api/analyses/:id/export', async (request, reply) => {
    const analysis = context.repository.getAnalysis((request.params as { id: string }).id);
    if (!analysis) return reply.code(404).send({ error: '找不到分析报告' });
    const event = context.repository.getEvent(analysis.eventId, analysis.revision);
    if (!event) return reply.code(404).send({ error: '找不到关联事件版本' });
    return {
      '事件编号': event.id,
      '生成时间': analysis.createdAt,
      '风险等级': analysis.risk,
      '适用机场与时间': `${event.payload.airportId} / ${event.payload.eventTimeLabel}`,
      '判断依据': analysis.narrative.explanations,
      '可能影响': analysis.narrative.impact,
      '待核查假设': analysis.narrative.assumptions,
      '信息缺口': analysis.ruleResult.gaps,
      '第一步行动': analysis.ruleResult.actions[0]?.text || '',
      '后续行动': analysis.ruleResult.actions.slice(1).map((action) => action.text),
      '升级条件': analysis.ruleResult.escalationConditions,
      '必须人工决定事项': analysis.ruleResult.humanDecisions,
      '内部运营提示': analysis.narrative.drafts.operations,
      '机场协调信息': analysis.narrative.drafts.airport,
      '旅客信息草案': analysis.narrative.drafts.passenger,
      '引用来源': analysis.evidence.map((item) => item.id),
      '输出状态': `${analysis.runMode} / ${analysis.reviewStatus}`,
    };
  });
}
