import type { AnalysisReport } from '@flightguard/contracts';
import { StatusPill } from '../components/StatusPill.tsx';
import styles from '../styles/App.module.css';

export function HistoryPage({ items, onOpen }: { items: AnalysisReport[]; onOpen: (item: AnalysisReport) => void }) {
  return <section className={styles.page}>
    <div className={styles.pageHeader}><div><p className={styles.eyebrow}>AUDIT TRAIL</p><h1>历史记录</h1><p>报告按事件版本保留，人工反馈不会覆盖原始输出。</p></div></div>
    <div className={styles.historyList}>{items.length ? items.map((item) => <button key={item.id} className={styles.historyItem} onClick={() => onOpen(item)}><div><strong>{item.narrative.summary}</strong><span>{new Date(item.createdAt).toLocaleString('zh-CN')} · 事件 {item.eventId.slice(0, 8)} · 修订 {item.revision}</span></div><div><StatusPill tone={item.risk === 'high' ? 'bad' : item.risk === 'medium' ? 'warn' : item.risk === 'low' ? 'good' : 'neutral'}>{item.risk}</StatusPill><StatusPill tone="neutral">{item.runMode}</StatusPill><StatusPill tone="neutral">审核 {item.reviewStatus}</StatusPill></div></button>) : <div className={styles.emptyCard}>尚无分析记录。</div>}</div>
  </section>;
}
