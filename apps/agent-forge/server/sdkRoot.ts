/**
 * The lousho SDK package root - where package-shipped assets like
 * `registry/dist/index.json` live, for the catalog routes
 * (server/routes/catalogRoutes.ts).
 *
 * Resolution: `LOUSHO_SDK_ROOT` when set (tests, unusual layouts), else
 * three levels above this file's own directory. Both places this code runs
 * from sit at `apps/agent-forge/<x>` - `server/` under tsx and the bundled
 * `dist-server/index.cjs` in prod - so `../../..` lands on the repo root in
 * this monorepo and on `node_modules/lousho` (the package root)
 * in an installed deployment, never assuming it runs from `server/`.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The SDK package root: env LOUSHO_SDK_ROOT, else three levels above this file's dir (server/ and dist-server/ are both at apps/agent-forge/<x>). */
export function sdkRootDir(): string {
  return process.env.LOUSHO_SDK_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}
