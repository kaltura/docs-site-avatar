/**
 * Live ground truth for the Nova eval: the real route list (nav.js) read from the docs-site
 * checkout (see ../../site-root.mjs), plus the same `sections.json` manifest the site publishes
 * and Nova's `go_to` tool navigates against. Nothing is hand-copied into this repo, so the eval
 * can't drift the moment a page or heading is added, renamed, or removed on the site.
 *
 * The manifest is read from the checkout's build output (`_site/nova/sections.json`) when a
 * build exists, else fetched from the public site. Either way it goes through the SDK's own
 * `validateSectionsManifest`, so a malformed file fails loudly here instead of producing a
 * silently empty persona set.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSiteDir } from '../../site-root.mjs';
import { validateSectionsManifest } from '../../vendor/sdk/src/core/site-keys.js';

// The site's actual published base — the only base a grounded reply may cite (see
// provision.mjs's BASE_URL); kept here too so probes can validate cited URLs independently.
export const BASE_URL = 'https://kaltura.github.io/intelligent-agents-sdk';

/** Same path the site writes and the browser fetches (scripts/lib/sections-manifest.mjs). */
export const MANIFEST_REL_PATH = 'nova/sections.json';

/** nav.js's url→file convention (provision.mjs's fileForUrl, duplicated read-only here). */
function fileForUrl(url) {
  return url.replace(/^\//, '').replace(/\/$/, '') + '.md';
}

async function loadManifest(siteDir, fetchImpl) {
  const local = join(siteDir, '_site', MANIFEST_REL_PATH);
  let raw;
  try {
    raw = JSON.parse(await readFile(local, 'utf8'));
  } catch {
    const res = await fetchImpl(`${BASE_URL}/${MANIFEST_REL_PATH}`);
    if (!res.ok) throw new Error(`site-data: ${MANIFEST_REL_PATH} not built at ${local} and fetch from the public site failed (${res.status})`);
    raw = await res.json();
  }
  return validateSectionsManifest(raw);
}

/**
 * @param {{siteDir?:string, fetchImpl?:typeof fetch}} [opts]
 * @returns {Promise<{siteDir:string, baseUrl:string, routes:{group:string,title:string,url:string,file:string}[], manifest:{version:number, lang?:string, pages:{path:string,title?:string,sections:{key:string,id:string,text:string}[]}[]}}>}
 */
export async function loadSiteData(opts = {}) {
  const siteDir = opts.siteDir || resolveSiteDir();
  const navPath = join(siteDir, 'src', '_data', 'nav.js');
  const navModule = await import(`file://${navPath}?t=${Date.now()}`);
  /** @type {{group:string, pages:{title:string,url:string}[]}[]} */
  const nav = navModule.default;

  const routes = [{ group: 'Home', title: 'Home', url: '/', file: 'index.md' }];
  for (const section of nav) {
    for (const page of section.pages) {
      routes.push({ group: section.group, title: page.title, url: page.url, file: fileForUrl(page.url) });
    }
  }

  const manifest = await loadManifest(siteDir, opts.fetchImpl || fetch);
  return { siteDir, baseUrl: BASE_URL, routes, manifest };
}
