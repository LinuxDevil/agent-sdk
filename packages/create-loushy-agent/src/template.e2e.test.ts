/**
 * End-to-end test of `create-loushy-agent` (which runs `loushy init`): scaffolds
 * a project in a FRESH TEMP DIRECTORY (never inside this checkout) with
 * `--sdk-path` pointing at this checkout, so the generator `npm pack`s the
 * local SDK build instead of fetching a published version. It lets `init`
 * run the real `npm install`, then typechecks the generated project and runs
 * its own `npm test` offline. Slow (a real install), hence the long timeout.
 *
 * Needs the SDK built first: `npm run build` at the repository root.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const SDK_ROOT = path.join(__dirname, '..', '..', '..');

/** Environment without any provider credentials, to prove the generated tests need none. */
function offlineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'LOUSHY_MODEL']) {
    delete env[key];
  }
  return env;
}

function npm(args: string[], cwd: string): string {
  return execSync(`npm ${args.join(' ')}`, { cwd, encoding: 'utf8', env: offlineEnv() });
}

describe('end-to-end scaffold + install + typecheck + test', () => {
  let base: string | undefined;

  afterAll(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it(
    'generates a project that installs from the locally packed SDK, typechecks, and passes its own tests',
    () => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'create-loushy-agent-e2e-'));
      const dir = path.join(base, 'test-agent');

      execFileSync(
        process.execPath,
        [CLI, dir, '--yes', '--no-git', '--provider', 'openai', '--package-manager', 'npm', '--sdk-path', SDK_ROOT],
        { encoding: 'utf8', env: offlineEnv(), stdio: 'pipe' }
      );

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      expect(pkg.dependencies['@loushy/build-ai-agent']).toMatch(/^file:\.\/.*\.tgz$/);
      expect(fs.existsSync(path.join(dir, 'node_modules', '@loushy', 'build-ai-agent'))).toBe(true);

      npm(['run', 'typecheck'], dir);
      const testOutput = npm(['test'], dir);
      expect(testOutput).toMatch(/2 passed/);

      const sdkPkg = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, 'package.json'), 'utf8'));
      const installed = JSON.parse(
        fs.readFileSync(path.join(dir, 'node_modules', '@loushy', 'build-ai-agent', 'package.json'), 'utf8')
      );
      expect(installed.version).toBe(sdkPkg.version);
    },
    300_000
  );
});
