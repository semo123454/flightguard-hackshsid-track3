import type { Evidence, EventRecord, Metric } from '@flightguard/contracts';
import type { Repository } from '../db/repositories.js';
import { calculateBaseline, comparableDelta, shiftMonth, type BaselineResult, type MonthlyMetricRow } from '../domain/baseline.js';

interface SourceRow { id: string; title: string; published_at: string | null; coverage: string | null; verification: Evidence['verification']; simulated: number }
interface RuleRow { id: string; version: string; description: string; action_text: string; human_approval_required: number; metadata_json: string }

export interface EvidencePackage {
  evidence: Evidence[];
  baseline: BaselineResult;
  releaseBaseline: BaselineResult;
  deltaPercentagePoints: number | null;
  verifiedSourceIds: string[];
  peerBaseline: PeerBaseline;
  sourceConflict: boolean;
  unreliableSources: boolean;
  ruleEvidenceIds: Record<string, string>;
}

export interface PeerBaseline {
  category: string | null;
  mean: number | null;
  sampleCount: number;
  period: string;
  evidenceId: string | null;
}

export function getAirportProfile(repository: Repository, airportId: string, asOf: string) {
  const airport = repository.db.prepare('SELECT id, name, category FROM airports WHERE id = ?').get(airportId) as { id: string; name: string; category: string } | undefined;
  if (!airport) return null;
  const year = Number(asOf.slice(0, 4));
  const annual = repository.db.prepare('SELECT * FROM airport_annual WHERE airport_id = ? AND year <= ? ORDER BY year DESC LIMIT 1').get(airportId, year) as Record<string, unknown> | undefined;
  return { ...airport, annual: annual ?? null };
}

export function getBaseline(repository: Repository, airportId: string, metric: Metric, referenceMonth: string): BaselineResult {
  const windowStart = shiftMonth(referenceMonth, -12);
  const rows = repository.db.prepare(`SELECT month, completion_ratio, release_normal_ratio, source_id, record_locator
    FROM airport_monthly WHERE airport_id = ? AND month >= ? AND month < ? ORDER BY month`).all(airportId, windowStart, referenceMonth) as Array<{
      month: string; completion_ratio: number | null; release_normal_ratio: number | null; source_id: string; record_locator: string;
    }>;
  const normalized: MonthlyMetricRow[] = rows.map((row) => ({
    month: row.month,
    completionRatio: row.completion_ratio,
    releaseNormalRatio: row.release_normal_ratio,
    sourceId: row.source_id,
    recordLocator: row.record_locator,
  }));
  return calculateBaseline(normalized, metric, referenceMonth);
}

export function getWeatherHistory(repository: Repository, airportId: string, startMonth: string, endMonth: string) {
  return repository.db.prepare(`SELECT * FROM weather_monthly WHERE airport_id = ? AND month BETWEEN ? AND ? ORDER BY month`)
    .all(airportId, startMonth, endMonth) as Array<Record<string, unknown>>;
}

export function getPeerBaseline(repository: Repository, airportId: string, referenceMonth: string): PeerBaseline {
  const airport = repository.db.prepare('SELECT category FROM airports WHERE id = ?').get(airportId) as { category: string } | undefined;
  if (!airport) return { category: null, mean: null, sampleCount: 0, period: referenceMonth, evidenceId: null };
  const row = repository.db.prepare(`SELECT AVG(monthly.completion_ratio) AS mean, COUNT(*) AS sample_count
    FROM airport_monthly monthly
    JOIN airports peer ON peer.id = monthly.airport_id
    WHERE peer.category = ? AND monthly.airport_id <> ? AND monthly.month = ? AND monthly.completion_ratio IS NOT NULL`)
    .get(airport.category, airportId, referenceMonth) as { mean: number | null; sample_count: number };
  const mean = typeof row?.mean === 'number' ? row.mean : null;
  return {
    category: airport.category,
    mean,
    sampleCount: Number(row?.sample_count || 0),
    period: referenceMonth,
    evidenceId: mean === null ? null : `PEER:${airportId}:${referenceMonth}:completion`,
  };
}

export function getApplicableRules(repository: Repository, ruleVersion = '1.0') {
  return repository.db.prepare('SELECT * FROM rules WHERE version = ? ORDER BY id').all(ruleVersion) as RuleRow[];
}

export function getPriorFeedback(repository: Repository, eventId: string, revision: number) {
  const analyses = repository.db.prepare('SELECT id FROM analyses WHERE event_id = ? AND revision <= ? ORDER BY created_at').all(eventId, revision) as Array<{ id: string }>;
  return analyses.flatMap((analysis) => repository.listFeedback(analysis.id));
}

export function buildEvidencePackage(repository: Repository, event: EventRecord): EvidencePackage {
  const { payload } = event;
  const datasetVersion = (repository.db.prepare('SELECT dataset_sha256 FROM dataset_imports ORDER BY imported_at DESC LIMIT 1').get() as { dataset_sha256: string } | undefined)?.dataset_sha256 ?? null;
  const eventVersion = `event:${event.id}:revision:${event.revision}`;
  const baseline = getBaseline(repository, payload.airportId, 'scheduled_completion_ratio', payload.baselineMonth);
  const releaseBaseline = getBaseline(repository, payload.airportId, 'airport_release_normal_ratio', payload.baselineMonth);
  const peerBaseline = getPeerBaseline(repository, payload.airportId, payload.baselineMonth);
  const current = payload.metrics.find((item) => item.metric === 'scheduled_completion_ratio') ?? null;
  const sourceRows = payload.sources.map((source) => repository.db.prepare('SELECT * FROM sources WHERE id = ?').get(source.sourceId) as SourceRow | undefined);
  const verifiedSourceIds = [...new Set(sourceRows.filter((row): row is SourceRow => row?.verification === 'verified').map((row) => row.id))];
  const unreliableSources = payload.sources.length === 0 || sourceRows.some((row) => !row || row.verification !== 'verified');
  const sourceConflict = hasMetricConflict(payload.metrics) || sourceRows.some((row) => row?.verification === 'conflicting');
  const deltaPercentagePoints = sourceConflict ? null : comparableDelta(current, baseline);
  const evidence: Evidence[] = [];
  const primarySource = sourceRows[0];
  const primaryRef = payload.sources[0];

  const airportProfile = getAirportProfile(repository, payload.airportId, payload.baselineMonth);
  if (airportProfile?.annual) {
    const annual = airportProfile.annual;
    const annualSource = repository.db.prepare('SELECT * FROM sources WHERE id = ?').get(String(annual.source_id)) as SourceRow | undefined;
    evidence.push(makeEvidence({
      id: `PROFILE:${payload.airportId}:${annual.year}`,
      kind: 'history',
      sourceId: String(annual.source_id),
      recordLocator: String(annual.record_locator),
      text: `${airportProfile.name}（${airportProfile.category}）${annual.year} 年背景：旅客吞吐量 ${annual.passenger_volume ?? '缺失'} 万人次，起降架次 ${annual.movements ?? '缺失'}，业务重要度 ${annual.importance ?? '缺失'}。机场画像仅用于核查优先级，不单独触发高风险。`,
      periodStart: String(annual.year),
      periodEnd: String(annual.year),
      publishedAt: annualSource?.published_at ?? null,
      dataVersion: datasetVersion,
      verification: annualSource?.verification ?? 'unverified',
      simulated: annualSource ? Boolean(annualSource.simulated) : true,
    }));
  }

  evidence.push(makeEvidence({
    id: `EVENT:${event.id}:R${event.revision}:DESCRIPTION`, kind: 'observation',
    sourceId: primaryRef?.sourceId ?? 'EVENT-INPUT', recordLocator: primaryRef?.recordLocator ?? `events/${event.id}/revisions/${event.revision}`,
    text: payload.description, periodStart: payload.eventTime, periodEnd: payload.eventTime,
    publishedAt: primarySource?.published_at ?? null, verification: primarySource?.verification ?? 'unverified', simulated: primarySource ? Boolean(primarySource.simulated) : true,
    dataVersion: eventVersion,
  }));
  payload.knownFacts.slice(0, 10).forEach((fact, index) => {
    const humanConfirmed = fact.startsWith('人工确认：');
    const factRef = humanConfirmed ? payload.sources.findLast((item) => item.sourceId === 'HUMAN-CONFIRMED') : primaryRef;
    const factSource = factRef ? repository.db.prepare('SELECT * FROM sources WHERE id = ?').get(factRef.sourceId) as SourceRow | undefined : undefined;
    evidence.push(makeEvidence({
      id: `EVENT:${event.id}:R${event.revision}:FACT:${index + 1}`, kind: humanConfirmed ? 'human_input' : 'observation',
      sourceId: factRef?.sourceId ?? 'EVENT-INPUT', recordLocator: factRef?.recordLocator ?? `knownFacts/${index}`,
      text: fact, periodStart: payload.eventTime, periodEnd: payload.eventTime,
      publishedAt: factSource?.published_at ?? null, verification: factSource?.verification ?? 'unverified', simulated: factSource ? Boolean(factSource.simulated) : true,
      dataVersion: eventVersion,
    }));
  });
  payload.metrics.forEach((metric, index) => {
    const ref = payload.sources.find((item) => item.sourceId === metric.sourceId);
    const source = sourceRows.find((row) => row?.id === metric.sourceId);
    evidence.push(makeEvidence({
      id: `CURRENT:${event.id}:R${event.revision}:${metric.metric}:${index + 1}`, kind: 'observation', sourceId: metric.sourceId,
      recordLocator: ref?.recordLocator ?? `metrics/${index}`, text: `${metric.metric}：${(metric.value * 100).toFixed(2)}%（${metric.granularity}，${metric.period}）`,
      periodStart: metric.period, periodEnd: metric.period, publishedAt: source?.published_at ?? null,
      dataVersion: eventVersion,
      verification: source?.verification ?? 'unverified', simulated: source ? Boolean(source.simulated) : true,
    }));
  });
  baseline.records.forEach((row) => {
    const value = row.completionRatio;
    if (value === null) return;
    const source = repository.db.prepare('SELECT * FROM sources WHERE id = ?').get(row.sourceId) as SourceRow | undefined;
    evidence.push(makeEvidence({
      id: `BASE:${payload.airportId}:${row.month}:operations`, kind: 'history', sourceId: row.sourceId, recordLocator: row.recordLocator,
      text: `${row.month} 按计划完成比例 ${(value * 100).toFixed(2)}%；机场放行正常比例 ${row.releaseNormalRatio === null ? '缺失' : `${(row.releaseNormalRatio * 100).toFixed(2)}%`}`, periodStart: row.month, periodEnd: row.month,
      publishedAt: source?.published_at ?? null, verification: source?.verification ?? 'unverified', simulated: source ? Boolean(source.simulated) : true,
      dataVersion: datasetVersion,
    }));
  });
  if (baseline.mean !== null) evidence.push(makeEvidence({
    id: `CALC:${payload.airportId}:${payload.baselineMonth}:completion-12m`, kind: 'history', sourceId: 'SYSTEM-CALC', recordLocator: `baseline/${payload.airportId}/${payload.baselineMonth}`,
    text: `参考月前 12 个自然月窗口内共有 ${baseline.sampleCount} 个月按计划完成比例，均值 ${(baseline.mean * 100).toFixed(2)}%，覆盖 ${baseline.periodStart} 至 ${baseline.periodEnd}，缺失 ${12 - baseline.sampleCount} 个月，不含参考月。`,
    periodStart: baseline.periodStart, periodEnd: baseline.periodEnd, publishedAt: null, verification: 'verified', simulated: true,
    dataVersion: datasetVersion,
  }));
  if (releaseBaseline.mean !== null) evidence.push(makeEvidence({
    id: `CALC:${payload.airportId}:${payload.baselineMonth}:release-12m`, kind: 'history', sourceId: 'SYSTEM-CALC', recordLocator: `baseline/${payload.airportId}/${payload.baselineMonth}`,
    text: `参考月前 12 个自然月窗口内共有 ${releaseBaseline.sampleCount} 个月机场放行正常比例，均值 ${(releaseBaseline.mean * 100).toFixed(2)}%，覆盖 ${releaseBaseline.periodStart} 至 ${releaseBaseline.periodEnd}，缺失 ${12 - releaseBaseline.sampleCount} 个月，不含参考月。`,
    periodStart: releaseBaseline.periodStart, periodEnd: releaseBaseline.periodEnd, publishedAt: null, verification: 'verified', simulated: true,
    dataVersion: datasetVersion,
  }));
  if (peerBaseline.mean !== null && peerBaseline.category && peerBaseline.evidenceId) evidence.push(makeEvidence({
    id: peerBaseline.evidenceId,
    kind: 'history',
    sourceId: 'SYSTEM-CALC',
    recordLocator: `peer-baseline/${peerBaseline.category}/${peerBaseline.period}`,
    text: `${peerBaseline.period} ${peerBaseline.category}同类机场（不含本机场）${peerBaseline.sampleCount} 家的按计划完成比例均值为 ${(peerBaseline.mean * 100).toFixed(2)}%。该值仅作同期参照，不单独改变风险等级。`,
    periodStart: peerBaseline.period,
    periodEnd: peerBaseline.period,
    publishedAt: null,
    dataVersion: datasetVersion,
    verification: 'verified',
    simulated: true,
  }));
  const weatherRow = getWeatherHistory(repository, payload.airportId, payload.baselineMonth, payload.baselineMonth)[0];
  if (weatherRow) {
    const weatherSourceId = String(weatherRow.source_id);
    const source = repository.db.prepare('SELECT * FROM sources WHERE id = ?').get(weatherSourceId) as SourceRow | undefined;
    const missing = Number(weatherRow.missing_flag) === 1;
    evidence.push(makeEvidence({
      id: `WEATHER:${payload.airportId}:${payload.baselineMonth}`, kind: 'history', sourceId: weatherSourceId,
      recordLocator: String(weatherRow.record_locator),
      text: missing
        ? `${payload.baselineMonth} 天气记录被来源明确标记为缺失，现有数值不作为完整输入。`
        : `${payload.baselineMonth} 月度天气背景：降水 ${weatherRow.precipitation_mm} 毫米，平均气温 ${weatherRow.mean_temperature_c} 摄氏度，最大风速 ${weatherRow.max_wind_speed_mps} 米/秒，明显不利天气 ${weatherRow.adverse_weather_days} 天。历史天气不能证明当前异常因果。`,
      periodStart: payload.baselineMonth, periodEnd: payload.baselineMonth, publishedAt: source?.published_at ?? null,
      dataVersion: datasetVersion,
      verification: source?.verification ?? 'unverified', simulated: source ? Boolean(source.simulated) : true,
    }));
  }

  getPriorFeedback(repository, event.id, event.revision).slice(-5).forEach((feedback) => {
    evidence.push(makeEvidence({
      id: `FEEDBACK:${feedback.id}`,
      kind: 'human_input',
      sourceId: 'HUMAN-CONFIRMED',
      recordLocator: `feedback/${feedback.id}`,
      text: `人工复核结论：${feedback.decision}；原因：${feedback.reason || '未填写'}；补充事实：${feedback.addedFacts.join('；') || '无'}；确认字段：${Object.entries(feedback.confirmedFields).map(([key, value]) => `${key}=${value === null ? 'unknown' : value}`).join('，') || '无'}。该记录只属于本事件。`,
      periodStart: feedback.createdAt,
      periodEnd: feedback.createdAt,
      publishedAt: feedback.createdAt,
      dataVersion: `feedback:${feedback.id}`,
      verification: 'verified',
      simulated: true,
    }));
  });

  const rules = getApplicableRules(repository);
  const ruleEvidenceIds: Record<string, string> = {};
  rules.forEach((rule) => {
    const id = `RULE:${rule.id}:${rule.version}`;
    ruleEvidenceIds[rule.id] = id;
    evidence.push(makeEvidence({
      id, kind: 'rule', sourceId: 'RULESET-1.0', recordLocator: `rules/${rule.id}/${rule.version}`,
      text: `${rule.description}；允许动作：${rule.action_text}；${rule.human_approval_required ? '需要人工审批' : '可作为核查提示'}`,
      periodStart: null, periodEnd: null, publishedAt: null, verification: 'verified', simulated: true,
      dataVersion: `rules:${rule.version}`,
    }));
  });
  return { evidence: limitEvidence(evidence), baseline, releaseBaseline, peerBaseline, deltaPercentagePoints, verifiedSourceIds, sourceConflict, unreliableSources, ruleEvidenceIds };
}

function makeEvidence(value: Evidence): Evidence {
  return { ...value, text: value.text.slice(0, 1000) };
}

function hasMetricConflict(metrics: EventRecord['payload']['metrics']): boolean {
  const groups = new Map<string, number[]>();
  metrics.forEach((item) => {
    const key = `${item.metric}|${item.period}|${item.granularity}`;
    groups.set(key, [...(groups.get(key) || []), item.value]);
  });
  return [...groups.values()].some((values) => values.length > 1 && Math.max(...values) - Math.min(...values) > 1e-9);
}

export function limitEvidence(evidence: Evidence[]): Evidence[] {
  if (evidence.length <= 30) return evidence;
  const rules = evidence.filter((item) => item.kind === 'rule');
  const profiles = evidence.filter((item) => item.id.startsWith('PROFILE:'));
  const protectedKinds = [
    ...evidence.filter((item) => item.kind === 'estimate'),
    ...evidence.filter((item) => item.kind === 'human_input'),
    ...evidence.filter((item) => item.kind === 'observation'),
    ...profiles,
  ];
  const history = evidence.filter((item) => item.kind === 'history' && !item.id.startsWith('PROFILE:'));
  const nonRuleSlots = Math.max(0, 30 - rules.length);
  const observations = protectedKinds.slice(0, nonRuleSlots);
  const historySlots = Math.max(0, nonRuleSlots - observations.length);
  return [...observations, ...history.slice(Math.max(0, history.length - historySlots)), ...rules];
}
