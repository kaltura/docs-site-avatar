/**
 * Writes a scored report to disk in the three shapes both the CLI (`run.mjs`) and the dashboard
 * server (`dashboard/server.mjs`) need: the "latest" pair (`transcript.json`/`report.json`) plus
 * human-readable `report.md`, and a timestamped copy under `artifacts/history/` so a run's result
 * survives being overwritten by the next one — that history directory is what the dashboard's
 * trend view reads.
 */
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIMENSIONS, RELEASE_BLOCKING } from './probes.mjs';

/** @param {object} report @param {{artDir: string, historyDir: string}} dirs */
export async function writeArtifacts(report, { artDir, historyDir }) {
  await mkdir(artDir, { recursive: true });
  await mkdir(historyDir, { recursive: true });
  const transcript = {
    _meta: report._meta,
    personas: report.personas.map((p) => ({
      id: p.id,
      persona: p.persona,
      turns: p.turns.map((t) => ({ prompt: t.prompt, latencyMs: t.latencyMs, text: t.text, toolNames: t.toolNames })),
    })),
  };
  await writeFile(join(artDir, 'transcript.json'), JSON.stringify(transcript, null, 2));
  await writeFile(join(artDir, 'report.json'), JSON.stringify(report, null, 2));
  await writeFile(join(artDir, 'report.md'), renderMarkdown(report));
  // Colons aren't valid in a filename on every filesystem — the ISO value survives intact
  // inside the file's own _meta.generatedAt for exact display.
  const historyFile = `${report._meta.generatedAt.replace(/[:.]/g, '-')}.json`;
  await writeFile(join(historyDir, historyFile), JSON.stringify(report, null, 2));
  return { historyFile };
}

/** Lightweight index of every history snapshot — just enough for a trend list, without loading
 * every full report into memory. */
export async function listHistory(historyDir) {
  let files;
  try { files = await readdir(historyDir); } catch { return []; }
  const entries = [];
  for (const f of files.filter((f) => f.endsWith('.json')).sort().reverse()) {
    try {
      const r = JSON.parse(await readFile(join(historyDir, f), 'utf8'));
      entries.push({
        file: f,
        generatedAt: r._meta.generatedAt,
        overall: r.summary.overall,
        healthy: r.summary.healthy,
        releaseBlockingFailCount: r.summary.releaseBlockingFailCount,
        erroredTurnCount: r.summary.erroredTurnCount,
        totalTurns: r.summary.totalTurns,
      });
    } catch { /* skip an unreadable/partial snapshot */ }
  }
  return entries;
}

function bar(x) {
  const n = Math.round(x * 10);
  return '█'.repeat(n) + '░'.repeat(10 - n);
}

export function renderMarkdown(r) {
  const s = r.summary;
  const L = [];
  L.push('# Nova (docs-site-avatar) — Eval Report');
  L.push('');
  L.push(`_${r._meta.generatedAt} · configId ${r._meta.configId} · ${r._meta.routes} routes · site ${r._meta.siteDir}${r._meta.trials > 1 ? ` · ${r._meta.trials} trials (pass^k)` : ''}${r._meta.judge ? ' · qualitative judge folded in' : ''}_`);
  L.push('');
  L.push(`## ${s.healthy ? '✅ Healthy' : '⛔ RELEASE BLOCKED'}`);
  L.push('');
  L.push(`**Overall ${(s.overall * 100).toFixed(0)}%** across ${s.totalTurns} turns · ${s.turnsFailing} turns with a failing dimension · **${s.releaseBlockingFailCount} release-blocking failures** · **${s.erroredTurnCount} errored/timed-out turns** · ${s.routesExercised}/${s.routesTotal} real routes exercised via navigate_to_page`);
  L.push('');
  if (s.reliability) {
    L.push(`**Reliability (${s.reliability.trials} trials, pass^k gating):** ${s.reliability.turnsPassPowK}/${s.reliability.totalTurns} turns passed every trial · ${s.reliability.turnsFlaky} flaky turns (passed at least once, not every time — see per-turn detail below)`);
    L.push('');
  }
  L.push('| Dimension | Score |');
  L.push('|---|---|');
  for (const d of DIMENSIONS) if (s.dimensions[d] != null) L.push(`| ${d}${RELEASE_BLOCKING.includes(d) ? ' ⛔' : ''} | ${bar(s.dimensions[d])} ${(s.dimensions[d] * 100).toFixed(0)}% |`);
  L.push('');
  L.push(`**Latency:** p50 ${s.latency.p50}ms · p90 ${s.latency.p90}ms · max ${s.latency.max}ms · ${s.latency.slowTurns} turns >9s`);
  L.push('');
  L.push('## Coverage');
  L.push('');
  const c = r.coverage;
  L.push(`- **Tools** expected: ${c.expectedTools.join(', ')} — observed live: ${c.observedTools.join(', ') || 'none'}`);
  L.push(`- **Uncovered routes:** ${c.uncoveredRoutes.join(', ') || 'none'}`);
  L.push('');
  if (r.releaseBlockingFails.length) {
    L.push(`## ⛔ Release-blocking failures (${r.releaseBlockingFails.length})`);
    L.push('');
    for (const f of r.releaseBlockingFails) L.push(`- **"${f.prompt}"** — failed [${f.fails.join(',')}] — reply: "${f.text.slice(0, 200)}"`);
    L.push('');
  } else {
    L.push('## ✅ No release-blocking failures');
    L.push('');
  }
  if (r.erroredTurns.length) {
    L.push(`## ⛔ Errored/timed-out turns (${r.erroredTurns.length})`);
    L.push('');
    for (const f of r.erroredTurns) L.push(`- **"${f.prompt}"** — ${f.error}`);
    L.push('');
  }
  L.push('## Per-persona detail');
  L.push('');
  for (const p of r.personas) {
    const avg = p.turns.reduce((a, t) => a + t.overall, 0) / p.turns.length;
    L.push(`### ${p.persona} — ${(avg * 100).toFixed(0)}%`);
    L.push('');
    for (const t of p.turns) {
      const tag = t.releaseBlockingFails.length ? '⛔' : t.failed.length ? `✗ ${t.failed.join(',')}` : '✓';
      const flaky = t.reliability && t.reliability.passAtK && !t.reliability.passPowK ? ` 🎲 flaky (${t.reliability.passCount}/${t.reliability.trials} trials passed)` : '';
      const spiral = t.spiralDetected ? ` 🌀 spiral ${t.spiralRecovered ? 'recovered' : 'NOT recovered'} (rawToolSegCount=${t.rawToolSegCount})` : '';
      L.push(`- ${tag} **"${t.prompt}"** — ${t.latencyMs}ms [${t.toolNames.join(',') || '-'}]${t.error ? ' ! ' + t.error : ''}${flaky}${spiral}`);
      for (const [k, v] of Object.entries(t.results)) if (v && v.pass === false) L.push(`    - ${k}: ${JSON.stringify(v)}`);
    }
    L.push('');
  }
  if (r.judge) {
    L.push('## Qualitative judge');
    L.push('');
    L.push(typeof r.judge === 'string' ? r.judge : '```json\n' + JSON.stringify(r.judge, null, 2) + '\n```');
    L.push('');
  }
  L.push('---');
  L.push('_Generated by `tests/eval/run.mjs`. Re-run any time for comparable coverage._');
  return L.join('\n') + '\n';
}
