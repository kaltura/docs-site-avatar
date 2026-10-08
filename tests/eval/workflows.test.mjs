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

test('nightly and dispatched redeploys skip the eval when the knowledge base was not rebuilt', () => {
  assert.match(redeploy, /schedule\|repository_dispatch\) \[ "\$KB_REBUILT" = "true" \] \|\| needed=false/);
  assert.match(redeploy, /name: eval-needed/);
  // The gate has no environment, so a skipped eval needs no approval; the eval job waits on it.
  const gate = evalWf.slice(evalWf.indexOf('  gate:'), evalWf.indexOf('  eval:'));
  assert.doesNotMatch(gate, /environment:/);
  assert.match(evalWf, /needs: gate\n\s+if: \$\{\{ needs\.gate\.outputs\.run == 'true' \}\}/);
});

// A `${{ }}` expression inside a run: script is pasted into the shell text before it runs, which
// is a script-injection risk. Pass the value through `env:` and read the shell variable instead.
function runScriptExpressions(text) {
  const lines = text.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    const parent = lines.slice(0, i).reverse().find((l) => l.trim() && l.match(/^\s*/)[0].length < indent);
    if (/^\s*outputs:/.test(parent || '')) continue; // a job output that happens to be named run
    const body = /^[|>]/.test(m[2]) ? [] : [m[2]];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].match(/^\s*/)[0].length > indent)) body.push(lines[++i]);
    found.push(...body.filter((l) => l.includes('${{')).map((l) => l.trim()));
  }
  return found;
}

test('no workflow puts a ${{ }} expression inside a run: script', () => {
  const files = ['ci.yml', 'eval.yml', 'redeploy.yml'];
  for (const f of files) assert.deepEqual(runScriptExpressions(wf(f)), [], f);
  assert.deepEqual(runScriptExpressions('steps:\n  - run: echo ${{ github.event_name }}'), ['echo ${{ github.event_name }}'], 'the check itself catches a one-line run');
  assert.deepEqual(runScriptExpressions('steps:\n  - run: |\n      echo "${{ github.actor }}"\n  - run: echo ok'), ['echo "${{ github.actor }}"'], 'and a block run');
});
