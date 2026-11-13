import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { findStudio, runStudio, startStudio, STUDIO_MISSING, STUDIO_PACKAGE, studioUrl } from './studio';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-studio-test-'));

/** A checkout's apps/agent-forge: package.json naming Studio, optional cli.cjs/server source. */
function makeCheckout(root: string, opts: { cli?: boolean; serverSource?: boolean } = {}): string {
  const appDir = path.join(root, 'apps', 'agent-forge');
  fs.mkdirSync(path.join(appDir, 'dist-server'), { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: STUDIO_PACKAGE }));
  if (opts.cli) fs.writeFileSync(path.join(appDir, 'dist-server', 'cli.cjs'), 'process.exit(0);');
  if (opts.serverSource) {
    fs.mkdirSync(path.join(appDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'server', 'index.ts'), 'export {};');
  }
  return appDir;
}

/** An installed @linuxdevil/studio under <root>/node_modules. */
function makeInstalled(root: string): { packageDir: string; cliPath: string } {
  const packageDir = path.join(root, 'node_modules', ...STUDIO_PACKAGE.split('/'));
  fs.mkdirSync(path.join(packageDir, 'dist-server'), { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: STUDIO_PACKAGE, version: '0.0.0' }));
  const cliPath = path.join(packageDir, 'dist-server', 'cli.cjs');
  fs.writeFileSync(cliPath, 'process.exit(0);');
  return { packageDir, cliPath };
}

/** A spawn stand-in: records calls, returns a killable EventEmitter child. */
function fakeSpawn() {
  const calls: { cmd: unknown; args: unknown; opts: unknown }[] = [];
  const fn = vi.fn((cmd: unknown, args: unknown, opts: unknown) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter() as unknown as ChildProcess;
    child.kill = vi.fn(() => true);
    return child;
  });
  return { fn: fn as unknown as typeof import('node:child_process').spawn, calls };
}

describe('findStudio', () => {
  it('returns the checkout when <cwd>/apps/agent-forge is named @linuxdevil/studio', () => {
    const cwd = tmp();
    const appDir = makeCheckout(cwd);
    expect(findStudio(cwd, { packageRoot: tmp(), globalRoot: () => undefined })).toEqual({ kind: 'checkout', appDir });
  });

  it('ignores an apps/agent-forge whose package.json has another name', () => {
    const cwd = tmp();
    const appDir = path.join(cwd, 'apps', 'agent-forge');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), '{}');
    expect(findStudio(cwd, { packageRoot: tmp(), globalRoot: () => undefined })).toBeUndefined();
  });

  it('resolves an installed Studio from the cwd node_modules', () => {
    const cwd = tmp();
    const { packageDir, cliPath } = makeInstalled(cwd);
    expect(findStudio(cwd, { packageRoot: tmp(), globalRoot: () => undefined })).toEqual({
      kind: 'installed',
      cliPath,
      packageDir,
    });
  });

  it('falls through to the SDK package root, then the global root', () => {
    const cwd = tmp();
    const sdkRoot = tmp();
    const { packageDir, cliPath } = makeInstalled(sdkRoot);
    const hit = findStudio(cwd, { packageRoot: sdkRoot, globalRoot: () => tmp() });
    expect(hit).toEqual({ kind: 'installed', cliPath, packageDir });

    const globalRoot = tmp();
    // `npm root -g` points at the global node_modules: <root>/@linuxdevil/studio.
    const globalPackageDir = path.join(globalRoot, ...STUDIO_PACKAGE.split('/'));
    fs.mkdirSync(path.join(globalPackageDir, 'dist-server'), { recursive: true });
    fs.writeFileSync(path.join(globalPackageDir, 'package.json'), JSON.stringify({ name: STUDIO_PACKAGE }));
    fs.writeFileSync(path.join(globalPackageDir, 'dist-server', 'cli.cjs'), 'process.exit(0);');
    const globalHit = findStudio(cwd, { packageRoot: tmp(), globalRoot: () => globalRoot });
    expect(globalHit).toEqual({
      kind: 'installed',
      cliPath: path.join(globalPackageDir, 'dist-server', 'cli.cjs'),
      packageDir: globalPackageDir,
    });
  });

  it('skips an installed package whose dist-server/cli.cjs is missing', () => {
    const cwd = tmp();
    const packageDir = path.join(cwd, 'node_modules', ...STUDIO_PACKAGE.split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: STUDIO_PACKAGE }));
    expect(findStudio(cwd, { packageRoot: tmp(), globalRoot: () => undefined })).toBeUndefined();
  });

  it('returns undefined when nothing is found', () => {
    expect(findStudio(tmp(), { packageRoot: tmp(), globalRoot: () => undefined })).toBeUndefined();
  });
});

describe('startStudio', () => {
  it('throws STUDIO_MISSING when no Studio exists', () => {
    expect(() => startStudio({ repoRoot: tmp(), packageRoot: tmp(), globalRoot: () => undefined })).toThrow(STUDIO_MISSING);
  });

  it('launches an installed Studio as cli.cjs --workspace <cwd> --port --host', () => {
    const cwd = tmp();
    const { cliPath } = makeInstalled(cwd);
    const { fn, calls } = fakeSpawn();
    const handle = startStudio({ repoRoot: cwd, apiPort: 4750, apiHost: '127.0.0.1', packageRoot: tmp(), globalRoot: () => undefined, spawnFn: fn });
    try {
      expect(handle.mode).toBe('installed');
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe(process.execPath);
      expect(calls[0].args).toEqual([cliPath, '--workspace', cwd, '--port', '4750', '--host', '127.0.0.1']);
      expect(calls[0].opts).toEqual({ stdio: 'inherit' });
    } finally {
      handle.stop();
    }
  });

  it('refuses --prod/--dev with an installed target (usage error, exit 2)', async () => {
    const cwd = tmp();
    makeInstalled(cwd);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runStudioWith(['--dev'], cwd)).toBe(2);
      expect(String(err.mock.calls[0]?.[0])).toMatch(/only apply inside the SDK repository/);
    } finally {
      err.mockRestore();
    }
  });

  it("checkout 'auto' resolves to prod when dist-server/cli.cjs is built and passes --workspace to it", () => {
    const repoRoot = tmp();
    const appDir = makeCheckout(repoRoot, { cli: true });
    const { fn, calls } = fakeSpawn();
    const handle = startStudio({ repoRoot, apiPort: 0, packageRoot: tmp(), globalRoot: () => undefined, spawnFn: fn });
    try {
      expect(handle.mode).toBe('prod');
      expect(handle.viteProcess).toBeUndefined();
      expect(calls[0].args).toEqual([
        path.join(appDir, 'dist-server', 'cli.cjs'),
        '--workspace',
        repoRoot,
        '--port',
        '0',
        '--host',
        '127.0.0.1',
      ]);
    } finally {
      handle.stop();
    }
  });

  it("checkout 'auto' resolves to dev when only the server source exists", () => {
    const repoRoot = tmp();
    makeCheckout(repoRoot, { serverSource: true });
    const { fn, calls } = fakeSpawn();
    const handle = startStudio({ repoRoot, apiPort: 0, packageRoot: tmp(), globalRoot: () => undefined, spawnFn: fn });
    try {
      expect(handle.mode).toBe('dev');
      expect(handle.viteProcess).toBeDefined();
      expect(handle.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(calls).toHaveLength(2);
      const apiEnv = (calls[0].opts as { env: Record<string, string> }).env;
      expect(apiEnv.BASE_DIR).toBe(repoRoot);
      expect(apiEnv.LOUSHO_STUDIO_TOKEN).toBe(handle.token);
      expect(apiEnv.NO_STATIC).toBe('1');
    } finally {
      handle.stop();
    }
  });

  it("--prod throws a clear, build-pointing error when dist-server/cli.cjs is missing", () => {
    const repoRoot = tmp();
    makeCheckout(repoRoot);
    expect(() => startStudio({ repoRoot, mode: 'prod', packageRoot: tmp(), globalRoot: () => undefined })).toThrow(/build:studio/);
  });

  it("'auto' with neither build nor source says to run build:studio", () => {
    const repoRoot = tmp();
    makeCheckout(repoRoot);
    expect(() => startStudio({ repoRoot, packageRoot: tmp(), globalRoot: () => undefined })).toThrow(/build:studio/);
  });

  it("--dev throws a clear error when the server source is missing", () => {
    const repoRoot = tmp();
    makeCheckout(repoRoot, { cli: true });
    expect(() => startStudio({ repoRoot, mode: 'dev', packageRoot: tmp(), globalRoot: () => undefined })).toThrow(/dev mode/);
  });

  it('checkout wins over an installed copy in the same directory', () => {
    const cwd = tmp();
    makeCheckout(cwd);
    makeInstalled(cwd);
    const target = findStudio(cwd, { packageRoot: tmp(), globalRoot: () => undefined });
    expect(target?.kind).toBe('checkout');
  });
});

/** runStudio with process.cwd() pointed at `cwd`. */
async function runStudioWith(args: string[], cwd: string): Promise<number> {
  const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    return await runStudio(args);
  } finally {
    spy.mockRestore();
  }
}

describe('lousho studio --help', () => {
  it('describes every flag and the separate-install story', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runStudio(['--help'])).toBe(0);
      const help = String(log.mock.calls[0]?.[0]);
      for (const flag of ['--port', '--host', '--prod', '--dev']) expect(help).toMatch(new RegExp(`\\n  ${flag.replace('-', '\\-')}\\b[^\\n]* {2,}\\S`));
      expect(help).toContain(STUDIO_PACKAGE);
      expect(help).toContain('separate package');
    } finally {
      log.mockRestore();
    }
  });
});

describe('studioUrl', () => {
  it('formats host, port and token', () => {
    expect(studioUrl('0.0.0.0', 4750, 'abc')).toBe('http://127.0.0.1:4750/?token=abc');
    expect(studioUrl('127.0.0.1', 5000, 'a+b')).toBe('http://127.0.0.1:5000/?token=a%2Bb');
  });
});
