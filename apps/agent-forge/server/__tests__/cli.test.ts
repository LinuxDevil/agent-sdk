/**
 * `lousho-studio` argument parsing and a real boot of `server/cli.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStudioCliArgs, StudioCliUsageError, studioVersion, USAGE } from '../cli';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('parseStudioCliArgs', () => {
  it('parses the documented flags', () => {
    expect(parseStudioCliArgs(['--workspace', '/tmp/x', '--port', '5000', '--host', '0.0.0.0'])).toEqual({
      workspace: '/tmp/x',
      port: 5000,
      host: '0.0.0.0',
    });
    expect(parseStudioCliArgs(['--port=0'])).toEqual({ port: 0 });
    expect(parseStudioCliArgs(['-v'])).toEqual({ version: true });
    expect(parseStudioCliArgs(['-h'])).toEqual({ help: true });
    expect(parseStudioCliArgs([])).toEqual({});
  });

  it('rejects unknown flags, missing values and bad ports', () => {
    for (const argv of [['--bogus'], ['--port'], ['--workspace'], ['positional']]) {
      expect(() => parseStudioCliArgs(argv)).toThrow(StudioCliUsageError);
    }
    for (const port of ['x', '-1', '1.5', '70000']) {
      expect(() => parseStudioCliArgs(['--port', port])).toThrow(StudioCliUsageError);
    }
    expect(() => parseStudioCliArgs(['--port', 'x'])).toThrow(/--port must be an integer between 0 and 65535/);
  });
});

describe('studioVersion', () => {
  it('reads the package version relative to the module dir', () => {
    const version = studioVersion(path.join(APP_DIR, 'server'));
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')) as { version: string };
    expect(version).toBe(pkg.version);
  });
});

describe('lousho-studio boot', () => {
  let child: ChildProcess | undefined;
  let tmp: string | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child!.once('exit', resolve));
    }
    child = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('--help exits 0 with usage; bad args exit 2', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
        const p = spawn(process.execPath, ['--import', 'tsx', path.join(APP_DIR, 'server', 'cli.ts'), ...args], {
          cwd: APP_DIR,
          env: { ...process.env, LOUSHO_STUDIO_COLLECTOR: '0', LOUSHO_STUDIO_JUDGE: '0' },
        });
        let stdout = '';
        let stderr = '';
        p.stdout!.on('data', (d) => (stdout += d));
        p.stderr!.on('data', (d) => (stderr += d));
        p.on('exit', (code) => resolve({ code, stdout, stderr }));
      });
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: lousho-studio');
    expect(USAGE).toContain('--workspace <dir>');
    const bad = await run(['--port', 'x']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('lousho-studio:');
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cli-'));
    const noFolder = await run(['--workspace', path.join(tmp, 'nope')]);
    expect(noFolder.code).toBe(2);
    expect(noFolder.stderr).toContain("is not a folder");
  }, 60_000);

  it('boots on --port 0, prints the tokened URL, /health answers, SIGTERM exits 0', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-cli-'));
    child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(APP_DIR, 'server', 'cli.ts'), '--port', '0', '--workspace', tmp],
      {
        cwd: APP_DIR,
        env: { ...process.env, LOUSHO_STUDIO_COLLECTOR: '0', LOUSHO_STUDIO_JUDGE: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`timed out waiting for URL; output so far:\n${out}`)), 45_000);
      child!.stdout!.on('data', (d) => {
        out += d;
        const match = /Lousho Studio \S+: (\S+)/.exec(out);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child!.stderr!.on('data', (d) => (out += d));
      child!.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cli exited early (${code}); output:\n${out}`));
      });
    });
    expect(url).toContain('/?token=');
    const health = await fetch(new URL('/health', url)).then((r) => r.text());
    expect(health).toBe('ok');
    child.kill('SIGTERM');
    const code = await new Promise<number | null>((resolve) => child!.once('exit', resolve));
    // Windows has no POSIX signals: kill() is TerminateProcess there, so the
    // graceful-shutdown exit code is only observable on POSIX.
    if (process.platform !== 'win32') expect(code).toBe(0);
    child = undefined;
  }, 90_000);
});
