# AGENTS.md

Quick orientation for a coding agent working in this repo. It points to the real docs. The full doc map is in [README.md](README.md).

## What this is

Nova: a live Kaltura Agentic Avatar embedded on the `@kaltura/intelligent-agents` public docs site. This repo provisions and redeploys her (`server/provision.mjs`) and proves she behaves with a live, no-mock conversational eval suite (`tests/eval/`).

The repo is standalone. It vendors the SDK from jsDelivr, so no local checkout is needed. When you change `provision.mjs`'s `Management` calls, tool or capability names, or anything else the SDK's contract governs, check it against [kaltura/intelligent-agents-sdk](https://github.com/kaltura/intelligent-agents-sdk). Its `API-REFERENCE.md` and `SDK_CONSTITUTION.md` say which fields are verified.

## Before you touch anything

- Zero runtime dependencies, plain ESM, no build step. `postinstall` vendors the SDK from jsDelivr into the gitignored `vendor/sdk/`.
- Credentials live only in `.env` (gitignored) or CI environment secrets. Never commit a real `AGENTIC_ADMIN_SECRET` or a raw KS token. Run `node scripts/scan-secrets.mjs` before any commit.
- `node server/provision.mjs` with no flags always creates a brand-new intellect, avatar, and agent. It leaves the live Nova alone unless you pass `--reuse <configId> --agent-id <agentId>` with the ids from `server/agent.json`. It does overwrite `server/agent.json` (the old file goes to `server/agent.json.bak`), so restore it with `git checkout server/agent.json` before committing.
- `server/agent.json` is committed on purpose. [SECURITY.md](SECURITY.md) says why.
- `tests/eval/` holds real adversarial jailbreak prompts and Nova's exact refusal phrasing. They are published on purpose, as reference material. If you add to them, follow [SECURITY.md](SECURITY.md).

## Commands

| Task | Command | Needs live credentials? |
|---|---|---|
| Unit tests (probes, provision helpers, transports, personas, workflows, digest) | `npm run test:eval:unit` | No |
| Syntax-check `provision.mjs` | `node --check server/provision.mjs` | No |
| Secret scan | `node scripts/scan-secrets.mjs` | No |
| Preview the conversation digest change | `node server/provision.mjs --digest-plan` | Yes (read-only, needs `DIGEST_RECIPIENTS`) |
| Full live eval run | `node tests/eval/run.mjs` | Yes |
| Eval dashboard | `npm run eval:dashboard` | Yes |
| Reliability check (pass^k) | `node tests/eval/run.mjs --trials 3` | Yes |

Every script and flag: [docs/REFERENCE.md](docs/REFERENCE.md).

## Before opening a PR

Run the first three commands above. They are exactly what `.github/workflows/ci.yml` runs on every PR, and they need no secrets. `redeploy.yml` and `eval.yml` sit behind a GitHub `production` environment with required reviewers. Do not loosen that gate.
