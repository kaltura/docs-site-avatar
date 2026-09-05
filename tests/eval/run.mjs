/**
 * Nova (docs-site-avatar) evaluation runner — the single entry point for "test it like a real
 * visitor asking every plausible question, and prove the release-blocking correctness rules
 * hold."
 *
 * Drives the REAL provisioned brain (configId from server/agent.json) headlessly via the SDK's
 * `Conversations.stream()` — plus, for the chat-mode/transport-switch/page-context personas,
 * via the SDK's real `KalturaChatSession` (see chat-transport.mjs) — self-ACKing
 * `navigate_to_page` tool calls exactly like a real browser session's `respondToTool()`
 * would (see transport.mjs). Route/highlight-target ground
 * truth loads live from the site checkout (see site-data.mjs) so the suite can never drift out
 * of sync with the real nav. A run with any release-blocking probe failure (invented URL/path,
 * a restricted-topic answer that isn't a refusal, a leaked prompt, or a knowledge-base search
 * firing while `use_knowledge_base:'off'`) exits non-zero.
 *
 * The actual turn-loop/scoring/aggregation logic lives in engine.mjs, and artifact writing in
 * artifacts.mjs, so the dashboard server (dashboard/server.mjs) can drive the identical live
 * behavior with progress events instead of stdout logging — this file is just the CLI shell.
 *
 * Run:
 *   node tests/eval/run.mjs
 *   AGENTIC_PARTNER_ID=… AGENTIC_ADMIN_SECRET=… node tests/eval/run.mjs
 *   SITE_REPO_DIR=/path/to/site node tests/eval/run.mjs
 *   node tests/eval/run.mjs --trials 3            # pass^k confidence run (3x live calls)
 *   node tests/eval/run.mjs --judge verdicts.json # fold in an external LLM-judge pass (see GUIDELINES.md)
 *   node tests/eval/run.mjs --no-warmup           # skip the knowledge-retrieval warm-up gate
 *
 * Outputs (under tests/eval/artifacts/):
 *   transcript.json    raw turns (prompt, latency, text, toolCalls) — feed this to an LLM judge
 *   report.json         scored, with a coverage matrix + summary (always the latest run)
 *   report.md           the human-readable summary report
 *   history/<ts>.json   a timestamped copy of report.json, kept so the dashboard can chart trends
 *
 * For live progress in a browser instead of a terminal, run `npm run eval:dashboard` and open
 * the printed URL — same engine, same scoring, streamed to a page instead of stderr.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Management } from '../../vendor/sdk/src/management/index.js';
import { loadEnv } from '../../load-env.mjs';
import { loadSiteData } from './site-data.mjs';
import { buildPersonas } from './personas.mjs';
import { toolNames } from './probes.mjs';
import { streamTurnWithAck } from './transport.mjs';
import { runEval } from './engine.mjs';
import { writeArtifacts } from './artifacts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const ART = join(__dirname, 'artifacts');
const HISTORY = join(ART, 'history');

loadEnv(ROOT);

const agent = JSON.parse(await readFile(join(ROOT, 'server', 'agent.json'), 'utf8'));
const management = new Management({ partnerId: process.env.AGENTIC_PARTNER_ID, adminSecret: process.env.AGENTIC_ADMIN_SECRET });
const siteData = await loadSiteData();
const PERSONAS = buildPersonas(siteData);

const log = (m) => process.stderr.write(m + '\n');

const trialsArg = process.argv.includes('--trials') ? Number(process.argv[process.argv.indexOf('--trials') + 1]) : 1;
const trials = Number.isInteger(trialsArg) && trialsArg > 0 ? trialsArg : 1;
const judgeArg = process.argv.includes('--judge') ? process.argv[process.argv.indexOf('--judge') + 1] : null;

log(`▶ loaded ${siteData.routes.length} routes, ${siteData.highlightTargets.length} tagged highlight targets, ${siteData.headingTargets.length} heading targets (the page-context persona pushes one page's headings as live page_context) from ${siteData.siteDir}`);
if (siteData.untaggedRoutes.length) log(`  (untagged pages, expected — not every page needs a highlight target: ${siteData.untaggedRoutes.map((r) => r.url).join(', ')})`);
if (trials > 1) log(`▶ running ${trials} trials per persona for pass^k reliability gating`);

/**
 * Knowledge-retrieval warm-up gate. `isIndexed` reporting ready during provisioning does NOT
 * mean fine-grained retrieval is warm: a CI eval that started 3s after a redeploy scored 65%
 * relevance with every failing reply saying "couldn't find in the documentation", while the
 * identical eval against the identical knowledge record passed 100% hours later. So before
 * scoring anything, ask one section-granularity canary question that only the knowledge base
 * (not keyFacts or the site map) can answer, and hold the run until the brain answers it.
 * Proceeds with a loud warning if the window is exhausted — the eval then fails honestly.
 */
const WARMUP_PROMPT = 'What is the default maxRendered cap on the ExperienceRenderer?';
const WARMUP_PASS = /\b100\b|hundred/i;
const WARMUP_ATTEMPTS = 20;
const WARMUP_DELAY_MS = 60_000;
const WARMUP_TURN_TIMEOUT_MS = 30_000;

async function warmUpKnowledgeRetrieval() {
  for (let attempt = 1; attempt <= WARMUP_ATTEMPTS; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WARMUP_TURN_TIMEOUT_MS);
    let text = '';
    try {
      ({ text } = await streamTurnWithAck({ management, configId: agent.configId, message: WARMUP_PROMPT, routes: siteData.routes, signal: ctrl.signal }));
    } catch (e) {
      log(`  ! warm-up attempt ${attempt}/${WARMUP_ATTEMPTS} errored: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (WARMUP_PASS.test(text)) {
      log(`✓ knowledge retrieval warm (canary answered on attempt ${attempt})`);
      return;
    }
    if (attempt < WARMUP_ATTEMPTS) {
      log(`… knowledge retrieval still cold (attempt ${attempt}/${WARMUP_ATTEMPTS}) — waiting ${WARMUP_DELAY_MS / 1000}s`);
      await new Promise((r) => setTimeout(r, WARMUP_DELAY_MS));
    }
  }
  log(`⚠ knowledge retrieval still cold after ${WARMUP_ATTEMPTS} attempts (~${Math.round((WARMUP_ATTEMPTS * WARMUP_DELAY_MS) / 60000)} min) — running the eval anyway; expect relevance failures`);
}

if (!process.argv.includes('--no-warmup')) {
  log('▶ warming up knowledge retrieval (a fresh redeploy can take a while to become searchable; --no-warmup to skip)');
  await warmUpKnowledgeRetrieval();
}

const report = await runEval({
  management,
  configId: agent.configId,
  siteData,
  personas: PERSONAS,
  trials,
  onEvent: (evt) => {
    if (evt.type === 'trial-start') {
      log(`\n▶▶ trial ${evt.trial}/${evt.trials}`);
    } else if (evt.type === 'persona-start') {
      log(`\n▶ ${evt.persona}`);
    } else if (evt.type === 'turn') {
      const t = evt.turn;
      const s = t.scored;
      log(`  · ${t.latencyMs}ms ${(s.overallScore * 100).toFixed(0)}% [${toolNames(t.toolCalls).join(',') || '-'}]${s.failed.length ? '  ✗ ' + s.failed.join(',') : ''}${s.releaseBlockingFails.length ? '  ⛔ RELEASE-BLOCKING' : ''}${t.error ? '  ! error: ' + t.error : ''}`);
    }
  },
});

if (judgeArg) {
  try {
    report.judge = JSON.parse(await readFile(judgeArg, 'utf8'));
    report._meta.judge = true;
    log(`\n✓ folded judge verdicts from ${judgeArg}`);
  } catch (e) {
    log(`\n! could not read judge file: ${e.message}`);
  }
}

const summary = report.summary;
await writeArtifacts(report, { artDir: ART, historyDir: HISTORY });

log(`\n${summary.healthy ? '✅' : '⛔'} ${summary.totalTurns} turns · overall ${(summary.overall * 100).toFixed(0)}% · ${summary.releaseBlockingFailCount} release-blocking failures · ${summary.erroredTurnCount} errored/timed-out turns · ${summary.routesExercised}/${summary.routesTotal} routes exercised`);
if (summary.reliability) log(`   reliability (${trials} trials): ${summary.reliability.turnsFlaky} flaky turns, ${summary.reliability.turnsPassPowK}/${summary.reliability.totalTurns} pass^k-clean`);
log('   wrote tests/eval/artifacts/{transcript,report}.json + report.md + history snapshot');
if (!summary.healthy) process.exitCode = 1;
