import type { AnalysisReport, ConfirmedFieldUpdates, EventInput, EventRecord, FeedbackDecision, FeedbackRecord, QuestionAnswer } from '@flightguard/contracts';

export interface Airport { id: string; name: string; category: string; aliases: string[] }
export interface Health {
  ok: boolean;
  database: string;
  model: 'configured' | 'rules_fallback';
  weather: 'configured' | 'not_configured' | 'not_validated';
  usage: { calls: number; cacheHits: number; inputTokens: number | null; outputTokens: number | null; unknownUsageRuns: number; estimatedCost: number | null; currency: string | null };
}
export type AnalysisDetail = AnalysisReport & { feedback?: FeedbackRecord[] };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const body = await response.json().catch(() => ({ error: '响应不是有效 JSON' })) as T & { error?: string; message?: string; details?: unknown };
  if (!response.ok) throw Object.assign(new Error(body.message || body.error || `请求失败（${response.status}）`), { status: response.status, body });
  return body;
}

export const api = {
  health: () => request<Health>('/api/health'),
  airports: () => request<{ airports: Airport[] }>('/api/airports'),
  createEvent: (event: EventInput) => request<{ event: EventRecord; privacyRedacted: boolean }>('/api/events', { method: 'POST', body: JSON.stringify(event), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  extract: (freeText: string) => request<unknown>('/api/events', { method: 'POST', body: JSON.stringify({ freeText }), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  reviseEvent: (id: string, baseRevision: number, event: EventInput) => request<{ event: EventRecord }>(`/api/events/${id}/revisions`, { method: 'POST', body: JSON.stringify({ baseRevision, event }), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  analyze: (eventId: string, revision: number, parentAnalysisId: string | null = null) => request<{ analysis: AnalysisReport }>('/api/analyses', { method: 'POST', body: JSON.stringify({ eventId, revision, parentAnalysisId }), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  analysis: (id: string) => request<{ analysis: AnalysisDetail }>(`/api/analyses/${id}`),
  analyses: () => request<{ analyses: AnalysisReport[] }>('/api/analyses'),
  ask: (id: string, question: string) => request<{ answer: QuestionAnswer & { runMode: AnalysisReport['runMode']; fallbackReason: string | null } }>(`/api/analyses/${id}/questions`, { method: 'POST', body: JSON.stringify({ question }), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  feedback: (id: string, input: { decision: FeedbackDecision; reason: string; addedFacts: string[]; reviewerRole: string; confirmedFields?: ConfirmedFieldUpdates }) => request<{ result: { feedback: unknown; revision: EventRecord | null; revisionConflict: boolean } | null }>(`/api/analyses/${id}/feedback`, { method: 'POST', body: JSON.stringify(input), headers: { 'Idempotency-Key': crypto.randomUUID() } }),
  exportUrl: (id: string) => `/api/analyses/${id}/export`,
};
