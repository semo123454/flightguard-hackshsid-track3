import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sanitize } from './engine.mjs';

const defaultPath = fileURLToPath(new URL('../runtime/state.json', import.meta.url));
const statePath = resolve(process.env.TRACK3_STATE_FILE || defaultPath);

function emptyState() {
  return { version: 1, analyses: [], feedback: [] };
}

function readState() {
  if (!existsSync(statePath)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      version: 1,
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
    };
  } catch {
    return emptyState();
  }
}

function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function listAnalyses() {
  return readState().analyses.slice().reverse();
}

export function getAnalysis(id) {
  return readState().analyses.find((item) => item.id === id) || null;
}

export function saveAnalysis(result, parentAnalysisId = null) {
  const state = readState();
  const saved = { ...result, parentAnalysisId };
  state.analyses.push(saved);
  if (state.analyses.length > 200) state.analyses = state.analyses.slice(-200);
  writeState(state);
  return saved;
}

export function listFeedback(analysisId = null) {
  const feedback = readState().feedback;
  return (analysisId ? feedback.filter((item) => item.analysisId === analysisId) : feedback).slice().reverse();
}

export function saveFeedback(analysisId, raw) {
  const state = readState();
  const analysis = state.analyses.find((item) => item.id === analysisId);
  if (!analysis) throw new Error('找不到要复核的分析记录');
  const decision = String(raw?.decision || '');
  if (!['接受', '修改', '拒绝'].includes(decision)) throw new Error('人工处理结果必须为接受、修改或拒绝');
  if (decision !== '接受' && !String(raw?.reason || '').trim()) throw new Error('修改或拒绝时必须填写原因');

  const clean = sanitize({
    reason: String(raw?.reason || '').slice(0, 3000),
    addedFacts: String(raw?.addedFacts || '').slice(0, 3000),
    finalAction: String(raw?.finalAction || '').slice(0, 3000),
    outcome: String(raw?.outcome || '').slice(0, 3000),
    improvement: String(raw?.improvement || '').slice(0, 3000),
    reviewerRole: String(raw?.reviewerRole || '专业复核人').slice(0, 100),
  });
  const feedback = {
    id: randomUUID(),
    analysisId,
    eventId: analysis.input.eventId || analysis.id,
    decision,
    ...clean,
    resourceAdequate: Boolean(raw?.resourceAdequate),
    createdAt: new Date().toISOString(),
  };
  state.feedback.push(feedback);
  const index = state.analyses.findIndex((item) => item.id === analysisId);
  state.analyses[index] = { ...analysis, status: decision === '接受' ? '已接受' : decision === '修改' ? '需修改' : '已否决' };
  writeState(state);
  return feedback;
}

export function clearStateForTests() {
  writeState(emptyState());
}

export { statePath };
