import type { Health } from '../api/client.ts';
import { StatusPill } from '../components/StatusPill.tsx';
import styles from '../styles/App.module.css';

export function SettingsPage({ health }: { health: Health | null }) {
  return <section className={styles.page}>
    <div className={styles.pageHeader}><div><p className={styles.eyebrow}>SYSTEM</p><h1>设置与运行状态</h1><p>密钥只由后端环境变量读取，不会显示在浏览器中。</p></div></div>
    <div className={styles.metricGrid}>
      <article><span>API</span><strong>{health?.ok ? '正常' : '未知'}</strong><StatusPill tone={health?.ok ? 'good' : 'neutral'}>{health?.database || '未连接'}</StatusPill></article>
      <article><span>语言模型</span><strong>{health?.model === 'configured' ? '已配置' : '规则模式'}</strong><small>未配置时仍可完成结构化事件研判</small></article>
      <article><span>天气函数</span><strong>{health?.weather || '未知'}</strong><small>未验证时不返回伪预测</small></article>
      <article><span>规则版本</span><strong>1.0</strong><small>停止条件优先，重大决定须人工审批</small></article>
      <article><span>今日模型调用</span><strong>{health?.usage.calls ?? 0}</strong><small>缓存命中 {health?.usage.cacheHits ?? 0} 次</small></article>
      <article><span>今日 Token</span><strong>{health?.usage.inputTokens === null ? '未知' : (health?.usage.inputTokens ?? 0) + (health?.usage.outputTokens ?? 0)}</strong><small>供应商不返回用量时保持未知</small></article>
      <article><span>估算费用</span><strong>{health?.usage.estimatedCost === null || health?.usage.estimatedCost === undefined ? '未核算' : `${health.usage.estimatedCost.toFixed(4)} ${health.usage.currency}`}</strong><small>仅在配置真实单价后计算</small></article>
    </div>
    <div className={styles.card}><h2>安全边界</h2><ul className={styles.cleanList}><li>所有数据与机场均为赛事模拟。</li><li>系统不自动取消、放行、调度、维修、赔付或正式发布。</li><li>未知值保持未知，不会转换成“否”。</li><li>天气估计不覆盖停止条件或正式运行状态。</li></ul></div>
  </section>;
}
