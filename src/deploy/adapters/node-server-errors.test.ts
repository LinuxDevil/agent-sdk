/**
 * Eve CLI-F7: a bundling failure in `lousho build --target=node-server` is a coded,
 * actionable error, not raw esbuild output. tsup reports a failure by posting to its
 * parent worker port, which trips vitest's worker pool, so the build runs in a child process.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBuildLock } from '../buildLock.testkit';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function writeAgentDir(files: Record<string, string>): string {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-err-')), 'my-agent');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('node-server build errors', () => {
  it('reports an unresolved import as a coded error that says what to install, and leaves no dist/', async () => {
    const dir = writeAgentDir({
      'instructions.md': 'Be brief.\n',
      'agent.ts': "import { createMockProvider } from '@lousho/build-ai-agent';\nexport default { provider: createMockProvider({ name: 'mock', responses: ['x'] }) };\n",
      'tools/uses-missing.ts': "import { nope } from 'definitely-not-installed-pkg';\nexport default nope;\n",
    });
    const outDir = path.join(path.dirname(dir), 'out');
    const script = path.join(path.dirname(dir), 'run.mts');
    const adapter = pathToFileURL(path.join(__dirname, 'node-server.ts')).href;
    fs.writeFileSync(
      script,
      `import { NodeServerAdapter } from ${JSON.stringify(adapter)};
await NodeServerAdapter.scaffold(${JSON.stringify(dir)}, ${JSON.stringify(outDir)});
try {
  await NodeServerAdapter.build(${JSON.stringify(outDir)});
  console.log('BUILD-OK');
} catch (error) {
  console.log('THROWN ' + JSON.stringify({ code: error.code, message: error.message, hint: error.hint }));
}
`
    );
    const run = await withBuildLock(async () =>
      spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' })
    );
    expect(run.stdout).not.toContain('BUILD-OK');
    const thrown = JSON.parse(/THROWN (.*)/.exec(run.stdout)?.[1] ?? 'null');
    expect(thrown.code).toBe('LOUSHO_DEPLOY_FAILED');
    expect(thrown.message).toContain('definitely-not-installed-pkg');
    expect(thrown.hint).toContain('npm install definitely-not-installed-pkg');
    expect(thrown.hint).not.toMatch(/mark the path as external/i);
    // esbuild's raw log and tsup's stack never reach the terminal.
    expect(run.stderr).not.toMatch(/\[ERROR\]|Build failed|mark the path/);
    expect(run.stdout).not.toMatch(/\[ERROR\]/);
    expect(fs.existsSync(path.join(outDir, 'dist'))).toBe(false);
  }, 90_000);
});
