# Security

This repo runs Nova, a live Kaltura Agentic Avatar embedded on the `@kaltura/intelligent-agents` public docs site. It provisions and redeploys a real production agent (`server/provision.mjs`) and runs a live, no-mock conversational eval suite (`tests/eval/`) against it. Both need real `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` credentials.

## Scope

In scope for a report:

- `server/`: provisioning, redeploy, and teardown of the live intellect, avatar, agent, and knowledge base.
- `tests/eval/`: the eval harness, including its transport layer (`tests/eval/transport.mjs`) and the adversarial persona and probe definitions.
- `.github/workflows/`: `redeploy.yml` and `eval.yml`, and how they handle `AGENTIC_ADMIN_SECRET`.
- `scripts/fetch-sdk.mjs` and the jsDelivr-pinned SDK it vendors.

Out of scope: the `@kaltura/intelligent-agents` SDK itself (report against `kaltura/intelligent-agents-sdk`), and the docs site content (report against that site's own repo and branch).

## Reporting a vulnerability

Email `security@kaltura.com` with details and a proof of concept if you have one, or open a private GitHub Security Advisory from this repo's Security tab. Do not open a public GitHub issue for an undisclosed vulnerability, because this repo's eval suite and provisioning scripts operate against a real production agent. We acknowledge within a few business days and coordinate disclosure before any public write-up.

## What this repo does and doesn't handle for you

- `AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET` live only in a gitignored `.env` locally. In CI they are secrets on the `production` and `production-nightly` GitHub Environments. A repo-level secret is not visible to environment-gated jobs. Never commit a real admin secret or a raw KS token.
- `redeploy.yml` and `eval.yml` run in the `production` environment, which has required reviewers, for a push or a manual run. A human approves before either job can read `AGENTIC_ADMIN_SECRET`. The nightly and `site-updated` docs syncs, and the eval after them, run in `production-nightly`: no reviewers, `main` only. They change only the knowledge base, never the prompt or config. `eval.yml` only talks to the live agent and never provisions anything, but it needs the secret to authenticate.
- `ci.yml` runs on every pull request, including from forks, with no secrets.
- `server/agent.json` holds the stable provisioned ids. It is committed on purpose: it is runtime state, not a secret, and CI needs it on disk to redeploy the same intellect, agent, and avatar instead of creating new ones. CI never writes it back.
- Nova's knowledge base starts with `use_knowledge_base:'off'`. `provision.mjs` turns it on once indexing is confirmed. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- `tests/eval/` holds real adversarial jailbreak prompts and the exact refusal phrasing this agent relies on. They are published on purpose, as reference material ([why](docs/ARCHITECTURE.md#about-the-eval-harness-as-a-reusable-pattern)). Any addition must contain no real credentials, no other party's private data, and nothing crafted to attack a different live system.

For the SDK's own security posture (token model, audit logging, transport hardening, compliance crosswalks), see [`intelligent-agents-sdk`'s SECURITY.md](https://github.com/kaltura/intelligent-agents-sdk/blob/main/SECURITY.md).
