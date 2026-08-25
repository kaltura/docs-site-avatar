# AGENTS.md

Quick orientation for a coding agent working in this repo. It's a pointer to the real docs, not a replacement for them — see the map in [README.md](README.md) for the full set.

## What this is

Nova: a live Kaltura Agentic Avatar embedded on the `@kaltura/intelligent-agents` public docs site. This repo provisions/redeploys her (`server/provision.mjs`) and proves she behaves with a live, no-mock conversational eval suite (`tests/eval/`).

## Before you touch anything

- Zero runtime dependencies, plain ESM, no build step. `npm install`'s `postinstall` vendors the SDK from jsDelivr into gitignored `vendor/sdk/`.
- Credentials live only in `.env` (gitignored) or CI environment secrets. Never commit a real `AGENTIC_ADMIN_SECRET` or a raw KS token (`djJ8...`). Run `node scripts/scan-secrets.mjs` before any commit touching tracked files.
- `node server/provision.mjs` with no flags **always creates a brand-new intellect/avatar/agent** — it never touches the live Nova on the public docs site unless you explicitly pass `--reuse <configId> --agent-id <agentId>` read from `server/agent.json`. Safe to run for testing.
- `server/agent.json` is committed on purpose — it's runtime state (provisioned resource IDs), not a secret.
- `tests/eval/` contains real adversarial jailbreak prompts and Nova's exact refusal phrasing, published deliberately as reference material (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). If you add to it, follow [SECURITY.md](SECURITY.md): no real credentials, no other party's private data, nothing crafted to attack a different live system.

## Commands

| Task | Command | Needs live credentials? |
|---|---|---|
| Unit tests (probes + provision helpers) | `npm run test:eval:unit` | No |
| Syntax-check `provision.mjs` | `node --check server/provision.mjs` | No |
| Secret scan | `node scripts/scan-secrets.mjs` | No |
| Full live eval run | `node tests/eval/run.mjs` | Yes |
| Eval dashboard | `npm run eval:dashboard` | Yes |
| Reliability check (pass^k) | `node tests/eval/run.mjs --trials 3` | Yes |

## Before opening a PR

Run the three no-credential checks above — they're exactly what `.github/workflows/ci.yml` runs on every PR/push, no secrets needed. `redeploy.yml`/`eval.yml` are separately gated behind a GitHub `production` environment with required reviewers; don't loosen that gating.

## Docs map

| Doc | Read it for |
|---|---|
| [README.md](README.md) | Overview, quickstart, full doc map |
| [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md) | Fresh clone → passing eval run, step by step |
| [docs/EVALS.md](docs/EVALS.md) | What the eval suite covers and how it works, in one skim |
| [docs/HOW-TO.md](docs/HOW-TO.md) | Redeploy, tear down, extend, CI setup |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Why the repo and the eval harness are built this way |
| [docs/REFERENCE.md](docs/REFERENCE.md) | Every script, flag, and env var |
| [tests/eval/GUIDELINES.md](tests/eval/GUIDELINES.md) | Every eval dimension, why it's (or isn't) release-blocking, failure triage |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting, credential handling, what's in/out of scope |
