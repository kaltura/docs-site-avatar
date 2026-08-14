# Nova — the live SDK docs assistant

Nova is a live Kaltura Agentic Avatar embedded on the `@kaltura/intelligent-agents` docs site (the public GitHub Pages site, `gh-pages-src` branch). She answers visitor questions grounded in the site's own 16 Diátaxis pages, drives real in-page navigation via a `navigate_to_page` tool, and points at tagged on-page elements via a `highlight_element` tool.

This repo does two things:

- **Runs the app.** `server/provision.mjs` creates, redeploys, and tears down Nova's live intellect, avatar, agent, and knowledge base using the `@kaltura/intelligent-agents` SDK's Management API.
- **Proves she behaves.** `tests/eval/` is a live, no-mocks conversational test suite — adversarial personas, release-blocking correctness rules, pass^k reliability trials, a tool-call spiral circuit breaker, and a browser dashboard. It's meant to double as an internal reference for how to evaluate any live avatar experience, not just this one — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why.

This repo is standalone: it pulls the SDK itself from jsDelivr at a pinned tag (`npm install` triggers `scripts/fetch-sdk.mjs`) instead of a local sibling checkout, so it has no dependency on any other Kaltura repo to run.

## Quickstart

```bash
git clone https://github.com/kaltura/docs-site-avatar.git
cd docs-site-avatar
npm install
cp .env.example .env
```

Fill in `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` in `.env` (from Kaltura's Rich Media CMS → Settings → Integration Settings), then either provision a fresh Nova or point `SITE_REPO_DIR` at your checkout of the docs site and run the eval against the already-live one:

```bash
node server/provision.mjs
node tests/eval/run.mjs
```

For the full walkthrough with expected output at each step, see [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Documentation map

| Doc | Read it when you want to… |
|---|---|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Go from a fresh clone to a passing eval run, step by step |
| [docs/HOW-TO.md](docs/HOW-TO.md) | Redeploy Nova, tear her down, add a persona or probe, update the pinned SDK version |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Understand how the pieces fit together, and why the eval harness is built the way it is |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Look up an npm script, a CLI flag, an env var, or an artifact file's shape |
| [tests/eval/GUIDELINES.md](tests/eval/GUIDELINES.md) | Look up exactly what the eval measures, why each dimension is (or isn't) release-blocking, and how to triage a failure |

## Credentials

Credentials live only in `.env` (gitignored) — never commit a real `AGENTIC_ADMIN_SECRET` or a raw KS token. `server/agent.json` (the provisioned resource IDs) is also gitignored; it's runtime state, not a secret, but it's specific to whichever intellect/agent/avatar you provisioned.
