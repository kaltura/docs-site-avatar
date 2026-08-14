import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const DEFAULT_SITE_DIR = '/opt/homebrew/var/www/GitHub/intelligent-agents-sdk-site';

/**
 * Resolve the docs-site checkout (the `gh-pages-src` orphan branch of
 * kaltura/intelligent-agents-sdk, checked out as its own working tree) that
 * this script reads `src/**\/*.md` + `src/_data/nav.js` from. Kept as a
 * SEPARATE checkout from this monorepo on purpose — the site is public and
 * the admin secret this script uses must never live anywhere near it.
 *
 * `--site-dir <path>`/`--site-dir=<path>`, else `SITE_REPO_DIR` env var, else
 * this machine's actual sibling checkout path.
 * @param {{argv?:string[], env?:NodeJS.ProcessEnv}} [opts]
 * @returns {string}
 */
export function resolveSiteDir({ argv = process.argv, env = process.env } = {}) {
  const eqFlag = argv.find((a) => a.startsWith('--site-dir='));
  const idx = argv.indexOf('--site-dir');
  const flagValue = eqFlag ? eqFlag.slice('--site-dir='.length) : (idx >= 0 ? argv[idx + 1] : null);
  const dir = resolve(flagValue || env.SITE_REPO_DIR || DEFAULT_SITE_DIR);
  if (!existsSync(resolve(dir, 'src', 'index.md')) || !existsSync(resolve(dir, 'src', '_data', 'nav.js'))) {
    throw new Error(`docs site checkout not found at ${dir} (expected src/index.md + src/_data/nav.js) — pass --site-dir <path> or set SITE_REPO_DIR`);
  }
  return dir;
}

/**
 * Strip a `--site-dir <path>`/`--site-dir=<path>` pair out of argv so this
 * script's own flag parsing doesn't mistake it for another argument.
 * @param {string[]} argv
 * @returns {string[]}
 */
export function stripSiteDirFlag(argv) {
  return argv.filter((a, i, arr) => {
    if (a.startsWith('--site-dir=')) return false;
    if (a === '--site-dir') return false;
    if (arr[i - 1] === '--site-dir') return false;
    return true;
  });
}
