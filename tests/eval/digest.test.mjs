import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureDigest, buildRules, assertScoped, digestConfig, INSIGHTS, LIFECYCLE_KEYS, CHANGED_KEYS,
  EXTRACT_SYSTEM_NAME, EMAIL_SYSTEM_NAME, RECIPIENTS_ENV, APP_GUID_ENV, templateDefinition,
} from '../../server/digest.mjs';

const AGENT_ID = '00000000-0000-4000-8000-000000000001';
const RECIPIENT = 'digest-recipient@example.test';
const ENV = { [RECIPIENTS_ENV]: RECIPIENT, [APP_GUID_ENV]: 'app-guid-1' };
const WRITES = ['create', 'update'];

/** In-memory Management stand-in. Records every call so tests can assert on writes. */
function fakeManagement({ insights = [], templates = [], rules = [] } = {}) {
  let n = 0;
  const nextId = () => `id-${++n}`;
  const state = { insights: [...insights], templates: [...templates], rules: [...rules] };
  const calls = [];
  const page = (items) => ({ all: async () => items.map((x) => structuredClone(x)) });
  const crud = (kind, items, defaults) => ({
    list: () => page(items),
    create: async (body) => { calls.push({ kind, op: 'create', body }); const o = { id: nextId(), ...defaults, ...structuredClone(body) }; items.push(o); return structuredClone(o); },
    update: async (id, patch) => { calls.push({ kind, op: 'update', id, patch }); Object.assign(items.find((x) => x.id === id), structuredClone(patch)); return {}; },
  });
  return {
    state,
    calls,
    writes: () => calls.filter((c) => WRITES.includes(c.op)),
    insightSettings: crud('insight', state.insights, { status: 'active' }),
    emailTemplates: crud('template', state.templates, { status: 'enabled' }),
    lifecycle: crud('rule', state.rules, { status: 'active', objectType: 'thread' }),
  };
}

async function tempAgentJson(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'nova-digest-'));
  const path = join(dir, 'agent.json');
  await writeFile(path, JSON.stringify({ configId: 1, avatarId: 'a', agentId: AGENT_ID, widgetId: 'w', tag: 't', ...extra }, null, 2) + '\n');
  return path;
}

const run = (k, path, opts = {}) => {
  const lines = [];
  return ensureDigest({ kaltura: k, admin: 'ks', agentJsonPath: path, env: ENV, log: (l) => lines.push(l), ...opts }).then((rows) => ({ rows, lines }));
};

test('create-all-from-empty: makes 4 insights, 1 template, 2 rules and records every id', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  const { rows } = await run(k, path, { apply: true });
  assert.equal(rows.length, 7);
  assert.ok(rows.every((r) => r.action === 'create'));
  assert.deepEqual(k.writes().map((c) => `${c.kind}:${c.op}`), ['insight:create', 'insight:create', 'insight:create', 'insight:create', 'template:create', 'rule:create', 'rule:create']);

  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.lifecycle), LIFECYCLE_KEYS);
  assert.equal(saved.agentId, AGENT_ID, 'the rest of agent.json is untouched');

  const extract = k.state.rules.find((r) => r.systemName === EXTRACT_SYSTEM_NAME);
  const email = k.state.rules.find((r) => r.systemName === EMAIL_SYSTEM_NAME);
  assert.deepEqual(extract.action.insightSettingsIds, INSIGHTS.map((i) => saved.lifecycle[i.idKey]));
  assert.equal(email.action.templateId, saved.lifecycle.emailTemplateId);
  assert.deepEqual(email.action.recipients, [RECIPIENT]);
  assert.equal(saved.lifecycle.extractRuleId, extract.id);
  assert.equal(saved.lifecycle.emailRuleId, email.id);
  assert.equal(k.state.templates[0].appGuid, 'app-guid-1');
});

test('no-op when equal: a second run writes nothing and leaves agent.json byte-identical', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true });
  const before = await readFile(path, 'utf8');
  const writesBefore = k.writes().length;

  const { rows } = await run(k, path, { apply: true });
  assert.ok(rows.every((r) => r.action === 'unchanged'), JSON.stringify(rows.map((r) => r.action)));
  assert.equal(k.writes().length, writesBefore);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('adopts live objects by name, creates only the missing Nova-owned CONTACT setting, repoints the extract rule', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true });
  const first = JSON.parse(await readFile(path, 'utf8')).lifecycle;

  // A second account state: contact setting missing, rule still pointing at some other setting.
  const contact = k.state.insights.find((i) => i.key === 'CONTACT');
  k.state.insights.splice(k.state.insights.indexOf(contact), 1);
  k.state.rules.find((r) => r.systemName === EXTRACT_SYSTEM_NAME).action.insightSettingsIds[3] = 'someone-elses-setting';
  k.calls.length = 0;

  const { rows } = await run(k, path, { apply: true });
  assert.deepEqual(k.writes().map((c) => `${c.kind}:${c.op}`), ['insight:create', 'rule:update']);
  assert.equal(k.writes()[0].body.title, INSIGHTS[3].title);
  const after = JSON.parse(await readFile(path, 'utf8')).lifecycle;
  assert.notEqual(after.contactInsightId, first.contactInsightId);
  for (const key of LIFECYCLE_KEYS.filter((x) => x !== 'contactInsightId')) assert.equal(after[key], first[key], `${key} adopted, not duplicated`);
  assert.deepEqual(rows.filter((r) => r.action !== 'unchanged').map((r) => r.idKey), ['contactInsightId', 'extractRuleId']);
  assert.ok(k.state.rules.find((r) => r.systemName === EXTRACT_SYSTEM_NAME).action.insightSettingsIds.includes(after.contactInsightId));
});

test('update on drift: only the drifted fields are sent', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true });
  k.state.insights[0].prompt = 'edited by hand';
  k.state.templates[0].subject = 'edited by hand';
  k.state.rules.find((r) => r.systemName === EMAIL_SYSTEM_NAME).action.recipients = ['someone-else@example.test'];
  k.calls.length = 0;

  const { rows } = await run(k, path, { apply: true });
  const writes = k.writes();
  assert.deepEqual(writes.map((c) => `${c.kind}:${c.op}`), ['insight:update', 'template:update', 'rule:update']);
  assert.deepEqual(Object.keys(writes[0].patch), ['prompt']);
  assert.deepEqual(Object.keys(writes[1].patch), ['subject']);
  assert.deepEqual(Object.keys(writes[2].patch), ['action']);
  assert.deepEqual(rows.filter((r) => r.action === 'update').map((r) => r.fields), [['prompt'], ['subject'], ['action']]);

  const again = await run(k, path, { apply: true });
  assert.ok(again.rows.every((r) => r.action === 'unchanged'), 'converged after one update run');
});

test('list order does not count as drift: id and recipient lists compare as sets', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true, env: { ...ENV, [RECIPIENTS_ENV]: 'a@example.test,b@example.test' } });
  const extract = k.state.rules.find((r) => r.systemName === EXTRACT_SYSTEM_NAME);
  extract.action.insightSettingsIds.reverse();
  const email = k.state.rules.find((r) => r.systemName === EMAIL_SYSTEM_NAME);
  email.action.recipients.reverse();
  email.eventConditions[1].value.reverse();
  k.calls.length = 0;
  const { rows } = await run(k, path, { apply: true, env: { ...ENV, [RECIPIENTS_ENV]: 'a@example.test,b@example.test' } });
  assert.ok(rows.every((r) => r.action === 'unchanged'));
  assert.equal(k.writes().length, 0);
});

test('plan mode: zero writes, agent.json untouched, output has names and ids but no recipient or secret', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  const original = await readFile(path, 'utf8');

  const empty = await run(k, path, { apply: false });
  assert.equal(k.writes().length, 0);
  assert.equal(await readFile(path, 'utf8'), original);
  assert.ok(empty.rows.every((r) => r.action === 'create'));
  assert.match(empty.lines[0], /read-only/);
  assert.ok(empty.lines.some((l) => l.includes(INSIGHTS[0].title)));
  assert.ok(empty.lines.every((l) => !l.includes(RECIPIENT)));

  // Seed an applied state, then plan against it with one drift and one missing object.
  await run(k, path, { apply: true });
  k.state.insights.pop();
  k.state.templates[0].body = 'drifted';
  const applied = await readFile(path, 'utf8');
  k.calls.length = 0;
  const plan = await run(k, path, { apply: false });
  assert.equal(k.writes().length, 0);
  assert.equal(await readFile(path, 'utf8'), applied);
  const byKind = Object.fromEntries(plan.rows.map((r) => [r.idKey, r.action]));
  assert.equal(byKind.contactInsightId, 'create');
  assert.equal(byKind.emailTemplateId, 'update');
  assert.equal(byKind.extractRuleId, 'update', 'a new insight id changes the extract rule');
  assert.ok(plan.lines.every((l) => !l.includes(RECIPIENT)));
  assert.match(plan.lines.at(-1), /to create/);
});

test('plan mode does not need the app guid, apply mode fails before writing anything', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  const env = { [RECIPIENTS_ENV]: RECIPIENT };
  await ensureDigest({ kaltura: k, admin: 'ks', agentJsonPath: path, env, apply: false, log: () => {} });
  await assert.rejects(ensureDigest({ kaltura: k, admin: 'ks', agentJsonPath: path, env, apply: true, log: () => {} }), new RegExp(APP_GUID_ENV));
  assert.equal(k.writes().length, 0);
});

test('scope rule: every rule built by the code carries object.agent_id eq <agent id>', () => {
  for (const agentId of [AGENT_ID, 'another-agent']) {
    const { extract, email } = buildRules({ agentId, insightIds: ['i1'], templateId: 't1', recipients: ['r'] });
    for (const rule of [extract, email]) {
      assert.ok(rule.eventConditions.some((c) => c.field === 'object.agent_id' && c.operator === 'eq' && c.value === agentId), `${rule.systemName} is scoped`);
      assertScoped(rule, agentId);
    }
    assert.deepEqual(email.eventConditions.find((c) => c.field === 'changed_keys'), { field: 'changed_keys', operator: 'has_all', value: CHANGED_KEYS });
    assert.deepEqual(CHANGED_KEYS, ['SUMMARY', 'TOPIC', 'CUSTOM', 'SOURCELEAK', 'CONTACT']);
  }
});

test('scope rule: an unscoped rule is rejected, and no rule the code writes is unscoped', async () => {
  const { extract } = buildRules({ agentId: AGENT_ID, insightIds: [], templateId: 't', recipients: ['r'] });
  assert.throws(() => assertScoped({ ...extract, eventConditions: [] }, AGENT_ID), /Refusing to write an unscoped rule/);
  assert.throws(() => assertScoped({ ...extract, eventConditions: [{ field: 'object.agent_id', operator: 'eq', value: 'other' }] }, AGENT_ID), /unscoped/);
  assert.throws(() => assertScoped({ ...extract, eventConditions: [{ field: 'object.agent_id', operator: 'neq', value: AGENT_ID }] }, AGENT_ID), /unscoped/);
  assert.throws(() => assertScoped(extract, ''), /agent id/);

  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true });
  k.state.rules.forEach((r) => { r.eventConditions = []; }); // drift: someone removed the scope
  k.calls.length = 0;
  await run(k, path, { apply: true });
  const ruleWrites = k.writes().filter((c) => c.kind === 'rule');
  assert.equal(ruleWrites.length, 2);
  for (const w of ruleWrites) assert.ok(w.patch.eventConditions.some((c) => c.field === 'object.agent_id' && c.value === AGENT_ID), 'repair restores the scope');
  for (const r of k.state.rules) assertScoped(r, AGENT_ID);
});

test('config: a missing recipient or agent id fails with a message that names the fix, before any call', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await assert.rejects(ensureDigest({ kaltura: k, admin: 'ks', agentJsonPath: path, env: {}, apply: true, log: () => {} }), new RegExp(RECIPIENTS_ENV));
  await assert.rejects(ensureDigest({ kaltura: k, admin: 'ks', agentJsonPath: path, env: { [RECIPIENTS_ENV]: ' , ' }, apply: false, log: () => {} }), new RegExp(RECIPIENTS_ENV));
  assert.throws(() => digestConfig(ENV, {}), /agentId/);
  assert.equal(k.calls.length, 0);
  assert.deepEqual(digestConfig({ [RECIPIENTS_ENV]: ' a@x.test, b@x.test ,' }, { agentId: 'x' }).recipients, ['a@x.test', 'b@x.test']);
});

test('two objects with one name stop the run before any write', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  await run(k, path, { apply: true });
  k.state.rules.push({ ...k.state.rules[0], id: 'dupe' });
  k.calls.length = 0;
  await assert.rejects(run(k, path, { apply: true }), /2 lifecycle rules are named/);
  assert.equal(k.writes().length, 0);
});

test('a failure part-way still records the ids made so far, so a rerun adopts them', async () => {
  const k = fakeManagement();
  const path = await tempAgentJson();
  const realCreate = k.emailTemplates.create;
  k.emailTemplates.create = async () => { throw new Error('boom'); };
  await assert.rejects(run(k, path, { apply: true }), /boom/);
  const partial = JSON.parse(await readFile(path, 'utf8')).lifecycle;
  assert.equal(Object.keys(partial).length, 4);

  k.emailTemplates.create = realCreate;
  const { rows } = await run(k, path, { apply: true });
  assert.deepEqual(rows.filter((r) => r.action === 'create').map((r) => r.kind), ['template', 'rule', 'rule']);
  assert.equal(k.state.insights.length, 4, 'no duplicate insight settings');
});

test('the template definition has no appGuid, and every insight setting is Nova-owned by name', () => {
  assert.equal('appGuid' in templateDefinition(), false);
  assert.ok(INSIGHTS.every((i) => i.title.startsWith('Nova')), 'every insight setting is Nova-owned by name');
});
