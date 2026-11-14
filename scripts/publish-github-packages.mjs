// Mirrors the two npm packages to GitHub Packages (npm.pkg.github.com) so they
// are listed on the repo's Packages tab. GitHub only accepts packages scoped to
// the repo owner, so the mirror is renamed @linuxdevil/*; npmjs.com keeps the
// original names. Run after `npm run build`, `npm run build:studio` and
// `npm run build -w create-lousho`. Needs NODE_AUTH_TOKEN with packages:write.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCOPE = '@linuxdevil';
const REGISTRY = 'https://npm.pkg.github.com';
const tag = process.env.NPM_TAG || 'alpha';
const dry = process.argv.includes('--dry-run');

const targets = [
  { dir: '.', name: `${SCOPE}/lousho` },
  { dir: 'packages/create-lousho', name: `${SCOPE}/create-lousho` },
];
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' }).toString().trim();

for (const t of targets) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ghpkg-'));
  const tgz = run('npm', ['pack', '--silent', '--pack-destination', work], t.dir).split('\n').pop();
  run('tar', ['-xzf', tgz], work);
  const pkgDir = path.join(work, 'package');
  const file = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.name = t.name;
  pkg.publishConfig = { registry: REGISTRY, access: 'public' };
  // The tarball is already built. Its lifecycle scripts (prepare: husky,
  // prepublishOnly) would otherwise run here, where their deps don't exist.
  delete pkg.scripts;
  // npm and GitHub Packages now use the same @linuxdevil/* names, so the
  // SDK dependency range resolves to this registry's mirror as-is.
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(pkgDir, '.npmrc'), `//npm.pkg.github.com/:_authToken=${process.env.NODE_AUTH_TOKEN}
`);
  console.log(`${dry ? 'would publish' : 'publishing'} ${pkg.name}@${pkg.version} (tag ${tag})`);
  if (!dry) run('npm', ['publish', '--ignore-scripts', '--tag', tag, '--registry', REGISTRY], pkgDir);
}
