import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory of the file this code was bundled into, in both build formats:
 * `__dirname` in the CJS build (and under vitest/tsx), `import.meta.url` in the
 * `.mjs` build where `__dirname` does not exist. The CJS build compiles
 * `import.meta` to an empty object, but that branch never runs there.
 *
 * With code splitting the file may be a shared chunk anywhere under `dist/`,
 * so callers walk up to the package root (see `findSdkRoot()`) instead of
 * assuming a fixed depth.
 */
export function moduleDir(): string {
  if (typeof __dirname === 'string') return __dirname;
  return path.dirname(fileURLToPath(import.meta.url));
}
