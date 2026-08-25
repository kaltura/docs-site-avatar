# Getting started

By the end of this walkthrough, we'll have a fresh Nova provisioned against a real docs-site checkout, and a passing eval run proving she behaves correctly against it.

## Install

```bash
git clone https://github.com/kaltura/docs-site-avatar.git
cd docs-site-avatar
npm install
```

`npm install` has nothing to install from the registry — this repo ships with zero npm dependencies — but its `postinstall` script fetches `@kaltura/intelligent-agents` from jsDelivr into a local `vendor/sdk/` directory. You'll see:

```
Fetching @kaltura/intelligent-agents-sdk@<pinned tag> from jsDelivr into vendor/sdk ...
Vendored <N> files at <pinned tag>.
```

(The pinned tag is `DEFAULT_TAG` in `scripts/fetch-sdk.mjs`.)

## Configure credentials

```bash
cp .env.example .env
```

Open `.env` and fill in `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` — get both from Kaltura's Rich Media CMS → Settings → Integration Settings.

## Get a docs-site checkout

Nova is grounded on the real markdown pages of the public docs site, and the eval suite reads the site's real page list to know what "correct navigation" means — so we need our own checkout of it. It's deliberately a separate clone from this repo, so the admin secret we just added to `.env` never sits anywhere near the public site's files:

```bash
git clone --branch gh-pages-src https://github.com/kaltura/intelligent-agents-sdk.git ../intelligent-agents-sdk-site
```

The command above puts the clone at the default location (`../intelligent-agents-sdk-site`, a sibling of this repo), so nothing else is needed. If your checkout lives somewhere else, set its absolute path in `.env` as `SITE_REPO_DIR` (or pass `--site-dir <path>` per run).

## Provision Nova

```bash
node server/provision.mjs
```

This creates a brand-new intellect, avatar, agent, and knowledge base — every run without `--reuse` is a fresh set of live resources (see [docs/HOW-TO.md](HOW-TO.md) for updating an existing one in place instead). Expect it to take a little while: it uploads all 16 site pages into the knowledge base one at a time. You'll see a line per step, ending with:

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

`server/agent.json` now holds the live resource IDs every other command in this repo reads. The knowledge base starts inactive (`use_knowledge_base:'off'`) and `provision.mjs` flips it on itself once indexing is confirmed ready — see [docs/ARCHITECTURE.md](ARCHITECTURE.md) for why.

## Run the eval

```bash
node tests/eval/run.mjs
```

This drives the real agent we just provisioned through every persona — a curious developer, a pricing-fisher, a prompt-injection attempt, a site tour through all 16 pages, and more — and scores every turn. You'll see one line per turn as it runs, then a summary:

```
✅ 60 turns · overall 99% · 0 release-blocking failures · 0 errored/timed-out turns · 16/16 routes exercised
   wrote tests/eval/artifacts/{transcript,report}.json + report.md + history snapshot
```

## Read the report

```bash
open tests/eval/artifacts/report.md
```

The top of the file is a ✅ Healthy / ⛔ RELEASE BLOCKED banner, followed by a per-dimension score table and a per-persona transcript. See [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md) for exactly what each dimension checks and why it's (or isn't) release-blocking.

## Where to go next

- [docs/HOW-TO.md](HOW-TO.md) — redeploy Nova in place, tear her down, add a persona or probe, run the browser dashboard
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) — how the app and the eval harness are built, and why
- [docs/REFERENCE.md](REFERENCE.md) — every script, flag, and env var in one place
