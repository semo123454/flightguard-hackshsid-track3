import AjvModule from 'ajv';
import { extractedEventSchema, type ExtractedEvent } from '@flightguard/contracts';
import type { LlmProvider } from './provider.js';
import { extractSystemPrompt } from '../prompts/extract-v1.js';

const validate = new AjvModule.default({ strict: true, allErrors: true }).compile<ExtractedEvent>(extractedEventSchema);

export interface ExtractionPayload {
  text: string;
  registeredAirports: Array<{ id: string; name: string; aliases: string[] }>;
}

export function requestExtraction(provider: LlmProvider, payload: ExtractionPayload, signal: AbortSignal) {
  return provider.generateJson({ purpose: 'extract', system: extractSystemPrompt, payload, schema: extractedEventSchema, signal });
}

export function repairExtraction(provider: LlmProvider, payload: ExtractionPayload, errors: string[], invalidOutput: unknown, signal: AbortSignal) {
  return provider.generateJson({
    purpose: 'extract',
    system: `${extractSystemPrompt}\n上一次输出未通过服务器校验。仅修复下列错误，不增加原文中不存在的信息：${errors.join('；')}`,
    payload: { ...payload, invalidOutput }, schema: extractedEventSchema, signal,
  });
}

export function validateExtraction(value: unknown): { ok: true; value: ExtractedEvent } | { ok: false; errors: string[] } {
  if (validate(value)) return { ok: true, value };
  return { ok: false, errors: (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || '校验失败'}`) };
}
