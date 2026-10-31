# Reference

## Repo file map

| Path | What it is |
|---|---|
| `.env.example` | Every env var this repo's own code reads |
| `package.json` | Scripts, `"type": "module"`, zero `dependencies` |
| `load-env.mjs` | Dependency-free `.env` parser used by every entry point |
| `site-root.mjs` | Resolves the docs-site checkout path (`resolveSiteDir`/`stripSiteDirFlag`) |
| `scripts/fetch-sdk.mjs` | Vendors `@kaltura/intelligent-agents` from jsDelivr into `vendor/sdk/` |
| `scripts/scan-secrets.mjs` | Secret-pattern scan over every tracked file. Run by `ci.yml` |
| `scripts/audit-knowledge-records.mjs` | Finds and cleans up unlinked knowledge records left behind by redeploys (see ARCHITECTURE.md's "Known limitations") |
| `vendor/sdk/` | Gitignored. The fetched SDK source, populated by `postinstall` |
| `server/provision.mjs` | Creates, redeploys, and tears down Nova's live intellect, avatar, agent, and knowledge base |
| `server/agent.json` | Committed. The stable live ids (`configId`, `avatarId`, `agentId`, `widgetId`, `tag`) that `provision.mjs` writes and every other command (including `redeploy.yml`) reads, plus the `lifecycle` block that `--digest` writes. Knowledge ids are discovered live from the intellect, not stored here |
| `server/digest.mjs` | Creates and updates Nova's conversation digest objects (insight settings, email template, lifecycle rules). Run through `provision.mjs --digest` |
| `server/digest-email.html` | HTML body of the digest email template |
| `.github/workflows/ci.yml` | CI: offline checks on every pull request, no secrets |
| `.github/workflows/redeploy.yml` | CI: redeploy Nova in place, gated behind the `production` environment (docs syncs run in `production-nightly`) |
| `.github/workflows/eval.yml` | CI: run the eval suite against whatever `redeploy.yml` most recently produced |
| `tests/eval/transport.mjs` | Wire layer: record-only `Conversations.stream()` turns, spiral circuit breaker |
| `tests/eval/chat-transport.mjs` | Wire layer, chat mode: same contract, driven through the SDK's real `KalturaChatSession` |
| `tests/eval/engine.mjs` | Run layer: `runTurn`, `runEval`, trial merging |
| `tests/eval/probes.mjs` | Scoring layer: pure per-dimension check functions, `DIMENSIONS`, `RELEASE_BLOCKING` |
| `tests/eval/personas.mjs` | The persona and turn dataset the eval drives the live agent through |
| `tests/eval/site-data.mjs` | Live route, sections-manifest, and quick-start SDK tag ground truth, read from the site checkout |
| `tests/eval/artifacts.mjs` | Writes `transcript.json`, `report.json`, `report.md`, and history snapshots |
| `tests/eval/run.mjs` | CLI entry point for a full eval run |
| `tests/eval/artifacts/` | Gitignored. `report.json`, `report.md`, `transcript.json`, and `history/` |
| `tests/eval/dashboard/server.mjs` | Browser front end over the same engine, streamed via SSE |
| `tests/eval/dashboard/public/` | The dashboard's static HTML, CSS, and JS |
| `tests/eval/*.test.mjs` | Offline unit tests: `probes`, `personas` (tours cover every page once, at most 8 turns each), `chat-transport`, `provision`, `workflows`, `digest` |

## npm scripts

| Script | Runs | Capability |
|---|---|---|
| `postinstall` | `node scripts/fetch-sdk.mjs` | write, idempotent (skips the fetch if already at the target tag) |
| `fetch-sdk` | `node scripts/fetch-sdk.mjs --force` | write, idempotent (overwrites `vendor/sdk/` with the same tag's content) |
| `provision` | `node server/provision.mjs` | write, NOT idempotent (creates a new intellect, avatar, agent, and knowledge base every run, and overwrites `server/agent.json`. Use `--reuse`, `--agent-id`, and `--avatar-id` to update in place) |
| `cleanup` | `node server/provision.mjs --cleanup` | write, destructive |
| `prune-orphans` | `node server/provision.mjs --prune-orphans` | write, destructive, idempotent (`--dry-run` is read-only) |
| `test:eval:unit` | `node --test tests/eval/probes.test.mjs tests/eval/provision.test.mjs tests/eval/chat-transport.test.mjs tests/eval/personas.test.mjs tests/eval/workflows.test.mjs tests/eval/digest.test.mjs` | read |
| `eval` | `node tests/eval/run.mjs` | read (drives the live agent conversationally and writes only to `tests/eval/artifacts/`) |
| `eval:dashboard` | `node tests/eval/dashboard/server.mjs` | read (starts a local server. Each run it launches has the same capability as `eval`) |

## `server/provision.mjs` flags

| Flag | Effect |
|---|---|
| *(none)* | Create a brand-new intellect, avatar, agent, and widget |
| `--site-dir <path>` | Read the docs site's `src/**/*.md` from here instead of the default (or set `SITE_REPO_DIR`) |
| `--sections-file <path>` | Read the `go_to` sections manifest (`nova/sections.json`) from a local site build instead of fetching the published one |
| `--reuse <configId>` | Update this intellect instead of creating one |
| `--avatar-id <existingAvatarId>` | Skip the preset pick and use this avatar as is |
| `--agent-id <existingAgentId>` | Update this agent in place, keeping its `widgetId` |
| `--rebuild` | With `--reuse`: build a new knowledge corpus even if the docs hash is unchanged. The old one is deleted only after the intellect points at the new one |
| `--knowledge-only` | With `--reuse`: sync only the knowledge base (same corpus swap as above). Tools, prompts, avatar, agent and `server/agent.json` are not touched. Fails if `use_knowledge_base` is off. The nightly and `site-updated` runs use it |
| `--verify-knowledge` | Read-only. Wait for indexing, then exit non-zero unless the live corpus has a stored docs hash and every entry is indexed. Used by `eval.yml` |
| `--index-wait-minutes <n>` | With `--verify-knowledge`: how long to wait for indexing. Default 45 |
| `--digest-plan` | Read-only. Print `create`, `update`, or `unchanged` for each digest object, with names and ids only. Needs `DIGEST_RECIPIENTS` |
| `--digest` | Create or update the digest objects and record their ids in `server/agent.json`. Idempotent. Needs `DIGEST_RECIPIENTS` |
| `--cleanup` | Delete the agent, avatar, and intellect recorded in `server/agent.json`, plus the entries and category of the corpus the intellect links (discovered live). The knowledge record itself stays |
| `--prune-orphans` | Delete `docs-site-avatar-*` document entries that sit in no category, and unlinked `docs-site-avatar-knowledge-*` categories with their entries. Keeps anything an intellect links and anything under an hour old. Exits non-zero with no delete if the intellect in `server/agent.json` is not listed or links no category. Keeps a category with 10,000 or more entries until a later run. Runs alone, or with `--dry-run` |
| `--dry-run` | With `--cleanup`: list what would be deleted and make no API calls. With `--prune-orphans`: print the counts and delete nothing (read calls only) |
| `--only <types>` | With `--cleanup`: limit to a comma-separated subset of `agent,avatar,intellect,knowledge` |
| `--help` | Print usage and exit, with no API calls |

`--digest` and `--digest-plan` run alone. Combined with another flag (or with each other) they exit non-zero. An unrecognized `--flag` exits non-zero with usage. `--dry-run` and `--only` outside `--cleanup` (and `--dry-run` outside `--prune-orphans`) also exit non-zero. `--prune-orphans` combined with any other flag but `--dry-run` (including `--verify-knowledge`) exits non-zero.

## `tests/eval/run.mjs` flags

| Flag | Effect |
|---|---|
| `--site-dir <path>` | Same resolution as `provision.mjs`. `resolveSiteDir()` scans all of `process.argv`, so the flag works here even though `run.mjs` does not parse it |
| `--trials <N>` | Run every persona `N` independent times and gate release on the union of every trial's release-blocking failures (pass^k). Default 1 |
| `--judge <path>` | Fold externally graded verdicts (a JSON file) into `report.judge` and `report.md` |
| `--no-warmup` | Skip the knowledge-retrieval warm-up gate |

Exits non-zero when `summary.healthy` is false (any release-blocking failure, or any errored or timed-out turn).

## `scripts/fetch-sdk.mjs` flags and env

| Flag / env | Effect |
|---|---|
| `--tag vX.Y.Z` / `--tag=vX.Y.Z` | Vendor this tag instead of the default (`DEFAULT_TAG` in `scripts/fetch-sdk.mjs`) |
| `SDK_TAG` | Same, read when `--tag` is omitted |
| `--force` | Re-fetch even if `vendor/sdk/.sdk-tag` already matches the target tag |

## `scripts/audit-knowledge-records.mjs` flags

| Flag | Effect |
|---|---|
| *(none)* | List candidate unlinked records. Read calls only, no deletes |
| `--delete` | Attempt `deleteRecord` on every candidate. A record that cannot be deleted is listed with its error code and left in place |

Only records named exactly `docs-site-avatar-knowledge`, or unnamed, are candidates. The record the live intellect (`configId` in `server/agent.json`) links is always excluded. A record with any other name is never touched.

## GitHub Actions workflows

Why they are shaped this way: [ARCHITECTURE.md](ARCHITECTURE.md#about-redeploying-and-evaluating-via-github-actions). How to run and set them up: [HOW-TO.md](HOW-TO.md).

| Workflow | Trigger | Gate | Secrets read from |
|---|---|---|---|
| `ci.yml` | Pull request against `main` (`pull_request`, so it also runs for forks) | None | None |
| `redeploy.yml` | Push to `server/provision.mjs` on `main`; nightly `schedule`; `repository_dispatch` (`site-updated`); `workflow_dispatch` (`rebuild` input) | `production` environment, required reviewers, for a push or a manual run. `production-nightly`, no reviewers, `main` only, for `schedule` and `repository_dispatch` | Same two secrets in both environments |
| `eval.yml` | `redeploy.yml` completing successfully (`workflow_run`); `workflow_dispatch` (`trials` input) | `production` environment, required reviewers, for a manual run or after a push or manual redeploy. `production-nightly` after a nightly or `site-updated` redeploy | Same two secrets in both environments |

`redeploy.yml` and `eval.yml` need `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` as secrets in both the `production` and `production-nightly` environments. Setup: [HOW-TO.md](HOW-TO.md#set-up-this-repos-ci-secrets-one-time).

## Environment variables

`.env.example` lists everything a fresh clone needs. This table says what each variable does.

| Variable | Required | Effect |
|---|---|---|
| `AGENTIC_PARTNER_ID` | Yes | Partner ID for every `Management` call (`provision.mjs`, `run.mjs`, the dashboard) |
| `AGENTIC_ADMIN_SECRET` | Yes | Admin secret paired with the partner ID. Never commit a real value |
| `DIGEST_RECIPIENTS` | For `--digest` and `--digest-plan` | Comma-separated Kaltura user ids that receive the digest email (not email addresses). Set it in the gitignored `.env` or as a CI secret. Never commit it |
| `DIGEST_EMAIL_APP_GUID` | Only when the email template does not exist yet | Messaging app id of the account, needed to create the template. Not needed to update it |
| `SITE_REPO_DIR` | No | Docs-site checkout path. The `--site-dir` flag takes precedence. Without either, `site-root.mjs` uses the sibling `../intelligent-agents-sdk-site` |
| `AGENTIC_GENIE_URL` | No | Overrides the conversation backend URL both eval transports talk to: the `Management` client behind `transport.mjs` and the dashboard, and `chat-transport.mjs`'s `KalturaChatSession`. Defaults to production |
| `NOVA_DASHBOARD_PORT` | No | Port for `npm run eval:dashboard`. Defaults to `8093`. A positional CLI arg (`node tests/eval/dashboard/server.mjs 9000`) is checked first |
| `SDK_TAG` | No | SDK tag to vendor. See the `fetch-sdk.mjs` table above |

## Artifact file shapes

All files are written to `tests/eval/artifacts/`, which is gitignored. They always reflect the most recent full run. A filtered dashboard run (`?ids=`) does not overwrite them.

- **`report.json`**: the full scored report.
  - `_meta`: `generatedAt`, `configId`, `siteDir`, `pages`, `trials`, and `judge` when a judge pass is folded in.
  - `summary`: `healthy`, `overall`, `totalTurns`, `turnsFailing`, `releaseBlockingFailCount`, `erroredTurnCount`, `pagesExercised`, `pagesTotal`, `dimensions`, `latency`, and `reliability` when `trials > 1`.
  - `coverage`: `expectedTools`, `observedTools`, `uncoveredPages`.
  - `releaseBlockingFails`, `erroredTurns`.
  - `personas`: per-turn detail including `results`, `reliability`, `spiralDetected`, `spiralRecovered`, `transport`, and `warnings` when the SDK emitted any (for example `empty_turn_with_request_vars`).
  - `judge`, when a judge pass is folded in.
- **`transcript.json`**: the ungraded raw shape a judge grades. `_meta` plus `personas[].turns[]` with only `prompt`, `latencyMs`, `text`, and `toolNames`.
- **`report.md`**: `renderMarkdown(report)`'s human-readable form of `report.json`: health banner, dimension score table, coverage, release-blocking and errored-turn call-outs, per-persona per-turn detail, and the judge section when present.
- **`history/<generatedAt>.json`**: a full timestamped copy of that run's `report.json`, one per run, with the `:` and `.` of the ISO timestamp replaced by `-`. The dashboard's trend view reads them through `listHistory()`.

## Dashboard API routes

Base: `http://localhost:8093` (or `NOVA_DASHBOARD_PORT`). The server listens on `127.0.0.1` only and has no auth. It is a single-operator dev tool.

| Method | Path | Capability |
|---|---|---|
| GET | `/api/run/stream` | read+write, NOT idempotent while a run is in flight. SSE stream of a live eval run (`?ids=<comma-separated persona ids>`, `?trials=<N>`). Returns 409 if a run is already in progress. Writes `tests/eval/artifacts/*` only for a full unfiltered run |
| GET | `/api/meta` | read. `configId`, resolved `siteDir`, `running`, and the persona inventory |
| GET | `/api/report/latest` | read. `{report, running}`, with `report` set to `null` if none exists yet |
| GET | `/api/history` | read. `{history}`, the lightweight history index (`listHistory`) |
| GET | `/api/history/:file` | read. One full historical report by filename |
| GET | `/api/personas` | read. Full persona and turn data plus site route and sections-manifest ground truth |
| POST | `/api/quick-test` | read. Runs one ad-hoc prompt (`{prompt, expectation?}`) through the live agent and scores it. `expectation.transport: 'chat'` and `expectation.pageContext` are honored. Writes no artifacts |
| GET | `/api/judge/prompt` | read. The judge rubric plus the current `transcript.json`, ready to paste into an external LLM. Returns 200 with an `error` body (`not_found`) if no transcript exists yet |
| POST | `/api/judge/import` | write, idempotent. Folds a judge verdicts body into `report.json` and `report.md`. Returns 200 with an `error` body (`not_found`) if no report exists yet |
| GET | *(any other path)* | read. Static file from `tests/eval/dashboard/public/` |
