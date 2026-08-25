# Security

This repo runs Nova, a live Kaltura Agentic Avatar embedded on the
`@kaltura/intelligent-agents` public docs site. It provisions and redeploys a
real production agent (`server/provision.mjs`) and runs a live, no-mock
conversational eval suite (`tests/eval/`) against it — both need real
`AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET` credentials to operate.

## Scope

In scope for a report:

- `server/` — provisioning, redeploy, and teardown of the live intellect,
  avatar, agent, and knowledge base.
- `tests/eval/` — the eval harness itself, including its transport layer
  (`tests/eval/transport.mjs`) and adversarial persona/probe definitions.
- `.github/workflows/` — `redeploy.yml` and `eval.yml`, and how they handle
  `AGENTIC_ADMIN_SECRET`.
- `scripts/fetch-sdk.mjs` and the jsDelivr-pinned SDK dependency it vendors.

Out of scope: the `@kaltura/intelligent-agents` SDK itself (report against
`kaltura/intelligent-agents-sdk`), and the docs site content (report against
that site's own repo/branch).

## Reporting a vulnerability

Email `security@kaltura.com` with details and a proof of concept if you have
one, or open a private GitHub Security Advisory from this repo's Security
tab. Please do not open a public GitHub issue for an undisclosed
vulnerability, since this repo's eval suite and provisioning scripts operate
against a real production agent. We acknowledge within a few business days
and coordinate disclosure before any public write-up.

## What this repo does and doesn't handle for you

- Credentials (`AGENTIC_PARTNER_ID`/`AGENTIC_ADMIN_SECRET`) live only in a
  gitignored `.env` locally, or in GitHub Environment/repository secrets in
  CI — never commit a real admin secret or a raw KS token.
- `redeploy.yml` is gated behind a GitHub Environment named `production`
  with required reviewers, so a human approves before the job can read
  `AGENTIC_ADMIN_SECRET` and reshape the live agent. `eval.yml` only reads
  the live agent conversationally and never provisions anything.
- `server/agent.json` (the provisioned resource IDs) is committed on
  purpose — it's runtime state, not a secret, and CI needs it on disk to
  redeploy the same live intellect/agent/avatar rather than minting new ones.
- Nova's knowledge base starts `use_knowledge_base:'off'` and `provision.mjs`
  flips it on automatically once indexing is confirmed ready — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why, and for the
  cache-propagation caveat on a `--reuse` redeploy.
- `tests/eval/` contains real adversarial jailbreak prompts and the exact
  refusal phrasing this agent relies on. That's published on purpose, as
  worked reference material — see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s "eval harness as a reusable
  pattern." Treat *new* additions to it with the same care: no real
  credentials, no other party's private data, and nothing crafted to attack
  a different live system.

For the SDK's own security posture (token model, audit logging, transport
hardening, compliance crosswalks), see
[`intelligent-agents-sdk`'s SECURITY.md](https://github.com/kaltura/intelligent-agents-sdk/blob/main/SECURITY.md).
