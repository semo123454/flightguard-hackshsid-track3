import { useEffect, useState } from 'react';
import type { AnalysisReport } from '@flightguard/contracts';
import { api, type Airport, type AnalysisDetail, type Health } from './api/client.ts';
import { EventsPage } from './pages/EventsPage.tsx';
import { AnalysisPage } from './pages/AnalysisPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import styles from './styles/App.module.css';

type Page = 'events' | 'analysis' | 'history' | 'settings';

export default function App() {
  const [page, setPage] = useState<Page>('events');
  const [airports, setAirports] = useState<Airport[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisDetail | null>(null);
  const [history, setHistory] = useState<AnalysisReport[]>([]);
  const [bootError, setBootError] = useState('');

  useEffect(() => {
    Promise.all([api.airports(), api.health(), api.analyses()])
      .then(([airportData, healthData, historyData]) => { setAirports(airportData.airports); setHealth(healthData); setHistory(historyData.analyses); })
      .catch((error: Error) => setBootError(error.message));
  }, []);

  function showAnalysis(value: AnalysisDetail) {
    setAnalysis(value);
    setHistory((items) => [value, ...items.filter((item) => item.id !== value.id)]);
    setPage('analysis');
    void api.analyses().then((data) => setHistory(data.analyses)).catch(() => undefined);
  }

  async function openHistoricalAnalysis(value: AnalysisReport) {
    try { showAnalysis((await api.analysis(value.id)).analysis); }
    catch { showAnalysis(value); }
  }

  return <div className={styles.shell}>
    <aside className={styles.sidebar}>
      <div className={styles.brand}><div className={styles.brandMark}>FG</div><div><strong>航策</strong><span>FlightGuard</span></div></div>
      <nav>{([['events', '新事件', '＋'], ['analysis', '研判报告', '◎'], ['history', '历史记录', '≡'], ['settings', '系统状态', '◇']] as const).map(([key, label, icon]) => <button key={key} className={page === key ? styles.navActive : ''} onClick={() => setPage(key)}><span>{icon}</span>{label}</button>)}</nav>
      <div className={styles.sidebarFooter}><span className={styles.liveDot} />{health?.model === 'configured' ? '模型＋规则模式' : '规则回退可用'}<small>赛事模拟 · 非真实运行系统</small></div>
    </aside>
    <main className={styles.main}>
      {bootError ? <div role="alert" className={styles.error}>无法连接后端：{bootError}</div> : null}
      {page === 'events' ? <EventsPage airports={airports} onAnalysis={showAnalysis} /> : null}
      {page === 'analysis' ? <AnalysisPage analysis={analysis} onUpdate={showAnalysis} /> : null}
      {page === 'history' ? <HistoryPage items={history} onOpen={(item) => { void openHistoricalAnalysis(item); }} /> : null}
      {page === 'settings' ? <SettingsPage health={health} /> : null}
    </main>
  </div>;
}
