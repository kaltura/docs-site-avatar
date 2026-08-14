import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Load AGENTIC_* credentials from the repo-root .env into process.env, same
 * convention as tools/agentic.mjs et al. (no dotenv dependency) — so this
 * script works whether invoked directly or spawned as a subprocess.
 */
export function loadEnv(repoRoot) {
  try {
    const env = readFileSync(resolve(repoRoot, '.env'), 'utf8');
    for (const line of env.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {
    // No .env file — credentials must be in the environment already.
  }
}
