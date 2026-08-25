# Testing Nova — the eval suite at a glance

How to test Nova, what the suite covers, and how it works, in the order a busy developer needs it. Dimension-by-dimension detail and failure triage live in [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md); this page gets you running and oriented first.

## Run it now

| I want to… | Run | Credentials? |
|---|---|---|
| Sanity-check the probe logic offline | `npm run test:eval:unit` | No |
| Score the live agent once | `npm run eval` | Yes |
| Gate a release (pass^k reliability) | `node tests/eval/run.mjs --trials 3` | Yes |
| Watch a run live, with history and trends | `npm run eval:dashboard` | Yes |

Live runs need `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET` in `.env` plus a docs-site checkout (`SITE_REPO_DIR` in `.env`, or `--site-dir`). Fresh clone? [GETTING-STARTED.md](GETTING-STARTED.md) walks the whole path with expected output.

**Pass/fail:** the run exits non-zero if any release-blocking probe fails on any turn. The verdict is the ✅/⛔ banner at the top of `tests/eval/artifacts/report.md`.

## What a green run proves

Nothing is mocked. The harness drives the same provisioned brain the public site embeds, headlessly over `Conversations.stream()`, and self-ACKs tool calls exactly as a real browser session would (`tests/eval/transport.mjs`). A passing run is evidence about the deployed agent, not about the prompt text.

## Coverage

16 adversarial personas across 7 categories. Every turn is scored on every applicable dimension:

| Category | Personas | What it stresses |
|---|---|---|
| Trust & safety | `restricted-topics`, `adversarial` | Pricing/licensing refusals with no smuggled figures, prompt-injection resistance, no prompt leaks |
| Navigation | `site-navigator-1/2`, `nonexistent-pages`, `single-nav-discipline` | Every real page reachable, no invented routes, one nav call per turn |
| Knowledge | `facts-and-scope`, `knowledge-depth`, `release-delta-depth`, `personalization-and-threads-depth` | Answers grounded in the site's own pages, knowledge-base retrieval depth |
| Highlight | `highlight-invariant`, `highlight-success` | Never claims an on-page highlight that didn't happen, and narrates the ones that did |
| Continuity | `thread-continuity`, `role-adherence-drift` | Multi-turn memory, staying in persona under pressure |
| Positioning | `byo-brain-evaluator` | The "we have our own AI brain, just give us the talking head" conversation lands on the three-flows value story |
| Lifecycle | `kickoff` | The synthetic session-open trigger gets a warm self-introduction, never an echo |

Each turn is scored on 16 dimensions. **7 block release** (any failure on any turn fails the run):

`noInventedPath` · `noInventedUrl` · `restrictedTopicRefusal` · `noPromptLeak` · `noKbSearchWhenOff` · `tools` · `noFalseHighlightClaim`

The other 9 (latency, tool budget, completeness, relevance, nav-target match, and so on) are reported but don't gate. The full table with each dimension's rationale is in [GUIDELINES.md](../tests/eval/GUIDELINES.md#the-measured-dimensions).

Coverage can't silently rot: the coverage matrix in `report.json`/`report.md` is computed from the persona expectations in `personas.mjs`, and route/highlight-target coverage is generated from the live site checkout (`site-data.mjs`). Add a page to the site and the navigation tours pick it up automatically.

## Methodology, in five bullets

- **Live, no mocks.** Real brain, real tool-call ACKs, real knowledge retrieval. Slower than fixtures, but the thing being certified is the deployed agent.
- **pass^k, not pass@k.** `--trials N` re-runs every persona end-to-end N independent times; release-blocking dimensions must pass *all* trials. A turn that passed some trials but not all is marked `🎲 flaky` in the report, which is exactly the signal that separates a regression from run-to-run nondeterminism.
- **Warm-up gate.** Each run opens with a canary question only the knowledge base can answer, retried up to 20 times a minute apart, because "indexed" does not mean "retrieval is warm". Skip with `--no-warmup` when iterating against an already-warm agent.
- **Tool-spiral circuit breaker.** The transport hard-stops a turn after 6 raw tool segments and records `spiralDetected`/`spiralRecovered`, so a stuck tool loop becomes a scored finding instead of a hung run.
- **Deterministic probes, external judge.** Every probe is a pure function (that's why `npm run test:eval:unit` works offline). Qualitative grading is deliberately not done in-process: `transcript.json` is written for an external LLM judge, whose verdicts fold back in via `--judge verdicts.json`. Rubric guidance: [GUIDELINES.md](../tests/eval/GUIDELINES.md#optional-qualitative-layer--the-external-llm-judge).

## The tools

| Tool | What it gives you |
|---|---|
| `tests/eval/run.mjs` | The full scored run. Writes `tests/eval/artifacts/`: `report.md` (human), `report.json` (machine, with a `_meta` provenance receipt), `transcript.json` (raw turns for external judging), `history/` (past runs) |
| `npm run eval:dashboard` | Same scoring engine, streamed live to a browser at `http://localhost:8093`: progress, run-history trends, persona inventory, and an ad-hoc single-prompt Quick Test |
| `npm run test:eval:unit` | Offline unit tests for every probe and for `provision.mjs`, no credentials or network |
| CI | `ci.yml` runs on every PR with no secrets (syntax check, unit tests, secret scan). `eval.yml` queues automatically after every redeploy and takes a manual `trials` input; both wait for `production`-environment approval, and the full artifacts directory is attached to the run |

CI recipes (approving a queued run, ad-hoc pass^k in Actions): [HOW-TO.md](HOW-TO.md#run-the-eval-suite-in-ci).

## When something fails

- **A blocking probe failed** → [GUIDELINES.md § When the eval finds something](../tests/eval/GUIDELINES.md#when-the-eval-finds-something) has per-dimension triage; most fixes are a prompt-var or tool-description change in `server/provision.mjs`, then redeploy and re-run.
- **Every relevance failure says "couldn't find in the documentation"** → cold knowledge index, not a content regression. Check whether the warm-up gate printed `⚠ still cold`.
- **A turn is `🎲 flaky` on a `--trials` run** → treat as real. Re-run; if it keeps flipping, the underlying prompt rule needs to be stated more forcefully, not observed once and dismissed.

## Extending the suite

- **New persona or turn:** edit `tests/eval/personas.mjs`, no registration step; the coverage matrix extends itself. Recipe: [HOW-TO.md](HOW-TO.md#add-a-new-persona-or-turn-to-the-eval).
- **New probe:** pure function in `tests/eval/probes.mjs`, wire into `scoreTurn()` and `DIMENSIONS` (and `RELEASE_BLOCKING` if it should gate), add unit tests. Recipe: [HOW-TO.md](HOW-TO.md#add-a-new-probe-to-the-eval).
