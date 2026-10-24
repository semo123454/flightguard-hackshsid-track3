import { createHash, randomUUID } from 'node:crypto';
import type { AnalysisReport, ConfirmedFieldUpdates, EventInput, EventRecord, FeedbackDecision } from '@flightguard/contracts';
import type { FlightGuardDb } from './connection.js';

interface RevisionRow { event_id: string; revision: number; payload_json: string; created_at: string }
interface AnalysisRow { report_json: string }
interface FeedbackRow { id: string; analysis_id: string; decision: FeedbackDecision; reason: string; added_facts_json: string; confirmed_fields_json: string; reviewer_role: string; created_at: string }

export class Repository {
  constructor(readonly db: FlightGuardDb) {}

  listAirports() {
    return this.db.prepare('SELECT id, name, category, aliases_json FROM airports ORDER BY id').all().map((raw) => {
      const row = raw as { id: string; name: string; category: string; aliases_json: string };
      return { id: row.id, name: row.name, category: row.category, aliases: JSON.parse(row.aliases_json) as string[] };
    });
  }

  hasAirport(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM airports WHERE id = ?').get(id));
  }

  resolveAirport(candidate: string): { id: string; name: string } | null {
    const rows = this.listAirports();
    const normalized = candidate.trim().toLowerCase();
    return rows.find((airport) => airport.id.toLowerCase() === normalized || airport.name.toLowerCase() === normalized || airport.aliases.some((alias) => alias.toLowerCase() === normalized)) || null;
  }

  createEvent(payload: EventInput): EventRecord {
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const run = this.db.transaction(() => {
      this.db.prepare('INSERT INTO events(id, created_at) VALUES (?, ?)').run(id, createdAt);
      this.db.prepare('INSERT INTO event_revisions(event_id, revision, payload_json, created_at) VALUES (?, 1, ?, ?)').run(id, JSON.stringify(payload), createdAt);
    });
    run();
    return { id, revision: 1, createdAt, payload };
  }

  getEvent(eventId: string, revision?: number): EventRecord | null {
    const row = (revision
      ? this.db.prepare('SELECT event_id, revision, payload_json, created_at FROM event_revisions WHERE event_id = ? AND revision = ?').get(eventId, revision)
      : this.db.prepare('SELECT event_id, revision, payload_json, created_at FROM event_revisions WHERE event_id = ? ORDER BY revision DESC LIMIT 1').get(eventId)) as RevisionRow | undefined;
    return row ? { id: row.event_id, revision: row.revision, createdAt: row.created_at, payload: JSON.parse(row.payload_json) as EventInput } : null;
  }

  addRevision(eventId: string, baseRevision: number, payload: EventInput): EventRecord | null {
    const latest = this.getEvent(eventId);
    if (!latest || latest.revision !== baseRevision) return null;
    const createdAt = new Date().toISOString();
    const revision = baseRevision + 1;
    this.db.prepare('INSERT INTO event_revisions(event_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)').run(eventId, revision, JSON.stringify(payload), createdAt);
    return { id: eventId, revision, createdAt, payload };
  }

  saveAnalysis(report: AnalysisReport): AnalysisReport {
    return this.saveAnalysisWithRuns(report, []);
  }

  saveAnalysisWithRuns(report: AnalysisReport, runIds: string[]): AnalysisReport {
    return this.db.transaction(() => {
      this.db.prepare(`INSERT INTO analyses
        (id, event_id, revision, parent_analysis_id, report_json, rule_version, prompt_version, model_version, run_mode, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(report.id, report.eventId, report.revision, report.parentAnalysisId, JSON.stringify(report), report.ruleVersion, report.promptVersion, report.modelVersion, report.runMode, report.createdAt);
      if (runIds.length) {
        const update = this.db.prepare('UPDATE llm_runs SET analysis_id = ? WHERE id = ? AND analysis_id IS NULL');
        runIds.forEach((id) => update.run(report.id, id));
      }
      return report;
    })();
  }

  getAnalysis(id: string): (AnalysisReport & { feedback: ReturnType<Repository['listFeedback']> }) | null {
    const row = this.db.prepare('SELECT report_json FROM analyses WHERE id = ?').get(id) as AnalysisRow | undefined;
    if (!row) return null;
    const report = JSON.parse(row.report_json) as AnalysisReport;
    const feedback = this.listFeedback(id);
    const latest = feedback.at(-1);
    if (latest) report.reviewStatus = latest.decision === 'accepted' ? 'accepted' : latest.decision === 'modified' ? 'modified' : 'rejected';
    return { ...report, feedback };
  }

  listAnalyses(limit = 50): AnalysisReport[] {
    return (this.db.prepare('SELECT report_json FROM analyses ORDER BY created_at DESC LIMIT ?').all(limit) as AnalysisRow[])
      .map((row) => JSON.parse(row.report_json) as AnalysisReport)
      .map((report) => {
        const latest = this.listFeedback(report.id).at(-1);
        if (latest) report.reviewStatus = latest.decision === 'accepted' ? 'accepted' : latest.decision === 'modified' ? 'modified' : 'rejected';
        return report;
      });
  }

  findLatestAnalysis(eventId: string, revision: number): AnalysisReport | null {
    const row = this.db.prepare('SELECT report_json FROM analyses WHERE event_id = ? AND revision = ? ORDER BY created_at DESC LIMIT 1').get(eventId, revision) as AnalysisRow | undefined;
    return row ? JSON.parse(row.report_json) as AnalysisReport : null;
  }

  addFeedback(analysisId: string, input: { decision: FeedbackDecision; reason: string; addedFacts: string[]; reviewerRole: string; confirmedFields?: ConfirmedFieldUpdates }) {
    const record = { id: randomUUID(), analysisId, ...input, createdAt: new Date().toISOString() };
    this.db.prepare(`INSERT INTO feedback(id, analysis_id, decision, reason, added_facts_json, confirmed_fields_json, reviewer_role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, analysisId, input.decision, input.reason, JSON.stringify(input.addedFacts), JSON.stringify(input.confirmedFields ?? {}), input.reviewerRole, record.createdAt);
    return record;
  }

  addFeedbackWithRevision(analysisId: string, input: { decision: FeedbackDecision; reason: string; addedFacts: string[]; reviewerRole: string; confirmedFields?: ConfirmedFieldUpdates }) {
    return this.db.transaction(() => {
      const analysis = this.getAnalysis(analysisId);
      if (!analysis) return null;
      const feedback = this.addFeedback(analysisId, input);
      const confirmedFields = input.confirmedFields ?? {};
      if (!input.addedFacts.length && !Object.keys(confirmedFields).length) return { feedback, revision: null, revisionConflict: false };
      const event = this.getEvent(analysis.eventId, analysis.revision);
      const latest = this.getEvent(analysis.eventId);
      if (!event || !latest || latest.revision !== analysis.revision) return { feedback, revision: null, revisionConflict: true };
      const source = { sourceId: 'HUMAN-CONFIRMED', recordLocator: `feedback/${feedback.id}` };
      const confirmedFieldFacts = Object.entries(confirmedFields).map(([field, value]) => `人工确认：${field}=${value === null ? 'unknown' : String(value)}`);
      const payload: EventInput = {
        ...event.payload,
        ...confirmedFields,
        knownFacts: [...event.payload.knownFacts, ...input.addedFacts.map((fact) => `人工确认：${fact}`), ...confirmedFieldFacts],
        sources: event.payload.sources.some((item) => item.sourceId === source.sourceId && item.recordLocator === source.recordLocator)
          ? event.payload.sources : [...event.payload.sources, source],
      };
      const revision = this.addRevision(analysis.eventId, analysis.revision, payload);
      return { feedback, revision, revisionConflict: false };
    })();
  }

  listFeedback(analysisId: string) {
    return (this.db.prepare('SELECT * FROM feedback WHERE analysis_id = ? ORDER BY created_at').all(analysisId) as FeedbackRow[]).map((row) => ({
      id: row.id,
      analysisId: row.analysis_id,
      decision: row.decision,
      reason: row.reason,
      addedFacts: JSON.parse(row.added_facts_json) as string[],
      confirmedFields: JSON.parse(row.confirmed_fields_json) as ConfirmedFieldUpdates,
      reviewerRole: row.reviewer_role,
      createdAt: row.created_at,
    }));
  }

  saveLlmRun(run: { analysisId?: string | null; requestId?: string | null; purpose: 'extract' | 'report' | 'answer'; mode: string; promptVersion: string; model?: string | null; inputTokens?: number | null; outputTokens?: number | null; durationMs: number; errorCategory?: string | null; cacheHit?: boolean }) {
    const id = randomUUID();
    this.db.prepare(`INSERT INTO llm_runs(id, analysis_id, request_id, purpose, mode, prompt_version, model, input_tokens, output_tokens, duration_ms, error_category, cache_hit, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, run.analysisId ?? null, run.requestId ?? null, run.purpose, run.mode, run.promptVersion, run.model ?? null, run.inputTokens ?? null, run.outputTokens ?? null, run.durationMs, run.errorCategory ?? null, run.cacheHit ? 1 : 0, new Date().toISOString());
    return id;
  }

  getCachedValue(cacheKey: string): { value: unknown; model: string } | null {
    const row = this.db.prepare('SELECT value_json, model FROM llm_cache WHERE cache_key = ? AND expires_at > ?').get(cacheKey, new Date().toISOString()) as { value_json: string; model: string } | undefined;
    return row ? { value: JSON.parse(row.value_json) as unknown, model: row.model } : null;
  }

  saveCachedValue(cacheKey: string, purpose: 'report' | 'answer', value: unknown, model: string) {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`INSERT INTO llm_cache(cache_key, purpose, value_json, model, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json, model = excluded.model, created_at = excluded.created_at, expires_at = excluded.expires_at`)
      .run(cacheKey, purpose, JSON.stringify(value), model, now.toISOString(), expiresAt);
  }

  getLlmTokenUsageToday(conservativeReservation: number): number {
    const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const rows = this.db.prepare(`SELECT input_tokens, output_tokens FROM llm_runs
      WHERE created_at >= ? AND cache_hit = 0`).all(start) as Array<{ input_tokens: number | null; output_tokens: number | null }>;
    return rows.reduce((sum, row) => sum + (row.input_tokens === null ? conservativeReservation : row.input_tokens + (row.output_tokens ?? 0)), 0);
  }

  getLlmUsageSummaryToday() {
    const start = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
    const row = this.db.prepare(`SELECT COUNT(*) AS calls,
      SUM(CASE WHEN cache_hit = 1 THEN 1 ELSE 0 END) AS cache_hits,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(CASE WHEN input_tokens IS NULL OR output_tokens IS NULL THEN 1 ELSE 0 END) AS unknown_usage_runs
      FROM llm_runs WHERE created_at >= ?`).get(start) as { calls: number; cache_hits: number | null; input_tokens: number | null; output_tokens: number | null; unknown_usage_runs: number | null };
    return { calls: row.calls, cacheHits: row.cache_hits ?? 0, inputTokens: row.input_tokens, outputTokens: row.output_tokens, unknownUsageRuns: row.unknown_usage_runs ?? 0 };
  }

  getIdempotent(key: string, route: string, body: unknown) {
    const requestHash = hash(body);
    const row = this.db.prepare('SELECT request_hash, status_code, response_json FROM idempotency_keys WHERE key = ? AND route = ? AND expires_at > ?').get(key, route, new Date().toISOString()) as { request_hash: string; status_code: number; response_json: string } | undefined;
    if (!row) return null;
    if (row.request_hash !== requestHash) return { conflict: true as const };
    return { conflict: false as const, statusCode: row.status_code, response: JSON.parse(row.response_json) as unknown };
  }

  saveIdempotent(key: string, route: string, body: unknown, statusCode: number, response: unknown) {
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`INSERT INTO idempotency_keys(key, route, request_hash, status_code, response_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(key, route) DO NOTHING`)
      .run(key, route, hash(body), statusCode, JSON.stringify(response), expiresAt);
  }
}

export function hash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
