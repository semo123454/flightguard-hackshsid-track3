import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { OpenAiResponsesProvider } from '../src/llm/providers/openai.js';
import { LlmError } from '../src/llm/provider.js';

const config: AppConfig['llm'] = {
  enabled: true, provider: 'openai', baseUrl: 'https://api.openai.test/v1', model: 'fixture-model', apiKey: 'secret-fixture',
  reasoningEffort: null,
  timeoutMs: 1000, reportDeadlineMs: 2000, maxConcurrency: 2, maxOutputTokens: 500, dailyTokenLimit: 10_000,
  cacheEnabled: true,
  inputPricePerMillion: null, outputPricePerMillion: null, priceCurrency: 'CNY',
};
const schema = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI Responses provider adapter', () => {
  it('sends strict JSON schema and maps output text plus usage', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
      expect(body.store).toBe(false);
      return new Response(JSON.stringify({
        id: 'resp_fixture', model: 'fixture-model', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }],
        usage: { input_tokens: 11, output_tokens: 7 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await new OpenAiResponsesProvider(config).generateJson({ purpose: 'answer', system: 'system', payload: { question: 'q' }, schema, signal: new AbortController().signal });
    expect(result).toMatchObject({ value: { answer: 'ok' }, inputTokens: 11, outputTokens: 7, providerRequestId: 'resp_fixture' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('forwards an explicitly configured reasoning effort', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: 'none' });
      return new Response(JSON.stringify({
        id: 'resp_deepseek_fixture', model: 'deepseek-flash', status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }],
        usage: { input_tokens: 10, output_tokens: 4 },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const deepseekConfig = { ...config, provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.test', model: 'deepseek-flash', reasoningEffort: 'none' as const };
    await new OpenAiResponsesProvider(deepseekConfig).generateJson({ purpose: 'answer', system: 'system', payload: { question: 'q' }, schema, signal: new AbortController().signal });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([[401, 'authentication'], [429, 'rate_limit'], [500, 'provider']] as const)('maps HTTP %s to %s', async (status, category) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fixture error', { status })));
    const call = new OpenAiResponsesProvider(config).generateJson({ purpose: 'report', system: 's', payload: {}, schema, signal: new AbortController().signal });
    await expect(call).rejects.toMatchObject({ category } satisfies Partial<LlmError>);
  });

  it('rejects malformed output text as a format error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'not-json' }] }] }), { status: 200 })));
    const call = new OpenAiResponsesProvider(config).generateJson({ purpose: 'extract', system: 's', payload: {}, schema, signal: new AbortController().signal });
    await expect(call).rejects.toMatchObject({ category: 'format' } satisfies Partial<LlmError>);
  });
});
