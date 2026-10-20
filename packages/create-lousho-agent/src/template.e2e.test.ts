/**
 * End-to-end test of `create-lousho-agent` (which runs `lousho init`): scaffolds
 * a project in a FRESH TEMP DIRECTORY (never inside this checkout) with
 * `--sdk-path` pointing at this checkout, so the generator `npm pack`s the
 * local SDK build instead of fetching a published version. It lets `init`
 * run the real `npm install`, then typechecks the generated project, runs
 * its own `npm test` offline, and builds it with `npm run build` (`lousho
 * build`), starting the built server to check /health. Slow (a real install),
 * hence the long timeout.
 *
 * Needs the SDK built first: `npm run build` at the repository root.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execSync, spawn } from 'node:child_process';
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

/** Starts the built server (`node dist/server.js`) on a free port and resolves with its /health status. */
function healthOfBuiltServer(buildDir: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server.js', '--port=0'], { cwd: buildDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => finish(new Error(`server did not start: ${output}`)), 30_000);
    // Settles once the server has exited, so the temp dir is no longer in use when it is removed (Windows).
    const finish = (error: Error | undefined, status?: number) => {
      clearTimeout(timer);
      child.removeAllListeners('exit');
      const settle = () => (error ? reject(error) : resolve(status!));
      if (child.exitCode !== null || child.signalCode !== null) return settle();
      child.once('exit', settle);
      child.kill();
    };
    const onData = (chunk: Buffer) => {
      output += chunk;
      const match = /listening on http:\/\/[^:]+:(\d+)/.exec(output);
      if (match) fetch(`http://127.0.0.1:${match[1]}/health`).then((res) => finish(undefined, res.status), finish);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(new Error(`server exited early (code ${code}): ${output}`)));
  });
}

describe('end-to-end scaffold + install + typecheck + test', () => {
  let base: string | undefined;

  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = undefined;
  });

  // OpenRouter runs on `@ai-sdk/openai` 4 through its Chat Completions model, like OpenAI.
  it.each(['openai', 'openrouter'])(
    '%s: generates a project that installs from the locally packed SDK, typechecks, passes its own tests and builds a server that starts',
    async (provider) => {
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

      // The scaffold is on the current `ai` major with its provider package major.
      const versionOf = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', name, 'package.json'), 'utf8')).version as string;
      expect(versionOf('ai')).toMatch(/^7\./);
      expect(versionOf('@ai-sdk/openai')).toMatch(/^4\./);

      // `lousho build` bundles the project without the optional OTel packages (not installed here),
      // and the built server starts. A placeholder key: starting the server makes no provider call.
      npm(['run', 'build'], dir);
      const buildDir = path.join(dir, '.lousho', 'build', 'node-server');
      expect(fs.existsSync(path.join(buildDir, 'dist', 'server.js'))).toBe(true);
      const keyVar = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY';
      expect(await healthOfBuiltServer(buildDir, { ...offlineEnv(), [keyVar]: 'placeholder-key' })).toBe(200);
    },
    300_000
  );
});
