/**
 * Eve E14 (CLI-F7 on the cloudflare-worker target): a bundling failure in
 * `lousho build --target=cloudflare-worker` is a coded, actionable error, not
 * esbuild's raw log, and leaves no half-written dist/ - the buildBundle() path
 * the node-server target got in #488. tsup reports a failure by posting to its
 * parent worker port, which trips vitest's worker pool, so the build runs in a
 * child process.
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
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cf-build-err-')), 'my-agent');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** Scaffolds and builds `dir` for cloudflare-worker in a child process; returns what it threw and its output. */
async function buildInChild(dir: string) {
  const outDir = path.join(path.dirname(dir), 'out');
  const script = path.join(path.dirname(dir), 'run.mts');
  const adapter = pathToFileURL(path.join(__dirname, 'cloudflare.ts')).href;
  fs.writeFileSync(
    script,
    `import { CloudflareWorkerAdapter } from ${JSON.stringify(adapter)};
await CloudflareWorkerAdapter.scaffold(${JSON.stringify(dir)}, ${JSON.stringify(outDir)});
try {
  await CloudflareWorkerAdapter.build(${JSON.stringify(outDir)});
  console.log('BUILD-OK');
} catch (error) {
  console.log('THROWN ' + JSON.stringify({ code: error.code, message: error.message, hint: error.hint }));
}
`
  );
  const run = await withBuildLock(async () => spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: REPO_ROOT, encoding: 'utf8' }));
  const thrown = JSON.parse(/THROWN (.*)/.exec(run.stdout)?.[1] ?? 'null') as { code?: string; message: string; hint?: string } | null;
  return { run, thrown, outDir };
}

describe('cloudflare-worker build errors', () => {
  it('reports an unresolved import as a coded error that says what to install, and leaves no dist/', async () => {
    const dir = writeAgentDir({
      'instructions.md': 'Be brief.\n',
      'agent.json': '{ "model": "mock/test" }\n',
      'tools/uses-missing.ts': "import { nope } from 'definitely-not-installed-pkg';\nexport default nope;\n",
    });
    const { run, thrown, outDir } = await buildInChild(dir);
    expect(run.stdout).not.toContain('BUILD-OK');
    expect(thrown?.code).toBe('LOUSHO_DEPLOY_FAILED');
    expect(thrown?.message).toContain('definitely-not-installed-pkg');
    expect(thrown?.hint).toContain('npm install definitely-not-installed-pkg');
    // esbuild's raw log and tsup's stack never reach the terminal.
    expect(run.stderr).not.toMatch(/\[ERROR\]|Build failed|mark the path/);
    expect(run.stdout).not.toMatch(/\[ERROR\]/);
    expect(fs.existsSync(path.join(outDir, 'dist'))).toBe(false);
  }, 180_000);

  it('still explains an SDK name a Worker bundle does not offer', async () => {
    const dir = writeAgentDir({
      'instructions.md': 'Be brief.\n',
      'agent.json': '{ "model": "mock/test" }\n',
      'tools/store.ts': "import { fileStore } from '@lousho/build-ai-agent';\nexport default fileStore;\n",
    });
    const { run, thrown } = await buildInChild(dir);
    expect(thrown?.code).toBe('LOUSHO_DEPLOY_FAILED');
    expect(thrown?.message).toContain('for import "fileStore"');
    expect(thrown?.message).toContain("the files of an agent directory can import only these from '@lousho/build-ai-agent'");
    expect(run.stderr).not.toMatch(/\[ERROR\]|Build failed/);
  }, 180_000);
});
