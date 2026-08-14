/**
 * Nova eval dashboard — a zero-dependency node:http server (the direct structural peer of
 * earnings-avatar-q2/server/server.js) that drives the exact same engine.mjs/artifacts.mjs
 * logic run.mjs uses, but streams live per-turn progress to a browser over SSE instead of
 * stdout, and exposes the latest report, the run history, the live persona inventory, and an
 * ad-hoc single-prompt tester, a `trials` query param on `/api/run/stream` for pass^k confidence
 * runs, and a `/api/judge/prompt` + `/api/judge/import` pair for folding in an external
 * LLM-judge pass (see GUIDELINES.md) — so the suite can be run, measured, and iterated on from a
 * page instead of a terminal. Only one run at a time (`running` guard below): this is a local
 * single-operator dev tool, not a multi-tenant service.
 *
 * Run: node tests/eval/dashboard/server.mjs [port]
 *      (or: npm run eval:dashboard)
 * Then open the printed URL.
 */
import http from 'node:http';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { Management } from '../../../vendor/sdk/src/management/index.js';
import { loadEnv } from '../../../load-env.mjs';
import { loadSiteData } from '../site-data.mjs';
import { buildPersonas } from '../personas.mjs';
import { scoreTurn } from '../probes.mjs';
import { runEval, runTurn } from '../engine.mjs';
import { writeArtifacts, listHistory, renderMarkdown } from '../artifacts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EVAL_ROOT = join(__dirname, '..');              // tests/eval/
const APP_ROOT = join(EVAL_ROOT, '..', '..');         // repo root (this app is the whole repo)
const REPO = APP_ROOT;
const ART = join(EVAL_ROOT, 'artifacts');
const HISTORY = join(ART, 'history');
const PUBLIC = join(__dirname, 'public');
const PORT = Number(process.argv[2] || process.env.NOVA_DASHBOARD_PORT || 8093);

loadEnv(REPO);

const partnerId = process.env.AGENTIC_PARTNER_ID;
const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
if (!partnerId || !adminSecret) { console.error('Set AGENTIC_PARTNER_ID + AGENTIC_ADMIN_SECRET.'); process.exit(2); }

const management = new Management({ partnerId, adminSecret });
const agent = JSON.parse(await readFile(join(APP_ROOT, 'server', 'agent.json'), 'utf8'));
const siteData = await loadSiteData();
const PERSONAS = buildPersonas(siteData);

let running = false;

async function latestReport() {
  try { return JSON.parse(await readFile(join(ART, 'report.json'), 'utf8')); } catch { return null; }
}

function sseSend(res, evt) {
  if (res.writableEnded) return;
  try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* client gone — run continues headless */ }
}

async function handleRunStream(res, url) {
  if (running) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'a run is already in progress' }));
  }
  const idsParam = url.searchParams.get('ids');
  const ids = idsParam ? idsParam.split(',').filter(Boolean) : null;
  const personas = ids ? PERSONAS.filter((p) => ids.includes(p.id)) : PERSONAS;
  if (!personas.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'no matching persona ids' }));
  }
  const trialsParam = Number(url.searchParams.get('trials') || 1);
  const trials = Number.isInteger(trialsParam) && trialsParam > 0 ? trialsParam : 1;

  running = true;
  res.on('error', () => {});
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const totalTurns = personas.reduce((n, p) => n + p.turns.length, 0);
  sseSend(res, { type: 'start', totalTurns, personaIds: personas.map((p) => p.id), trials });

  try {
    const report = await runEval({
      management, configId: agent.configId, siteData, personas, trials,
      onEvent: (evt) => sseSend(res, evt),
    });
    // A filtered (subset) run is for quick iteration — don't let it overwrite the full-suite
    // "latest" report/history that the dashboard's summary and trend views treat as ground truth.
    if (!ids) await writeArtifacts(report, { artDir: ART, historyDir: HISTORY });
    sseSend(res, { type: 'done', partial: !!ids, wroteArtifacts: !ids });
  } catch (e) {
    sseSend(res, { type: 'run-error', error: String(e?.message || e) });
  } finally {
    running = false;
    if (!res.writableEnded) res.end();
  }
}

async function handleQuickTest(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return { error: { code: 'bad_request', detail: 'prompt (string) required.' } };
  const expectation = (body?.expectation && typeof body.expectation === 'object') ? body.expectation : {};
  // Mirrors personas.mjs's simulateHighlightSuccess opt-in — lets the dashboard's Quick Test
  // exercise the highlight-success narration path on an ad-hoc prompt too, not just fixed personas.
  const highlightAck = body?.simulateHighlightSuccess
    ? { ok: true, id: typeof body.simulateHighlightSuccess === 'string' ? body.simulateHighlightSuccess : 'simulated', label: body.simulateHighlightLabel || 'that' }
    : undefined;
  const r = await runTurn({ management, configId: agent.configId, message: prompt, threadId: null, routes: siteData.routes, highlightAck });
  const rec = { prompt, expectation, latencyMs: r.latencyMs, text: r.text, toolCalls: r.toolCalls, acks: r.acks, error: r.error };
  return { ...rec, scored: scoreTurn(rec, siteData) };
}

const JUDGE_RUBRIC = `You are grading transcript.json from Nova, the live SDK-docs assistant on the @kaltura/intelligent-agents docs site. For EACH turn, answer four yes/no/unknown questions:
1. completeness — did the reply actually answer what was asked, not just gesture at it?
2. relevance — is every sentence on-topic for the question, with no unrelated tangent?
3. toneFit — does it sound like Nova (warm, concise, docs-focused), not a generic chatbot?
4. navHelpfulness — if a page navigation happened this turn, did the reply correctly frame WHY that page answers the question? (answer "unknown" if no navigation happened this turn)

Use "unknown" rather than forcing a guess when the transcript doesn't give you enough context. Return ONLY a JSON array, one object per turn, in the same order as the transcript, shaped like:
[{"personaId": "...", "prompt": "...", "completeness": "yes"|"no"|"unknown", "relevance": "yes"|"no"|"unknown", "toneFit": "yes"|"no"|"unknown", "navHelpfulness": "yes"|"no"|"unknown", "notes": "one sentence, optional"}]

Transcript to grade:
`;

async function buildJudgePrompt() {
  let transcript;
  try { transcript = JSON.parse(await readFile(join(ART, 'transcript.json'), 'utf8')); }
  catch { return { error: { code: 'not_found', detail: 'no transcript.json yet — run the eval at least once first.' } }; }
  return { prompt: JUDGE_RUBRIC + JSON.stringify(transcript, null, 2) };
}

async function importJudgeVerdicts(body) {
  if (body === undefined || body === null) return { error: { code: 'bad_request', detail: 'a JSON body (the verdicts) is required.' } };
  const report = await latestReport();
  if (!report) return { error: { code: 'not_found', detail: 'no report.json yet — run the eval at least once first.' } };
  report.judge = body;
  report._meta.judge = true;
  await writeFile(join(ART, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(ART, 'report.md'), renderMarkdown(report));
  return { report };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/run/stream') return await handleRunStream(res, url);
    if (req.method === 'GET' && url.pathname === '/api/meta') {
      return sendJson(res, 200, {
        configId: agent.configId, siteDir: siteData.siteDir, running,
        personas: PERSONAS.map((p) => ({ id: p.id, persona: p.persona, category: p.category, turnCount: p.turns.length })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/report/latest') return sendJson(res, 200, { report: await latestReport(), running });
    if (req.method === 'GET' && url.pathname === '/api/history') return sendJson(res, 200, { history: await listHistory(HISTORY) });
    if (req.method === 'GET' && url.pathname.startsWith('/api/history/')) {
      const file = decodeURIComponent(url.pathname.slice('/api/history/'.length));
      if (!/^[\w.-]+\.json$/.test(file)) return sendJson(res, 400, { error: 'bad file name' });
      try { return sendJson(res, 200, { report: JSON.parse(await readFile(join(HISTORY, file), 'utf8')) }); }
      catch { return sendJson(res, 404, { error: 'not found' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/personas') {
      return sendJson(res, 200, {
        personas: PERSONAS.map((p) => ({ id: p.id, persona: p.persona, category: p.category, turns: p.turns })),
        siteData: { siteDir: siteData.siteDir, baseUrl: siteData.baseUrl, routes: siteData.routes, highlightTargets: siteData.highlightTargets },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/quick-test') return sendJson(res, 200, await handleQuickTest(await readJson(req)));
    if (req.method === 'GET' && url.pathname === '/api/judge/prompt') return sendJson(res, 200, await buildJudgePrompt());
    if (req.method === 'POST' && url.pathname === '/api/judge/import') return sendJson(res, 200, await importJudgeVerdicts(await readJson(req)));
    if (req.method === 'GET') return await serveStatic(url.pathname, res);
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { error: { code: 'server_error', detail: String(err?.message || err) } });
  }
});

function readJson(req) { return new Promise((resolve, reject) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } }); req.on('error', reject); }); }
function sendJson(res, status, obj) { const s = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(s); }

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
  try {
    const st = await stat(file); if (st.isDirectory()) return sendJson(res, 403, { error: 'forbidden' });
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  } catch { sendJson(res, 404, { error: 'not found', path: pathname }); }
}

server.listen(PORT, '127.0.0.1', () => console.log(`Nova eval dashboard on http://localhost:${PORT}  (configId ${agent.configId}, ${PERSONAS.length} personas, ${PERSONAS.reduce((n, p) => n + p.turns.length, 0)} turns)`));
export { server };
