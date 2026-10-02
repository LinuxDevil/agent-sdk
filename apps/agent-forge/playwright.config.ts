import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S3 (LOU-S): E2E smoke test config for the real, BUILT `lousho studio`
 * (production mode - see `src/cli/studio.ts` and `server/tsup.config.ts`),
 * not a dev-mode Vite server. `webServer` below runs the exact same
 * `node dist-server/index.cjs` entry point `lousho studio --prod` spawns,
 * so `npm run build:studio` must have been run first (the `test:e2e:studio`
 * script in `package.json` does this) - if `dist-server/index.cjs` is
 * missing, the webServer command fails immediately with a clear ENOENT
 * rather than silently falling back to something else.
 *
 * A fresh, disposable `BASE_DIR` (`.lousho/**`'s root) is used per test run
 * so this never reads/writes real agent data, and multiple runs don't
 * collide.
 */
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-forge-e2e-'));
const port = Number(process.env.LOUSHO_STUDIO_E2E_PORT ?? 4799);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node dist-server/index.cjs',
    cwd: moduleDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', BASE_DIR: baseDir },
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
