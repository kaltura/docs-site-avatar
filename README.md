# Nova: the live SDK docs assistant

Nova is a live Kaltura Agentic Avatar embedded on the `@kaltura/intelligent-agents` docs site (the public GitHub Pages site, `gh-pages-src` branch). She answers visitor questions grounded in every page of the site (the same page list as the `go_to` sections manifest). She also drives real in-page navigation, including deep links to a specific section, with a single fire-and-forget `go_to(path, section?)` tool.

This repo does two things:

- **Runs the app.** `server/provision.mjs` creates, redeploys, and tears down Nova's live intellect, avatar, agent, and knowledge base using the SDK's Management API.
- **Proves she behaves.** `tests/eval/` is a live, no-mocks conversational test suite: adversarial personas, release-blocking correctness rules, pass^k reliability trials, a tool-call spiral circuit breaker, and a browser dashboard. Start at [docs/EVALS.md](docs/EVALS.md). It doubles as a reference implementation for evaluating any live avatar experience. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why.

The repo is standalone. `npm install` runs `scripts/fetch-sdk.mjs`, which pulls the SDK from jsDelivr at a pinned tag. No local SDK checkout is needed.

## Quickstart

```bash
git clone https://github.com/kaltura/docs-site-avatar.git
cd docs-site-avatar
npm install
cp .env.example .env
```

Fill in `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` in `.env` (from Kaltura's Rich Media CMS → Settings → Integration Settings). Then provision a fresh Nova, or point `SITE_REPO_DIR` at your checkout of the docs site and run the eval against an agent that is already live:

```bash
node server/provision.mjs
node tests/eval/run.mjs
```

The full walkthrough, with expected output at each step, is in [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md).

## Documentation map

| Doc | Read it when you want to |
|---|---|
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Go from a fresh clone to a passing eval run |
| [docs/EVALS.md](docs/EVALS.md) | Test Nova: commands, coverage, and methodology in one skim |
| [docs/HOW-TO.md](docs/HOW-TO.md) | Redeploy or tear down Nova, add a persona or probe, update the pinned SDK version |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | See how the pieces fit together and why the eval harness is built this way |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Look up an npm script, CLI flag, env var, or artifact file shape |
| [tests/eval/GUIDELINES.md](tests/eval/GUIDELINES.md) | See what each eval dimension measures, why it does or does not block release, and how to triage a failure |
| [SECURITY.md](SECURITY.md) | Report a vulnerability, or see how credentials and redeploy access are handled |
| [AGENTS.md](AGENTS.md) | Orient a coding agent: safety rules and commands |
| [Case Study: Nova](https://kaltura.github.io/intelligent-agents-sdk/explanation/case-study-nova/) | See how the knowledge-base and eval patterns here fit the wider SDK docs |

## Credentials

Where credentials live, why `server/agent.json` is committed, and what never goes in git: [SECURITY.md](SECURITY.md). Redeploying through GitHub Actions and setting up its secrets: [docs/HOW-TO.md](docs/HOW-TO.md).
