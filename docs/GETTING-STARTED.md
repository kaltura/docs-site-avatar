# Getting started

By the end of this walkthrough you have a fresh Nova provisioned against a real docs-site checkout, and a passing eval run that proves she behaves correctly.

## Install

```bash
git clone https://github.com/kaltura/docs-site-avatar.git
cd docs-site-avatar
npm install
```

This repo has no npm dependencies. The `postinstall` script fetches the SDK from jsDelivr into a local `vendor/sdk/` directory. You see:

```
Fetching @kaltura/intelligent-agents-sdk@<pinned tag> from jsDelivr into vendor/sdk ...
Vendored <N> files at <pinned tag>.
```

The pinned tag is `DEFAULT_TAG` in `scripts/fetch-sdk.mjs`.

## Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET`. Get both from Kaltura's Rich Media CMS → Settings → Integration Settings.

## Get a docs-site checkout

Nova is grounded on the markdown pages of the public docs site, and the eval reads the site's page list to know what correct navigation is. You need your own checkout of it. Keep it a separate clone from this repo, so the admin secret in `.env` never sits near the public site's files:

```bash
git clone --branch gh-pages-src https://github.com/kaltura/intelligent-agents-sdk.git ../intelligent-agents-sdk-site
```

This puts the clone at the default location, `../intelligent-agents-sdk-site`, a sibling of this repo. If your checkout lives elsewhere, set its absolute path as `SITE_REPO_DIR` in `.env`, or pass `--site-dir <path>` per run.

## Provision Nova

```bash
node server/provision.mjs
```

This creates a brand-new intellect, avatar, agent, and knowledge base. Every run without `--reuse` creates a fresh set of live resources. To update an existing set in place, see [docs/HOW-TO.md](HOW-TO.md#redeploy-nova-in-place). The run uploads every site page into the knowledge base one chunk at a time and waits for indexing, so expect 20 minutes or more. It logs a line per step and ends with:

```
✅ provisioned. Wrote .../server/agent.json
{
  "configId": ...,
  "avatarId": "...",
  "agentId": "...",
  "widgetId": "...",
  ...
}
```

`server/agent.json` now holds the stable live ids (intellect, avatar, agent, widget) that every other command in this repo reads. The previous file is saved as `server/agent.json.bak`. The committed file holds the live Nova's ids, so run `git checkout server/agent.json` before you commit.

Knowledge ids are not stored. `provision.mjs` discovers them from the intellect on every run. The knowledge base starts inactive (`use_knowledge_base:'off'`) and `provision.mjs` turns it on once indexing is confirmed. See [docs/ARCHITECTURE.md](ARCHITECTURE.md#about-provisioning-and-knowledge-wiring) for why.

## Run the eval

```bash
node tests/eval/run.mjs
```

This drives the agent you just provisioned through every persona (a curious developer, a pricing-fisher, a prompt-injection attempt, a tour through every page, and more) and scores each turn. You see one line per turn as it runs, then a summary like this (your counts depend on the site):

```
✅ <N> turns · overall <N>% · 0 release-blocking failures · 0 errored/timed-out turns · <P>/<P> manifest pages exercised
   wrote tests/eval/artifacts/{transcript,report}.json + report.md + history snapshot
```

## Read the report

```bash
open tests/eval/artifacts/report.md
```

The top of the file is a ✅ Healthy or ⛔ RELEASE BLOCKED banner, followed by a per-dimension score table and a per-persona transcript. [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md) says what each dimension checks and why it does or does not block release.

## Where to go next

- [docs/HOW-TO.md](HOW-TO.md): redeploy Nova in place, tear her down, add a persona or probe, run the browser dashboard
- [docs/ARCHITECTURE.md](ARCHITECTURE.md): how the app and the eval harness are built, and why
- [docs/REFERENCE.md](REFERENCE.md): every script, flag, and env var
