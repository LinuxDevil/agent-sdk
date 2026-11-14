// fallow-ignore-file complexity
/**
 * pack-smoke:studio
 *
 * Proves that what `npm pack` produces for `@linuxdevil/studio` (and the SDK
 * it depends on) installs and works in a fresh project that has never seen
 * this checkout:
 *
 *   1. builds the SDK and Studio (skip with --skip-build),
 *   2. `npm pack`s both into a temp dir and checks the Studio tarball (no
 *      source, tests, maps or `.package.json.prepack`; `package.json` carries
 *      the bin and a semver SDK range, never `file:`; entry count and sizes
 *      under the thresholds below), and that `apps/agent-forge/package.json`
 *      is byte-identical afterwards (prepack/postpack pin+restore),
 *   3. `npm publish --dry-run` for the Studio tarball (never a real publish),
 *   4. installs both tarballs into a temp project (the SDK dependency is
 *      overridden to the SDK tarball, since its semver range is not on npm),
 *   5. `lousho-studio --help` through node_modules/.bin,
 *   6. starts `dist-server/cli.cjs` directly: `GET /health` answers `ok` and
 *      `GET /` serves the built UI,
 *   7. starts `lousho studio` through the SDK's bin - the W13b launcher must
 *      find the installed Studio and serve the same UI.
 *
 * Both launches run with LOUSHO_STUDIO_COLLECTOR=0 so no observe daemon is
 * started. Usage: npm run pack-smoke:studio [-- --skip-build] [--keep]
 *
 * Needs network access to the npm registry. It is deliberately NOT part of
 * `npm test`. It never publishes: `npm publish` is only ever run with
 * --dry-run.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkTarballContents, cleanSmokeDir, IS_WIN, SDK_NAME, dryRunPublish, freePort, packTarball, reportSmoke, run, smokeDirs, smokeSetup, type TarballLimits } from './smokeKit';

const REPO_ROOT = path.resolve(__dirname, '..');
const STUDIO_DIR = path.join(REPO_ROOT, 'apps', 'agent-forge');
const STUDIO_NAME = '@linuxdevil/studio';

/**
 * Thresholds measured on the first green run (2026-11-13, W15a): the Studio
 * tarball ships 9 entries, 4.9 MB unpacked, 1.3 MB packed. Budgets carry
 * ~10% headroom, like scripts/pack-smoke.ts.
 */
const STUDIO_MAX_ENTRIES = 12;
const STUDIO_MAX_UNPACKED_BYTES = 5_500_000;
const STUDIO_MAX_PACKED_BYTES = 1_500_000;

const STUDIO_REQUIRED_PATHS = ['dist/index.html', 'dist-server/index.cjs', 'dist-server/cli.cjs', 'package.json', 'README.md'];
const STUDIO_FORBIDDEN_PATHS = [
  /\.map$/,
  /^(src|server|shared|e2e|scripts)\//,
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)node_modules\//,
  /\.package\.json\.prepack$/,
];

const { args, rep, log, fail, mustRun } = smokeSetup('pack-smoke:studio');

const STUDIO_TARBALL_LIMITS: TarballLimits = {
  maxEntries: STUDIO_MAX_ENTRIES,
  maxUnpackedBytes: STUDIO_MAX_UNPACKED_BYTES,
  maxPackedBytes: STUDIO_MAX_PACKED_BYTES,
  requiredPaths: STUDIO_REQUIRED_PATHS,
  forbiddenPatterns: STUDIO_FORBIDDEN_PATHS,
};

/** Reads the packed package.json and checks name/bin/SDK range (prepack pin ran). */
function checkStudioPackageJson(unpackedPackageJson: unknown): void {
  const pkg = unpackedPackageJson as { name?: string; bin?: Record<string, string>; dependencies?: Record<string, string> };
  if (pkg.name !== STUDIO_NAME) fail(`studio package.json name is ${JSON.stringify(pkg.name)}, expected ${STUDIO_NAME}`);
  if (pkg.bin?.['lousho-studio'] !== 'dist-server/cli.cjs') fail(`studio bin.lousho-studio is ${JSON.stringify(pkg.bin?.['lousho-studio'])}, expected 'dist-server/cli.cjs'`);
  const sdkRange = pkg.dependencies?.[SDK_NAME];
  if (!sdkRange || !/^\^\d/.test(sdkRange)) fail(`studio dependency ${SDK_NAME} is ${JSON.stringify(sdkRange)}, expected a ^<semver> range (prepack pin did not run)`);
}

/** Step 5: `lousho-studio --help` through node_modules/.bin exits 0 and mentions --workspace. */
function checkStudioBin(project: string): void {
  const res = IS_WIN
    ? run('npx', ['--no-install', 'lousho-studio', '--help'], project)
    : run(path.join(project, 'node_modules', '.bin', 'lousho-studio'), ['--help'], project);
  if (res.status !== 0 || !res.stdout.includes('--workspace')) {
    fail(`lousho-studio --help failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
  } else {
    log('lousho-studio --help: ok');
  }
}

interface ServerHandle {
  child: ChildProcess;
  port: number;
  stderr: () => string;
}

/** Spawns a detached Studio process; the caller kills it via killTree. */
function startStudioProcess(nodeArgs: string[], project: string, port: number): ServerHandle {
  const child = spawn(process.execPath, nodeArgs, {
    cwd: project,
    env: { ...process.env, LOUSHO_STUDIO_COLLECTOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString();
    if (stderr.length > 64 * 1024) stderr = stderr.slice(-16 * 1024);
  });
  child.stdout?.resume();
  return { child, port, stderr: () => stderr };
}

/** Kills the whole process tree: taskkill on Windows, the process group elsewhere. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Resolves once the killed process exits (5s cap) so a leaked Studio cannot hold the port. */
function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Polls GET /health for `ok` then GET / for the built UI, within 20s. */
async function waitForStudio(handle: ServerHandle, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const health = await fetch(`http://127.0.0.1:${handle.port}/health`);
      const text = await health.text();
      last = `health ${health.status} ${text.slice(0, 80)}`;
      if (health.status === 200 && text.trim() === 'ok') {
        const root = await fetch(`http://127.0.0.1:${handle.port}/`);
        const html = await root.text();
        if (root.status === 200 && html.includes('<div id="root">')) {
          rep.log(`${label}: /health ok and / serves the UI`);
          return;
        }
        last = `GET / -> ${root.status}, ${html.length} bytes`;
      }
    } catch (e) {
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  rep.fail(`${label}: Studio did not come up within 20s (last: ${last}; stderr: ${handle.stderr().slice(-500)})`);
}

/** Steps 6+7: boot Studio directly and through `lousho studio`, each on a free port. */
async function checkStudioServes(project: string): Promise<void> {
  const cliPath = path.join(project, 'node_modules', ...STUDIO_NAME.split('/'), 'dist-server', 'cli.cjs');
  const loushoBin = path.join(project, 'node_modules', ...SDK_NAME.split('/'), 'bin', 'lousho.js');

  const port1 = await freePort();
  const direct = startStudioProcess([cliPath, '--port', String(port1), '--workspace', project], project, port1);
  try {
    await waitForStudio(direct, 'lousho-studio (cli.cjs)');
  } finally {
    killTree(direct.child);
    await waitExit(direct.child);
  }

  const port2 = await freePort();
  const viaLauncher = startStudioProcess([loushoBin, 'studio', '--port', String(port2)], project, port2);
  try {
    await waitForStudio(viaLauncher, 'lousho studio (launcher)');
  } finally {
    killTree(viaLauncher.child);
    await waitExit(viaLauncher.child);
  }
}

/** `file:` spec relative to the project dir - npm requires the override and the direct dep to be the same spec string. */
function fileSpec(fromDir: string, p: string): string {
  return `file:${path.relative(fromDir, p).replace(/\\/g, '/')}`;
}

async function main(): Promise<void> {
  if (!args.has('--skip-build')) {
    mustRun('npm run build', 'npm', ['run', 'build'], REPO_ROOT);
    mustRun('npm run build:studio', 'npm', ['run', 'build:studio'], REPO_ROOT);
  }
  const { base, packDir, project } = smokeDirs('lousho-studio-pack-smoke');
  log(`temp dir ${base}`);

  const studioPkgJsonBefore = fs.readFileSync(path.join(STUDIO_DIR, 'package.json'), 'utf8');
  try {
    const sdk = packTarball(rep, '(sdk)', REPO_ROOT, packDir);
    const studio = packTarball(rep, '(studio)', STUDIO_DIR, packDir);

    // `npm pack` runs prepack/postpack; unpack once to read the shipped package.json.
    const unpackDir = path.join(base, 'studio-unpack');
    fs.mkdirSync(unpackDir);
    const tar = run('tar', ['-xzf', path.relative(unpackDir, studio.tarball)], unpackDir);
    if (tar.status !== 0) fail(`could not unpack the studio tarball: ${tar.stderr}`);
    else {
      const shippedPkg = JSON.parse(fs.readFileSync(path.join(unpackDir, 'package', 'package.json'), 'utf8'));
      checkStudioPackageJson(shippedPkg);
      checkTarballContents(rep, studio.entry, STUDIO_TARBALL_LIMITS);
    }

    // prepack pins file:../.. to a semver range and postpack restores it - even on failure.
    const pkgJsonAfter = fs.readFileSync(path.join(STUDIO_DIR, 'package.json'), 'utf8');
    if (pkgJsonAfter !== studioPkgJsonBefore) fail('apps/agent-forge/package.json changed after npm pack (pin/restore did not restore it)');
    else log('apps/agent-forge/package.json restored after pack');

    dryRunPublish(rep, '(studio)', studio.tarball, base);

    // The override must carry the same spec string npm records for the direct dependency.
    const sdkSpec = fileSpec(project, sdk.tarball);
    const studioSpec = fileSpec(project, studio.tarball);
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'studio-smoke', version: '0.0.0', private: true, overrides: { [SDK_NAME]: sdkSpec } }, null, 2)
    );
    mustRun('npm install sdk + studio tarballs', 'npm', ['install', '--no-audit', '--no-fund', sdkSpec, studioSpec], project);

    checkStudioBin(project);
    await checkStudioServes(project);
  } finally {
    if (fs.readFileSync(path.join(STUDIO_DIR, 'package.json'), 'utf8') !== studioPkgJsonBefore) {
      rep.fail('apps/agent-forge/package.json was left modified - restoring is the postpack script\'s job');
    }
    cleanSmokeDir(rep, base, args.has('--keep'));
  }
  reportSmoke(rep);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
