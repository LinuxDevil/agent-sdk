/**
 * The observe daemon `project` a workspace root reports under - Studio's
 * copy of the SDK's `resolveProject` (`src/observe/identity.ts`; Studio
 * imports public SDK exports only, §19.7, so the rule is duplicated here
 * and must be kept in step with it): `LOUSHO_OBSERVE_PROJECT` when set,
 * else the `name` of `<root>/package.json`, else `'default'`.
 *
 * Caveat: `LOUSHO_OBSERVE_PROJECT` set on the Studio process applies to
 * EVERY workspace - they all share one project and aggregate placement
 * falls back to the first match. Documented, not "fixed" (W16 owns the
 * deployed-agent naming story).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export function observeProjectOf(root: string): string {
  const env = process.env.LOUSHO_OBSERVE_PROJECT;
  if (env) return env;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name !== '') return pkg.name;
  } catch {
    // an unreadable package.json is no reason to lose the project name
  }
  return 'default';
}
