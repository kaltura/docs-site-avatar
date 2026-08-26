# How-to guides

Recipes for the specific problems you'll hit running, redeploying, and extending this app. For running/reading the eval suite itself, see [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md) — this file covers what that one doesn't.

## Redeploy Nova in place

Update the prompt, tools, or knowledge of the agent you already provisioned, instead of minting a new one (which would break anything embedding the old `widgetId`):

```bash
node server/provision.mjs --reuse <configId> --agent-id <agentId>
```

Take `<configId>` and `<agentId>` from your existing `server/agent.json`. Add `--avatar-id <existingAvatarId>` to keep the current avatar too instead of creating a new one. `navigate_to_page` and `highlight_element` are upserted by name — if another intellect also references one of them, provision.mjs warns and reuses its id without overwriting its config, rather than changing a tool out from under that other intellect.

## Redeploy Nova via GitHub Actions

Go to this repo's **Actions → Redeploy Nova → Run workflow**, or push a change to `server/provision.mjs` on `main`. Either way, the job waits for a required reviewer on the `production` environment before it runs `provision.mjs --reuse` against the ids in `server/agent.json`, then commits that file back if anything changed. See [docs/ARCHITECTURE.md](ARCHITECTURE.md) for why the environment gate exists and why the docs site's own deploy doesn't trigger this automatically.

Approve the pending deployment from the run's page (or the notification GitHub sends the reviewers) — the run stays queued until someone does.

## Run the eval suite in CI

`eval.yml` is queued automatically when `redeploy.yml` completes successfully (`workflow_run`). But it's scoped to the `production` environment just like `redeploy.yml` is, so "runs automatically" means "gets queued automatically" — it still waits for a required reviewer to approve the run (same page/notification as approving a redeploy) before it can read `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET` and actually execute. To run it ad hoc — a pass^k reliability check without redeploying first, say — go to **Actions → Eval Nova → Run workflow** and set `trials`; that run needs the same approval. The report and the full `tests/eval/artifacts/` directory are attached to the run (job summary plus a 30-day build artifact), the same outputs a local `npm run eval` writes to disk.

## Validate a provision.mjs change before merge

`ci.yml` runs on every pull request against `main` — including from forks — and needs no secrets: it checks `server/provision.mjs` parses (`node --check`), runs the offline probe unit tests (`npm run test:eval:unit`), and scans every git-tracked file for leaked-secret patterns (`node scripts/scan-secrets.mjs`). It never calls the live agent or provisions anything; it exists to catch a broken `provision.mjs` or an accidentally-committed credential before the change can reach `redeploy.yml`'s production path.

## Set up this repo's CI secrets (one-time)

`redeploy.yml` and `eval.yml` both read `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET` from the same GitHub Environment, `production` — there's one place to set these, not two:

1. In Settings → Environments, create (or reuse) an environment named `production`.
2. Add both values as environment secrets on `production`.
3. Add required reviewers to `production`. Every job scoped to it — both workflows — queues and waits for one of those reviewers to approve, whether the trigger was a push, a `workflow_run`, or a manual `workflow_dispatch`.

`ci.yml` needs none of this: it runs on every PR without secrets (see "Validate a provision.mjs change before merge" above).

## Point at a different site checkout

```bash
node server/provision.mjs --site-dir /path/to/checkout
node tests/eval/run.mjs --site-dir /path/to/checkout
```

Or set `SITE_REPO_DIR` in `.env` once instead of passing `--site-dir` every time — both `provision.mjs` and the eval suite read the same resolution order (flag, then `SITE_REPO_DIR`, then a hardcoded local default). The checkout must have `src/index.md` and `src/_data/nav.js`, or resolution fails with a clear error naming the path it tried.

## Tear down live resources

```bash
node server/provision.mjs --cleanup --dry-run
```

Lists what would be deleted with no API calls — always run this first. Then either:

```bash
node server/provision.mjs --cleanup
node server/provision.mjs --cleanup --only agent,avatar
```

`--only` limits the scope to a comma-separated subset of `agent,avatar,intellect,knowledge`.

## Run the eval dashboard

```bash
npm run eval:dashboard
```

Open the printed URL (`http://localhost:8093` by default, override with `NOVA_DASHBOARD_PORT`). Same scoring engine as `tests/eval/run.mjs`, streamed live over SSE instead of stdout — includes a run-history trend view, the live persona inventory, and an ad-hoc single-prompt Quick Test. Only one run at a time; it's a local dev tool, not a multi-tenant service.

## Add a new persona or turn to the eval

Edit `tests/eval/personas.mjs` — add an entry to the array `buildPersonas()` returns, or a turn to an existing persona's `turns` array. Each turn is a plain object: a `prompt` string plus whichever expectation keys apply — `expectTools`, `forbidTools`, `expectNavPath`, `relevanceAny`, `expectRestrictedRefusal`, `expectNoPromptLeak`, `expectNoInventedApi`, `skipCompleteness`, or `simulateHighlightSuccess`/`simulateHighlightLabel`. A persona with `transport: 'chat'` runs through the SDK's real `KalturaChatSession` instead of the raw stream; a single turn can override with its own `transport` (that's how `transport-switch-continuity` proves the thread survives a mid-conversation switch), and a chat turn can carry `pageContext` to push page context via `setDynamicPrompt()`. No separate registration step: `engine.mjs` iterates whatever `buildPersonas()` returns, and the coverage matrix in `report.json`/`report.md` is computed from these same expectation keys automatically — see GUIDELINES.md's "Coverage contract."

## Add a new probe to the eval

1. Write a pure function in `tests/eval/probes.mjs` following the existing shape — return `{ pass, ...detail }`, or `null` when the probe doesn't apply to this turn (see any `expectation.expectXyz`-gated probe for the pattern).
2. Call it inside `scoreTurn()`'s `results` object under a new key.
3. Add that key to the `DIMENSIONS` array, and to `RELEASE_BLOCKING` too if a failure should block release.
4. Add its expected pass/fail cases to `tests/eval/probes.test.mjs`, then run:

```bash
node --test tests/eval/probes.test.mjs
```

Run a full `node tests/eval/run.mjs` afterward to confirm the new dimension behaves against the real agent, not just your unit-test fixtures.

## Update the pinned SDK version

```bash
node scripts/fetch-sdk.mjs --tag v1.2.0 --force
```

Or set `SDK_TAG` in the environment and re-run `npm run fetch-sdk` without `--tag`. There's no build step to catch an incompatible SDK API change at compile time, so re-run the unit tests and a full live eval afterward:

```bash
node --test tests/eval/probes.test.mjs
node tests/eval/run.mjs
```
