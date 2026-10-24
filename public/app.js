const state = { meta: null, current: null, messageType: 'operations' };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

function riskClass(risk) {
  return risk === '低' ? 'risk-low' : risk === '中' ? 'risk-mid' : risk === '高' ? 'risk-high' : 'risk-unknown';
}

function formatPct(value) {
  return value == null || Number.isNaN(Number(value)) ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value));
}

function navigate(page) {
  const titles = { dashboard: '运行总览', analysis: '事件研判', history: '复核记录', tests: '场景测试', governance: '规则与治理' };
  $$('.page').forEach((item) => item.classList.toggle('active', item.id === `page-${page}`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === page));
  $('#pageTitle').textContent = titles[page];
  $('.sidebar').classList.remove('open');
  history.replaceState(null, '', `#${page}`);
  if (page === 'dashboard') loadDashboard();
  if (page === 'history') loadHistory();
}

function setAnalysisProgress(activeIndex = 0, finished = false) {
  $$('.progress-step').forEach((item, index) => {
    item.classList.toggle('complete', finished ? index <= activeIndex : index < activeIndex);
    item.classList.toggle('active', !finished && index === activeIndex);
  });
}

async function init() {
  try {
    state.meta = await api('/api/meta');
    populateMeta();
    bindEvents();
    await loadDashboard();
    const deepLinkId = new URLSearchParams(location.search).get('analysis');
    if (deepLinkId) {
      await openAnalysis(deepLinkId);
      return;
    }
    const page = location.hash.slice(1);
    if (['analysis', 'history', 'tests', 'governance'].includes(page)) navigate(page);
  } catch (error) {
    toast(error.message);
  }
}

function populateMeta() {
  $('#airportSelect').innerHTML = state.meta.airports.map((airport) => `<option>${airport}</option>`).join('');
  $('#presetSelect').innerHTML += state.meta.events.map((event) => `<option value="${event['事件编号']}">${event['事件编号']} · ${event['事件名称']}</option>`).join('');
  $('#allRules').innerHTML = state.meta.rules.map((rule) => `
    <div class="governance-rule"><header><strong>${rule['规则主题']}</strong><code>${rule['规则编号']}</code></header>
    <p>触发：${rule['触发条件']}</p><p>行动：${rule['建议行动']} · 升级至 ${rule['建议升级对象']}</p></div>`).join('');
  $('#sourceList').innerHTML = state.meta.sources.map((source) => `
    <div class="source-item"><strong>${source['来源编号']} · ${source['资料名称']}</strong>
    <small>${source['发布机构']} · ${source['数据所属期间'] || '参考入口'} · ${source['复核状态']}</small></div>`).join('');
  $('#qualityList').innerHTML = state.meta.quality.map((item) => `
    <div class="quality-item"><span>${item['状态']}</span><strong>${item['问题编号']} · ${item['问题类型']}</strong>
    <small>${item['问题描述']}。处理：${item['处理方式']}</small></div>`).join('');
}

function bindEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.page)));
  $$('[data-go]').forEach((button) => button.addEventListener('click', () => {
    if (button.dataset.go === 'analysis') setAnalysisProgress(0);
    navigate(button.dataset.go);
  }));
  $('#newAnalysis').addEventListener('click', () => {
    setAnalysisProgress(0);
    navigate('analysis');
  });
  $('#menuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
  $('#presetSelect').addEventListener('change', loadPreset);
  $('#analysisForm').addEventListener('submit', submitAnalysis);
  $('#askForm').addEventListener('submit', askQuestion);
  $('#feedbackForm').addEventListener('submit', submitFeedback);
  $('#refreshHistory').addEventListener('click', loadHistory);
  $('#runTests').addEventListener('click', runTests);
  $('#downloadResult').addEventListener('click', downloadResult);
  $('#copyMessage').addEventListener('click', copyMessage);
  $$('.result-tab').forEach((button) => button.addEventListener('click', () => setResultTab(button.dataset.resultTab)));
  $$('.message-tab').forEach((button) => button.addEventListener('click', () => setMessage(button.dataset.message)));
  window.addEventListener('hashchange', () => {
    const page = location.hash.slice(1);
    if (page && $(`#page-${page}`)) navigate(page);
  });
}

async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    $('#metricAirports').textContent = data.metrics.airportCount;
    $('#metricAnalyses').textContent = data.metrics.analysisCount;
    $('#metricPending').textContent = data.metrics.pendingCount;
    $('#metricFeedback').textContent = data.metrics.feedbackCount;
    $('#airportTable').innerHTML = data.airports.map((item) => {
      const delta = (item.rate - item.peerRate) * 100;
      return `<tr><td><strong>${item.airport}</strong></td><td>${item.category}</td><td>${item.importance}</td>
        <td>${formatPct(item.rate)}</td><td>${formatPct(item.peerRate)}</td><td class="${delta >= 0 ? 'delta-up' : 'delta-down'}">${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp</td></tr>`;
    }).join('');
    $('#recentCases').innerHTML = data.recent.length ? data.recent.map((item) => `
      <div class="recent-item" data-analysis-id="${item.id}"><span class="risk-mini ${riskClass(item.risk)}">${item.risk}</span>
      <div><strong>${item.input.airport} · ${item.input.name || '未命名事件'}</strong><small>${formatTime(item.generatedAt)} · ${item.status}</small></div><span>›</span></div>`).join('') : '尚无研判记录';
    $$('.recent-item').forEach((item) => item.addEventListener('click', () => openAnalysis(item.dataset.analysisId)));
  } catch (error) { toast(error.message); }
}

function loadPreset() {
  const item = state.meta.events.find((event) => event['事件编号'] === $('#presetSelect').value);
  if (!item) return;
  fillForm(item.preset);
  setAnalysisProgress(0);
  toast(`已载入 ${item['事件编号']}：${item['事件名称']}`);
}

function fillForm(values) {
  const form = $('#analysisForm');
  Object.entries(values).forEach(([key, value]) => {
    const input = form.elements[key];
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else if (['currentRate', 'sourceA', 'sourceB'].includes(key) && value != null) input.value = value * 100;
    else input.value = value ?? '';
  });
}

function formEvent() {
  const form = $('#analysisForm');
  const data = Object.fromEntries(new FormData(form));
  ['weatherRisk', 'operatingPressure', 'formalDelay', 'conflict', 'unreliable', 'safetyIssue'].forEach((key) => {
    data[key] = form.elements[key].checked;
  });
  ['currentRate', 'sourceA', 'sourceB'].forEach((key) => {
    if (data[key] === '') delete data[key];
    else data[key] = Number(data[key]) / 100;
  });
  data.confirmedSources = Number(data.confirmedSources || 0);
  const selected = state.meta.events.find((event) => event['事件编号'] === $('#presetSelect').value);
  if (selected) data.eventId = selected['事件编号'];
  return data;
}

async function submitAnalysis(event) {
  event.preventDefault();
  const button = $('#analyzeButton');
  button.disabled = true;
  button.textContent = '正在核对证据…';
  setAnalysisProgress(1);
  try {
    const result = await api('/api/analyze', { method: 'POST', body: JSON.stringify(formEvent()) });
    renderResult(result);
    toast(result.privacyRemoved ? '研判完成，输入中的个人信息已移除' : '研判完成，等待人工复核');
  } catch (error) { setAnalysisProgress(0); toast(error.message); }
  finally { button.disabled = false; button.innerHTML = '生成可解释研判 <span>→</span>'; }
}

function renderResult(result) {
  state.current = result;
  setAnalysisProgress(3);
  $('#resultEmpty').hidden = true;
  $('#analysisResult').hidden = false;
  $('#resultStatus').textContent = `${result.status} · 置信度 ${result.confidence}`;
  $('#riskBadge').textContent = result.risk;
  $('#riskBadge').className = `risk-badge ${riskClass(result.risk)}`;
  $('#resultAirport').textContent = `${result.input.airport} · ${result.input.name || '事件研判'}`;
  $('#resultSummary').textContent = result.summary;
  const signalLabels = result.signals.length ? result.signals : ['未确认异常信号'];
  $('#signalStrip').innerHTML = [...signalLabels, `规则 ${result.rules.length} 条`, `证据 ${result.evidence.length} 项`, result.privacyRemoved ? '已脱敏' : '无身份字段'].map((label) => `<span>${label}</span>`).join('');
  const delta = result.delta == null ? '缺少当前值' : `${result.delta >= 0 ? '+' : ''}${result.delta.toFixed(2)}pp`;
  $('#baselineMetrics').innerHTML = [
    ['参考月完成比例', formatPct(result.baseline.referenceRate), result.baseline.month],
    ['前12个月均值', formatPct(result.baseline.mean), `${result.baseline.historyStart} 至 ${result.baseline.historyEnd}`],
    ['同类机场平均', formatPct(result.baseline.peerRate), result.baseline.scale['机场分类']],
    ['当前相对历史', delta, result.anomaly ? '超过 -5pp 异常阈值' : '未触发量化异常'],
  ].map(([label, value, note]) => `<div class="mini-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join('');
  renderChart(result.baseline.trend);
  $('#actionList').innerHTML = result.actions.map((action) => `<div class="timeline-item"><span class="timeline-index">${String(action.priority).padStart(2, '0')}</span><div><h4>${action.owner}</h4><p>${action.text}</p><small>门槛：${action.gate}</small></div></div>`).join('');
  $('#gapList').innerHTML = result.gaps.map((gap) => `<li>${gap}</li>`).join('');
  $('#escalationText').textContent = result.escalation;
  $('#boundaryText').textContent = result.boundary;
  $('#evidenceList').innerHTML = result.evidence.map((item) => `<div class="evidence-item"><span class="evidence-kind">${item.kind}</span><div class="evidence-body"><p>${item.text}</p><small>${item.source} · ${item.period}</small></div></div>`).join('');
  $('#ruleList').innerHTML = result.rules.map((rule) => `<div class="rule-card"><code>${rule['规则编号']}</code> <strong>${rule['规则主题']}</strong><p>${rule['触发条件']}</p><p>禁止：${rule['禁止自动执行事项']}</p></div>`).join('');
  $('#definitionText').textContent = result.disruptionDefinition;
  setMessage('operations');
  setResultTab('decision');
  $('#answerBox').hidden = true;
  if (window.innerWidth < 900) $('#analysisResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderChart(trend) {
  const values = trend.flatMap((item) => [item.rate, item.peerRate]);
  const min = Math.min(...values) - 0.015;
  const max = Math.max(...values) + 0.015;
  const width = 800; const height = 220; const left = 44; const right = 15; const top = 12; const bottom = 28;
  const x = (index) => left + index * (width - left - right) / (trend.length - 1);
  const y = (value) => top + (max - value) * (height - top - bottom) / (max - min);
  const path = (key) => trend.map((item, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(item[key]).toFixed(1)}`).join(' ');
  const grids = [0, .25, .5, .75, 1].map((fraction) => {
    const yy = top + fraction * (height - top - bottom);
    const value = max - fraction * (max - min);
    return `<line class="grid" x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}"/><text x="2" y="${yy + 3}">${(value * 100).toFixed(0)}%</text>`;
  }).join('');
  const labels = trend.map((item, index) => index % 3 === 0 || index === trend.length - 1 ? `<text x="${x(index)}" y="${height - 6}" text-anchor="middle">${item.month.slice(2)}</text>` : '').join('');
  const points = trend.map((item, index) => `<circle class="point" cx="${x(index)}" cy="${y(item.rate)}" r="3"/>`).join('');
  $('#trendChart').innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="机场与同类平均运行比例趋势">${grids}<path class="peer-line" d="${path('peerRate')}"/><path class="airport-line" d="${path('rate')}"/>${points}${labels}</svg>`;
}

function setResultTab(name) {
  $$('.result-tab').forEach((button) => button.classList.toggle('active', button.dataset.resultTab === name));
  $$('.result-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `result-${name}`));
}

function setMessage(type) {
  state.messageType = type;
  $$('.message-tab').forEach((button) => button.classList.toggle('active', button.dataset.message === type));
  $('#messageText').textContent = state.current?.drafts[type] || '';
}

async function askQuestion(event) {
  event.preventDefault();
  if (!state.current) return;
  try {
    const data = await api('/api/ask', { method: 'POST', body: JSON.stringify({ analysisId: state.current.id, question: $('#questionInput').value }) });
    $('#answerBox').textContent = data.answer;
    $('#answerBox').hidden = false;
  } catch (error) { toast(error.message); }
}

async function submitFeedback(event) {
  event.preventDefault();
  if (!state.current) return;
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  data.resourceAdequate = form.elements.resourceAdequate.checked;
  try {
    const response = await api(`/api/analyses/${state.current.id}/feedback`, { method: 'POST', body: JSON.stringify(data) });
    toast(response.revision ? '反馈已记录，并生成保留原记录的修订版' : '反馈已记录');
    if (response.revision) renderResult(response.revision);
    else {
      state.current.status = '已接受';
      $('#resultStatus').textContent = '已接受 · 人工复核完成';
      setAnalysisProgress(3, true);
    }
  } catch (error) { toast(error.message); }
}

async function loadHistory() {
  try {
    const data = await api('/api/analyses');
    $('#historyEmpty').hidden = data.analyses.length > 0;
    $('#historyTable').innerHTML = data.analyses.map((item) => `<tr><td>${formatTime(item.generatedAt)}</td><td><strong>${item.input.airport}</strong><br><span class="subtle">${item.input.name || '未命名事件'}</span></td><td><span class="risk-pill ${riskClass(item.risk)}">${item.risk}</span></td><td>${item.confidence}</td><td><span class="status-pill">${item.status}</span></td><td>${item.evidence.length} / ${item.rules.length}</td><td><button class="table-action" data-open="${item.id}">查看 →</button></td></tr>`).join('');
    $$('[data-open]').forEach((button) => button.addEventListener('click', () => openAnalysis(button.dataset.open)));
  } catch (error) { toast(error.message); }
}

async function openAnalysis(id) {
  try {
    const result = await api(`/api/analyses/${id}`);
    navigate('analysis');
    $('#presetSelect').value = result.input.eventId || '';
    fillForm(result.input);
    renderResult(result);
  } catch (error) { toast(error.message); }
}

async function runTests() {
  const button = $('#runTests');
  button.disabled = true; button.textContent = '正在运行…';
  try {
    const report = await api('/api/evaluation');
    $('#testSummary').innerHTML = `<strong>${report.passed}/${report.total}</strong><span>通过 · ${(report.passRate * 100).toFixed(1)}% · ${formatTime(report.generatedAt)}</span>`;
    $('#testGrid').innerHTML = report.cases.map((item) => `<article class="test-card ${item.passed ? 'pass' : 'fail'}"><header><code>${item.id}</code><b>${item.passed ? '通过' : '失败'}</b></header><h4>${item.type}</h4><p>${item.evidence}</p></article>`).join('');
    toast(`${report.passed}/${report.total} 项测试通过`);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = '重新运行测试'; }
}

async function downloadResult() {
  if (!state.current) return;
  try {
    const data = await api(`/api/analyses/${state.current.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${data['事件编号']}-标准输出.json`; anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) { toast(error.message); }
}

async function copyMessage() {
  if (!state.current) return;
  try { await navigator.clipboard.writeText(state.current.drafts[state.messageType]); toast('草案已复制，发布前仍须人工审核'); }
  catch { toast('浏览器未允许复制，请手动选择文本'); }
}

init();
