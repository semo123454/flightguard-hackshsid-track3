export interface LlmResult {
  value: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  providerRequestId: string | null;
}

export interface LlmProvider {
  generateJson(args: {
    purpose: 'extract' | 'report' | 'answer';
    system: string;
    payload: unknown;
    schema: object;
    signal: AbortSignal;
  }): Promise<LlmResult>;
}

export class LlmError extends Error {
  constructor(message: string, readonly category: 'configuration' | 'authentication' | 'rate_limit' | 'provider' | 'timeout' | 'format' | 'budget' | 'concurrency') {
    super(message);
  }
}
