import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const wf = (name) => readFileSync(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), 'utf8');
const redeploy = wf('redeploy.yml');
const evalWf = wf('eval.yml');

test('redeploy.yml: runs nightly and on a site-updated dispatch, not only on a provision.mjs push', () => {
  assert.match(redeploy, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
  assert.match(redeploy, /^ {2}repository_dispatch:\n {4}types: \[site-updated\]$/m);
});

test('both workflows keep the production environment on their job', () => {
  assert.match(redeploy, /^ {4}environment: production$/m);
  assert.match(evalWf, /^ {4}environment: production$/m);
});

test('redeploy.yml: no cross-repo token or secret beyond the two production secrets', () => {
  const secrets = [...redeploy.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['AGENTIC_ADMIN_SECRET', 'AGENTIC_PARTNER_ID']);
});

test('eval.yml: verifies the knowledge base before the eval runs', () => {
  const verify = evalWf.indexOf('server/provision.mjs --verify-knowledge');
  const run = evalWf.indexOf('node tests/eval/run.mjs');
  assert.ok(verify > 0, 'verify step present');
  assert.ok(verify < run, 'verify step runs first');
});
