const nullableString = { type: ['string', 'null'], maxLength: 1000 } as const;
const triState = { type: ['boolean', 'null'] } as const;
const field = (valueSchema: object) => ({
  type: 'object',
  additionalProperties: false,
  required: ['value', 'origin', 'span'],
  properties: {
    value: valueSchema,
    origin: { type: 'string', const: 'model_candidate' },
    span: nullableString,
  },
});

export const eventInputSchema = {
  $id: 'EventInput',
  type: 'object',
  additionalProperties: false,
  required: ['airportId', 'eventTimeLabel', 'eventTime', 'baselineMonth', 'description', 'weatherRisk', 'operatingPressure', 'formalDelay', 'resourceAdequate', 'sources', 'knownFacts', 'unknowns', 'metrics'],
  properties: {
    airportId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' },
    eventTimeLabel: { type: 'string', minLength: 1, maxLength: 200 },
    eventTime: { type: ['string', 'null'], format: 'date-time' },
    baselineMonth: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
    description: { type: 'string', minLength: 1, maxLength: 5000 },
    weatherRisk: triState,
    operatingPressure: triState,
    formalDelay: triState,
    resourceAdequate: triState,
    sources: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false, required: ['sourceId', 'recordLocator'],
        properties: {
          sourceId: { type: 'string', minLength: 1, maxLength: 100 },
          recordLocator: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
    knownFacts: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    unknowns: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    metrics: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['metric', 'value', 'period', 'granularity', 'sourceId'],
        properties: {
          metric: { enum: ['scheduled_completion_ratio', 'airport_release_normal_ratio'] },
          value: { type: 'number', minimum: 0, maximum: 1 },
          period: { type: 'string', minLength: 1, maxLength: 100 },
          granularity: { enum: ['month', 'day', 'intra_day'] },
          sourceId: { type: 'string', minLength: 1, maxLength: 100 },
        },
      },
    },
  },
} as const;

export const extractedEventSchema = {
  $id: 'ExtractedEvent', type: 'object', additionalProperties: false,
  required: ['airportCandidate', 'eventTimeLabel', 'weatherRisk', 'operatingPressure', 'formalDelay', 'resourceAdequate', 'unknowns'],
  properties: {
    airportCandidate: field(nullableString),
    eventTimeLabel: field(nullableString),
    weatherRisk: field(triState),
    operatingPressure: field(triState),
    formalDelay: field(triState),
    resourceAdequate: field(triState),
    unknowns: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 500 } },
  },
} as const;

const explanationSchema = {
  type: 'object', additionalProperties: false, required: ['text', 'evidenceIds'],
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 1500 },
    evidenceIds: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 120 } },
  },
} as const;

export const generatedNarrativeSchema = {
  $id: 'GeneratedNarrative', type: 'object', additionalProperties: false,
  required: ['summary', 'impact', 'assumptions', 'explanations', 'drafts'],
  properties: {
    summary: { type: 'string', minLength: 1, maxLength: 2000 },
    impact: { type: 'string', minLength: 1, maxLength: 2000 },
    assumptions: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    explanations: { type: 'array', minItems: 1, maxItems: 20, items: { ...explanationSchema, properties: { ...explanationSchema.properties, evidenceIds: { ...explanationSchema.properties.evidenceIds, minItems: 1 } } } },
    drafts: {
      type: 'object', additionalProperties: false, required: ['operations', 'airport', 'passenger'],
      properties: {
        operations: { type: 'string', minLength: 1, maxLength: 2500 },
        airport: { type: 'string', minLength: 1, maxLength: 2500 },
        passenger: { type: 'string', minLength: 1, maxLength: 2500 },
      },
    },
  },
} as const;

export const questionAnswerSchema = {
  $id: 'QuestionAnswer', type: 'object', additionalProperties: false,
  required: ['answer', 'evidenceIds', 'needsRevision'],
  properties: {
    answer: { type: 'string', minLength: 1, maxLength: 3000 },
    evidenceIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 120 } },
    needsRevision: { type: 'boolean' },
  },
} as const;

export const weatherEstimateSchema = {
  $id: 'WeatherEstimate', type: 'object', additionalProperties: false,
  required: ['status', 'estimate', 'predictionInterval', 'modelVersion', 'trainingScope', 'validationSummary', 'reason'],
  properties: {
    status: { enum: ['ok', 'not_configured', 'not_validated', 'insufficient_data', 'out_of_scope', 'timeout', 'error'] },
    estimate: { type: ['number', 'null'], minimum: 0, maximum: 1 },
    predictionInterval: {
      anyOf: [
        { type: 'null' },
        { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1 } },
      ],
    },
    modelVersion: nullableString,
    trainingScope: nullableString,
    validationSummary: nullableString,
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

export const feedbackInputSchema = {
  $id: 'FeedbackInput', type: 'object', additionalProperties: false,
  required: ['decision', 'reason', 'addedFacts', 'reviewerRole'],
  properties: {
    decision: { enum: ['accepted', 'modified', 'rejected'] },
    reason: { type: 'string', maxLength: 2000 },
    addedFacts: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 1000 } },
    reviewerRole: { type: 'string', minLength: 1, maxLength: 100 },
    confirmedFields: {
      type: 'object', additionalProperties: false,
      properties: {
        weatherRisk: triState,
        operatingPressure: triState,
        formalDelay: triState,
        resourceAdequate: triState,
      },
    },
  },
} as const;
