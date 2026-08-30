#!/usr/bin/env node
/**
 * Audits this partner's Knowledge records for leaked shells left behind by
 * `provision.mjs --reuse` redeploys — see docs/ARCHITECTURE.md's "Known
 * limitations": `knowledge.deleteRecord()` reliably 500s on the live backend
 * for any record that ever reached indexed content, so the category/entries
 * it held delete fine but the record's own metadata object survives as an
 * inert, contentless shell. Manual/on-demand only, per ARCHITECTURE.md's "no
 * silent unreviewed reprovision" principle — deliberately NOT wired into
 * redeploy.yml's automatic path.
 *
 * This partner is SHARED across multiple unrelated Kaltura products — this
 * script only ever considers records named exactly `docs-site-avatar-knowledge`
 * (this deploy's own naming convention) or unnamed, and always excludes the
 * currently active record (server/agent.json's knowledgeRecordId). It never
 * touches a record with any other name.
 *
 * Usage: node scripts/audit-knowledge-records.mjs [--delete]
 * Default (no flags): dry-run — lists candidates, makes no delete calls.
 * --delete: attempts deleteRecord on every candidate; a 500 on a previously-
 *           indexed shell is expected and reported separately from a clean
 *           delete (the record's own metadata is what's left, never content).
 * Exit: 0 always (this is an audit/cleanup tool, not a pass/fail gate).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Management } from '../vendor/sdk/src/management/index.js';
import { loadEnv } from '../load-env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
loadEnv(ROOT);

const RECORD_NAME = 'docs-site-avatar-knowledge';

function isCandidate(record, activeId) {
  if (record.id === activeId) return false;
  return record.name === RECORD_NAME || !record.name;
}

async function main() {
  const doDelete = process.argv.includes('--delete');

  const partnerId = process.env.AGENTIC_PARTNER_ID;
  const adminSecret = process.env.AGENTIC_ADMIN_SECRET;
  if (!partnerId || !adminSecret) {
    console.error('✗ AGENTIC_PARTNER_ID/AGENTIC_ADMIN_SECRET not set (see .env.example)');
    process.exit(2);
  }

  const saved = JSON.parse(await readFile(join(__dirname, '..', 'server', 'agent.json'), 'utf8').catch(() => '{}'));
  const activeId = saved.knowledgeRecordId;

  const kaltura = new Management({ partnerId, adminSecret });
  const admin = await kaltura.sessions.createAdminToken();
  console.log('✓ admin token');

  const all = await kaltura.knowledge.listRecords(admin, { pageSize: 50 }).all();
  const candidates = all.filter((r) => isCandidate(r, activeId));
  console.log(`✓ ${all.length} total record(s) on this partner, ${candidates.length} candidate(s) (named "${RECORD_NAME}" or unnamed, excluding the active record ${activeId})`);

  if (!candidates.length) {
    console.log('nothing to do.');
    return;
  }

  if (!doDelete) {
    console.log('(dry run — no API calls will be made; pass --delete to attempt cleanup)');
    for (const r of candidates) console.log(`  would delete: id=${r.id} name=${r.name ?? '(unnamed)'} status=${r.status}`);
    return;
  }

  const deleted = [];
  const stillShells = [];
  for (const r of candidates) {
    try {
      await kaltura.knowledge.deleteRecord(r.id, admin, { confirmPermanent: true });
      deleted.push(r.id);
      console.log(`  ✓ deleted id=${r.id}`);
    } catch (e) {
      stillShells.push(r.id);
      const code = e.code || e.message;
      const why = code === 'knowledge_in_use'
        ? 'still referenced by a live intellect — not a leak, the in-use guard correctly refused this delete'
        : 'still 500s (expected for a previously-indexed shell — see docs/ARCHITECTURE.md)';
      console.log(`  ⚠ id=${r.id} ${why}: ${code}`);
    }
  }
  console.log(`\n✅ ${deleted.length} deleted cleanly, ${stillShells.length} not deleted (server-side 500 on a previously-indexed shell, or a live in-use guard — see per-id detail above).`);
}

main();
