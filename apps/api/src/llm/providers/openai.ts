import type { AppConfig } from '../../config.js';
import { LlmError, type LlmProvider, type LlmResult } from '../provider.js';

interface OpenAiResponse {
  id?: string;
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class OpenAiResponsesProvider implements LlmProvider {
  private active = 0;
  private usedTokens: number;
  private usageDay = new Date().toISOString().slice(0, 10);

  constructor(private readonly config: AppConfig['llm'], initialUsedTokens = 0) { this.usedTokens = initialUsedTokens; }

  async generateJson(args: Parameters<LlmProvider['generateJson']>[0]): Promise<LlmResult> {
    if (!this.config.apiKey || !this.config.model) throw new LlmError('模型名称或 API 密钥未配置', 'configuration');
    this.resetDailyUsageIfNeeded();
    if (this.active >= this.config.maxConcurrency) throw new LlmError('本地模型并发额度已满', 'concurrency');
    const reservation = this.config.maxOutputTokens * 2;
    if (this.usedTokens + reservation > this.config.dailyTokenLimit) throw new LlmError('本地每日 token 预算不足', 'budget');
    this.active++;
    this.usedTokens += reservation;
    const signal = AbortSignal.any([args.signal, AbortSignal.timeout(this.config.timeoutMs)]);
    try {
      const requestBody: Record<string, unknown> = {
        model: this.config.model,
        input: [
          { role: 'system', content: args.system },
          { role: 'user', content: JSON.stringify(args.payload) },
        ],
        max_output_tokens: this.config.maxOutputTokens,
        store: false,
        text: {
          format: {
            type: 'json_schema',
            name: `flightguard_${args.purpose}`,
            strict: true,
            schema: stripSchemaMetadata(args.schema),
          },
        },
      };
      if (this.config.reasoningEffort) requestBody.reasoning = { effort: this.config.reasoningEffort };
      const response = await fetch(`${this.config.baseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        if (response.status === 401 || response.status === 403) throw new LlmError(`模型鉴权失败：${detail}`, 'authentication');
        if (response.status === 429) throw new LlmError(`模型服务限流：${detail}`, 'rate_limit');
        throw new LlmError(`模型服务返回 ${response.status}：${detail}`, 'provider');
      }
      const body = await response.json() as OpenAiResponse;
      if (body.status === 'incomplete') throw new LlmError(`模型输出不完整：${body.incomplete_details?.reason || 'unknown'}`, 'format');
      const text = body.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
      if (!text) {
        const refusal = body.output?.flatMap((item) => item.content || []).find((item) => item.refusal)?.refusal;
        throw new LlmError(refusal ? `模型拒绝生成：${refusal}` : '模型未返回结构化文本', 'format');
      }
      let value: unknown;
      try { value = JSON.parse(text); }
      catch { throw new LlmError('模型返回的内容不是有效 JSON', 'format'); }
      const inputTokens = body.usage?.input_tokens ?? null;
      const outputTokens = body.usage?.output_tokens ?? null;
      const actual = (inputTokens ?? reservation) + (outputTokens ?? 0);
      this.usedTokens += actual - reservation;
      return { value, model: body.model || this.config.model, inputTokens, outputTokens, providerRequestId: body.id ?? null };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof DOMException && error.name === 'TimeoutError' || signal.aborted) throw new LlmError('模型调用超时或被取消', 'timeout');
      throw new LlmError(error instanceof Error ? error.message : '模型调用失败', 'provider');
    } finally {
      this.active--;
    }
  }

  private resetDailyUsageIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.usageDay) {
      this.usageDay = today;
      this.usedTokens = 0;
    }
  }
}

function stripSchemaMetadata(schema: object): object {
  const copy = structuredClone(schema) as Record<string, unknown>;
  delete copy.$id;
  return copy;
}
