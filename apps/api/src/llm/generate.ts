import { generatedNarrativeSchema } from '@flightguard/contracts';
import type { LlmProvider } from './provider.js';
import { reportSystemPrompt } from '../prompts/report-v4.js';

export function generateReport(provider: LlmProvider, payload: unknown, signal: AbortSignal) {
  return provider.generateJson({ purpose: 'report', system: reportSystemPrompt, payload, schema: generatedNarrativeSchema, signal });
}

export function repairReport(provider: LlmProvider, payload: unknown, errors: string[], invalidOutput: unknown, signal: AbortSignal) {
  return provider.generateJson({
    purpose: 'report',
    system: `${reportSystemPrompt}\n上一次输出未通过服务器校验。仅修复下列错误，不增加新事实：${errors.join('；')}`,
    payload: { ...payload as object, invalidOutput }, schema: generatedNarrativeSchema, signal,
  });
}
