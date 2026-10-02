/**
 * End-to-end test of `create-lousho-agent` (which runs `lousho init`): scaffolds
 * a project in a FRESH TEMP DIRECTORY (never inside this checkout) with
 * `--sdk-path` pointing at this checkout, so the generator `npm pack`s the
 * local SDK build instead of fetching a published version. It lets `init`
 * run the real `npm install`, then typechecks the generated project and runs
 * its own `npm test` offline. Slow (a real install), hence the long timeout.
 *
 * Needs the SDK built first: `npm run build` at the repository root.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const SDK_ROOT = path.join(__dirname, '..', '..', '..');

/** Environment without any provider credentials, to prove the generated tests need none. */
function offlineEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_BASE_URL', 'LOUSHO_MODEL']) {
    delete env[key];
  }
  return env;
}

function npm(args: string[], cwd: string): string {
  return execSync(`npm ${args.join(' ')}`, { cwd, encoding: 'utf8', env: offlineEnv() });
}

describe('end-to-end scaffold + install + typecheck + test', () => {
  let base: string | undefined;

  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  // OpenRouter runs on `@ai-sdk/openai` 4 through its Chat Completions model (LOU-D28f), like OpenAI.
  it.each(['openai', 'openrouter'])(
    '%s: generates a project that installs from the locally packed SDK, typechecks, and passes its own tests',
    (provider) => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), `create-lousho-agent-e2e-${provider}-`));
      const dir = path.join(base, 'test-agent');

      execFileSync(
        process.execPath,
        [CLI, dir, '--yes', '--no-git', '--provider', provider, '--package-manager', 'npm', '--sdk-path', SDK_ROOT],
        { encoding: 'utf8', env: offlineEnv(), stdio: 'pipe' }
      );

      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      expect(pkg.dependencies['@lousho/build-ai-agent']).toMatch(/^file:\.\/.*\.tgz$/);
      expect(fs.existsSync(path.join(dir, 'node_modules', '@lousho', 'build-ai-agent'))).toBe(true);

      npm(['run', 'typecheck'], dir);
      const testOutput = npm(['test'], dir);
      expect(testOutput).toMatch(/2 passed/);

      const sdkPkg = JSON.parse(fs.readFileSync(path.join(SDK_ROOT, 'package.json'), 'utf8'));
      const installed = JSON.parse(
        fs.readFileSync(path.join(dir, 'node_modules', '@lousho', 'build-ai-agent', 'package.json'), 'utf8')
      );
      expect(installed.version).toBe(sdkPkg.version);

      // The scaffold is on the current `ai` major with its provider package major (LOU-D28d).
      const versionOf = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version as string;
      expect(versionOf('ai')).toMatch(/^7\./);
      expect(versionOf('@ai-sdk/openai')).toMatch(/^4\./);
    },
    300_000
  );
});
