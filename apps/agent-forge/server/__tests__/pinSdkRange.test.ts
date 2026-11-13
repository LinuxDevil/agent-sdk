/**
 * `scripts/pin-sdk-range.mjs` - the pack-time rewrite of the SDK dependency
 * from `file:../..` to `^<sdk version>`, exercised against a temp monorepo
 * layout (`<tmp>/apps/x` + `<tmp>/package.json`).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'pin-sdk-range.mjs'
);

interface Fixture {
  root: string;
  app: string;
  pkgPath: string;
  backupPath: string;
}

function makeFixture({ withSdkRoot = true }: { withSdkRoot?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-pin-'));
  const app = path.join(root, 'apps', 'x');
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(app, 'scripts', 'pin-sdk-range.mjs'));
  if (withSdkRoot) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      `${JSON.stringify({ name: '@linuxdevil/lousho', version: '9.9.9' }, null, 2)}\n`
    );
  }
  const pkgPath = path.join(app, 'package.json');
  fs.writeFileSync(
    pkgPath,
    `${JSON.stringify(
      {
        name: '@linuxdevil/studio',
        version: '0.1.0-alpha.0',
        dependencies: { '@linuxdevil/lousho': 'file:../..', yaml: '^2.9.1' },
      },
      null,
      2
    )}\n`
  );
  return { root, app, pkgPath, backupPath: path.join(app, '.package.json.prepack') };
}

function run(script: string, args: string[], cwd: string) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

describe('pin-sdk-range.mjs', () => {
  it('pin rewrites the SDK dep to ^<root version>, keeps a backup, refuses a second pin, restore puts it back', () => {
    const fx = makeFixture();
    try {
      const original = fs.readFileSync(fx.pkgPath, 'utf8');
      const pin = run('scripts/pin-sdk-range.mjs', ['pin'], fx.app);
      expect(pin.status).toBe(0);
      const pinned = JSON.parse(fs.readFileSync(fx.pkgPath, 'utf8')) as {
        dependencies: Record<string, string>;
      };
      expect(pinned.dependencies['@linuxdevil/lousho']).toBe('^9.9.9');
      expect(pinned.dependencies.yaml).toBe('^2.9.1');
      expect(fs.existsSync(fx.backupPath)).toBe(true);
      expect(fs.readFileSync(fx.backupPath, 'utf8')).toBe(original);

      const second = run('scripts/pin-sdk-range.mjs', ['pin'], fx.app);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('restore first');

      const restore = run('scripts/pin-sdk-range.mjs', ['restore'], fx.app);
      expect(restore.status).toBe(0);
      expect(fs.readFileSync(fx.pkgPath, 'utf8')).toBe(original);
      expect(fs.existsSync(fx.backupPath)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('pin is a no-op when there is no SDK root package', () => {
    const fx = makeFixture({ withSdkRoot: false });
    try {
      const original = fs.readFileSync(fx.pkgPath, 'utf8');
      const pin = run('scripts/pin-sdk-range.mjs', ['pin'], fx.app);
      expect(pin.status).toBe(0);
      expect(fs.readFileSync(fx.pkgPath, 'utf8')).toBe(original);
      expect(fs.existsSync(fx.backupPath)).toBe(false);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });

  it('pin is a no-op when the root package is not the SDK', () => {
    const fx = makeFixture();
    try {
      fs.writeFileSync(path.join(fx.root, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0' }));
      const original = fs.readFileSync(fx.pkgPath, 'utf8');
      const pin = run('scripts/pin-sdk-range.mjs', ['pin'], fx.app);
      expect(pin.status).toBe(0);
      expect(fs.readFileSync(fx.pkgPath, 'utf8')).toBe(original);
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
