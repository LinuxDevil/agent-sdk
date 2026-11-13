#!/usr/bin/env node
/**
 * Rewrites the Studio package's SDK dependency for packing.
 *
 * In the monorepo `dependencies['@linuxdevil/lousho']` stays `file:../..`
 * so the dev loop always runs the checkout next door. `npm pack`/`publish`
 * run `prepack` (`pin`) first: when the repo root package is the SDK
 * (`@linuxdevil/lousho`), the range is rewritten to `^<its version>` and the
 * original file is kept as `.package.json.prepack`; `postpack` (`restore`)
 * puts it back. Outside that layout `pin` is a no-op.
 *
 * Usage: node scripts/pin-sdk-range.mjs pin|restore   (cwd: apps/agent-forge)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const SDK_PACKAGE = '@linuxdevil/lousho';
const DEP_KEY = SDK_PACKAGE;
const BACKUP = '.package.json.prepack';

const appDir = process.cwd();
const pkgPath = path.join(appDir, 'package.json');
const rootPkgPath = path.join(appDir, '..', '..', 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pin() {
  const backupPath = path.join(appDir, BACKUP);
  if (fs.existsSync(backupPath)) {
    console.error('pin-sdk-range: restore first (.package.json.prepack already exists)');
    process.exit(1);
  }
  if (!fs.existsSync(rootPkgPath) || !fs.existsSync(pkgPath)) return;
  const root = readJson(rootPkgPath);
  if (root.name !== SDK_PACKAGE) return;
  const pkg = readJson(pkgPath);
  if (pkg.dependencies?.[DEP_KEY] === undefined) return;
  fs.writeFileSync(backupPath, fs.readFileSync(pkgPath));
  pkg.dependencies[DEP_KEY] = `^${root.version}`;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`pin-sdk-range: ${DEP_KEY} -> ^${root.version}`);
}

function restore() {
  const backupPath = path.join(appDir, BACKUP);
  if (!fs.existsSync(backupPath)) return;
  fs.renameSync(backupPath, pkgPath);
  console.log('pin-sdk-range: restored package.json');
}

const command = process.argv[2];
if (command === 'pin') pin();
else if (command === 'restore') restore();
else {
  console.error('pin-sdk-range: usage: pin-sdk-range.mjs pin|restore');
  process.exit(2);
}
