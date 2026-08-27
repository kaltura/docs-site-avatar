/**
 * The reusable eval-running core, extracted from what used to be all of run.mjs so both the
 * CLI (`run.mjs`) and the dashboard server (`dashboard/server.mjs`) drive the exact same live
 * logic — same per-turn timeout safety net, same scoring, same aggregation — rather than two
 * copies that can silently drift. `run.mjs` stays the thin CLI wrapper: load config, call
 * {@link runEval}, write artifacts. The dashboard calls {@link runEval} too, with an `onEvent`
 * callback that streams progress to the browser instead of `console.log`-ing it.
 */
import { scoreTurn, toolNames, DIMENSIONS } from './probes.mjs';
import { streamTurnWithAck } from './transport.mjs';
import { chatTurnWithAck } from './chat-transport.mjs';
import { KICKOFF_TRIGGER } from './personas.mjs';

// Sized to give transport.mjs's own spiral detector (TOOL_SPIRAL_HARD_LIMIT=6) room to trip AND
// complete one recovery resend within this budget at observed live cadence (~1-7s per raw tool
// segment) — a plain non-spiraling turn still finishes in a few seconds regardless.
export const TURN_TIMEOUT_MS = 90000;

// A single turn stalling against the live backend (observed intermittently — e.g. a runaway
// tool-call loop, or plain backend flakiness) must never block the whole suite indefinitely.
// Race against a timeout and record it as a turn-level error so a run always terminates.
// Racing alone isn't enough, though — a losing promise keeps running: it was observed live
// that an abandoned streamTurnWithAck() call keeps its HTTP stream connection open and its
// `for await` loop reading forever, which kept the whole eval CLI process alive for 15+
// minutes after it had already printed its final report and "finished." `ctrl` is the fix —
// the caller must build it, pass `ctrl.signal` into the raced promise, and this aborts it the
// moment the timeout wins, so the abandoned connection actually closes.
function withTimeout(promise, ms, label, ctrl) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctrl?.abort();
      reject(new Error(`turn timed out after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Run one live conversation turn, self-ACKing tool calls exactly like a real browser would.
 * @param {{management: object, configId: number, message: string, threadId: string|null, routes: {url:string}[], siteData?: object, highlightAck?: object, simulateNavNotFound?: boolean, capabilities?: object, transport?: 'stream'|'chat', pageContext?: object}} opts
 *   `capabilities` is the documented per-message override (conversations.stream()'s
 *   `{name:state}` param) — e.g. `{use_knowledge_base:'on'}` to probe RAG retrieval quality for
 *   one turn without touching the live agent's stored (usually off) capability state.
 *   `transport: 'chat'` routes the turn through the SDK's real KalturaChatSession (the site's
 *   chat mode) instead of the raw converse stream — same thread ids, so a persona can switch
 *   transports mid-thread to prove backend thread continuity across the two client stacks.
 *   `pageContext` (chat transport only) is pushed via `session.setDynamicPrompt()` before the
 *   turn, the exact call the site's highlighter.js makes per page.
 *   `siteData` lets a successful nav ack carry a real `highlightable` list, mirroring production
 *   `navigator.js` — required for a same-turn navigate_to_page → highlight_element (Path B) call
 *   to have anything real to resolve against. `simulateNavNotFound` forces navigate_to_page's ack
 *   to `{ok:false,error:'not_found'}` even for a real path, to test the not-found branch in
 *   isolation from a path-fabrication failure.
 */
export async function runTurn({ management, configId, message, threadId, routes, siteData, highlightAck, simulateNavNotFound, capabilities, transport = 'stream', pageContext }) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const turnFn = transport === 'chat' ? chatTurnWithAck : streamTurnWithAck;
  try {
    const r = await withTimeout(
      turnFn({ management, configId, message, threadId, routes, siteData, highlightAck, simulateNavNotFound, capabilities, pageContext, signal: ctrl.signal }),
      TURN_TIMEOUT_MS,
      message,
      ctrl,
    );
    return {
      latencyMs: Date.now() - t0, threadId: r.threadId, text: r.text, toolCalls: r.toolCalls, acks: r.acks, error: null,
      spiralDetected: r.spiralDetected, spiralRecovered: r.spiralRecovered, rawToolSegCount: r.rawToolSegCount,
      transport, warnings: r.warnings || [],
    };
  } catch (e) {
    return {
      latencyMs: Date.now() - t0, threadId, text: '', toolCalls: [], acks: [], error: String(e?.detail || e?.message || e),
      spiralDetected: false, spiralRecovered: false, rawToolSegCount: 0,
      transport, warnings: [],
    };
  }
}

/**
 * Merge the same logical turn's scored results across N independent trial runs into one
 * release-gating verdict. Anthropic's distinction between pass@k (at least one of k trials
 * succeeds — right when one success suffices) and pass^k (all k trials succeed — right when
 * reliability itself is the thing being measured) applies directly to a customer-facing avatar:
 * a release-blocking probe that fails on even one of several identical trials is a real
 * reliability gap a real visitor WILL eventually hit, so gating uses the union of every trial's
 * release-blocking failures (pass^k semantics), while soft dimensions still average normally.
 * @param {object[]} trialScoreds one `scoreTurn()` result per trial, same turn
 */
export function unionScored(trialScoreds) {
  const failedSet = new Set();
  const blockingSet = new Set();
  for (const s of trialScoreds) {
    for (const f of s.failed) failedSet.add(f);
    for (const f of s.releaseBlockingFails) blockingSet.add(f);
  }
  const passCount = trialScoreds.filter((s) => s.healthy).length;
  return {
    results: trialScoreds[0].results,
    failed: [...failedSet],
    releaseBlockingFails: [...blockingSet],
    overallScore: trialScoreds.reduce((a, s) => a + s.overallScore, 0) / trialScoreds.length,
    healthy: blockingSet.size === 0,
    reliability: { trials: trialScoreds.length, passCount, passAtK: passCount > 0, passPowK: passCount === trialScoreds.length },
  };
}

/**
 * Run a full (or filtered) persona set against the live agent, scoring every turn and
 * aggregating a release-readiness report. Emits `onEvent` at each step so a caller can render
 * live progress rather than waiting for the whole run to finish.
 *
 * @param {object} opts
 * @param {object} opts.management
 * @param {number} opts.configId
 * @param {object} opts.siteData
 * @param {{id:string, persona:string, turns:object[]}[]} opts.personas
 * @param {number} [opts.trials] how many independent times to run every persona end-to-end
 *   (default 1). >1 enables pass^k gating (see {@link unionScored}) — the only way to tell a
 *   genuine regression from LLM run-to-run non-determinism, which this suite has hit live.
 * @param {(evt: object) => void} [opts.onEvent]
 * @returns {Promise<object>} the aggregated report (same shape run.mjs has always written to report.json)
 */
export async function runEval({ management, configId, siteData, personas, trials = 1, onEvent = () => {} }) {
  const trialPersonaResults = [];
  for (let trial = 1; trial <= trials; trial++) {
    if (trials > 1) onEvent({ type: 'trial-start', trial, trials });
    const personaResults = [];
    for (const p of personas) {
      onEvent({ type: 'persona-start', personaId: p.id, persona: p.persona, turnCount: p.turns.length, trial, trials });
      // Every real session sends KICKOFF_TRIGGER exactly once, as message #1 — replicate that
      // warmup so each persona's real first question lands on an already-opened thread. The
      // 'kickoff' persona's own listed turn IS that exact trigger, so warming up separately would
      // double-send it in one thread — a message shape production never produces — skip the
      // warmup there and let its single turn be the thread's actual first message.
      const skipWarmup = p.id === 'kickoff';
      // Warm up on the persona's own transport so a chat-mode persona's thread is opened by the
      // same client stack its first real turn uses — matching what a real chat session does.
      const personaTransport = p.transport === 'chat' ? 'chat' : 'stream';
      const warmup = skipWarmup
        ? { threadId: null }
        : await runTurn({ management, configId, message: KICKOFF_TRIGGER, threadId: null, routes: siteData.routes, siteData, transport: personaTransport });
      let threadId = warmup.threadId || null;
      const turns = [];
      for (const t of p.turns) {
        // simulateHighlightSuccess opts a specific persona turn into a forced ok:true ack — the
        // only way a headless run ever exercises "Nova correctly narrates a real highlight" (see
        // transport.mjs's ackHighlight comment).
        const highlightAck = t.simulateHighlightSuccess
          ? { ok: true, id: t.simulateHighlightSuccess === true ? 'simulated' : t.simulateHighlightSuccess, label: t.simulateHighlightLabel || 'that' }
          : undefined;
        // A turn may override its persona's transport (t.transport) — this is how a single
        // persona proves the SAME thread survives a mid-conversation chat↔stream switch.
        const turnTransport = t.transport || p.transport || 'stream';
        const r = await runTurn({ management, configId, message: t.prompt, threadId, routes: siteData.routes, siteData, highlightAck, simulateNavNotFound: t.simulateNavNotFound, capabilities: t.capabilities, transport: turnTransport, pageContext: t.pageContext });
        threadId = r.threadId || threadId;
        const rec = {
          prompt: t.prompt, expectation: t, latencyMs: r.latencyMs, text: r.text, toolCalls: r.toolCalls, acks: r.acks, error: r.error,
          spiralDetected: r.spiralDetected, spiralRecovered: r.spiralRecovered, rawToolSegCount: r.rawToolSegCount,
          transport: r.transport, warnings: r.warnings,
        };
        const scored = scoreTurn(rec, siteData);
        const full = { ...rec, scored };
        turns.push(full);
        onEvent({ type: 'turn', personaId: p.id, persona: p.persona, turn: full, trial, trials });
      }
      personaResults.push({ id: p.id, persona: p.persona, threadId, turns });
      onEvent({ type: 'persona-done', personaId: p.id, persona: p.persona, trial, trials });
    }
    trialPersonaResults.push(personaResults);
  }

  // Zip the N independent trial runs back into one personaResults shape: same turn, same
  // position, across every trial, merged via unionScored so every downstream consumer
  // (buildReport, the dashboard, report.md) sees exactly one turn record per prompt, same as
  // trials=1 always has, just with a `reliability` receipt and `trialsDetail` attached.
  const personaResults = personas.map((p, pi) => {
    const acrossTrials = trialPersonaResults.map((pr) => pr[pi]);
    const turns = p.turns.map((_, ti) => {
      const perTrial = acrossTrials.map((pr) => pr.turns[ti]);
      const scored = unionScored(perTrial.map((t) => t.scored));
      return {
        ...perTrial[0],
        scored,
        trialsDetail: perTrial.map((t) => ({
          latencyMs: t.latencyMs, text: t.text, toolNames: toolNames(t.toolCalls), error: t.error,
          overall: t.scored.overallScore, failed: t.scored.failed, releaseBlockingFails: t.scored.releaseBlockingFails,
        })),
      };
    });
    return { id: p.id, persona: p.persona, threadId: acrossTrials[0].threadId, turns };
  });

  const report = buildReport({ personaResults, personas, siteData, configId, trials });
  onEvent({ type: 'summary', report });
  return report;
}

/** Pure aggregation — same math run.mjs has always done, split out so runEval() can call it
 * and a caller can also re-aggregate cached persona results (e.g. the dashboard's quick-test
 * path) without re-running turns. */
export function buildReport({ personaResults, personas, siteData, configId, trials = 1 }) {
  const allTurns = personaResults.flatMap((p) => p.turns);
  const lats = allTurns.map((t) => t.latencyMs).sort((a, b) => a - b);
  const pct = (arr, q) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] : 0);
  const dimAvg = {};
  for (const d of DIMENSIONS) {
    const xs = allTurns.map((t) => t.scored.results[d]).filter(Boolean);
    dimAvg[d] = xs.length ? xs.filter((v) => v.pass !== false).length / xs.length : null;
  }

  const expectedTools = new Set();
  const observedTools = new Set();
  for (const p of personas) for (const t of p.turns) (t.expectTools || []).forEach((x) => expectedTools.add(x));
  for (const t of allTurns) toolNames(t.toolCalls).forEach((n) => observedTools.add(n));

  const releaseBlockingFails = allTurns.filter((t) => t.scored.releaseBlockingFails.length);
  const erroredTurns = allTurns.filter((t) => t.error);
  const exercisedRouteUrls = new Set(
    allTurns.flatMap((t) => t.toolCalls.filter((c) => c.name === 'navigate_to_page').map((c) => c.args?.path))
  );
  const uncoveredRoutes = siteData.routes.filter((r) => !exercisedRouteUrls.has(r.url));

  const summary = {
    overall: allTurns.length ? allTurns.reduce((s, t) => s + t.scored.overallScore, 0) / allTurns.length : 1,
    dimensions: dimAvg,
    latency: { p50: pct(lats, 0.5), p90: pct(lats, 0.9), max: lats[lats.length - 1] || 0, slowTurns: lats.filter((x) => x > 9000).length },
    releaseBlockingFailCount: releaseBlockingFails.length,
    erroredTurnCount: erroredTurns.length,
    turnsFailing: allTurns.filter((t) => t.scored.failed.length).length,
    totalTurns: allTurns.length,
    routesTotal: siteData.routes.length,
    routesExercised: siteData.routes.length - uncoveredRoutes.length,
    // A turn that errored/timed out never got validated at all — that's release-blocking on
    // its own, independent of whatever the (empty/partial) response happened to score.
    healthy: releaseBlockingFails.length === 0 && erroredTurns.length === 0,
  };
  if (trials > 1) {
    const rel = allTurns.map((t) => t.scored.reliability).filter(Boolean);
    summary.reliability = {
      trials,
      turnsFlaky: rel.filter((r) => r.passAtK && !r.passPowK).length,
      turnsPassPowK: rel.filter((r) => r.passPowK).length,
      totalTurns: rel.length,
    };
  }

  return {
    _meta: { generatedAt: new Date().toISOString(), configId, siteDir: siteData.siteDir, routes: siteData.routes.length, trials },
    summary,
    coverage: {
      expectedTools: [...expectedTools],
      observedTools: [...observedTools],
      uncoveredRoutes: uncoveredRoutes.map((r) => r.url),
    },
    releaseBlockingFails: releaseBlockingFails.map((t) => ({ prompt: t.prompt, fails: t.scored.releaseBlockingFails, text: t.text })),
    erroredTurns: erroredTurns.map((t) => ({ prompt: t.prompt, error: t.error })),
    personas: personaResults.map((p) => ({
      id: p.id,
      persona: p.persona,
      turns: p.turns.map((t) => ({
        prompt: t.prompt,
        latencyMs: t.latencyMs,
        overall: t.scored.overallScore,
        failed: t.scored.failed,
        releaseBlockingFails: t.scored.releaseBlockingFails,
        toolNames: toolNames(t.toolCalls),
        text: t.text,
        error: t.error,
        spiralDetected: t.spiralDetected,
        spiralRecovered: t.spiralRecovered,
        rawToolSegCount: t.rawToolSegCount,
        transport: t.transport || 'stream',
        ...(t.warnings?.length ? { warnings: t.warnings } : {}),
        results: t.scored.results,
        ...(trials > 1 ? { reliability: t.scored.reliability, trialsDetail: t.trialsDetail } : {}),
      })),
    })),
  };
}
