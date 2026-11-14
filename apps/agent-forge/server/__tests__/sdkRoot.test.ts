/**
 * `sdkRootDir()` must find the SDK both from the monorepo (workspace
 * symlink) and from an installed `node_modules/@linuxdevil/studio` layout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sdkRootDir } from '../sdkRoot';

const SDK_PACKAGE = '@linuxdevil/lousho';
let tmp: string | undefined;

afterEach(() => {
  delete process.env.LOUSHO_SDK_ROOT;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function pkgName(dir: string): string | undefined {
  const pkgPath = path.join(dir, 'package.json');
  return fs.existsSync(pkgPath) ? (JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string }).name : undefined;
}

describe('sdkRootDir', () => {
  it('resolves the monorepo checkout to the SDK package root', () => {
    const root = sdkRootDir();
    expect(pkgName(root)).toBe(SDK_PACKAGE);
    expect(fs.existsSync(path.join(root, 'registry', 'dist', 'index.json'))).toBe(true);
  });

  it('honours LOUSHO_SDK_ROOT', () => {
    process.env.LOUSHO_SDK_ROOT = '/custom/sdk';
    expect(sdkRootDir()).toBe('/custom/sdk');
  });

  it('finds the SDK from an installed node_modules/@linuxdevil/studio layout', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-sdkroot-'));
    const sdkDir = path.join(tmp, 'node_modules', '@linuxdevil', '@linuxdevil/lousho');
    const studioDir = path.join(tmp, 'node_modules', '@linuxdevil', 'studio');
    fs.mkdirSync(path.join(sdkDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(studioDir, 'dist-server'), { recursive: true });
    fs.writeFileSync(
      path.join(sdkDir, 'package.json'),
      JSON.stringify({ name: SDK_PACKAGE, version: '1.0.0', main: 'dist/index.js' })
    );
    fs.writeFileSync(path.join(sdkDir, 'dist', 'index.js'), 'module.exports = {};\n');
    const moduleDir = path.join(studioDir, 'dist-server');
    expect(sdkRootDir(moduleDir)).toBe(sdkDir);
  });

  it('throws a clear error when the SDK cannot be resolved', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-sdkroot-'));
    const moduleDir = path.join(tmp, 'dist-server');
    fs.mkdirSync(moduleDir, { recursive: true });
    // A temp dir outside any node_modules tree: resolution walks up to the
    // filesystem root without finding the package (unless the machine has a
    // global install, which the env override covers in real use).
    expect(() => sdkRootDir(moduleDir)).toThrow(/could not locate the @linuxdevil\/lousho package/);
  });
});
