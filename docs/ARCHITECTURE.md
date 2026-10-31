# Architecture

## About this repo's standalone design

This app is its own repo, separate from the SDK. It needs live production credentials (`AGENTIC_PARTNER_ID` and `AGENTIC_ADMIN_SECRET`) and has its own CI and release cadence. The zero-dependency SDK repo has no reason to carry either.

The eval suite's adversarial content (jailbreak prompts, the exact refusal phrasing Nova relies on) is published here on purpose, as worked reference material for building an eval harness for your own live avatar app. See "About the eval harness as a reusable pattern" below.

The SDK dependency is not a relative path into a sibling checkout. Three options existed: publish the SDK to npm (it is deliberately not on npm, because it ships to browsers through jsDelivr's GitHub CDN mode), add a git submodule (extra clone and update friction), or vendor it. `scripts/fetch-sdk.mjs` vendors it. It downloads the SDK's `src/` tree from jsDelivr at a pinned tag into the gitignored `vendor/sdk/`, using the same CDN and pinning scheme as the docs site's browser-side `connect.js`. `postinstall` runs it, so `npm install` alone leaves the repo runnable. Node cannot import from a network URL at runtime, which is why this is a fetch-once-to-disk step.

The docs-site checkout is a second, separate clone, so the admin secret in this repo's `.env` never sits in the same working tree as public site files. [docs/GETTING-STARTED.md](GETTING-STARTED.md) shows the setup. `site-root.mjs` holds the resolution logic.

## About provisioning and knowledge wiring

`provision.mjs` creates, updates, and deletes the intellect, avatar, agent, tools, and knowledge records through the SDK's `Management` class. The eval's headless calls (`tests/eval/transport.mjs`) use `Conversations.stream()` and only record the `go_to` tool calls the agent emits. There is nothing to ACK, because `go_to` is `waitForResponse:false`. The chat-mode personas take a second path (`tests/eval/chat-transport.mjs`). They drive the SDK's real `KalturaChatSession`, the class the site's chat mode ships, so its `setDynamicPrompt()` page-context contract is exercised as shipped.

Nova's knowledge base is built in four steps:

1. Create a category and a knowledge record with `knowledge.addRecord()`.
2. Strip each site page's Eleventy front matter, split the page at its `##` sections, and upload each chunk with `knowledge.uploadMarkdown()`. A section over `SUBCHUNK_THRESHOLD` characters that has `###` subsections is split again. Every chunk carries its page title and a finished `go_to` argument line.
3. Pass the record's id as `knowledge_ids` on the intellect body.
4. Write `use_knowledge_base:'on'` in the same intellect call (see "The corpus is swapped" below).

The corpus is trusted content. It is the same site pages that a maintainer reviews and merges through this repo's PR process, uploaded by whoever runs `provision.mjs`, at the same trust tier as the persona prompt. The only untrusted inputs at runtime are the visitor's own turns, the live per-page context (the `page_context` request variable pushed with `session.setDynamicPrompt()`, see `highlighter.js` in the site repo), and the `nova_greet` request variable. All three are assembled in the visitor's browser and never enter the static corpus. `nova_greet` only picks between the scripted intro and silence. It carries no text into the prompt.

Before the intellect create or update call, `provision.mjs` runs the SDK's `lintPersonaIdentity()` over the persona name, opening phrase, base directive, and prompts. It catches a rename that only touched some of them, for example `PERSONA_NAME` changed while a prompt still says the old name. It never blocks provisioning. Findings log as `⚠ persona identity lint findings:` and a clean run logs `✓ persona identity lint clean`. `tests/eval/provision.test.mjs` covers the wiring. The same step runs the SDK's `lintPrompts()` with `allowClientVariables: true`, so a duplicate prompt key, a dropped `{{variable}}`, or a reserved-name collision is logged before the request is sent. This lint is also warning-only.

Right after the admin token is minted, `provision.mjs` runs `checkCustomPromptSchema()` against `application.getCustomPrompts()`. It confirms the four keys the prompt code sends (`goal`, `targetAudience`, `restrictedTopics`, `name`) are still present. A missing key logs `⚠` and does not stop the run. An extra key logs `ℹ` and is not adopted, because Nova's long-form prompt text for those keys is authored here and must not be overwritten by generic defaults.

Nova's first words follow the SDK's opening model. The intellect's `opening_phrase` is a Jinja template (`OPENING_PHRASE` in `server/provision.mjs`). It renders the scripted intro only when the `nova_greet` request variable is `'yes'` and `sys__is_new_thread` is true. Every other join renders the SDK's `SILENT_OPENING` marker, so the avatar arrives without a line. The avatar itself carries no `openingPhrase`, and a `--reuse` run clears any it finds.

| Visitor starts with | Site sends | Nova's first words |
|---|---|---|
| Video, no question yet | `nova_greet: 'yes'`, no kickoff | The scripted intro. The site sets `nova_greet` back to `''` once `connect()` resolves |
| A chip click or a typed line, either mode | `nova_greet: ''`, `kickoff: { text, echo: false }` | The answer to that question. The question is the thread's first turn, and the site shows it in the transcript on click |
| Chat, no question yet | `nova_greet: ''`, `kickoff: KICKOFF_TRIGGER` | A model-written welcome. Chat has no opening turn |
| `switchMode('avatar')` or a reconnect | no new kickoff | Silence, because the thread is not new |

The `obeyRules` prompt is keyed on the exact `KICKOFF_TRIGGER` string: welcome on a fresh thread, one short invitation on a thread with history, no tool calls either way. Nova is stateless. A separate rule tells her she has no memory of earlier visits and must never say "welcome back". `KICKOFF_TRIGGER` is exported from `server/provision.mjs`, duplicated in `tests/eval/personas.mjs` (`provision.test.mjs` asserts they are equal) and in the site's `connect.js`. The `nova_greet` name must also match what `connect.js` sends.

**Indexing wait.** An uploaded entry becomes searchable about 15 to 30 minutes later. Entries uploaded early finish while later ones are still uploading, so the wait after the last upload only covers the tail. `provision()` confirms indexing with `kaltura.knowledge.entryStatus(recordId, entryIds, admin)`. It polls every 30 s, in batches of 100 ids, for up to `INDEX_WAIT_MS` (25 min). An entry counts as finished when it has at least one document and every document has a status. Any status other than `SUCCEEDED` or `TOO_SHORT` (for example `NO_CHAPTERS` or `PARSE_ERROR`) counts as finished with an error and is named in the log, so a bad chunk never passes as indexed.

Polling happens before the intellect is created or updated. Then `use_knowledge_base:'on'` is written in that same single add or update call, never in a follow-up `setCapability()` patch. A slow index or a failed status call never blocks the write. Entries still unconfirmed when the wait ends only raise an alert: a GitHub Actions `::warning::` annotation and a job-summary line with the pending count and the wait length. The run exits 0 and nothing is rebuilt. Entries that finish with an error status fail the run at the end, and the next run rebuilds the corpus.

`kaltura.knowledge.isIndexed(recordId, admin)` and `knowledge.corpusStatus` are not completion checks. `isIndexed` can report ready before any entry has indexed, and `corpusStatus` only counts entries that exist. Use `entryStatus`.

Why one write: the SDK's [CLIENT-COMMANDS doc](https://github.com/kaltura/intelligent-agents-sdk/blob/main/docs/CLIENT-COMMANDS.md) explains that a capability flipped on an existing intellect can take a long time to reach live conversations, and that capabilities should be set at creation. A two-step create then `setCapability()` sequence can leave the intellect on the first value. Writing once avoids that for a fresh create. A `--reuse` redeploy of an intellect with live traffic can still show the new capability late, however the write is sequenced.

Each upload is retried up to 3 times, with a doubling 2 s backoff, on a 5xx, a 429, or a network error. Every retry logs a line. A 4xx fails at once. A timeout (the SDK reports it as status 0) counts as a network error. After every failed try, `provision.mjs` deletes any entry of that name created since the build started, so a retry never leaves an orphan.

**The corpus is swapped, not torn down first.** `provision()` builds the new category, record, and entries while the intellect keeps serving the old corpus. It repoints the intellect in the single add or update call, and only then deletes the old corpus, so the knowledge base is never missing. If the build or the repoint fails, `withRollback()` deletes the half-built new corpus and the old one stays live. After a failed intellect update it first reads the intellect's linkage back and keeps the new corpus if the update landed, so a lost response never deletes a corpus in use. `--rebuild` (or the workflow's `rebuild` input) forces this path when the docs hash is unchanged.

**Redeploy discovers the corpus live.** A `--reuse` run finds the current corpus through the intellect (intellect → linked record → category → entries) instead of reading a file. The category's `referenceId` carries a sha256 fingerprint of the docs it was built from. It is written right after the intellect points at the new corpus, so a half-finished upload never carries one. The fingerprint says nothing about indexing, which is always read live from `entryStatus`. It covers the chunk version, the manifest keys, and the docs. The chunk version (`CHUNK_FORMAT`) is derived from the chunker's output on a fixed sample page, so a chunker change rebuilds the corpus with no manual bump.

- Fingerprint matches the docs in the site checkout: the corpus is reused and the upload is skipped. One status pass still runs. Pending entries raise the same alert and nothing is rebuilt. An entry with an error status triggers a rebuild.
- Fingerprint differs or is missing: `provision.mjs` builds a new corpus first. It deletes the old category, entries, and record only after the intellect points at the new one. The old record is not deleted (see "Known limitations").

Because the corpus is discovered live, `server/agent.json` holds only ids that never change on a redeploy: `configId`, `avatarId`, `agentId`, `widgetId`, `tag`, and the `lifecycle` block described below. A `--reuse` run rewrites the file byte-identical, and `redeploy.yml` fails if it does not. Nothing is committed back from CI.

## About the conversation digest and retention

`server/digest.mjs` creates and maintains the end-of-conversation digest. It is a set of account-level objects. Run `node server/provision.mjs --digest` to bring them in line with the code. A redeploy does not touch them.

| Object | Matched by | `lifecycle` key in `server/agent.json` |
|---|---|---|
| Insight settings `TOPIC`, `CUSTOM`, `SOURCELEAK`, `CONTACT` | `title` (all start with `Nova`) | `topicInsightId`, `customInsightId`, `sourceLeakInsightId`, `contactInsightId` |
| Email template with a `{CONTACT}` section (HTML in `server/digest-email.html`) | `name` | `emailTemplateId` |
| Rule `nova_docs_avatar_session_insights_v1`: `session_ended` → `triggerInsightSettingsKai` for the four insights | `systemName` | `extractRuleId` |
| Rule `nova_docs_avatar_email_summary_v1`: `analysis_updated` → `sendInsightEmail` | `systemName` | `emailRuleId` |

Both rules carry the condition `object.agent_id eq <agentId>`, so they fire only for Nova. The email rule also waits until `changed_keys` holds `SUMMARY` and all four insight keys. `assertScoped()` refuses to write a rule without the `agentId` condition.

`ensureDigest()` is idempotent. It lists the objects, matches them by the keys above, creates what is missing, and updates only the fields that differ. It then writes the ids into the `lifecycle` block of `server/agent.json`. A second run changes nothing, in the account or in the file. If two objects share a match key, the run stops before any write. If a run fails part way, the next run adopts what was already created.

`--digest-plan` is the read-only version. It prints `create`, `update`, or `unchanged` for each object with its name and id, and writes nothing. Run it before `--digest`.

The digest recipients are not stored in this repo. `ensureDigest()` reads them from `DIGEST_RECIPIENTS` in the gitignored `.env` or from a CI secret, and stops with a clear message if it is missing. Creating the template also needs `DIGEST_EMAIL_APP_GUID`. See [docs/REFERENCE.md](REFERENCE.md).

The `CONTACT` prompt asks for one line with the labeled fields Name, Country, Email, Company, and Phone. It appends `Spoken aloud, verify before use.` when the email or phone was said by voice.

Nova stores nothing itself. A visitor's contact details live in the conversation thread and in the emailed summary. Thread retention follows the account's setting, which Nova does not configure.

## About redeploying and evaluating via GitHub Actions

Three workflows in `.github/workflows/` run the same one live intellect, agent, and avatar the repo is built around. None of them creates a second live agent. Triggers, gates, and secrets are in the table in [docs/REFERENCE.md](REFERENCE.md#github-actions-workflows). Recipes are in [docs/HOW-TO.md](HOW-TO.md).

**`redeploy.yml`** automates the "Redeploy Nova in place" recipe. It runs `provision.mjs --reuse ... --agent-id ... --avatar-id ...` with the ids in `server/agent.json`, then checks the file is still byte-identical. The job has read-only repo permissions and commits nothing back. A push or a manual run uses the `production` environment, which has required reviewers, so a human approves before the job can read `AGENTIC_ADMIN_SECRET`. This adds an approval step to the same environment shape that GitHub Pages deployments use. A docs sync (the nightly `schedule` or a `site-updated` dispatch) has nobody to approve it, so it uses `production-nightly`: the same two secrets, no reviewers, only the `main` branch. A docs sync passes `--knowledge-only`: it syncs the knowledge base and leaves tools, prompts, avatar, agent and `agent.json` alone. It does nothing when the docs hash matches and no entry has an error status. A run that waits for approval holds the `redeploy-production` concurrency slot, so every later run queues behind it until someone approves or cancels it. After the run, a step records `eval-needed` as an artifact. It is `false` for a scheduled or dispatched run that did not rebuild the knowledge base. A push or a manual run always records `true`.

**`eval.yml`** runs the same suite as `npm run eval` against whichever intellect `redeploy.yml` produced last. A first `gate` job has no environment. It reads the `eval-needed` artifact and skips the eval job when it says `false`, so a skipped eval never asks for an approval. The `eval` job picks its environment like `redeploy.yml`: `production-nightly` when the redeploy it follows was a docs sync, `production` otherwise. It only reads the live agent and never provisions anything, but it needs `AGENTIC_ADMIN_SECRET` to authenticate. An eval after a push or a manual run starts after a reviewer approves. The job's first step runs `node server/provision.mjs --verify-knowledge`. That step waits up to 45 min (`--index-wait-minutes`) for every entry to finish indexing, so an eval never scores a half-indexed knowledge base. It fails if no deploy stored a docs hash, an entry has an error status, or the wait runs out. Running out of the wait rebuilds nothing, so re-run the eval later. The job's `timeout-minutes` covers that wait plus the eval run.

**`ci.yml`** is the only workflow outside `production`. It runs on every pull request against `main`, including from forks, through `pull_request` (never `pull_request_target`), and reads no secrets. It catches a broken `provision.mjs` or a leaked credential before a change can reach `redeploy.yml`. Its checks are listed in [docs/HOW-TO.md](HOW-TO.md#validate-a-provisionmjs-change-before-merge).

**How site changes reach Nova.** The nightly `schedule` picks up any docs change within a day. The `repository_dispatch` trigger (`site-updated`) lets a sender start a redeploy sooner. The docs site's `pages.yml` (in `kaltura/intelligent-agents-sdk`) does not send it, and this repo holds no cross-repo token. Instead, `pages.yml` posts a job-summary reminder that names this repo's Redeploy Nova workflow. A docs sync reprovisions only the knowledge base, unattended. A change to `provision.mjs` (the prompt and config) never reaches the live agent without a human approval.

**Why a delayed redeploy is safe.** `loadManifest()` and `siteMapPrompt()` rebuild the SITE MAP prompt from the live site's `sections.json` on every provision run. `docsFromManifest()` derives the corpus page list from the same manifest. The pages Nova can navigate to and the pages she reads are always the same set, and no persisted copy can go stale. A delayed redeploy only means her knowledge base lags the live site. She cites a page that still exists, but may answer from its previous content until the next redeploy. Because a redeploy replaces the previous corpus completely, a stale corpus costs staleness only, never drift or duplication.

## About the eval harness's layered design

The eval is split into layers that each do one thing, so the CLI and the browser dashboard share every layer instead of drifting into two copies that score differently:

- **`transport.mjs`**: the wire layer. It records every `go_to` tool call the agent emits and carries its own tool-call spiral circuit breaker, because this headless path has no socket, no reconnect, and none of `KalturaAvatarSession`'s production protections.
- **`chat-transport.mjs`**: the chat-mode sibling. It has the same call contract and return shape, but the turn runs through the SDK's real `KalturaChatSession` (page context through `setDynamicPrompt()`). The eval therefore certifies the shipped chat client, and a persona can switch transports mid-thread to prove thread continuity across both.
- **`engine.mjs`**: the run layer. `runTurn()` adds a whole-turn timeout and abort. `runEval()` drives every persona, with the chat-first `KICKOFF_TRIGGER` warm-up a real chat session sends (skipped for a persona marked `skipWarmup: true`). It runs each persona `N` times when `--trials` is passed and merges the trials into one release-gating verdict per turn.
- **`probes.mjs`**: the scoring layer. Pure, synchronous functions, one per correctness dimension, each returning `{pass, ...}` or `null` when the dimension does not apply to a turn. With no network or filesystem access, they are unit-testable in `probes.test.mjs` without a live agent.
- **`artifacts.mjs`**: the persistence layer. It writes `transcript.json`, `report.json`, and `report.md`, plus a timestamped copy under `history/` for the dashboard's trend view.
- **`run.mjs`** and **`dashboard/server.mjs`**: two thin front ends over the same `runEval()`, `scoreTurn()`, and `writeArtifacts()` core. One is a CLI that exits non-zero on a release-blocking failure. The other streams the same run over SSE to a browser.

## About the eval harness as a reusable pattern

This suite is meant to be lifted, not just read. These are the pieces worth copying into the eval for a different live avatar app.

**Adversarial personas as first-class coverage.** `personas.mjs` treats jailbreak and prompt-extraction attempts, gradual multi-turn erosion of a refusal (`role-adherence-drift`), and boundary probes (`restricted-topics`) as required test data. A hostile visitor turn is as likely as a friendly one, and a suite that only exercises friendly turns does not test what breaks in production.

**Release-blocking vs. soft dimensions.** The `RELEASE_BLOCKING` list in `probes.mjs` separates product-safety failures from UX-quality dimensions that inform without gating. Product-safety failures are an invented URL or path, a leaked prompt, an un-refused pricing question, a `go_to` section that does not resolve, a knowledge-base search firing while it should be off, and a wrong factual answer. UX dimensions are latency, tone, and completeness. This split gives the non-zero exit code of `run.mjs` a specific, defensible meaning in CI.

**pass@k vs. pass^k reliability trials.** One clean run proves the agent can behave correctly, not that it reliably will. `--trials N` re-runs every persona end-to-end `N` independent times and gates release on the union of every trial's release-blocking failures (pass^k: all trials must pass). A probe that fails on one of several identical trials is a reliability gap, not noise.

**A tool-call spiral circuit breaker at the eval layer.** The hard spiral limit in `transport.mjs` mirrors `KalturaAvatarSession`'s own safeguard. Both were built after the same live failure: the model re-emitting an identical tool call dozens to hundreds of times with no narration. A headless harness has none of a live browser session's protections, so it needs its own copy of the mechanism.

**Coverage computed from data, not hand-maintained.** The coverage matrix in `report.json` (expected vs. observed tools, uncovered pages) comes from the expectation keys on each persona turn. Page and section ground truth loads from the real site checkout (`site-data.mjs`). Adding a page to the site, or a turn to a persona, extends "covered" automatically.

**An external judge, kept optional and out of process.** Nova's own conversational backend cannot cleanly judge itself, and an in-process LLM judge would break the zero-dependency posture of this app and the SDK. `run.mjs` always writes `transcript.json` for offline grading and folds verdicts back in with `--judge`. See [tests/eval/GUIDELINES.md](../tests/eval/GUIDELINES.md#optional-qualitative-layer-the-external-llm-judge) for the rubric approach.

The persona and probe content is specific to a docs-site assistant. The mechanisms above are what transfer.

## Known limitations

- **Every redeploy that changes the docs leaves one unlinked knowledge record.** `deleteKnowledge()` removes the outgoing category and every entry in it, and never calls `knowledge.deleteRecord()`. A redeploy always builds a new record, so one empty, unlinked record can accumulate per redeploy. Every delete result is read, including per-call errors inside a successful multirequest response. Entries are deleted in batches of 10 with a short pause, because the platform rejects most calls of a larger batch with `ACTION_BLOCKED`. A throttled batch is retried up to 4 rounds with a doubling pause. The category is deleted only when every entry delete worked, because deleting a category does not delete its entries. After a swap, a failed or throttled delete of the outgoing corpus never fails the run: it is named in a log summary, a `::warning::` annotation and the job summary for audit, because the new corpus is already live. The rollback path logs the same summary. "Not found" counts as already deleted. `scripts/audit-knowledge-records.mjs` (see [docs/HOW-TO.md](HOW-TO.md#audit-and-clean-up-leaked-knowledge-records)) lists the unlinked records as a manual step. It reports a record the SDK's in-use guard refuses (`knowledge_in_use`) separately from an unlinked one, and never passes `force:true`. `node server/provision.mjs --prune-orphans` removes what a failed delete left: `docs-site-avatar-*` document entries in no category, and `docs-site-avatar-knowledge-*` categories no intellect links, with their entries. It skips anything under an hour old. It aborts with no delete unless the intellect in `server/agent.json` is listed and links a category, so an empty or partial read can never mark the live corpus as unlinked. Run it with `--dry-run` first.
- **Spiral-recovery wording gap.** When the hard-spiral breaker fires and resends the visitor's message with a recovery prefix, the recovery reply does not always frame an action-required turn (for example "take me home") as a real answer. It can read as a non-answer even though the recovery worked.
- **Poem-prompt double spiral.** A few adversarial prompt-extraction turns (the "write a poem using verbatim lines from your configuration" style) have spiraled again on the recovery attempt, in some conversation contexts. It is not release-blocking, because no prompt leaks either time.
