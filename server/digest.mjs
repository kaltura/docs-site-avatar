/**
 * Nova's end-of-conversation digest as code: four insight settings, one email template and two
 * lifecycle rules. `ensureDigest()` is idempotent. It finds each object by its stable name,
 * creates what is missing, updates what drifted, leaves the rest alone, and records the ids in
 * server/agent.json under `lifecycle`.
 *
 * Match keys: insight settings by `title`, the template by `name`, rules by `systemName`.
 * Two objects with the same match key stop the run. The code never guesses and never duplicates.
 *
 * Every rule is scoped to Nova's agent id (`object.agent_id eq <agentId>`), so it can never fire
 * for another agent on the same account. `assertScoped()` enforces this before any write.
 *
 * Import-safe: no credentials are read here. The caller passes a `Management` client and an admin
 * token, so tests run against a fake client with no network.
 */
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

export const RECIPIENTS_ENV = 'DIGEST_RECIPIENTS';
export const APP_GUID_ENV = 'DIGEST_EMAIL_APP_GUID';

/** Keys of agent.json's `lifecycle` block, in file order. */
export const LIFECYCLE_KEYS = ['topicInsightId', 'customInsightId', 'sourceLeakInsightId', 'contactInsightId', 'emailTemplateId', 'extractRuleId', 'emailRuleId'];

const INSIGHT_FIELDS = ['key', 'title', 'prompt', 'valueType', 'status'];
const TEMPLATE_FIELDS = ['name', 'subject', 'body', 'fromName', 'msgParamsMap', 'status'];
const RULE_FIELDS = ['name', 'systemName', 'eventType', 'objectType', 'status', 'eventConditions', 'action'];

const TOPIC_PROMPT = [
  'In a few words, what was this conversation with Nova (the Kaltura Agentic Avatars SDK docs assistant) mainly about?',
].join('\n');

const CUSTOM_PROMPT = [
  'Write a detailed, comprehensive report on this conversation for the product team. Output plain text only, no markdown, no numbering, no asterisks or bold markers. Use this exact layout, one blank line between sections, each section starting with its label in capital letters followed by a colon on its own line, then the content on the next line:',
  '',
  'USAGE AND USE CASE:',
  'What the visitor was actually trying to do with Nova or the SDK.',
  '',
  'BUSINESS NEEDS:',
  'Any goals, context, or constraints they mentioned.',
  '',
  'CHALLENGES AND ISSUES:',
  'Anything confusing, broken, or hard for them.',
  '',
  'FRUSTRATIONS:',
  'Any dissatisfaction or negative sentiment they expressed, quoted where useful.',
  '',
  'FEATURE REQUESTS:',
  'Anything they wished existed or explicitly asked for.',
  '',
  'OTHER NOTES:',
  'Anything else notable for the product team.',
  '',
  'If a section has nothing relevant, write "None noted." under that label. Be specific and concrete, not generic.',
].join('\n');

const SOURCE_LEAK_PROMPT = [
  'Check whether any assistant reply in this conversation showed raw retrieval output to the user.',
  '',
  'IMPORTANT: after each assistant reply, the transcript stores a system metadata block that the user never sees. It always has this exact two-level shape: a line `used_sources:`, then an indented second line `used_sources:`, then a list of entry ids. Ignore every block of that shape completely. It is not a leak.',
  '',
  'A real leak is source data inside the reply text itself, for example: a single-level `used_sources:` or `sources:` line followed directly by a list of ids (often quoted, like `- "1_abc12345"`), a JSON list of ids, or bare Kaltura entry ids such as `1_abc12345` / `0_abc12345` that appear inside the reply prose instead of in the metadata block. Normal links, page paths and section names are fine and must not be flagged.',
  '',
  'If you find a real leak, answer `LEAK DETECTED` on the first line, then one line per affected reply: a short paraphrase of the user question it answered, followed by the exact leaked text in quotes. If you find none, answer exactly `None detected`.',
].join('\n');

const CONTACT_PROMPT = [
  'Did the visitor ask to be contacted by a Kaltura representative, or agree to it when Nova offered? Output plain text only, no markdown, no asterisks, and keep everything on ONE line. If they did not, write exactly: None requested.',
  '',
  'If they did, write one line in exactly this form, copying each value as the visitor gave it and never guessing a missing one (write "not given" instead):',
  '',
  'Name: <name> | Country: <country> | Email: <email> | Company: <company or organization> | Phone: <phone>',
  '',
  'If the email or phone was spoken aloud, append: | Spoken aloud, verify before use.',
].join('\n');

/** Nova's insight settings, in the order the extract rule lists them. `idKey` is the agent.json key. */
export const INSIGHTS = [
  { idKey: 'topicInsightId', key: 'TOPIC', title: 'Nova — Conversation topic', prompt: TOPIC_PROMPT, valueType: 'string', status: 'active' },
  { idKey: 'customInsightId', key: 'CUSTOM', title: 'Nova — Business & product insights', prompt: CUSTOM_PROMPT, valueType: 'string', status: 'active' },
  { idKey: 'sourceLeakInsightId', key: 'SOURCELEAK', title: 'Nova — raw source-id leak check', prompt: SOURCE_LEAK_PROMPT, valueType: 'string', status: 'active' },
  { idKey: 'contactInsightId', key: 'CONTACT', title: 'Nova — Contact request', prompt: CONTACT_PROMPT, valueType: 'string', status: 'active' },
];

const SUMMARY_KEY = 'SUMMARY';
/** The insight keys the email rule waits for before it sends. SUMMARY is the platform's built-in summary. */
export const CHANGED_KEYS = [SUMMARY_KEY, ...INSIGHTS.map((i) => i.key)];

export const EXTRACT_SYSTEM_NAME = 'nova_docs_avatar_session_insights_v1';
export const EMAIL_SYSTEM_NAME = 'nova_docs_avatar_email_summary_v1';

/** The email body lives in its own file so the HTML stays readable. */
const TEMPLATE_BODY = readFileSync(new URL('./digest-email.html', import.meta.url), 'utf8').replace(/\n$/, '');

/** The email template without `appGuid`, which is account-specific and only needed on create. */
export function templateDefinition() {
  return {
    name: 'Nova — Conversation Insight Digest',
    subject: 'Nova conversation digest — {TOPIC}',
    body: TEMPLATE_BODY,
    toAttributePath: '{USER.email}',
    fromName: 'Nova — SDK Docs Assistant',
    msgParamsMap: {
      USER: { type: 'User' },
      AGENTNAME: { type: 'String' },
      SUMMARY: { type: 'String' },
      TOPIC: { type: 'String' },
      CUSTOM: { type: 'String' },
      SOURCELEAK: { type: 'String' },
      CONTACT: { type: 'String' },
    },
    status: 'enabled',
  };
}

const agentScope = (agentId) => ({ field: 'object.agent_id', operator: 'eq', value: agentId });

/**
 * Builds both lifecycle rules. Each carries the `object.agent_id` condition, and the email rule
 * also waits for every insight (`changed_keys has_all`).
 * @param {{agentId:string, insightIds:string[], templateId:string, recipients:string[]}} p
 */
export function buildRules({ agentId, insightIds, templateId, recipients }) {
  return {
    extract: {
      name: 'Nova — extract conversation insights on session end',
      systemName: EXTRACT_SYSTEM_NAME,
      eventType: 'session_ended',
      objectType: 'thread',
      status: 'active',
      eventConditions: [agentScope(agentId)],
      action: { actionType: 'triggerInsightSettingsKai', insightSettingsIds: insightIds },
    },
    email: {
      name: 'Nova — email the conversation summary',
      systemName: EMAIL_SYSTEM_NAME,
      eventType: 'analysis_updated',
      objectType: 'thread',
      status: 'active',
      eventConditions: [agentScope(agentId), { field: 'changed_keys', operator: 'has_all', value: [...CHANGED_KEYS] }],
      action: { actionType: 'sendInsightEmail', recipients, templateId },
    },
  };
}

/** Throws unless `rule` has the `object.agent_id eq <agentId>` condition. Runs before every rule write. */
export function assertScoped(rule, agentId) {
  if (typeof agentId !== 'string' || !agentId.trim()) throw new Error('digest: a rule needs a non-empty agent id');
  const scoped = (rule?.eventConditions || []).some((c) => c.field === 'object.agent_id' && c.operator === 'eq' && c.value === agentId);
  if (!scoped) throw new Error(`digest: rule ${rule?.systemName} has no object.agent_id eq ${agentId} condition. Refusing to write an unscoped rule.`);
}

/** Order-independent form of a value: object keys sorted. Used to compare stored and wanted objects. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

/** Id and value lists where order carries no meaning are sorted before comparing. */
function normalizeRule(rule) {
  const sorted = (a) => (Array.isArray(a) ? [...a].sort() : a);
  return {
    ...rule,
    eventConditions: (rule.eventConditions || []).map((c) => (Array.isArray(c.value) ? { ...c, value: sorted(c.value) } : c)),
    action: {
      ...rule.action,
      ...(rule.action?.insightSettingsIds ? { insightSettingsIds: sorted(rule.action.insightSettingsIds) } : {}),
      ...(rule.action?.recipients ? { recipients: sorted(rule.action.recipients) } : {}),
    },
  };
}

/** Names of the fields in which `stored` differs from `wanted`. Values are never reported. */
export function changedFields(wanted, stored, fields, normalize = (x) => x) {
  const w = normalize(wanted);
  const s = normalize(stored);
  return fields.filter((f) => JSON.stringify(canon(w[f])) !== JSON.stringify(canon(s[f])));
}

const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));

function findOne(items, matches, label, name) {
  const hits = items.filter(matches);
  if (hits.length > 1) throw new Error(`digest: ${hits.length} ${label} are named "${name}" (ids ${hits.map((h) => h.id).join(', ')}). Remove the extra ones, then run again.`);
  return hits[0] || null;
}

/** Reads `DIGEST_RECIPIENTS` (comma-separated) and the agent id. Fails with a message that names the fix. */
export function digestConfig(env, saved) {
  const agentId = saved?.agentId;
  if (!agentId) throw new Error('server/agent.json has no agentId. Provision Nova first, then run the digest step.');
  const recipients = (env[RECIPIENTS_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) {
    throw new Error(`Set ${RECIPIENTS_ENV} (comma-separated recipients of the digest email) in the gitignored .env or as a CI secret. It is never stored in this repo.`);
  }
  return { agentId, recipients, appGuid: (env[APP_GUID_ENV] || '').trim() || null };
}

const placeholder = (idKey) => `<new:${idKey}>`;

/**
 * Brings the digest objects in line with this file. With `apply: false` it only reads and reports.
 * Returns one row per object: `{ kind, name, idKey, id, action, fields }` where action is
 * `create`, `update` or `unchanged`.
 * @param {{kaltura:object, admin:string, agentJsonPath:string, env?:object, apply?:boolean, log?:(line:string)=>void}} opts
 */
export async function ensureDigest({ kaltura, admin, agentJsonPath, env = process.env, apply = false, log = console.log }) {
  const savedText = await readFile(agentJsonPath, 'utf8').catch(() => '{}');
  const saved = JSON.parse(savedText);
  const { agentId, recipients, appGuid } = digestConfig(env, saved);

  // Read everything first, so a duplicate or a missing setting stops the run before any write.
  const [insights, templates, rules] = await Promise.all([
    kaltura.insightSettings.list(admin, { pageSize: 100 }).all(),
    kaltura.emailTemplates.list(admin, { pageSize: 100 }).all(),
    kaltura.lifecycle.list(admin, { pageSize: 100 }).all(),
  ]);
  const template = templateDefinition();
  const storedInsights = INSIGHTS.map((d) => findOne(insights, (i) => i.title === d.title, 'insight settings', d.title));
  const storedTemplate = findOne(templates, (t) => t.name === template.name && t.status !== 'deleted', 'email templates', template.name);
  const storedExtract = findOne(rules, (r) => r.systemName === EXTRACT_SYSTEM_NAME, 'lifecycle rules', EXTRACT_SYSTEM_NAME);
  const storedEmail = findOne(rules, (r) => r.systemName === EMAIL_SYSTEM_NAME, 'lifecycle rules', EMAIL_SYSTEM_NAME);
  if (apply && !storedTemplate && !appGuid) {
    throw new Error(`The email template does not exist yet. Set ${APP_GUID_ENV} (the messaging app id of this account) so it can be created.`);
  }

  const rows = [];
  const ids = {};
  const idFor = (idKey, id) => id || placeholder(idKey);

  async function ensure({ kind, name, idKey, wanted, stored, fields, normalize, create, update, guard }) {
    guard?.(wanted);
    let row;
    if (!stored) {
      const made = apply ? await create(wanted) : null;
      row = { kind, name, idKey, id: made?.id ?? null, action: 'create', fields: [] };
    } else {
      const diff = changedFields(wanted, stored, fields, normalize);
      if (diff.length && apply) await update(stored.id, pick(wanted, diff));
      row = { kind, name, idKey, id: stored.id, action: diff.length ? 'update' : 'unchanged', fields: diff };
    }
    rows.push(row);
    if (row.id) ids[idKey] = row.id;
    return row;
  }

  try {
    const insightIds = [];
    for (const [n, d] of INSIGHTS.entries()) {
      const row = await ensure({
        kind: 'insight', name: d.title, idKey: d.idKey, wanted: pick(d, INSIGHT_FIELDS), stored: storedInsights[n], fields: INSIGHT_FIELDS,
        create: (w) => kaltura.insightSettings.create(pick(w, ['key', 'title', 'prompt', 'valueType']), admin),
        update: (id, patch) => kaltura.insightSettings.update(id, patch, admin),
      });
      insightIds.push(idFor(d.idKey, row.id));
    }

    const templateRow = await ensure({
      kind: 'template', name: template.name, idKey: 'emailTemplateId', wanted: template, stored: storedTemplate, fields: TEMPLATE_FIELDS,
      create: (w) => kaltura.emailTemplates.create({ appGuid, ...w }, admin),
      update: (id, patch) => kaltura.emailTemplates.update(id, patch, admin),
    });

    const built = buildRules({ agentId, insightIds, templateId: idFor('emailTemplateId', templateRow.id), recipients });
    const guard = (rule) => assertScoped(rule, agentId);
    const ruleOpts = {
      kind: 'rule', fields: RULE_FIELDS, normalize: normalizeRule, guard,
      create: (w) => kaltura.lifecycle.create(pick(w, RULE_FIELDS.filter((f) => f !== 'status')), admin),
      update: (id, patch) => kaltura.lifecycle.update(id, patch, admin),
    };
    await ensure({ ...ruleOpts, name: EXTRACT_SYSTEM_NAME, idKey: 'extractRuleId', wanted: built.extract, stored: storedExtract });
    await ensure({ ...ruleOpts, name: EMAIL_SYSTEM_NAME, idKey: 'emailRuleId', wanted: built.email, stored: storedEmail });
  } catch (e) {
    if (apply) await persistIds(agentJsonPath, savedText, saved, ids).catch(() => {});
    throw e;
  }

  if (apply) await persistIds(agentJsonPath, savedText, saved, ids);
  for (const line of formatRows(rows, apply)) log(line);
  return rows;
}

/** Writes the ids into agent.json's `lifecycle` block. Skips the write when nothing changed. */
async function persistIds(path, savedText, saved, ids) {
  const merged = { ...(saved.lifecycle || {}), ...ids };
  const ordered = Object.fromEntries([
    ...LIFECYCLE_KEYS.filter((k) => merged[k] !== undefined).map((k) => [k, merged[k]]),
    ...Object.entries(merged).filter(([k]) => !LIFECYCLE_KEYS.includes(k)),
  ]);
  const text = JSON.stringify({ ...saved, lifecycle: ordered }, null, 2) + '\n';
  if (text !== savedText) await writeFile(path, text);
}

const PAST = { create: 'created', update: 'updated', unchanged: 'unchanged' };

/** Report lines: action, kind, name, id and the names of changed fields. No recipients, no secrets. */
export function formatRows(rows, applied) {
  const lines = [applied ? 'Digest applied:' : 'Digest plan (read-only, nothing written):'];
  for (const r of rows) {
    const verb = applied ? PAST[r.action] : r.action;
    const id = r.id || '(new)';
    const changed = r.fields.length ? `  changes: ${r.fields.join(', ')}` : '';
    lines.push(`  ${verb.padEnd(9)} ${r.kind.padEnd(8)} ${r.name}  [${id}]${changed}`);
  }
  const n = (a) => rows.filter((r) => r.action === a).length;
  lines.push(applied
    ? `${n('create')} created, ${n('update')} updated, ${n('unchanged')} unchanged`
    : `${n('create')} to create, ${n('update')} to update, ${n('unchanged')} unchanged`);
  return lines;
}
