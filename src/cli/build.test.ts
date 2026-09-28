import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { runBuild, parseBuildArgs, stubAdapterCalls, BuildIO } from './build';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'loushy.js');

function captureIO(): BuildIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

describe('parseBuildArgs', () => {
  it('reads --flag=value and --flag value forms, like bin/loushy.js', () => {
    expect(parseBuildArgs(['--target=stub', '--agent', 'a.yaml'])).toEqual({
      target: 'stub',
      agent: 'a.yaml',
      out: undefined,
    });
    expect(parseBuildArgs(['--target', 'node-server', '--out=build'])).toEqual({
      target: 'node-server',
      agent: undefined,
      out: 'build',
    });
  });
});

describe('runBuild', () => {
  beforeEach(() => {
    stubAdapterCalls.length = 0;
  });

  it("drives the adapter in exactly scaffold -> build -> describe order and prints describe()'s output", async () => {
    const io = captureIO();
    const code = await runBuild(['--target=stub', '--agent=agent.yaml'], io);

    expect(code).toBe(0);
    expect(stubAdapterCalls).toEqual(['scaffold', 'build', 'describe']);
    expect(io.out).toEqual(['stub adapter calls: scaffold,build,describe']);
    expect(io.err).toEqual([]);
  });

  it('exits non-zero with "unknown target" on stderr for an unregistered target', async () => {
    const io = captureIO();
    const code = await runBuild(['--target=doesnotexist'], io);

    expect(code).not.toBe(0);
    expect(io.err.join('\n')).toContain('Error: unknown target "doesnotexist"');
    expect(stubAdapterCalls).toEqual([]);
  });

  it('exits non-zero when --target is missing', async () => {
    const io = captureIO();
    expect(await runBuild([], io)).toBe(1);
    expect(io.err.join('\n')).toContain('--target is required');
  });
});

describe('bin/loushy.js build (subprocess smoke test)', () => {
  beforeAll(async () => {
    // bin/loushy.js requires the compiled dist/cli/build.js (as it does
    // dist/cli/dev.js for `loushy dev`), so compile just that entry the
    // same way tsup.config.ts does, without a full `npm run build`.
    const { build } = await import('tsup');
    await build({
      config: false,
      entry: { 'cli/build': path.join(REPO_ROOT, 'src', 'cli', 'build.ts') },
      outDir: path.join(REPO_ROOT, 'dist'),
      format: ['cjs'],
      external: ['tsup', 'ai', 'zod'],
      clean: false,
      silent: true,
    });
  }, 60_000);

  function runBin(args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...args], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error: any) {
      return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it('dispatches `loushy build --target=stub` and runs scaffold, build, describe in order', () => {
    const result = runBin(['build', '--target=stub', '--agent=agent.yaml']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stub adapter calls: scaffold,build,describe');
  });

  it('exits non-zero with "unknown target" on stderr for --target=doesnotexist', () => {
    const result = runBin(['build', '--target=doesnotexist']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unknown target');
  });
});
