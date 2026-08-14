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

`eval.yml` runs automatically after every successful `redeploy.yml` run. To run it ad hoc — a pass^k reliability check without redeploying first, say — go to **Actions → Eval Nova → Run workflow** and set `trials`. The report and the full `tests/eval/artifacts/` directory are attached to the run (job summary plus a 30-day build artifact), the same outputs a local `npm run eval` writes to disk.

## Set up this repo's CI secrets (one-time)

Both workflows need `AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET`, in two different places, because only one of them is gated:

1. In Settings → Environments, create an environment named `production`, add both as environment secrets, and add required reviewers.
2. In Settings → Secrets and variables → Actions, add the same two values again as repository secrets — `eval.yml` reads from here since it deliberately isn't gated by the environment.

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

Edit `tests/eval/personas.mjs` — add an entry to the array `buildPersonas()` returns, or a turn to an existing persona's `turns` array. Each turn is a plain object: a `prompt` string plus whichever expectation keys apply — `expectTools`, `forbidTools`, `expectNavPath`, `relevanceAny`, `expectRestrictedRefusal`, `expectNoPromptLeak`, `expectNoInventedApi`, `skipCompleteness`, or `simulateHighlightSuccess`/`simulateHighlightLabel`. No separate registration step: `engine.mjs` iterates whatever `buildPersonas()` returns, and the coverage matrix in `report.json`/`report.md` is computed from these same expectation keys automatically — see GUIDELINES.md's "Coverage contract."

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
node scripts/fetch-sdk.mjs --tag v1.1.0 --force
```

Or set `SDK_TAG` in the environment and re-run `npm run fetch-sdk` without `--tag`. There's no build step to catch an incompatible SDK API change at compile time, so re-run the unit tests and a full live eval afterward:

```bash
node --test tests/eval/probes.test.mjs
node tests/eval/run.mjs
```
