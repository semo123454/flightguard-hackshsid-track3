import { useEffect, useMemo, useState } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ConfirmedFieldUpdates, Evidence, FeedbackDecision } from '@flightguard/contracts';
import { api } from '../api/client.ts';
import type { AnalysisDetail } from '../api/client.ts';
import { StatusPill } from '../components/StatusPill.tsx';
import styles from '../styles/App.module.css';

const riskText = { low: '低风险', medium: '中风险', high: '高风险', undetermined: '无法判断' } as const;
const riskTone = { low: 'good', medium: 'warn', high: 'bad', undetermined: 'neutral' } as const;
const kindText = { observation: '事实', history: '历史', rule: '规则', human_input: '人工输入', estimate: '估计' } as const;
const confirmedFieldLabels = { weatherRisk: '天气风险', operatingPressure: '运行压力', formalDelay: '正式延误', resourceAdequate: '资源充足' } as const;
const confirmedOptions = [{ value: 'unchanged', label: '不更新' }, { value: 'null', label: '确认仍未知' }, { value: 'true', label: '确认是' }, { value: 'false', label: '确认否' }];
const signalStateText = { present: '已触发', absent: '未触发', unknown: '待确认' } as const;

export function AnalysisPage({ analysis, onUpdate }: { analysis: AnalysisDetail | null; onUpdate: (analysis: AnalysisDetail) => void }) {
  const [draft, setDraft] = useState<'operations' | 'airport' | 'passenger'>('operations');
  const [chartMetric, setChartMetric] = useState<'completion' | 'release'>('completion');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [answerNeedsRevision, setAnswerNeedsRevision] = useState(false);
  const [decision, setDecision] = useState<FeedbackDecision>('accepted');
  const [reason, setReason] = useState('');
  const [facts, setFacts] = useState('');
  const [confirmedFields, setConfirmedFields] = useState<Record<keyof typeof confirmedFieldLabels, string>>({ weatherRisk: 'unchanged', operatingPressure: 'unchanged', formalDelay: 'unchanged', resourceAdequate: 'unchanged' });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const chart = useMemo(() => historyChart(analysis?.evidence || []), [analysis]);

  useEffect(() => {
    setQuestion('');
    setAnswer('');
    setAnswerNeedsRevision(false);
    setDraft('operations');
  }, [analysis?.id]);

  if (!analysis) return <section className={styles.emptyState}><p className={styles.eyebrow}>ANALYSIS</p><h1>尚未选择报告</h1><p>先创建一个新事件，或从历史记录打开已有报告。</p></section>;

  async function ask(event: React.FormEvent) {
    event.preventDefault(); setBusy('ask'); setMessage('');
    try { const result = await api.ask(analysis!.id, question); setAnswer(result.answer.answer); setAnswerNeedsRevision(result.answer.needsRevision); }
    catch (error) { setMessage(error instanceof Error ? error.message : '追问失败'); }
    finally { setBusy(''); }
  }

  async function submitFeedback(event: React.FormEvent) {
    event.preventDefault(); setBusy('feedback'); setMessage('');
    try {
      const fieldUpdates = Object.fromEntries(Object.entries(confirmedFields).filter(([, value]) => value !== 'unchanged').map(([key, value]) => [key, value === 'null' ? null : value === 'true'])) as ConfirmedFieldUpdates;
      const response = await api.feedback(analysis!.id, { decision, reason, addedFacts: facts.split(/\r?\n/).map((item) => item.trim()).filter(Boolean), reviewerRole: '运行复核人', ...(Object.keys(fieldUpdates).length ? { confirmedFields: fieldUpdates } : {}) });
      if (response.result?.revision) {
        const next = await api.analyze(response.result.revision.id, response.result.revision.revision, analysis!.id);
        onUpdate(next.analysis);
        setMessage('反馈已留痕；补充事实已创建事件修订并生成关联报告。');
      } else {
        const refreshed = await api.analysis(analysis!.id);
        onUpdate(refreshed.analysis);
        setMessage(response.result?.revisionConflict ? '反馈已留痕，但事件已有更新版本，补充事实未自动合并。' : '反馈已完整留痕，原报告未被覆盖。');
      }
      setFacts(''); setReason(''); setConfirmedFields({ weatherRisk: 'unchanged', operatingPressure: 'unchanged', formalDelay: 'unchanged', resourceAdequate: 'unchanged' });
    } catch (error) { setMessage(error instanceof Error ? error.message : '反馈提交失败'); }
    finally { setBusy(''); }
  }

  return <section className={styles.page}>
    <div className={styles.analysisHero}>
      <div><p className={styles.eyebrow}>REPORT · REVISION {analysis.revision}</p><h1>{analysis.assessment ? `${analysis.assessment.scope.airportId} · ${riskText[analysis.risk]}` : analysis.narrative.summary}</h1><p>{analysis.narrative.summary}</p><p>{analysis.narrative.impact}</p></div>
      <div className={styles.statusStack}>
        <StatusPill tone={riskTone[analysis.risk]}>事件风险 · {riskText[analysis.risk]}</StatusPill>
        <StatusPill tone={analysis.runMode === 'llm' ? 'good' : 'neutral'}>系统模式 · {analysis.runMode === 'llm' ? '模型＋规则' : '规则回退'}</StatusPill>
        <StatusPill tone="neutral">审核 · {analysis.reviewStatus}</StatusPill>
      </div>
    </div>
    {analysis.fallbackReason ? <div className={styles.notice}><strong>回退说明</strong><span>{analysis.fallbackReason}</span></div> : null}
    {analysis.ruleResult.stopped ? <div className={styles.notice}><strong>停止条件已触发</strong><span>当前仅整理证据和核查方向，不形成确定性行动结论；须先解决来源、事实或模型冲突。</span></div> : null}

    <div className={styles.metricGrid}>
      <article><span>当前按计划完成</span><strong>{currentCompletionLabel(analysis)}</strong><small>{currentCompletionDetail(analysis)}</small></article>
      <article><span>本机场历史均值</span><strong>{analysis.assessment?.ownBaseline ? formatRatio(analysis.assessment.ownBaseline.mean) : '不可用'}</strong><small>{analysis.assessment?.ownBaseline ? `${analysis.assessment.ownBaseline.sampleCount} 个月 · ${analysis.assessment.ownBaseline.periodStart}至${analysis.assessment.ownBaseline.periodEnd}` : '历史样本不足'}</small></article>
      <article><span>历史差值</span><strong>{analysis.ruleResult.deltaPercentagePoints === null ? '不可比' : `${analysis.ruleResult.deltaPercentagePoints.toFixed(2)} pp`}</strong><small>严格低于 −5 pp 才触发异常</small></article>
      <article><span>同类机场同期参照</span><strong>{analysis.assessment?.peerBaseline ? formatRatio(analysis.assessment.peerBaseline.mean) : '不可用'}</strong><small>{analysis.assessment?.peerBaseline ? `${analysis.assessment.peerBaseline.category} · ${analysis.assessment.peerBaseline.sampleCount} 家（不含本机场）` : '不冒充行业基准'}</small></article>
    </div>

    <div className={styles.twoColumns}>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>已知事实</h2><span>来自当前事件版本</span></div><ul className={styles.cleanList}>{analysis.assessment?.knownFacts.length ? analysis.assessment.knownFacts.map((item, index) => <li key={`${index}-${item.text}`}>{item.text}<small> · {item.evidenceIds.join('、') || '待核查输入'}</small></li>) : <li>没有独立确认的现场事实，不用事件描述冒充确认信息。</li>}</ul></section>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>结构化状态</h2><span>是 / 否 / 未知分开表达</span></div><ul className={styles.cleanList}>{analysis.assessment ? analysis.assessment.signals.map((signal) => <li key={signal.key}><strong>{signal.label}</strong>：{signalStateText[signal.state]}</li>) : <li>旧版报告未保存结构化状态。</li>}</ul></section>
    </div>

    <div className={styles.twoColumns}>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>研判依据</h2><span>事实、对比、规则和边界</span></div><ol className={styles.actionList}>{analysis.narrative.explanations.map((item, index) => <li key={`${index}-${item.text}`}><p>{item.text}</p><small>证据：{item.evidenceIds.join('、')}</small></li>)}</ol><div className={styles.sectionTitle}><h2>适用边界</h2><span>不作为已确认事实</span></div><ul className={styles.cleanList}>{analysis.narrative.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul></section>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>未知与信息缺口</h2><span>需要继续核查</span></div><ul className={styles.cleanList}>{analysis.ruleResult.gaps.length ? analysis.ruleResult.gaps.map((item, index) => <li key={`${index}-${item}`}>{item}</li>) : <li>当前版本没有新增信息缺口；仍须遵守报告适用范围。</li>}</ul></section>
    </div>
    {analysis.feedback?.length ? <section className={styles.card}><div className={styles.sectionTitle}><h2>审核记录</h2><span>追加留痕，不覆盖原报告</span></div><ol className={styles.actionList}>{analysis.feedback.map((item) => <li key={item.id}><div><strong>{item.reviewerRole} · {item.decision}</strong><span>{new Date(item.createdAt).toLocaleString('zh-CN')}</span></div><p>{item.reason || '未填写原因'}</p><small>补充事实：{item.addedFacts.join('；') || '无'} · 确认字段：{Object.entries(item.confirmedFields).map(([key, value]) => `${confirmedFieldLabels[key as keyof typeof confirmedFieldLabels] || key}=${value === null ? '未知' : value ? '是' : '否'}`).join('，') || '无'}</small></li>)}</ol></section> : null}

    <div className={styles.twoColumns}>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>历史参照</h2><div className={styles.segmented}><button type="button" className={chartMetric === 'completion' ? styles.active : ''} onClick={() => setChartMetric('completion')}>按计划完成</button><button type="button" className={chartMetric === 'release' ? styles.active : ''} onClick={() => setChartMetric('release')}>放行正常</button></div></div>{chart.length ? <div className={styles.chart}><ResponsiveContainer width="100%" height="100%"><LineChart data={chart}><XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#89959f', fontSize: 11 }} /><YAxis domain={['dataMin - 2', 'dataMax + 2']} axisLine={false} tickLine={false} tickFormatter={(value) => `${value}%`} tick={{ fill: '#89959f', fontSize: 11 }} /><Tooltip formatter={(value) => [`${String(value)}%`, chartMetric === 'completion' ? '按计划完成比例' : '机场放行正常比例']} /><Line type="monotone" dataKey={chartMetric} name={chartMetric === 'completion' ? '按计划完成比例' : '机场放行正常比例'} stroke="#7894a8" strokeWidth={3} dot={false} connectNulls={false} /></LineChart></ResponsiveContainer></div> : <p>证据包中没有可绘制的月度历史。</p>}</section>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>行动清单</h2><span>受控动作集合</span></div><ol className={styles.actionList}>{analysis.ruleResult.actions.map((action) => <li key={action.id}><div><strong>{action.ownerRole}</strong><span>优先级 {action.priority}</span></div><p>{action.text}</p><small>依据：{action.basisIds.join('、') || '规则边界'}</small>{action.requiresHumanReview ? <small> · 需要人工复核</small> : null}</li>)}</ol></section>
    </div>

    <div className={styles.twoColumns}>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>升级条件</h2><span>满足后交人工处理</span></div><ul className={styles.cleanList}>{analysis.ruleResult.escalationConditions.map((item) => <li key={item}>{item}</li>)}</ul></section>
      <section className={styles.card}><div className={styles.sectionTitle}><h2>必须人工决定</h2><span>系统不会自动执行</span></div><ul className={styles.cleanList}>{analysis.ruleResult.humanDecisions.map((item) => <li key={item}>{item}</li>)}</ul></section>
    </div>

    <section className={styles.card}><div className={styles.sectionTitle}><h2>证据与边界</h2><span>主视图隐藏规则噪声，审计信息仍可展开</span></div><div className={styles.evidenceGrid}>{analysis.evidence.filter((item) => item.kind !== 'rule').map((item) => <EvidenceItem key={item.id} item={item} />)}</div>{analysis.evidence.some((item) => item.kind === 'rule') ? <details className={styles.auditRules}><summary>查看规则审计 · {analysis.ruleResult.ruleIds.length} 条实际触发 / {analysis.evidence.filter((item) => item.kind === 'rule').length} 条可追溯规则证据</summary><p className={styles.auditHint}>规则证据用于审计，不代表每条规则都改变了风险等级或行动顺序。</p><div className={styles.evidenceGrid}>{analysis.evidence.filter((item) => item.kind === 'rule').map((item) => <EvidenceItem key={item.id} item={item} />)}</div></details> : null}</section>

    <section className={styles.card}><div className={styles.sectionTitle}><h2>沟通草案</h2><span>不会自动发送</span></div><div className={styles.segmented}>{(['operations', 'airport', 'passenger'] as const).map((key) => <button key={key} onClick={() => setDraft(key)} className={draft === key ? styles.active : ''}>{({ operations: '运营', airport: '机场', passenger: '旅客' })[key]}</button>)}</div><div className={styles.draft}><p>{analysis.narrative.drafts[draft]}</p><button onClick={() => navigator.clipboard.writeText(analysis.narrative.drafts[draft])}>复制草案</button><a href={api.exportUrl(analysis.id)} target="_blank" rel="noreferrer">导出 17 字段</a></div></section>

    <div className={styles.twoColumns}>
      <form className={styles.card} onSubmit={ask}><div className={styles.sectionTitle}><h2>追问当前报告</h2><span>新增事实会转修订</span></div><textarea rows={5} value={question} onChange={(event) => setQuestion(event.target.value)} required placeholder="例如：这个判断的依据是什么？" /><button className={styles.primaryButton} disabled={busy === 'ask'}>{busy === 'ask' ? '回答中…' : '提交追问'}</button>{answer ? <div className={styles.answer}>{answer}{answerNeedsRevision ? <button type="button" onClick={() => { setDecision('modified'); document.getElementById('feedback-revision')?.scrollIntoView({ behavior: 'smooth' }); }}>将确认事实写入修订</button> : null}</div> : null}</form>
      <form id="feedback-revision" className={styles.card} onSubmit={submitFeedback}><div className={styles.sectionTitle}><h2>人工反馈</h2><span>追加记录，不覆盖原报告</span></div><label>复核结论<select value={decision} onChange={(event) => setDecision(event.target.value as FeedbackDecision)}><option value="accepted">接受</option><option value="modified">修改</option><option value="rejected">拒绝</option></select></label><label>原因<textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} required={decision !== 'accepted'} /></label><label>已确认补充事实（每行一项）<textarea rows={3} value={facts} onChange={(event) => setFacts(event.target.value)} /></label><div className={styles.formGrid4}>{(Object.keys(confirmedFieldLabels) as Array<keyof typeof confirmedFieldLabels>).map((key) => <label key={key}>确认字段 · {confirmedFieldLabels[key]}<select value={confirmedFields[key]} onChange={(event) => setConfirmedFields((current) => ({ ...current, [key]: event.target.value }))}>{confirmedOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>)}</div><button className={styles.primaryButton} disabled={busy === 'feedback'}>{busy === 'feedback' ? '保存中…' : '保存反馈'}</button></form>
    </div>
    {message ? <p className={styles.notice}>{message}</p> : null}
  </section>;
}

function historyChart(evidence: Evidence[]) {
  return evidence.filter((item) => item.id.startsWith('BASE:')).map((item) => {
    const values = [...item.text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
    return { month: item.periodStart, completion: values[0], release: values[1] };
  }).filter((item) => item.month && Number.isFinite(item.completion));
}

function EvidenceItem({ item }: { item: Evidence }) {
  return <details className={styles.evidence}><summary><span>{kindText[item.kind]}</span>{item.text}</summary><dl><dt>证据 ID</dt><dd>{item.id}</dd><dt>来源</dt><dd>{item.sourceId} · {item.recordLocator}</dd><dt>数据版本</dt><dd>{item.dataVersion || '—'}</dd><dt>核验</dt><dd>{item.verification}{item.simulated ? ' · 模拟' : ''}</dd><dt>期间</dt><dd>{item.periodStart || '—'} 至 {item.periodEnd || '—'}</dd><dt>发布时间</dt><dd>{item.publishedAt || '—'}</dd></dl></details>;
}

function formatRatio(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

function currentCompletionLabel(analysis: AnalysisDetail) {
  const candidates = analysis.assessment?.currentCompletionCandidates || [];
  if (new Set(candidates.map((item) => item.value)).size > 1) return `${candidates.length} 个冲突值`;
  return analysis.assessment?.currentCompletion ? formatRatio(analysis.assessment.currentCompletion.value) : '未提供';
}

function currentCompletionDetail(analysis: AnalysisDetail) {
  const candidates = analysis.assessment?.currentCompletionCandidates || [];
  if (new Set(candidates.map((item) => item.value)).size > 1) return candidates.map((item) => `${item.sourceId} ${formatRatio(item.value)}`).join(' · ');
  return analysis.assessment?.currentCompletion
    ? `${analysis.assessment.currentCompletion.period} · ${analysis.assessment.currentCompletion.granularity}`
    : '不用旧数据替代当前值';
}
