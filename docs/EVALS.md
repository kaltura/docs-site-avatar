# Testing Nova: the eval suite at a glance

How to test Nova, what the suite covers, and how it works. Dimension-by-dimension detail and failure triage are in [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md). This page gets you running first.

## Run it now

| I want to | Run | Credentials? |
|---|---|---|
| Sanity-check the probe logic offline | `npm run test:eval:unit` | No |
| Score the live agent once | `npm run eval` | Yes |
| Gate a release (pass^k reliability) | `node tests/eval/run.mjs --trials 3` | Yes |
| Watch a run live, with history and trends | `npm run eval:dashboard` | Yes |

Live runs need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` in `.env`, plus a docs-site checkout (`SITE_REPO_DIR` in `.env`, or `--site-dir`). On a fresh clone, [GETTING-STARTED.md](GETTING-STARTED.md) walks the whole path with expected output.

**Pass or fail:** the run exits non-zero if any release-blocking probe fails on any turn, or any turn errors or times out. The verdict is the ✅ or ⛔ banner at the top of `tests/eval/artifacts/report.md`.

## What a green run proves

Nothing is mocked. The harness drives the same provisioned agent the public site embeds, headlessly, over both transports the site uses:

- `Conversations.stream()` records every tool call without acknowledging any, because `go_to` is fire-and-forget (`tests/eval/transport.mjs`).
- The SDK's real `KalturaChatSession`, the class the site's chat mode ships, serves the chat, transport-switch, and page-context personas (`tests/eval/chat-transport.mjs`).

A passing run is evidence about the deployed agent, not about the prompt text.

## Coverage

25 fixed adversarial personas in 8 categories, plus `site-navigator-N` tours generated from the sections manifest. Every turn is scored on every applicable dimension.

| Category | Personas | What it stresses |
|---|---|---|
| Trust & safety | `restricted-topics`, `adversarial`, `free-and-signup`, `contact-request`, `contact-request-declined` | Pricing and licensing refusals with no smuggled figures, prompt-injection resistance, no prompt leaks. "Is it free?" gets the MIT answer plus a sign-up button. A rep request never claims a callback or stored details |
| Navigation | `site-navigator-1..N`, `section-navigator`, `nonexistent-pages`, `single-nav-discipline` | Every real page reachable, no invented routes, one nav call per turn, no narration of what the screen is doing. Tours hold at most 8 turns, so one bad first turn cannot poison a whole tour. Section-level `go_to` calls land on a real section key of the targeted page, judged with the SDK's `resolveTarget` |
| Knowledge | `facts-and-scope`, `knowledge-depth`, `release-delta-depth`, `personalization-and-threads-depth`, `answer-accuracy` | Answers grounded in the site's own pages, knowledge-base retrieval depth |
| Continuity | `thread-continuity`, `role-adherence-drift`, `transport-switch-continuity` | Multi-turn memory, staying in persona under pressure, and one thread surviving a mid-conversation chat↔stream transport switch |
| Positioning | `byo-brain-evaluator`, `face-only-own-brain`, `coding-agent-newbie` | The "we have our own AI brain, just give us the talking head" conversation lands on the three-flows value story. "Train Claude Code on your SDK" lands on the plugin and the Build with coding agents guide, not on knowledge-base jargon |
| Lifecycle | `kickoff`, `resume-kickoff`, `pill-first`, `fresh-start` | The chat-first greeting kickoff gets a warm self-introduction, never an echo. A repeated kickoff on a thread with history gets one short invitation, not a reintroduction or a memory claim. A pill question sent as the first message gets an answer, not a greeting. "Do you remember me?" gets "I start fresh each visit", never "welcome back" |
| Transport | `chat-mode-tools` | Nav and knowledge behavior hold when the turn runs through the real `KalturaChatSession` instead of the raw stream |
| Context | `page-context` | `setDynamicPrompt()` page context reaches the agent: it can list the current page's sections and navigate to one. Soft assertions only, because the `allow_client_variables` gate can lag after a redeploy (see [GUIDELINES.md](../tests/eval/GUIDELINES.md#when-the-eval-finds-something)) |

Each turn is scored on 20 dimensions. **8 block release** (any failure on any turn fails the run):

`noInventedPath` · `noInventedUrl` · `restrictedTopicRefusal` · `noPromptLeak` · `noKbSearchWhenOff` · `tools` · `sectionResolvable` · `relevance`

The other 12 are reported but do not gate: latency, tool budget, completeness, the kickoff and fresh-start checks, nav-target match, section match, split path, and so on. The full table with each dimension's rationale is in [GUIDELINES.md](../tests/eval/GUIDELINES.md#the-measured-dimensions).

Coverage cannot rot silently. The coverage matrix in `report.json` and `report.md` is computed from the persona expectations in `personas.mjs`, and page coverage comes from the live site checkout (`site-data.mjs`). Add a page to the site and the navigation tours pick it up.

## Methodology

- **Live, no mocks.** Real agent, real tool calls, real knowledge retrieval. It is slower than fixtures, but the deployed agent is the thing being certified.
- **pass^k, not pass@k.** `--trials N` re-runs every persona end-to-end N independent times, and release-blocking dimensions must pass all trials. A turn that passed some trials but not all is marked `🎲 flaky` in the report. That separates a regression from run-to-run nondeterminism.
- **Warm-up gate.** Each run opens with four canary questions that only the knowledge base can answer, retried up to 20 times a minute apart, because "indexed" does not mean "retrieval is warm". Skip it with `--no-warmup` against an already-warm agent. Details: [GUIDELINES.md](../tests/eval/GUIDELINES.md#knowledge-retrieval-warm-up-gate).
- **Tool-spiral circuit breaker.** The stream transport hard-stops a turn after 6 raw tool segments and records `spiralDetected` and `spiralRecovered`, so a stuck tool loop becomes a scored finding instead of a hung run. The chat transport uses `KalturaChatSession`'s own `toolSpiralLimit` and `toolSpiralDetected` at the same limit. Its `sendText()` drains the whole stream, so the engine's 90 s per-turn abort bounds a live spiral there.
- **Deterministic probes, external judge.** Every probe is a pure function, which is why `npm run test:eval:unit` works offline. Qualitative grading is not done in-process. `transcript.json` is written for an external LLM judge, and its verdicts fold back in with `--judge verdicts.json`. Rubric guidance: [GUIDELINES.md](../tests/eval/GUIDELINES.md#optional-qualitative-layer-the-external-llm-judge).

## The tools

| Tool | What it gives you |
|---|---|
| `tests/eval/run.mjs` | The full scored run. Writes `tests/eval/artifacts/`: `report.md` (human), `report.json` (machine, with a `_meta` provenance receipt), `transcript.json` (raw turns for external judging), `history/` (past runs) |
| `npm run eval:dashboard` | The same scoring engine, streamed live to a browser at `http://localhost:8093`: progress, run-history trends, persona inventory, and an ad-hoc single-prompt Quick Test |
| `npm run test:eval:unit` | Offline unit tests for every probe, for `provision.mjs`, and for the digest step. No credentials or network |
| CI | `ci.yml` runs the offline checks on every PR. `eval.yml` queues after a redeploy and takes a manual `trials` input. Triggers and gates: [REFERENCE.md](REFERENCE.md#github-actions-workflows). Recipes: [HOW-TO.md](HOW-TO.md#run-the-eval-suite-in-ci) |

## When something fails

- **A blocking probe failed.** [GUIDELINES.md](../tests/eval/GUIDELINES.md#when-the-eval-finds-something) has per-dimension triage. Most fixes are a prompt-var or tool-description change in `server/provision.mjs`, then redeploy and re-run.
- **Relevance failures** mean a wrong or missing factual answer. If every one says "couldn't find in the documentation", the knowledge index is cold, not the content wrong. Check whether the warm-up gate printed `⚠ still cold`. Otherwise read the reply. Fix the docs chunk it should have come from, or, if the reply is right and only phrased differently, widen that probe's keywords.
- **A turn is `🎲 flaky` on a `--trials` run.** Treat it as real. Re-run. If it keeps flipping, state the underlying prompt rule more forcefully.

## Extending the suite

- **New persona or turn:** edit `tests/eval/personas.mjs`. There is no registration step, and the coverage matrix extends itself. Recipe: [HOW-TO.md](HOW-TO.md#add-a-new-persona-or-turn-to-the-eval).
- **New probe:** add a pure function in `tests/eval/probes.mjs`, wire it into `scoreTurn()` and `DIMENSIONS` (and `RELEASE_BLOCKING` if it should gate), and add unit tests. Recipe: [HOW-TO.md](HOW-TO.md#add-a-new-probe-to-the-eval).
