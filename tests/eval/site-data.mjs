/**
 * Live ground truth for the Nova eval — the real route list (nav.js), the real
 * `data-nova-target`/`data-nova-label` highlight-tag inventory, and every markdown h2/h3 heading
 * (the site's `highlighter.js` treats these as highlightable too — see its own doc comment),
 * all read directly from the docs-site checkout (see ../../site-root.mjs) rather than
 * hand-copied into this repo. This keeps the eval from drifting the moment a page is added,
 * renamed, or re-tagged on the site.
 *
 * NOTE ON WHAT THIS CAN AND CAN'T VERIFY: `highlightable_elements` (curated tags AND headings)
 * only ever reaches the live brain via `session.setDynamicPrompt()` — a browser-socket-only call
 * (see sdk/src/experience/session.js) with NO HTTP equivalent (`Conversations.stream()`'s
 * `request_vars` is a documented DISTINCT mechanism). The headless eval in this directory talks
 * to `Conversations.stream()` only, so it can never actually push a page's heading list into a
 * turn — `headingTargets` below is exposed for logging/inventory and for a real-browser eval to
 * consume, NOT as something a personas.mjs turn can assert the brain picked correctly from.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSiteDir } from '../../site-root.mjs';

// The site's actual published base — the only base a grounded reply may cite (see
// provision.mjs's BASE_URL); kept here too so probes can validate cited URLs independently.
export const BASE_URL = 'https://kaltura.github.io/intelligent-agents-sdk';

/** nav.js's url→file convention (provision.mjs's fileForUrl, duplicated read-only here). */
function fileForUrl(url) {
  return url.replace(/^\//, '').replace(/\/$/, '') + '.md';
}

const TARGET_RE = /<div\s+data-nova-target="([^"]+)"\s+data-nova-label="([^"]+)"/g;
const HEADING_RE = /^#{2,3}\s+(.+)$/gm;

/** markdown-it-anchor's slugify for this site (eleventy.config.js's githubSlugify),
 * duplicated read-only here so a heading's id can be predicted without a full site build. */
function githubSlugify(s) {
  return String(s).trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

/**
 * @param {{siteDir?:string}} [opts]
 * @returns {Promise<{siteDir:string, baseUrl:string, routes:{group:string,title:string,url:string,file:string}[], highlightTargets:{url:string,title:string,id:string,label:string}[], headingTargets:{url:string,title:string,id:string,label:string}[], taggedUrls:string[], untaggedRoutes:{url:string,title:string}[]}>}
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

  const highlightTargets = [];
  const headingTargets = [];
  for (const route of routes) {
    let text;
    try { text = await readFile(join(siteDir, 'src', route.file), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(TARGET_RE)) {
      highlightTargets.push({ url: route.url, title: route.title, id: m[1], label: m[2] });
    }
    for (const m of text.matchAll(HEADING_RE)) {
      const label = m[1].trim();
      headingTargets.push({ url: route.url, title: route.title, id: githubSlugify(label), label });
    }
  }
  const taggedUrls = [...new Set(highlightTargets.map((t) => t.url))];
  const untaggedRoutes = routes.filter((r) => !taggedUrls.includes(r.url)).map((r) => ({ url: r.url, title: r.title }));

  return { siteDir, baseUrl: BASE_URL, routes, highlightTargets, headingTargets, taggedUrls, untaggedRoutes };
}
