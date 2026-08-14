#!/usr/bin/env node
/**
 * Vendors @kaltura/intelligent-agents from jsDelivr's GitHub CDN into vendor/sdk
 * at a pinned tag — the same CDN + pinning scheme the docs site's browser-side
 * connect.js already uses (SDK_TAG / cdn.jsdelivr.net/gh/kaltura/intelligent-agents-sdk).
 * This repo has no local sibling checkout of the SDK, so this is how it gets one.
 *
 * Usage: node scripts/fetch-sdk.mjs [--tag vX.Y.Z] [--force]
 * Env:   SDK_TAG (used when --tag is omitted)
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'kaltura/intelligent-agents-sdk';
const SRC_SUBTREE = 'src';
const DEFAULT_TAG = 'v1.0.1';
const DEST_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'sdk');

function parseArgs(argv, env) {
  const eqFlag = argv.find((a) => a.startsWith('--tag='));
  const idx = argv.indexOf('--tag');
  const flagValue = eqFlag ? eqFlag.slice('--tag='.length) : (idx >= 0 ? argv[idx + 1] : null);
  return { tag: flagValue || env.SDK_TAG || DEFAULT_TAG, force: argv.includes('--force') };
}

async function alreadyVendored(tag) {
  try {
    const stamped = (await readFile(join(DEST_ROOT, '.sdk-tag'), 'utf8')).trim();
    return stamped === tag;
  } catch {
    return false;
  }
}

async function listSrcFiles(tag) {
  const res = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${REPO}@${tag}`);
  if (!res.ok) throw new Error(`jsDelivr file listing failed for ${REPO}@${tag}: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const root = data.files.find((f) => f.type === 'directory' && f.name === SRC_SUBTREE);
  if (!root) throw new Error(`no "${SRC_SUBTREE}" directory found in ${REPO}@${tag}`);
  const out = [];
  const walk = (node, prefix) => {
    for (const entry of node.files || []) {
      const path = `${prefix}/${entry.name}`;
      if (entry.type === 'directory') walk(entry, path);
      else out.push(path);
    }
  };
  walk(root, SRC_SUBTREE);
  return out;
}

async function fetchOne(tag, relPath) {
  const url = `https://cdn.jsdelivr.net/gh/${REPO}@${tag}/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed for ${relPath}: ${res.status} ${res.statusText}`);
  const body = await res.text();
  const dest = join(DEST_ROOT, relPath);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body, 'utf8');
}

async function main() {
  const { tag, force } = parseArgs(process.argv.slice(2), process.env);
  if (!force && (await alreadyVendored(tag))) {
    console.log(`vendor/sdk already at ${tag} — skipping (pass --force to re-fetch).`);
    return;
  }
  console.log(`Fetching @kaltura/intelligent-agents-sdk@${tag} from jsDelivr into vendor/sdk ...`);
  const files = await listSrcFiles(tag);
  for (const relPath of files) await fetchOne(tag, relPath);
  await writeFile(join(DEST_ROOT, '.sdk-tag'), `${tag}\n`, 'utf8');
  console.log(`Vendored ${files.length} files at ${tag}.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
