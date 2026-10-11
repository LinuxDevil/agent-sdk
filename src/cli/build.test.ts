import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBuild, parseBuildArgs, stubAdapter, stubAdapterCalls, BuildIO } from './build';
import { registerAdapter } from '../deploy';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin', 'lousho.js');

function captureIO(): BuildIO & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
}

describe('parseBuildArgs', () => {
  it('reads --flag=value and --flag value forms, like bin/lousho.js', () => {
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
  beforeAll(() => {
    registerAdapter('stub', stubAdapter);
  });
  beforeEach(() => {
    stubAdapterCalls.length = 0;
  });

  it("drives the adapter in exactly scaffold -> build -> describe order and prints describe()'s output", async () => {
    const io = captureIO();
    const code = await runBuild(['--target=stub', '--agent=agent.yaml'], io);

    expect(code).toBe(0);
    expect(stubAdapterCalls).toEqual(['scaffold', 'build', 'describe']);
    expect(io.out).toEqual([`Built stub in ${path.join('.lousho', 'build', 'stub')}. From there, run:\nstub adapter calls: scaffold,build,describe`]);
    expect(io.err).toEqual([]);
  });

  it('warns when --out names a directory that is not empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-out-'));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'x');
    const io = captureIO();
    expect(await runBuild(['--target=stub', `--out=${dir}`], io)).toBe(0);
    expect(io.err.join('\n')).toMatch(/^Warning: --out .* is not empty/);
  });

  it('--help lists the targets; the test-only stub target is not one of them by default', async () => {
    const io = captureIO();
    expect(await runBuild(['--help'], io)).toBe(0);
    expect(io.out.join('\n')).toMatch(/node-server.*\n.*cloudflare-worker.*\n.*docker/);
    expect(io.out.join('\n')).not.toContain('stub');
  });

  it('exits 2 (usage error) with "unknown target" on stderr for an unregistered target', async () => {
    const io = captureIO();
    const code = await runBuild(['--target=doesnotexist'], io);

    expect(code).toBe(2);
    expect(io.err.join('\n')).toContain('Error: unknown target "doesnotexist"');
    expect(stubAdapterCalls).toEqual([]);
  });

  it('exits 2 (usage error) when --target is missing or a flag is unknown', async () => {
    const io = captureIO();
    expect(await runBuild([], io)).toBe(2);
    expect(io.err.join('\n')).toContain('--target is required');
    expect(await runBuild(['--target=stub', '--bogus'], captureIO())).toBe(2);
  });

  it("warns when the provider package of the spec's provider is not installed, and builds anyway", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-peer-'));
    const spec = path.join(dir, 'agent.yaml');
    fs.writeFileSync(spec, 'name: a\nprompt: p\nprovider:\n  type: openai\n  model: gpt-4o-mini\n');
    const io = { ...captureIO(), resolveFrom: dir };
    expect(await runBuild(['--target=stub', `--agent=${spec}`], io)).toBe(0);
    expect(io.err.join('\n')).toMatch(/'openai' provider, but its package @ai-sdk\/openai is not installed[\s\S]*npm install @ai-sdk\/openai@/);

    // An agent directory's agent.json model prefix counts too; with the package installed there is no warning.
    const agentDir = path.join(dir, 'agent');
    fs.mkdirSync(agentDir);
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({ model: 'anthropic/claude-x' }));
    const missing = { ...captureIO(), resolveFrom: dir };
    await runBuild(['--target=stub', `--agent=${agentDir}`], missing);
    expect(missing.err.join('\n')).toContain('@ai-sdk/anthropic is not installed');
    const installed = { ...captureIO(), resolveFrom: REPO_ROOT };
    await runBuild(['--target=stub', `--agent=${agentDir}`], installed);
    expect(installed.err).toEqual([]);

    // The mock provider needs no package.
    fs.writeFileSync(spec, 'name: a\nprompt: p\nprovider:\n  type: mock\n  model: m\n');
    const mock = { ...captureIO(), resolveFrom: dir };
    await runBuild(['--target=stub', `--agent=${spec}`], mock);
    expect(mock.err).toEqual([]);
  });
});

describe('bin/lousho.js build (subprocess smoke test)', () => {
  beforeAll(async () => {
    // bin/lousho.js requires the compiled dist/cli/build.js (as it does
    // dist/cli/dev.js for `lousho dev`), so compile just that entry the
    // same way tsup.config.ts does, without a full `npm run build`.
    const { build } = await import('tsup');
    await build({
      config: false,
      entry: { 'cli/build': path.join(REPO_ROOT, 'src', 'cli', 'build.ts') },
      outDir: path.join(REPO_ROOT, 'dist'),
      // The bin loads the ESM build (dist/cli/*.mjs).
      format: ['esm'],
      external: ['tsup', 'ai', 'zod'],
      clean: false,
      silent: true,
    });
  }, 60_000);

  function runBin(args: string[]): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...args], {
        cwd: REPO_ROOT,
        env: { ...process.env, LOUSHO_BUILD_STUB_ADAPTER: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { code: 0, stdout, stderr: '' };
    } catch (caught) {
      const error = caught as { status?: number; stdout?: string; stderr?: string };
      return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  }

  it.each(['--help', '-h', 'help'])('`lousho %s` prints the usage and exits 0', (flag) => {
    const result = runBin([flag]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('lousho init');
  });

  it('`lousho --help` lists the implemented flags (LOU-R19)', () => {
    const { stdout } = runBin(['--help']);
    expect(stdout).toContain('--no-schedules');
    expect(stdout).toContain('--traces[=dir]');
    expect(stdout).toContain('--drift');
    expect(stdout).toContain('--sdk-path');
    expect(stdout).toContain('lousho build <agent-dir|spec> --target=<node-server|cloudflare-worker|docker>');
  });

  it('dispatches `lousho build --target=stub` and runs scaffold, build, describe in order', () => {
    const result = runBin(['build', '--target=stub', '--agent=agent.yaml']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('stub adapter calls: scaffold,build,describe');
  });

  it('builds a real node-server target end to end through the bundled CLI', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-build-cli-'));
    const specPath = path.join(dir, 'agent.yaml');
    fs.writeFileSync(
      specPath,
      'name: cli-agent\nprompt: You are helpful.\nprovider:\n  type: mock\n  model: mock-1\n'
    );
    const outDir = path.join(dir, 'out');
    const result = runBin(['build', '--target=node-server', `--agent=${specPath}`, `--out=${outDir}`]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(`Built node-server in ${path.relative(REPO_ROOT, outDir)}. From there, run:\nnode dist/server.js`);
    expect(fs.statSync(path.join(outDir, 'dist', 'server.js')).size).toBeGreaterThan(0);
  }, 120_000);

  it('exits non-zero with "unknown target" on stderr for --target=doesnotexist', () => {
    const result = runBin(['build', '--target=doesnotexist']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('unknown target');
  });
});
