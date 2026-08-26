# Reference

## Repo file map

| Path | What it is |
|---|---|
| `README.md` | Repo hub — what this is, quickstart, doc map |
| `.env.example` | Every env var this repo's own code reads |
| `package.json` | Scripts, `"type": "module"`, zero `dependencies` |
| `load-env.mjs` | Dependency-free `.env` parser used by every entry point |
| `site-root.mjs` | Resolves the docs-site checkout path (`resolveSiteDir`/`stripSiteDirFlag`) |
| `scripts/fetch-sdk.mjs` | Vendors `@kaltura/intelligent-agents` from jsDelivr into `vendor/sdk/` |
| `vendor/sdk/` | Gitignored — the fetched SDK source, populated by `postinstall` |
| `server/provision.mjs` | Creates/redeploys/tears down Nova's live intellect, avatar, agent, knowledge base |
| `server/agent.json` | Committed — the live resource IDs `provision.mjs` writes and every other command (incl. `redeploy.yml`) reads |
| `.github/workflows/redeploy.yml` | CI: redeploy Nova in place, gated behind the `production` environment |
| `.github/workflows/eval.yml` | CI: run the eval suite against whatever `redeploy.yml` most recently produced |
| `docs/GETTING-STARTED.md` | Tutorial — zero to a passing eval run |
| `docs/HOW-TO.md` | How-to guides — redeploy, tear down, extend |
| `docs/ARCHITECTURE.md` | Explanation — why the repo and the eval harness are built this way |
| `docs/REFERENCE.md` | This file |
| `tests/eval/GUIDELINES.md` | Dimensions, blocking rationale, pass@k vs pass^k, coverage contract, triage guide |
| `tests/eval/transport.mjs` | Wire layer — tool-call self-ACKing, spiral circuit breaker |
| `tests/eval/chat-transport.mjs` | Wire layer, chat mode — same contract, driven through the SDK's real `KalturaChatSession` |
| `tests/eval/engine.mjs` | Run layer — `runTurn`/`runEval`/trial merging |
| `tests/eval/probes.mjs` | Scoring layer — pure per-dimension check functions, `DIMENSIONS`, `RELEASE_BLOCKING` |
| `tests/eval/probes.test.mjs` | Unit tests for `probes.mjs` |
| `tests/eval/personas.mjs` | The persona/turn dataset the eval drives the live agent through |
| `tests/eval/site-data.mjs` | Live route + highlight-target ground truth, read from the site checkout |
| `tests/eval/artifacts.mjs` | Writes `transcript.json`/`report.json`/`report.md` + history snapshots |
| `tests/eval/run.mjs` | CLI entry point for a full eval run |
| `tests/eval/artifacts/` | Gitignored — `report.json`/`report.md`/`transcript.json` + `history/` |
| `tests/eval/dashboard/server.mjs` | Browser front end over the same engine, streamed via SSE |
| `tests/eval/dashboard/public/` | Dashboard's static HTML/CSS/JS |

## npm scripts

| Script | Runs | Capability |
|---|---|---|
| `postinstall` | `node scripts/fetch-sdk.mjs` | write, idempotent (skips re-fetch if already at the target tag) |
| `fetch-sdk` | `node scripts/fetch-sdk.mjs --force` | write, idempotent (overwrites `vendor/sdk/` with the same tag's content) |
| `provision` | `node server/provision.mjs` | write, NOT idempotent (creates a new intellect/avatar/agent/knowledge base every run — see `--reuse`/`--agent-id`/`--avatar-id` below to update in place instead) |
| `cleanup` | `node server/provision.mjs --cleanup` | write, destructive |
| `test:eval:unit` | `node --test tests/eval/probes.test.mjs tests/eval/provision.test.mjs tests/eval/chat-transport.test.mjs` | read |
| `eval` | `node tests/eval/run.mjs` | read (drives the live agent conversationally; writes only to `tests/eval/artifacts/`) |
| `eval:dashboard` | `node tests/eval/dashboard/server.mjs` | read (starts a local server; each run it launches carries the same capability as `eval`) |

## `server/provision.mjs` flags

| Flag | Effect |
|---|---|
| *(none)* | Create a brand-new intellect, avatar, agent, and widget |
| `--site-dir <path>` | Read the docs site's `src/**/*.md` from here instead of the default (or set `SITE_REPO_DIR`) |
| `--reuse <configId>` | Update this intellect instead of creating one |
| `--avatar-id <existingAvatarId>` | Skip the preset pick, use this avatar as-is |
| `--agent-id <existingAgentId>` | Update this agent in place, keeping its `widgetId` |
| `--cleanup` | Delete the resources recorded in `server/agent.json` |
| `--dry-run` | With `--cleanup`: list what would be deleted, make no API calls |
| `--only <types>` | With `--cleanup`: limit to a comma-separated subset of `agent,avatar,intellect,knowledge` |
| `--help` | Print usage and exit, no API calls |

An unrecognized `--flag` exits non-zero with usage rather than being silently ignored. `--dry-run`/`--only` outside of `--cleanup` also exit non-zero.

## `tests/eval/run.mjs` flags

| Flag | Effect |
|---|---|
| `--site-dir <path>` | Same resolution as `provision.mjs` — `resolveSiteDir()` scans all of `process.argv`, so this flag works here too even though `run.mjs` never parses it itself |
| `--trials <N>` | Run every persona `N` independent times and gate release on the union of every trial's release-blocking failures (pass^k). Defaults to 1 |
| `--judge <path>` | Fold externally-graded verdicts (a JSON file) into `report.judge`/`report.md` |

Exits non-zero when `summary.healthy` is false (any release-blocking failure or errored/timed-out turn).

## `scripts/fetch-sdk.mjs` flags and env

| Flag / env | Effect |
|---|---|
| `--tag vX.Y.Z` / `--tag=vX.Y.Z` | Vendor this tag instead of the default (`DEFAULT_TAG` in `scripts/fetch-sdk.mjs`) |
| `SDK_TAG` | Same, read when `--tag` is omitted |
| `--force` | Re-fetch even if `vendor/sdk/.sdk-tag` already matches the target tag |

## GitHub Actions workflows

See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for why these are shaped this way, and [docs/HOW-TO.md](HOW-TO.md) for how to run/set them up.

| Workflow | Trigger | Gate | Secrets read from |
|---|---|---|---|
| `redeploy.yml` | Push to `server/provision.mjs` on `main`; `workflow_dispatch` | `production` environment, required reviewers | `production` environment secrets |
| `eval.yml` | `redeploy.yml` completing successfully (`workflow_run`); `workflow_dispatch` with a `trials` input | `production` environment, required reviewers (a `workflow_run` trigger queues the eval; it runs after approval) | `production` environment secrets |

Both need `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET` defined in whichever secrets scope they read from — see HOW-TO.md's "Set up this repo's CI secrets."

## Environment variables

Everything a fresh clone needs is in `.env.example`; this table is what each one actually does.

| Variable | Required | Effect |
|---|---|---|
| `AGENTIC_PARTNER_ID` | Yes | Partner ID for every `Management` call (`provision.mjs`, `run.mjs`, the dashboard) |
| `AGENTIC_ADMIN_SECRET` | Yes | Admin secret paired with the partner ID above. Never commit a real value |
| `SITE_REPO_DIR` | No | Overrides the default docs-site checkout path `site-root.mjs` resolves to. Flag (`--site-dir`) takes precedence over this; this takes precedence over the default sibling checkout (`../intelligent-agents-sdk-site`) |
| `AGENTIC_GENIE_URL` | No | Overrides the Genie conversation backend both eval transports talk to (`transport.mjs` ACK posts, `chat-transport.mjs`'s `KalturaChatSession`). Defaults to production |
| `NOVA_DASHBOARD_PORT` | No | Port for `npm run eval:dashboard`. Defaults to `8093`. The dashboard also accepts a positional CLI arg (`node tests/eval/dashboard/server.mjs 9000`), checked before this env var |

## Artifact file shapes

All written to `tests/eval/artifacts/`, gitignored, always reflecting the most recent full run (a filtered dashboard run with `?ids=` does not overwrite them — see the dashboard routes below).

- **`report.json`** — the full scored report: `_meta` (`generatedAt`, `configId`, `routes`, `siteDir`, `trials`, `judge`), `summary` (`healthy`, `overall`, `totalTurns`, `turnsFailing`, `releaseBlockingFailCount`, `erroredTurnCount`, `routesExercised`/`routesTotal`, `dimensions`, `latency`, and `reliability` when `trials > 1`), `coverage` (`expectedTools`, `observedTools`, `uncoveredRoutes`), `releaseBlockingFails`, `erroredTurns`, `personas` (per-turn detail including `results`, `reliability`, `spiralDetected`/`spiralRecovered`, `transport`, and `warnings` when the SDK emitted any — e.g. `empty_turn_with_request_vars`), and `judge` when a judge pass has been folded in.
- **`transcript.json`** — the ungraded raw shape a judge grades: `_meta` plus `personas[].turns[]` with only `prompt`, `latencyMs`, `text`, `toolNames`.
- **`report.md`** — `renderMarkdown(report)`'s human-readable rendering of the same `report.json`: healthy/blocked banner, dimension score table, coverage, release-blocking and errored-turn call-outs, per-persona per-turn detail, and the judge section when present.
- **`history/<generatedAt-with-colons-and-dots-as-dashes>.json`** — a full timestamped copy of that run's `report.json`, one per run, read by the dashboard's trend view via `listHistory()`.

## Dashboard API routes

Base: `http://localhost:8093` (or `NOVA_DASHBOARD_PORT`). All routes are same-process, local-only, no auth — this is a single-operator dev tool.

| Method | Path | Capability |
|---|---|---|
| GET | `/api/run/stream` | read+write, NOT idempotent while a run is in flight — SSE stream of a live eval run (`?ids=<comma-separated persona ids>`, `?trials=<N>`); 409 if a run is already in progress; writes `tests/eval/artifacts/*` only for a full unfiltered run |
| GET | `/api/meta` | read — `configId`, resolved `siteDir`, `running`, and the persona inventory |
| GET | `/api/report/latest` | read — the current `report.json`, or `null` if none exists yet |
| GET | `/api/history` | read — the lightweight history index (`listHistory`) |
| GET | `/api/history/:file` | read — one full historical report by filename |
| GET | `/api/personas` | read — full persona/turn data plus site route and highlight-target ground truth |
| POST | `/api/quick-test` | read — runs one ad-hoc prompt (`{prompt, expectation?, simulateHighlightSuccess?, simulateHighlightLabel?}`) through the live agent and scores it; does not write artifacts |
| GET | `/api/judge/prompt` | read — the judge rubric plus the current `transcript.json`, ready to paste into an external LLM; 404-shaped error if no transcript exists yet |
| POST | `/api/judge/import` | write, idempotent — folds a judge verdicts body into `report.json`/`report.md`; 404-shaped error if no report exists yet |
| GET | *(any other path)* | read — static file from `tests/eval/dashboard/public/` |
