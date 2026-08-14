/* Nova eval dashboard — vanilla JS, no build step, no dependencies. Talks to dashboard/server.mjs. */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function pct(x) { return x == null ? '—' : `${Math.round(x * 100)}%`; }

/* ---------- tabs ---------- */
$$('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
    $$('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`#tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'history') loadHistory();
    if (btn.dataset.tab === 'personas') loadPersonas();
    if (btn.dataset.tab === 'judge') loadJudgePrompt();
  });
});

/* ---------- status pill ---------- */
function setStatus(kind, label) {
  const pill = $('#status-pill');
  pill.className = `pill pill-${kind}`;
  pill.textContent = label;
}

/* ---------- meta + persona checkboxes ---------- */
async function loadMeta() {
  const r = await fetch('/api/meta').then((r) => r.json());
  $('#meta-line').textContent = `configId ${r.configId} · ${r.siteDir} · ${r.personas.length} personas, ${r.personas.reduce((n, p) => n + p.turnCount, 0)} turns`;
  const wrap = $('#persona-checks');
  wrap.innerHTML = r.personas.map((p) => `
    <label class="persona-check">
      <input type="checkbox" value="${esc(p.id)}" checked />
      ${esc(p.id)} (${p.turnCount})
    </label>
  `).join('');
  if (r.running) { setStatus('running', 'run in progress'); setRunButtonsEnabled(false); }
  return r;
}

$('#btn-select-all').addEventListener('click', () => $$('#persona-checks input').forEach((i) => (i.checked = true)));
$('#btn-select-none').addEventListener('click', () => $$('#persona-checks input').forEach((i) => (i.checked = false)));

function setRunButtonsEnabled(enabled) {
  $('#btn-run-all').disabled = !enabled;
  $('#btn-run-selected').disabled = !enabled;
}

/* ---------- latest report on load ---------- */
async function loadLatestReport() {
  const r = await fetch('/api/report/latest').then((r) => r.json());
  if (r.report) {
    renderSummary(r.report, $('#run-summary'));
    $('#run-summary').hidden = false;
    setStatus(r.report.summary.healthy ? 'healthy' : 'blocked', r.report.summary.healthy ? 'healthy' : 'release-blocked');
  }
}

/* ---------- live run ---------- */
let es = null;
let seenTurns = 0;
let totalTurns = 0;

function startRun(ids) {
  if (es) es.close();
  $('#live-log').innerHTML = '';
  $('#run-summary').hidden = true;
  $('#progress-wrap').hidden = false;
  $('#progress-fill').style.width = '0%';
  seenTurns = 0;
  setRunButtonsEnabled(false);
  setStatus('running', 'running…');

  const params = new URLSearchParams();
  if (ids) params.set('ids', ids.join(','));
  const trials = Number($('#trials-input').value) || 1;
  if (trials > 1) params.set('trials', String(trials));
  const qs = params.toString() ? `?${params}` : '';
  es = new EventSource(`/api/run/stream${qs}`);
  es.onmessage = (msg) => {
    const evt = JSON.parse(msg.data);
    handleRunEvent(evt);
  };
  es.onerror = () => {
    es.close();
    setRunButtonsEnabled(true);
    if (seenTurns < totalTurns) $('#progress-label').textContent += ' (stream closed early)';
  };
}

function handleRunEvent(evt) {
  const log = $('#live-log');
  if (evt.type === 'start') {
    totalTurns = evt.totalTurns;
    $('#progress-label').textContent = `0 / ${totalTurns}`;
  } else if (evt.type === 'trial-start') {
    seenTurns = 0;
    const h = document.createElement('div');
    h.className = 'log-persona';
    h.textContent = `▶▶ trial ${evt.trial}/${evt.trials}`;
    log.appendChild(h);
    $('#progress-label').textContent = `trial ${evt.trial}/${evt.trials} · 0 / ${totalTurns}`;
  } else if (evt.type === 'persona-start') {
    const h = document.createElement('div');
    h.className = 'log-persona';
    h.textContent = evt.persona;
    log.appendChild(h);
  } else if (evt.type === 'turn') {
    seenTurns++;
    log.appendChild(renderTurnLine(evt.turn));
    log.scrollTop = log.scrollHeight;
    const p = totalTurns ? Math.round((seenTurns / totalTurns) * 100) : 0;
    $('#progress-fill').style.width = `${p}%`;
    $('#progress-label').textContent = `${seenTurns} / ${totalTurns}`;
  } else if (evt.type === 'summary') {
    renderSummary(evt.report, $('#run-summary'));
    $('#run-summary').hidden = false;
    setStatus(evt.report.summary.healthy ? 'healthy' : 'blocked', evt.report.summary.healthy ? 'healthy' : 'release-blocked');
  } else if (evt.type === 'done') {
    setRunButtonsEnabled(true);
    es.close();
  } else if (evt.type === 'run-error') {
    setRunButtonsEnabled(true);
    setStatus('blocked', 'run error');
    const h = document.createElement('div');
    h.className = 'log-turn blocked';
    h.textContent = `Run error: ${evt.error}`;
    log.appendChild(h);
    es.close();
  }
}

function renderTurnLine(t) {
  const s = t.scored;
  const div = document.createElement('div');
  div.className = `log-turn ${s.releaseBlockingFails.length ? 'blocked' : s.failed.length ? 'fail' : 'pass'}`;
  const tools = (t.toolCalls || []).map((c) => c.name).join(', ') || '–';
  const tags = [
    ...s.releaseBlockingFails.map((f) => `<span class="tag tag-blocked">⛔ ${esc(f)}</span>`),
    ...s.failed.filter((f) => !s.releaseBlockingFails.includes(f)).map((f) => `<span class="tag tag-fail">${esc(f)}</span>`),
  ].join(' ');
  const flaky = flakyBadge(s.reliability);
  div.innerHTML = `
    <div class="log-prompt">"${esc(t.prompt)}"</div>
    <div class="log-detail">${t.latencyMs}ms · ${pct(s.overallScore)} · tools: ${esc(tools)}${t.error ? ` · <span class="tag tag-blocked">error: ${esc(t.error)}</span>` : ''}${flaky}</div>
    ${tags ? `<div class="log-detail">${tags}</div>` : ''}
  `;
  return div;
}

/* A turn is flaky when it passed at least one trial but not every trial (pass@k true, pass^k
   false) — the exact signal that distinguishes run-to-run non-determinism from a genuine
   regression on a --trials run. */
function flakyBadge(rel) {
  if (!rel || !rel.passAtK || rel.passPowK) return '';
  return ` <span class="tag tag-flaky">🎲 flaky (${rel.passCount}/${rel.trials} trials passed)</span>`;
}

$('#btn-run-all').addEventListener('click', () => startRun(null));
$('#btn-run-selected').addEventListener('click', () => {
  const ids = $$('#persona-checks input:checked').map((i) => i.value);
  if (!ids.length) return alert('Select at least one persona.');
  startRun(ids);
});

/* ---------- summary rendering (shared by live run + history detail) ---------- */
function renderSummary(report, container) {
  const s = report.summary;
  const dimRows = Object.entries(s.dimensions)
    .filter(([, v]) => v != null)
    .map(([k, v]) => {
      const cls = v >= 0.95 ? '' : v >= 0.8 ? 'warn' : 'bad';
      return `<div class="dim-row"><span>${esc(k)}</span><div class="dim-track"><div class="dim-fill ${cls}" style="width:${Math.round(v * 100)}%"></div></div><span>${pct(v)}</span></div>`;
    }).join('');
  const blocking = report.releaseBlockingFails.length
    ? `<div class="log-detail">${report.releaseBlockingFails.map((f) => `⛔ "${esc(f.prompt)}" — ${esc(f.fails.join(', '))}`).join('<br/>')}</div>`
    : '';
  const reliability = s.reliability ? `
    <div class="reliability-banner">
      🎲 <b>Reliability (${s.reliability.trials} trials, pass^k gating):</b>
      ${s.reliability.turnsPassPowK}/${s.reliability.totalTurns} turns passed every trial ·
      ${s.reliability.turnsFlaky} flaky turn${s.reliability.turnsFlaky === 1 ? '' : 's'}
    </div>` : '';
  const judge = report.judge ? `
    <div class="judge-fold">
      <div class="judge-fold-header">Qualitative judge verdicts folded in</div>
      <pre>${esc(typeof report.judge === 'string' ? report.judge : JSON.stringify(report.judge, null, 2))}</pre>
    </div>` : '';
  container.innerHTML = `
    <div class="summary-headline">${s.healthy ? '✅ Healthy' : '⛔ RELEASE BLOCKED'} — ${report._meta.generatedAt}</div>
    <div class="summary-stats">
      <span><b>${pct(s.overall)}</b> overall</span>
      <span>${s.totalTurns} turns</span>
      <span>${s.releaseBlockingFailCount} release-blocking</span>
      <span>${s.erroredTurnCount} errored</span>
      <span>${s.routesExercised}/${s.routesTotal} routes</span>
      <span>p50 ${s.latency.p50}ms · p90 ${s.latency.p90}ms</span>
    </div>
    ${reliability}
    ${blocking}
    <div class="dim-bars">${dimRows}</div>
    ${judge}
    ${renderPersonaDetail(report.personas)}
  `;
}

/* Per-persona/turn breakdown — always available on a completed report (unlike the live-log,
   which only ever shows the trial currently streaming), and the only place a flaky badge is
   backed by real reliability data rather than a single trial's transient score. */
function renderPersonaDetail(personas) {
  if (!personas || !personas.length) return '';
  const rows = personas.map((p) => {
    const avg = p.turns.reduce((a, t) => a + t.overall, 0) / p.turns.length;
    const turnRows = p.turns.map((t) => {
      const tag = t.releaseBlockingFails.length ? '⛔' : t.failed.length ? `✗ ${esc(t.failed.join(', '))}` : '✓';
      const cls = t.releaseBlockingFails.length ? 'blocked' : t.failed.length ? 'fail' : 'pass';
      return `<div class="log-turn ${cls}"><span class="turn-tag">${tag}</span> "${esc(t.prompt)}" — ${t.latencyMs}ms${flakyBadge(t.reliability)}</div>`;
    }).join('');
    return `<div class="persona-group"><h3>${esc(p.persona)} — ${pct(avg)}</h3>${turnRows}</div>`;
  }).join('');
  return `<details class="persona-detail"><summary>Per-persona detail (${personas.length} personas)</summary>${rows}</details>`;
}

/* ---------- history ---------- */
async function loadHistory() {
  const { history } = await fetch('/api/history').then((r) => r.json());
  const list = $('#history-list');
  if (!history.length) { list.innerHTML = '<p class="hint">No runs recorded yet.</p>'; return; }
  list.innerHTML = history.map((h) => `
    <div class="history-row" data-file="${esc(h.file)}">
      <div>${h.healthy ? '✅' : '⛔'} <b>${pct(h.overall)}</b> · ${h.totalTurns} turns</div>
      <div class="log-detail">${esc(h.generatedAt)} · ${h.releaseBlockingFailCount} blocking · ${h.erroredTurnCount} errored</div>
    </div>
  `).join('');
  $$('.history-row').forEach((row) => row.addEventListener('click', async () => {
    $$('.history-row').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    const { report } = await fetch(`/api/history/${encodeURIComponent(row.dataset.file)}`).then((r) => r.json());
    renderSummary(report, $('#history-detail'));
  }));
}

/* ---------- personas browser ---------- */
const FLAG_KEYS = ['expectTools', 'forbidTools', 'expectNavPath', 'relevanceAny', 'expectRestrictedRefusal', 'expectNoPromptLeak', 'expectNoInventedPath', 'expectNoInventedApi', 'isKickoff', 'mustHonor', 'skipCompleteness', 'simulateHighlightSuccess', 'simulateHighlightLabel'];

function personaGroupHtml(p) {
  return `
    <div class="persona-group">
      <h3>${esc(p.id)} — ${esc(p.persona)}</h3>
      ${p.turns.map((t) => `
        <div class="persona-turn">
          <div>"${esc(t.prompt)}"</div>
          <div class="tags">${FLAG_KEYS.filter((k) => t[k] != null && t[k] !== false).map((k) => `<span class="tag">${esc(k)}: ${esc(Array.isArray(t[k]) ? t[k].join(',') : t[k])}</span>`).join(' ')}</div>
        </div>
      `).join('')}
    </div>
  `;
}

async function loadPersonas() {
  const { personas } = await fetch('/api/personas').then((r) => r.json());
  const byCategory = new Map();
  for (const p of personas) {
    const cat = p.category || 'uncategorized';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p);
  }
  $('#personas-browser').innerHTML = [...byCategory.entries()].map(([cat, ps]) => `
    <div class="category-section">
      <h2 class="category-header"><span class="category-badge">${esc(cat)}</span> ${ps.length} persona${ps.length === 1 ? '' : 's'}</h2>
      ${ps.map(personaGroupHtml).join('')}
    </div>
  `).join('');
}

/* ---------- quick test ---------- */
$('#btn-quick-run').addEventListener('click', async () => {
  const prompt = $('#quick-prompt').value.trim();
  const out = $('#quick-result');
  if (!prompt) return alert('Enter a prompt.');
  let expectation = {};
  const raw = $('#quick-expectation').value.trim();
  if (raw) {
    try { expectation = JSON.parse(raw); }
    catch { return alert('Expectation must be valid JSON (or left blank).'); }
  }
  const simulateHighlightSuccess = $('#quick-simulate-highlight').checked;
  const simulateHighlightLabel = $('#quick-simulate-highlight-label').value.trim() || undefined;
  out.innerHTML = '<p class="hint">running…</p>';
  const r = await fetch('/api/quick-test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, expectation, simulateHighlightSuccess, simulateHighlightLabel }),
  }).then((r) => r.json());
  if (r.error) { out.innerHTML = `<p class="hint">Error: ${esc(r.error.detail || r.error.code)}</p>`; return; }
  const s = r.scored;
  const dims = Object.entries(s.results).filter(([, v]) => v != null).map(([k, v]) => `
    <div class="dim-row"><span>${esc(k)}${s.releaseBlockingFails.includes(k) ? ' ⛔' : ''}</span><span>${v.pass === false ? '✗ fail' : '✓ pass'}</span><span></span></div>
  `).join('');
  out.innerHTML = `
    <div class="summary-card">
      <div class="summary-headline">${s.healthy ? '✅ Healthy' : '⛔ Release-blocking failure'}</div>
      <div class="summary-stats">
        <span>${r.latencyMs}ms</span>
        <span>${pct(s.overallScore)} overall</span>
        <span>tools: ${esc((r.toolCalls || []).map((c) => c.name).join(', ') || '–')}</span>
      </div>
      <p><b>Reply:</b> ${esc(r.text) || '<i>(empty)</i>'}</p>
      ${r.error ? `<p class="hint">Error: ${esc(r.error)}</p>` : ''}
      <div class="dim-bars">${dims}</div>
    </div>
  `;
});

/* ---------- judge ---------- */
async function loadJudgePrompt() {
  const out = $('#judge-result');
  const box = $('#judge-prompt');
  box.value = 'loading…';
  const r = await fetch('/api/judge/prompt').then((r) => r.json());
  if (r.error) { box.value = ''; out.innerHTML = `<p class="hint">${esc(r.error.detail || r.error.code)}</p>`; return; }
  box.value = r.prompt;
  out.innerHTML = '';
}

$('#btn-judge-refresh').addEventListener('click', loadJudgePrompt);
$('#btn-judge-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($('#judge-prompt').value); }
  catch { /* clipboard permission denied — the textarea's own select-all/copy still works */ }
});
$('#btn-judge-import').addEventListener('click', async () => {
  const out = $('#judge-result');
  const raw = $('#judge-verdicts').value.trim();
  if (!raw) return alert('Paste the judge\'s JSON verdicts first.');
  let verdicts;
  try { verdicts = JSON.parse(raw); }
  catch { return alert('Verdicts must be valid JSON.'); }
  out.innerHTML = '<p class="hint">importing…</p>';
  const r = await fetch('/api/judge/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(verdicts),
  }).then((r) => r.json());
  if (r.error) { out.innerHTML = `<p class="hint">Error: ${esc(r.error.detail || r.error.code)}</p>`; return; }
  out.innerHTML = '<p class="hint">Imported — folded into report.json/report.md. See the summary below.</p>';
  renderSummary(r.report, $('#judge-summary'));
  $('#judge-summary').hidden = false;
  // Keep the Run tab's summary in sync too, in case the user switches back to it — same
  // report.json, now with the judge fold-in included.
  if (!$('#run-summary').hidden) renderSummary(r.report, $('#run-summary'));
});

/* ---------- boot ---------- */
loadMeta().then(loadLatestReport);
