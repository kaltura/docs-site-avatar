# How-to guides

Recipes for running, redeploying, and extending this app. For running and reading the eval suite, see [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md). This file covers what that one does not.

## Redeploy Nova in place

Update the prompt, tools, or knowledge of the agent you already provisioned, instead of creating a new one (which would break anything embedding the old `widgetId`):

```bash
node server/provision.mjs --reuse <configId> --agent-id <agentId>
```

Take `<configId>` and `<agentId>` from your existing `server/agent.json`. Add `--avatar-id <existingAvatarId>` to keep the current avatar too. `go_to` is upserted by name through `upsertClientTool()`. If another intellect also references it, `provision.mjs` warns and reuses its id without overwriting its config, so the tool does not change under that other intellect.

## Redeploy Nova via GitHub Actions

Go to this repo's **Actions → Redeploy Nova → Run workflow**, or push a change to `server/provision.mjs` on `main`. The workflow also runs nightly and on a `repository_dispatch` of type `site-updated` (all triggers: [REFERENCE.md](REFERENCE.md#github-actions-workflows)). A push or a manual run waits for a required reviewer on the `production` environment. The nightly run and `site-updated` dispatch run unattended in `production-nightly`. Each runs `provision.mjs --reuse` against the ids in `server/agent.json`. The unattended runs add `--knowledge-only`, so they sync the knowledge base and change nothing else. The knowledge corpus is re-uploaded only when the docs changed (tick **rebuild** to force it). The job commits nothing back and fails if `server/agent.json` drifted. Why the gate exists and why the docs site's deploy does not trigger this automatically: [ARCHITECTURE.md](ARCHITECTURE.md#about-redeploying-and-evaluating-via-github-actions).

Approve the pending deployment from the run's page, or from the notification GitHub sends the reviewers. The run stays queued until someone does, and every later run queues behind it. Approve or cancel a waiting run promptly.

To check the live knowledge base without deploying:

```bash
node server/provision.mjs --verify-knowledge
```

It is read-only. It waits up to 45 minutes for every entry to finish indexing (change it with `--index-wait-minutes <n>`). It exits non-zero if a deploy never stored the docs hash, an entry has an error status, or the wait ran out. Running out of the wait rebuilds nothing, so run it again later. `eval.yml` runs it first.

A redeploy that ends with a "not confirmed indexed yet" warning still succeeded. Indexing is still running, so check later with the command above.

## Create or update the conversation digest

Set `DIGEST_RECIPIENTS` in `.env` (comma-separated Kaltura user ids, see [docs/REFERENCE.md](REFERENCE.md)). Preview the change, then apply it:

```bash
node server/provision.mjs --digest-plan   # read-only: create / update / unchanged per object
node server/provision.mjs --digest        # apply, then record the ids in server/agent.json
```

Run it again after any change to `server/digest.mjs` or `server/digest-email.html`, and after provisioning a new agent (the rules are scoped to the `agentId` in `server/agent.json`). Commit the `lifecycle` block if it changed. If the email template does not exist yet, also set `DIGEST_EMAIL_APP_GUID`. What the objects are: [ARCHITECTURE.md](ARCHITECTURE.md#about-the-conversation-digest-and-retention).

## Run the eval suite in CI

`eval.yml` is queued automatically when `redeploy.yml` completes successfully. After a nightly or `site-updated` redeploy it runs unattended, and only when the knowledge base was rebuilt. After a push or a manual redeploy it waits for a required reviewer on `production`. To run it ad hoc, for a pass^k check without redeploying first, go to **Actions → Eval Nova → Run workflow** and set `trials`. That run needs the same approval. The job summary shows the report, and the full `tests/eval/artifacts/` directory is attached as a 30-day artifact.

## Validate a provision.mjs change before merge

`ci.yml` runs on every pull request against `main`, including from forks, and needs no secrets:

1. `node --check server/provision.mjs`
2. `npm run test:eval:unit`
3. `node scripts/scan-secrets.mjs` (scans every tracked file for secret patterns)

It never calls the live agent. Run the same three commands locally before you push.

## Set up this repo's CI secrets (one-time)

`redeploy.yml` and `eval.yml` read `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` from two GitHub Environments with the same two secrets.

1. In Settings → Environments, create (or reuse) an environment named `production`. Add both values as environment secrets, and add required reviewers. Every job in it queues and waits for one of them.
2. Create `production-nightly`. Add the same two secrets, add no reviewers, and limit deployment branches to `main`. Nightly and `site-updated` runs use it.

`ci.yml` needs none of this.

## Point at a different site checkout

```bash
node server/provision.mjs --site-dir /path/to/checkout
node tests/eval/run.mjs --site-dir /path/to/checkout
```

Or set `SITE_REPO_DIR` in `.env` once. Both `provision.mjs` and the eval suite resolve the checkout in the same order: flag, then `SITE_REPO_DIR`, then the sibling `../intelligent-agents-sdk-site`. The checkout must have `src/index.md` and `src/_data/nav.js`, or resolution fails with an error that names the path it tried.

`provision.mjs` reads one markdown file per page in the sections manifest (`nova/sections.json`, fetched from the live site or passed with `--sections-file`). The checkout must therefore be the one the published manifest was built from. If the manifest and the checkout list different pages, `provision.mjs` fails before any upload and names the pages missing on each side.

## Tear down live resources

```bash
node server/provision.mjs --cleanup --dry-run
```

This lists what would be deleted and makes no API calls. Always run it first. Then:

```bash
node server/provision.mjs --cleanup
node server/provision.mjs --cleanup --only agent,avatar
```

`--only` limits the scope to a comma-separated subset of `agent,avatar,intellect,knowledge`.

## Prune orphaned knowledge entries

A failed or throttled delete can leave knowledge entries behind. List them first (read calls only):

```bash
node server/provision.mjs --prune-orphans --dry-run
node server/provision.mjs --prune-orphans
```

It deletes entries that sit in no category, and unlinked `docs-site-avatar-knowledge-*` categories with their entries. Anything an intellect links, and anything under an hour old, is kept.

## Audit and clean up leaked knowledge records

```bash
node scripts/audit-knowledge-records.mjs
```

This lists every record named `docs-site-avatar-knowledge`, or unnamed, that the live intellect does not link. These accumulate by design, one per redeploy that changes the docs (see [ARCHITECTURE.md](ARCHITECTURE.md#known-limitations)). The default run makes read calls only and deletes nothing. Then:

```bash
node scripts/audit-knowledge-records.mjs --delete
```

This tries to delete every candidate. A record that cannot be deleted is listed with its error code and left in place. `knowledge_in_use` means a live intellect still references it, so it is not a leak. The script never touches a record with any other name.

## Run the eval dashboard

```bash
npm run eval:dashboard
```

Open the printed URL (`http://localhost:8093` by default, override with `NOVA_DASHBOARD_PORT`). It uses the same scoring engine as `tests/eval/run.mjs`, streamed live over SSE, and adds a run-history trend view, the persona inventory, and an ad-hoc single-prompt Quick Test. It runs one eval at a time and is a local dev tool, not a multi-user service.

## Add a new persona or turn to the eval

Edit `tests/eval/personas.mjs`. Add an entry to the array `buildPersonas()` returns, or add a turn to an existing persona's `turns` array. Each turn is a plain object: a `prompt` string plus whichever expectation keys apply:

`expectTools`, `forbidTools`, `expectNavPath`, `expectSection` (one manifest key or an array of acceptable keys), `relevanceAny`, `expectRestrictedRefusal`, `expectNoPromptLeak`, `expectNoInventedApi`, `isKickoff`, `isResumeKickoff`, `expectFreshStart`, `isPillFirst`, `skipCompleteness`, or a per-turn `capabilities` override.

Persona options:

- `skipWarmup: true` opens the thread with the persona's own first turn instead of the `KICKOFF_TRIGGER` warm-up.
- `transport: 'chat'` runs the persona through the SDK's real `KalturaChatSession` instead of the raw stream. A single turn can set its own `transport`, which is how `transport-switch-continuity` proves a thread survives a mid-conversation switch. A chat turn can carry `pageContext` to push page context with `setDynamicPrompt()`.

There is no registration step. `engine.mjs` iterates whatever `buildPersonas()` returns, and the coverage matrix is computed from the same expectation keys. See "Coverage contract" in [GUIDELINES.md](../tests/eval/GUIDELINES.md#coverage-contract).

## Add a new probe to the eval

1. Write a pure function in `tests/eval/probes.mjs` that returns `{ pass, ...detail }`, or `null` when the probe does not apply to the turn. Copy the pattern of any probe gated on an `expectation.expectXyz` key.
2. Call it inside `scoreTurn()`'s `results` object under a new key.
3. Add that key to the `DIMENSIONS` array, and to `RELEASE_BLOCKING` if a failure should block release.
4. Add its pass and fail cases to `tests/eval/probes.test.mjs`, then run:

```bash
node --test tests/eval/probes.test.mjs
```

Then run a full `node tests/eval/run.mjs` to confirm the new dimension behaves against the real agent, not only against your unit-test fixtures.

## Update the pinned SDK version

Read the SDK's [release notes](https://github.com/kaltura/intelligent-agents-sdk/releases) first, for any breaking change between your current pinned tag and the new one.

```bash
node scripts/fetch-sdk.mjs --tag vX.Y.Z --force
```

Or set `SDK_TAG` in the environment and re-run `npm run fetch-sdk`. Nothing here is compiled, so a breaking SDK change only shows at runtime. Re-run the unit tests and a full live eval:

```bash
npm run test:eval:unit
node tests/eval/run.mjs
```

To make the new tag the default for everyone, change `DEFAULT_TAG` in `scripts/fetch-sdk.mjs`.
