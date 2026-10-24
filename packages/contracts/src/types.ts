export type TriState = true | false | null;
export type Risk = 'low' | 'medium' | 'high' | 'undetermined';
export type RunMode = 'llm' | 'rules_fallback';
export type Verification = 'verified' | 'unverified' | 'conflicting';
export type Metric = 'scheduled_completion_ratio' | 'airport_release_normal_ratio';
export type FeedbackDecision = 'accepted' | 'modified' | 'rejected';
export type ConfirmedFieldUpdates = Partial<Pick<EventInput, 'weatherRisk' | 'operatingPressure' | 'formalDelay' | 'resourceAdequate'>>;

export interface SourceRef {
  sourceId: string;
  recordLocator: string;
}

export interface MetricObservation {
  metric: Metric;
  value: number;
  period: string;
  granularity: 'month' | 'day' | 'intra_day';
  sourceId: string;
}

export interface EventInput {
  airportId: string;
  eventTimeLabel: string;
  eventTime: string | null;
  baselineMonth: string;
  description: string;
  weatherRisk: TriState;
  operatingPressure: TriState;
  formalDelay: TriState;
  resourceAdequate: TriState;
  sources: SourceRef[];
  knownFacts: string[];
  unknowns: string[];
  metrics: MetricObservation[];
}

export interface EventRecord {
  id: string;
  revision: number;
  createdAt: string;
  payload: EventInput;
}

export interface Evidence {
  id: string;
  kind: 'observation' | 'history' | 'rule' | 'human_input' | 'estimate';
  sourceId: string;
  recordLocator: string;
  text: string;
  periodStart: string | null;
  periodEnd: string | null;
  publishedAt: string | null;
  dataVersion: string | null;
  verification: Verification;
  simulated: boolean;
}

export interface Action {
  id: string;
  priority: 1 | 2 | 3;
  ownerRole: string;
  text: string;
  basisIds: string[];
  requiresHumanReview: boolean;
}

export interface RuleResult {
  risk: Risk;
  stopped: boolean;
  ruleIds: string[];
  evidenceIds: string[];
  gaps: string[];
  actions: Action[];
  escalationConditions: string[];
  humanDecisions: string[];
  deltaPercentagePoints: number | null;
}

export interface GeneratedNarrative {
  summary: string;
  impact: string;
  assumptions: string[];
  explanations: Array<{ text: string; evidenceIds: string[] }>;
  drafts: {
    operations: string;
    airport: string;
    passenger: string;
  };
}

export interface AssessmentFrame {
  scope: {
    airportId: string;
    eventTimeLabel: string;
    baselineMonth: string;
  };
  conclusion: string;
  knownFacts: Array<{ text: string; evidenceIds: string[] }>;
  signals: Array<{
    key: 'weatherRisk' | 'operatingPressure' | 'formalDelay' | 'resourceAdequate';
    label: string;
    state: 'present' | 'absent' | 'unknown';
    evidenceIds: string[];
  }>;
  currentCompletion: {
    value: number;
    period: string;
    granularity: 'month' | 'day' | 'intra_day';
    evidenceId: string | null;
  } | null;
  currentCompletionCandidates: Array<{
    value: number;
    period: string;
    granularity: 'month' | 'day' | 'intra_day';
    sourceId: string;
    evidenceId: string | null;
  }>;
  ownBaseline: {
    mean: number;
    sampleCount: number;
    periodStart: string | null;
    periodEnd: string | null;
    evidenceId: string | null;
  } | null;
  peerBaseline: {
    category: string;
    mean: number;
    sampleCount: number;
    period: string;
    evidenceId: string | null;
  } | null;
  deltaPercentagePoints: number | null;
  anomalyTriggered: boolean;
  triggeredReasons: string[];
  unknowns: string[];
  verifiedSourceIds: string[];
}

export interface WeatherEstimate {
  status: 'ok' | 'not_configured' | 'not_validated' | 'insufficient_data' | 'out_of_scope' | 'timeout' | 'error';
  estimate: number | null;
  predictionInterval: [number, number] | null;
  modelVersion: string | null;
  trainingScope: string | null;
  validationSummary: string | null;
  reason: string;
}

export interface AnalysisReport {
  id: string;
  eventId: string;
  revision: number;
  parentAnalysisId: string | null;
  risk: Risk;
  runMode: RunMode;
  fallbackReason: string | null;
  ruleVersion: string;
  promptVersion: string;
  modelVersion: string | null;
  createdAt: string;
  evidence: Evidence[];
  ruleResult: RuleResult;
  assessment?: AssessmentFrame;
  narrative: GeneratedNarrative;
  weather: WeatherEstimate;
  reviewStatus: 'pending' | 'accepted' | 'modified' | 'rejected';
}

export interface FeedbackRecord {
  id: string;
  analysisId: string;
  decision: FeedbackDecision;
  reason: string;
  addedFacts: string[];
  confirmedFields: ConfirmedFieldUpdates;
  reviewerRole: string;
  createdAt: string;
}

export interface ExtractedField<T> {
  value: T | null;
  origin: 'model_candidate';
  span: string | null;
}

export interface ExtractedEvent {
  airportCandidate: ExtractedField<string>;
  eventTimeLabel: ExtractedField<string>;
  weatherRisk: ExtractedField<boolean>;
  operatingPressure: ExtractedField<boolean>;
  formalDelay: ExtractedField<boolean>;
  resourceAdequate: ExtractedField<boolean>;
  unknowns: string[];
}

export interface QuestionAnswer {
  answer: string;
  evidenceIds: string[];
  needsRevision: boolean;
}
