import { questionAnswerSchema } from '@flightguard/contracts';
import type { LlmProvider } from './provider.js';
import { answerSystemPrompt } from '../prompts/answer-v1.js';

export function answerWithModel(provider: LlmProvider, payload: unknown, signal: AbortSignal) {
  return provider.generateJson({ purpose: 'answer', system: answerSystemPrompt, payload, schema: questionAnswerSchema, signal });
}

export function repairAnswer(provider: LlmProvider, payload: unknown, errors: string[], invalidOutput: unknown, signal: AbortSignal) {
  return provider.generateJson({
    purpose: 'answer',
    system: `${answerSystemPrompt}\n上一次输出未通过服务器校验。仅修复下列错误，不增加新事实：${errors.join('；')}`,
    payload: { ...payload as object, invalidOutput }, schema: questionAnswerSchema, signal,
  });
}
