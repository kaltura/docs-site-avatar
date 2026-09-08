#!/usr/bin/env node
/**
 * Secret-leak scan for docs-site-avatar (Nova).
 *
 * This repo actually touches AGENTIC_ADMIN_SECRET (unlike the SDK repo, which
 * only documents it), so it gets its own gate rather than relying on
 * ../intelligent-agents-sdk/tools/check-docs.mjs. Ports that file's KS-token
 * pattern and its "diff the tracked tree against the live .env secret"
 * approach, and adds generic secret-shape regexes (32+ hex blob, cloud/VCS
 * provider token prefixes, PEM private-key blocks, key=literal assignments).
 *
 * Deliberately does NOT exclude test/ or tests/ from the scan (see
 * project memory: the SDK repo's own check-docs.mjs excludes those dirs —
 * that gap should not be repeated here).
 *
 * Usage: node scripts/scan-secrets.mjs
 * Exit:  0 clean, 1 offenders found.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = normalize(join(__dirname, '..'));
const SELF = 'scripts/scan-secrets.mjs';

function read(rel) {
  const p = join(ROOT, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function trackedFiles() {
  const out = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' });
  return out.trim().split('\n').filter(Boolean);
}

// Only real noise sources are excluded — never test/ or tests/, and never
// anything under src content the repo actually ships.
const SCAN_EXCLUDE_DIRS = ['node_modules', 'vendor', '.git'];
const SCAN_EXCLUDE_FILES = ['package-lock.json', SELF];

function isExcluded(f) {
  const parts = f.split('/');
  if (SCAN_EXCLUDE_DIRS.some((d) => parts.includes(d))) return true;
  if (SCAN_EXCLUDE_FILES.some((s) => f.endsWith(s))) return true;
  return false;
}

const SCAN_EXTS = /\.(md|mjs|js|html|css|json|jsonl|yml|yaml|env|example)$/;

function scanFiles() {
  return trackedFiles().filter((f) => SCAN_EXTS.test(f) && !isExcluded(f));
}

// Pattern name → regex. Each pattern is checked against every scanned file.
const PATTERNS = [
  // Kaltura KS session token (djJ8<partnerId>|...), same shape as
  // check-docs.mjs's SDK-repo check.
  ['Kaltura KS token', /djJ8[A-Za-z0-9_-]{20,}/],

  // PEM-style private key block.
  ['PEM private key', /-----BEGIN (RSA |EC |OPENSSH |DSA |)?PRIVATE KEY-----/],

  // Common VCS/cloud provider token prefixes.
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],

  // key/secret/token/password assigned to a long quoted literal — catches
  // hardcoded credentials without flagging bare env-var *names* (e.g.
  // `process.env.AGENTIC_ADMIN_SECRET` or an empty `.env.example` line).
  [
    'hardcoded key/secret/token literal',
    /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"][A-Za-z0-9/+_.-]{16,}['"]/i,
  ],

  // Generic 32+ hex-char blob — the common shape of API keys, session
  // tokens, and admin secrets. Kaltura object ids (avatarId etc.) are
  // 24 hex chars, so this deliberately starts at 32 to avoid flagging them.
  ['generic hex secret (32+ chars)', /\b[0-9a-f]{32,}\b/i],
];

function scanForPatterns() {
  const offenders = [];
  for (const f of scanFiles()) {
    const content = read(f);
    for (const [name, re] of PATTERNS) {
      const m = content.match(re);
      if (m) offenders.push({ file: f, pattern: name, match: m[0].slice(0, 12) + '…' });
    }
  }
  return offenders;
}

// Additionally: if a live AGENTIC_ADMIN_SECRET is present in a local .env,
// confirm it hasn't leaked verbatim into any tracked file (same approach as
// check-docs.mjs, ported here since this repo is the one that holds the
// live secret at deploy time).
function scanForLiveEnvSecret() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return [];
  const secret = readFileSync(envPath, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('AGENTIC_ADMIN_SECRET='))
    ?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  if (!secret) return [];
  const offenders = [];
  for (const f of scanFiles()) {
    if (read(f).includes(secret)) offenders.push({ file: f, pattern: 'live AGENTIC_ADMIN_SECRET', match: '(redacted)' });
  }
  return offenders;
}

function main() {
  const offenders = [...scanForPatterns(), ...scanForLiveEnvSecret()];
  if (offenders.length > 0) {
    console.error('Secret-leak scan FAILED:');
    for (const o of offenders) {
      console.error(`  ${o.file}: ${o.pattern} (${o.match})`);
    }
    process.exit(1);
  }
  console.log(`Secret-leak scan OK (${scanFiles().length} files checked).`);
}

main();
