import { useMemo, useState } from 'react';
import type { AnalysisReport, EventInput, TriState } from '@flightguard/contracts';
import { api, type Airport } from '../api/client.ts';
import styles from '../styles/App.module.css';

const triOptions: Array<{ value: string; label: string }> = [
  { value: 'null', label: '未知' }, { value: 'true', label: '是' }, { value: 'false', label: '否' },
];
const tri = (value: string): TriState => value === 'true' ? true : value === 'false' ? false : null;

export function EventsPage({ airports, onAnalysis }: { airports: Airport[]; onAnalysis: (analysis: AnalysisReport) => void }) {
  const [mode, setMode] = useState<'structured' | 'free'>('structured');
  const [freeText, setFreeText] = useState('');
  const [candidate, setCandidate] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    airportId: '', eventTimeLabel: '第4天下午', baselineMonth: '2025-12', description: '',
    weatherRisk: 'null', operatingPressure: 'null', formalDelay: 'null', resourceAdequate: 'null',
    knownFacts: '', unknowns: '', sourceIds: 'SIM-BASE', currentRate: '',
  });
  const selected = useMemo(() => airports.find((airport) => airport.id === form.airportId), [airports, form.airportId]);

  const update = (key: keyof typeof form, value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submitStructured(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const sourceIds = form.sourceIds.split(/[，,\s]+/).map((item) => item.trim()).filter(Boolean);
    const rate = form.currentRate.trim() === '' ? null : Number(form.currentRate) / 100;
    const payload: EventInput = {
      airportId: form.airportId,
      eventTimeLabel: form.eventTimeLabel,
      eventTime: null,
      baselineMonth: form.baselineMonth,
      description: form.description,
      weatherRisk: tri(form.weatherRisk), operatingPressure: tri(form.operatingPressure),
      formalDelay: tri(form.formalDelay), resourceAdequate: tri(form.resourceAdequate),
      sources: sourceIds.map((sourceId, index) => ({ sourceId, recordLocator: `web-form/source-${index + 1}` })),
      knownFacts: splitLines(form.knownFacts), unknowns: splitLines(form.unknowns),
      metrics: rate === null || !Number.isFinite(rate) ? [] : [{ metric: 'scheduled_completion_ratio', value: rate, period: form.baselineMonth, granularity: 'month', sourceId: sourceIds[0] || 'EVENT-INPUT' }],
    };
    try {
      const created = await api.createEvent(payload);
      const generated = await api.analyze(created.event.id, created.event.revision);
      onAnalysis(generated.analysis);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '提交失败'); }
    finally { setBusy(false); }
  }

  async function submitFree(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setCandidate(null);
    try { await api.extract(freeText); }
    catch (caught) {
      const value = caught as Error & { body?: unknown };
      if ((value as { status?: number }).status === 422 && value.body && typeof value.body === 'object' && (value.body as { status?: unknown }).status === 'needs_clarification') setCandidate(value.body);
      else setError(value.message);
    } finally { setBusy(false); }
  }

  return <section className={styles.page}>
    <div className={styles.pageHeader}>
      <div><p className={styles.eyebrow}>NEW EVENT</p><h1>新事件研判</h1><p>输入只用于模拟与汇总分析，请勿提交真实个人信息。</p></div>
      <div className={styles.segmented}>
        <button className={mode === 'structured' ? styles.active : ''} onClick={() => setMode('structured')}>结构化表单</button>
        <button className={mode === 'free' ? styles.active : ''} onClick={() => setMode('free')}>自由文本</button>
      </div>
    </div>

    {mode === 'free' ? <form className={styles.card} onSubmit={submitFree}>
      <label>事件原文<textarea value={freeText} onChange={(event) => setFreeText(event.target.value)} rows={9} maxLength={5000} placeholder="粘贴脱敏后的新事件描述。模型只会提取候选字段，仍需人工确认。" required /></label>
      <div className={styles.formActions}><button className={styles.primaryButton} disabled={busy}>{busy ? '正在提取…' : '提取候选字段'}</button></div>
      {candidate ? <div className={styles.notice}><strong>需要人工确认</strong><pre>{JSON.stringify(candidate, null, 2)}</pre><button type="button" onClick={() => setMode('structured')}>转到结构化表单</button></div> : null}
    </form> : <form className={styles.card} onSubmit={submitStructured}>
      <div className={styles.formGrid}>
        <label>机场<select value={form.airportId} onChange={(event) => update('airportId', event.target.value)} required><option value="">请选择</option>{airports.map((airport) => <option key={airport.id} value={airport.id}>{airport.name} · {airport.id}</option>)}</select><small>{selected?.category || '必须选择已登记机场'}</small></label>
        <label>事件时间标签<input value={form.eventTimeLabel} onChange={(event) => update('eventTimeLabel', event.target.value)} required /></label>
        <label>历史参考月<input type="month" value={form.baselineMonth} onChange={(event) => update('baselineMonth', event.target.value)} required /></label>
        <label>当前月度按计划完成比例（%）<input type="number" min="0" max="100" step="0.01" value={form.currentRate} onChange={(event) => update('currentRate', event.target.value)} placeholder="留空表示未知" /></label>
      </div>
      <label>事件描述<textarea rows={5} value={form.description} onChange={(event) => update('description', event.target.value)} maxLength={5000} required /></label>
      <div className={styles.formGrid4}>
        {(['weatherRisk', 'operatingPressure', 'formalDelay', 'resourceAdequate'] as const).map((key) => <label key={key}>{({ weatherRisk: '天气风险', operatingPressure: '运行压力', formalDelay: '正式延误', resourceAdequate: '资源充足' })[key]}<select value={form[key]} onChange={(event) => update(key, event.target.value)}>{triOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}
      </div>
      <div className={styles.formGrid}>
        <label>已知事实（每行一项）<textarea rows={4} value={form.knownFacts} onChange={(event) => update('knownFacts', event.target.value)} /></label>
        <label>未知信息（每行一项）<textarea rows={4} value={form.unknowns} onChange={(event) => update('unknowns', event.target.value)} /></label>
      </div>
      <label>来源编号（逗号分隔）<input value={form.sourceIds} onChange={(event) => update('sourceIds', event.target.value)} required /><small>可靠性由后端来源登记推导；推荐模拟来源：SIM-BASE、SIM-WEATHER。</small></label>
      <div className={styles.formActions}><button className={styles.primaryButton} disabled={busy}>{busy ? '正在研判…' : '创建事件并生成报告'}</button></div>
    </form>}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </section>;
}

function splitLines(value: string) { return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }
