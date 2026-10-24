import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, answerQuestion, airports, baselineFor, preset, standardOutput, tables } from './lib/engine.mjs';
import { runEvaluation } from './lib/evaluation.mjs';
import { getAnalysis, listAnalyses, listFeedback, saveAnalysis, saveFeedback } from './lib/repository.mjs';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function send(response, status, body, type = 'application/json; charset=utf-8') {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : body;
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求不是有效 JSON'); }
}

function dashboard() {
  const analyses = listAnalyses();
  const feedback = listFeedback();
  const latest = airports.map((airport) => {
    const base = baselineFor(airport, '2025-12');
    return {
      airport,
      rate: base.referenceRate,
      peerRate: base.peerRate,
      mean: base.mean,
      category: base.scale['机场分类'],
      importance: base.scale['航空公司业务重要程度'],
    };
  });
  return {
    airports: latest,
    metrics: {
      airportCount: airports.length,
      analysisCount: analyses.length,
      pendingCount: analyses.filter((item) => item.status === '待复核').length,
      feedbackCount: feedback.length,
    },
    recent: analyses.slice(0, 8),
  };
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return send(response, 200, { ok: true, service: '航策 FlightGuard' });
  if (request.method === 'GET' && url.pathname === '/api/meta') {
    return send(response, 200, {
      airports,
      events: tables.events.map((event) => ({ ...event, preset: preset(event) })),
      rules: tables.rules,
      tests: tables.tests,
      sources: tables.sources,
      quality: tables.quality,
      sampleFeedback: tables.sampleFeedback,
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/dashboard') return send(response, 200, dashboard());
  if (request.method === 'GET' && url.pathname === '/api/analyses') return send(response, 200, { analyses: listAnalyses(), feedback: listFeedback() });
  if (request.method === 'POST' && url.pathname === '/api/analyze') {
    const result = saveAnalysis(analyze(await readJson(request)));
    return send(response, 201, result);
  }
  if (request.method === 'POST' && url.pathname === '/api/ask') {
    const body = await readJson(request);
    const result = body.analysisId ? getAnalysis(body.analysisId) : analyze(body.event || body);
    if (!result) return send(response, 404, { error: '找不到分析记录' });
    return send(response, 200, { answer: answerQuestion(result, body.question), analysisId: result.id });
  }
  if (request.method === 'GET' && url.pathname === '/api/evaluation') return send(response, 200, runEvaluation());

  const analysisMatch = url.pathname.match(/^\/api\/analyses\/([\w-]+)$/);
  if (request.method === 'GET' && analysisMatch) {
    const result = getAnalysis(analysisMatch[1]);
    return result ? send(response, 200, { ...result, feedback: listFeedback(result.id) }) : send(response, 404, { error: '找不到分析记录' });
  }
  const exportMatch = url.pathname.match(/^\/api\/analyses\/([\w-]+)\/export$/);
  if (request.method === 'GET' && exportMatch) {
    const result = getAnalysis(exportMatch[1]);
    return result ? send(response, 200, standardOutput(result)) : send(response, 404, { error: '找不到分析记录' });
  }
  const feedbackMatch = url.pathname.match(/^\/api\/analyses\/([\w-]+)\/feedback$/);
  if (request.method === 'POST' && feedbackMatch) {
    const body = await readJson(request);
    const original = getAnalysis(feedbackMatch[1]);
    if (!original) return send(response, 404, { error: '找不到分析记录' });
    const feedback = saveFeedback(original.id, body);
    let revision = null;
    if (body.decision !== '接受') {
      revision = saveAnalysis(analyze({
        ...original.input,
        humanRejected: true,
        humanReason: body.reason,
        resourceAdequate: Boolean(body.resourceAdequate),
        known: [original.input.known, body.addedFacts].filter(Boolean).join('；'),
      }), original.id);
    }
    return send(response, 201, { feedback, revision });
  }
  return false;
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const file = join(publicDir, safe);
  if (!file.startsWith(publicDir)) return send(response, 403, { error: '禁止访问' });
  try {
    const body = await readFile(file);
    return send(response, 200, body, mime[extname(file)] || 'application/octet-stream');
  } catch {
    if (!extname(requested)) {
      const body = await readFile(join(publicDir, 'index.html'));
      return send(response, 200, body, mime['.html']);
    }
    return send(response, 404, { error: '页面不存在' });
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(request, response, url);
      if (handled !== false) return;
      return send(response, 404, { error: '接口不存在' });
    }
    return await serveStatic(response, url.pathname);
  } catch (error) {
    return send(response, 400, { error: error.message || '请求处理失败' });
  }
});

server.listen(port, host, () => {
  console.log(`航策 FlightGuard 已启动：http://${host}:${port}`);
});
