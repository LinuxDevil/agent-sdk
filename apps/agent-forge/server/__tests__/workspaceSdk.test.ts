/**
 * W11b: `findWorkspaceSdk` - Node's node_modules walk done by hand, the
 * SDK-checkout self case, and the `bin/lousho.js`/`built` gates.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspaceSdk } from '../host/workspaceSdk';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lou-w11b-sdk-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a minimal SDK install: manifest + bin + optional dist marker. */
function installSdk(nodeModulesDir: string, name: string, options: { built?: boolean; bin?: boolean } = {}): string {
  const pkgDir = path.join(nodeModulesDir, ...name.split('/'));
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.2.3' }));
  if (options.bin !== false) fs.writeFileSync(path.join(pkgDir, 'bin', 'lousho.js'), '// bin\n');
  if (options.built) {
    fs.mkdirSync(path.join(pkgDir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli', 'bridge.mjs'), '// bridge\n');
  }
  return pkgDir;
}

describe('findWorkspaceSdk', () => {
  it('returns undefined for a folder with no SDK anywhere up the tree', () => {
    // os.tmpdir() has no node_modules/@linuxdevil or /lousho above it.
    expect(findWorkspaceSdk(dir)).toBeUndefined();
  });

  it('returns undefined for a nonexistent root', () => {
    expect(findWorkspaceSdk(path.join(dir, 'nope'))).toBeUndefined();
  });

  it('finds @linuxdevil/lousho in the workspace root node_modules', () => {
    const pkgDir = installSdk(path.join(dir, 'node_modules'), '@linuxdevil/lousho', { built: true });
    const sdk = findWorkspaceSdk(dir);
    expect(sdk).toMatchObject({
      version: '1.2.3',
      packageDir: fs.realpathSync(pkgDir),
      binPath: path.join(fs.realpathSync(pkgDir), 'bin', 'lousho.js'),
      source: 'node_modules',
      built: true,
    });
  });

  it('finds lousho (the name the package ships under today) the same way', () => {
    installSdk(path.join(dir, 'node_modules'), 'lousho');
    expect(findWorkspaceSdk(dir)?.source).toBe('node_modules');
  });

  it('walks up to a parent folder node_modules (nearest hit wins)', () => {
    installSdk(path.join(dir, 'node_modules'), 'lousho', { built: true });
    const nested = path.join(dir, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    // A nearer install shadows the parent's.
    installSdk(path.join(dir, 'a', 'node_modules'), 'lousho');
    const sdk = findWorkspaceSdk(nested);
    expect(sdk?.packageDir).toBe(fs.realpathSync(path.join(dir, 'a', 'node_modules', 'lousho')));
  });

  it('prefers the scoped name over lousho at the same level', () => {
    installSdk(path.join(dir, 'node_modules'), 'lousho');
    installSdk(path.join(dir, 'node_modules'), '@linuxdevil/lousho');
    const sdk = findWorkspaceSdk(dir);
    expect(sdk?.packageDir).toContain(`${path.sep}@linuxdevil${path.sep}lousho`);
  });

  it('classifies the SDK checkout itself as self, built only with dist/cli/bridge.mjs', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'lousho', version: '9.9.9' }));
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'lousho.js'), '// bin\n');
    const unbuilt = findWorkspaceSdk(dir);
    expect(unbuilt).toMatchObject({ source: 'self', version: '9.9.9', built: false });
    fs.mkdirSync(path.join(dir, 'dist', 'cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'cli', 'bridge.mjs'), '// bridge\n');
    expect(findWorkspaceSdk(dir)?.built).toBe(true);
  });

  it('returns undefined when bin/lousho.js is missing', () => {
    installSdk(path.join(dir, 'node_modules'), 'lousho', { bin: false });
    expect(findWorkspaceSdk(dir)).toBeUndefined();
  });

  it('returns undefined when the manifest name is not the SDK', () => {
    const pkgDir = path.join(dir, 'node_modules', 'lousho');
    fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'not-lousho', version: '1.0.0' }));
    fs.writeFileSync(path.join(pkgDir, 'bin', 'lousho.js'), '// bin\n');
    expect(findWorkspaceSdk(dir)).toBeUndefined();
  });
});
