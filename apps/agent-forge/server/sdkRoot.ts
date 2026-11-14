/**
 * The lousho SDK package root - where package-shipped assets like
 * `registry/dist/index.json` and `docs/` live, for the catalog routes
 * (server/routes/catalogRoutes.ts) and the docs tools.
 *
 * Resolution: `LOUSHO_SDK_ROOT` when set (tests, unusual layouts), else the
 * installed `@linuxdevil/lousho` package itself - `createRequire` resolves
 * its entry and we walk up to the first folder whose `package.json` is
 * named `@linuxdevil/lousho`. That works from the monorepo (the workspace
 * symlink lands on the repo root) and from `node_modules/@linuxdevil/studio`
 * (the SDK is a real dependency there), where the old "three levels up"
 * rule broke.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SDK_PACKAGE = '@linuxdevil/lousho';

/** The SDK package root: env LOUSHO_SDK_ROOT, else the resolved `@linuxdevil/lousho` install. */
export function sdkRootDir(moduleDir?: string): string {
  const env = process.env.LOUSHO_SDK_ROOT;
  if (env) return env;
  const from = moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const require = createRequire(path.join(from, 'noop.cjs'));
  let entry: string;
  try {
    entry = require.resolve(SDK_PACKAGE);
  } catch {
    throw new Error(`lousho-studio: could not locate the ${SDK_PACKAGE} package. Set LOUSHO_SDK_ROOT.`);
  }
  let dir = path.dirname(entry);
  for (;;) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        if ((JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string }).name === SDK_PACKAGE) return dir;
      } catch {
        // Unreadable package.json - keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`lousho-studio: could not locate the ${SDK_PACKAGE} package. Set LOUSHO_SDK_ROOT.`);
}
