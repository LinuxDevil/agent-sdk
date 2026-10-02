// fallow-ignore-file complexity
/**
 * pack-smoke (LOU-D49)
 *
 * Proves that what `npm pack` produces installs and works, in a fresh project
 * that has never seen this checkout:
 *
 *   1. builds the SDK and `create-lousho-agent` (skip with --skip-build),
 *   2. `npm pack`s both into a temp dir and checks the SDK tarball (no `.env`,
 *      tests, fixtures or secret-looking strings; entry count and unpacked size
 *      under the thresholds below),
 *   3. `npm publish <tarball> --dry-run` for both packages (nothing is
 *      published; a tarball argument also skips the prepublishOnly build),
 *   4. installs the tarballs plus the required peers from the REGISTRY into a
 *      temp project,
 *   5. in that project, runs Node: ESM `import` and CJS `require` of the root
 *      and of every `exports` subpath, a mock-model agent turn in both formats,
 *      `lousho --help` / `lousho doctor` through the installed bin, and
 *      `tsc --noEmit` with `moduleResolution` bundler and node16.
 *
 * Usage: npm run pack-smoke [-- --skip-build] [--keep]
 * Peer versions can be overridden for a matrix run, e.g.
 *   PACK_SMOKE_PEERS="ai@4 zod@3 @ai-sdk/openai@0.0.42" npm run pack-smoke
 *
 * Needs network access to the npm registry. It is deliberately NOT part of
 * `npm test`. It never publishes: `npm publish` is only ever run with --dry-run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IS_WIN, SDK_NAME, checkBin, checkModuleLoads, createReporter, mustRun as mustRunIn, run } from './smokeKit';

const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Thresholds: the 1.0.0-alpha.8 tarball is ~705 entries / ~11.4 MB unpacked / ~3.1 MB packed; headroom ~25%.
 * Unpacked raised from 14 to 16 MiB by N4 (#315): main was at 14.63 MB, N4 brought it to 14.73 MB; see #316.
 */
const MAX_ENTRIES = 900;
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;
const MAX_PACKED_BYTES = 4 * 1024 * 1024;

const DEFAULT_PEERS = 'ai@7 zod@4 @ai-sdk/openai@4 react@19 vue@3 @opentelemetry/api@1';
/** Files the `files` allowlist ships on purpose that look like tests (`.test-d.ts` type tests live next to source). */
const ALLOWED_TEST_LIKE = [/\.test-d\.ts$/];
const FORBIDDEN_PATHS = [/(^|\/)\.env(\.|$)/, /\.test\.[cm]?[jt]sx?$/, /\.eval\.ts$/, /__fixtures__\//, /(^|\/)node_modules\//, /\.pem$/, /\.key$/];
const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{32,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /_authToken\s*=/];

const args = new Set(process.argv.slice(2));
const rep = createReporter('pack-smoke');
const { log, fail, failures } = rep;
const mustRun = (label: string, cmd: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv) => mustRunIn(rep, label, cmd, argv, cwd, env);

interface PackEntry {
  filename: string;
  entryCount: number;
  size: number;
  unpackedSize: number;
  files: { path: string }[];
}

function pack(label: string, cwd: string, dest: string): { entry: PackEntry; tarball: string } {
  const res = mustRun(`npm pack ${label}`, 'npm', ['pack', '--json', '--pack-destination', dest], cwd);
  const entry = (JSON.parse(res.stdout) as PackEntry[])[0];
  return { entry, tarball: path.join(dest, entry.filename) };
}

function checkTarball(entry: PackEntry, tarball: string): void {
  log(`tarball ${entry.filename}: ${entry.entryCount} entries, ${(entry.unpackedSize / 1048576).toFixed(1)} MB unpacked, ${(entry.size / 1048576).toFixed(1)} MB packed`);
  if (entry.entryCount > MAX_ENTRIES) fail(`tarball has ${entry.entryCount} entries (max ${MAX_ENTRIES})`);
  if (entry.unpackedSize > MAX_UNPACKED_BYTES) fail(`tarball unpacked size ${entry.unpackedSize} exceeds ${MAX_UNPACKED_BYTES}`);
  if (entry.size > MAX_PACKED_BYTES) fail(`tarball packed size ${entry.size} exceeds ${MAX_PACKED_BYTES}`);
  for (const f of entry.files) {
    if (ALLOWED_TEST_LIKE.some((re) => re.test(f.path))) continue;
    if (FORBIDDEN_PATHS.some((re) => re.test(f.path))) fail(`tarball contains forbidden file ${f.path}`);
  }
  const extracted = fs.mkdtempSync(path.join(path.dirname(tarball), 'unpack-'));
  // Relative tarball path: GNU tar (Git Bash) reads "C:" in an absolute Windows path as a remote host.
  const tar = run('tar', ['-xzf', path.relative(extracted, tarball)], extracted);
  if (tar.status !== 0) return fail(`could not unpack the tarball to scan it: ${tar.stderr}`);
  for (const f of entry.files) {
    if (!/\.(js|mjs|cjs|ts|mts|json|map|md|txt|yaml|yml)$/.test(f.path) && !f.path.startsWith('bin/')) continue;
    const text = fs.readFileSync(path.join(extracted, 'package', f.path), 'utf8');
    for (const re of SECRET_PATTERNS) if (re.test(text)) fail(`${f.path} matches secret pattern ${re}`);
  }
}

function dryRunPublish(label: string, tarball: string, cwd: string): void {
  // `--tag next`: the versions are prereleases and npm 11 refuses a prerelease without an explicit tag.
  const res = run('npm', ['publish', tarball, '--dry-run', '--tag', 'next', '--access', 'public'], cwd);
  const out = res.stdout + res.stderr;
  // After a release the version in the repo is the one on npm until the next bump. The dry run
  // then fails only on that; the tarball itself was accepted, which is what this step checks.
  if (/cannot publish over the previously published versions/i.test(out)) {
    log(`npm publish --dry-run ${label}: ok (this version is already on npm; bump it before the next release)`);
  } else if (res.status !== 0 || /npm (error|ERR!)/.test(out)) {
    fail(`npm publish --dry-run ${label} failed:\n${out}`);
  } else {
    log(`npm publish --dry-run ${label}: ok`);
  }
}

function checkTypes(project: string): void {
  const entry = [
    `import { createAgent, defineTool } from '${SDK_NAME}';`,
    `import { mockModel } from '${SDK_NAME}/testing';`,
    `import type { ToolRegistry } from '${SDK_NAME}/tools';`,
    `import type { HookRegistry } from '${SDK_NAME}/hooks';`,
    `export const agent = createAgent({ provider: mockModel(['x']), prompt: 'p' });`,
    `export const t = defineTool;`,
    `export type T = ToolRegistry;`,
    `export type H = HookRegistry;`,
  ].join('\n');
  fs.writeFileSync(path.join(project, 'types-entry.ts'), entry + '\n');
  const tsc = path.join(project, 'node_modules', 'typescript', 'bin', 'tsc');
  const modes: [string, Record<string, unknown>][] = [
    ['bundler', { module: 'esnext', moduleResolution: 'bundler' }],
    ['node16', { module: 'node16', moduleResolution: 'node16' }],
  ];
  for (const [name, opts] of modes) {
    const cfg = {
      compilerOptions: { ...opts, target: 'es2022', strict: true, noEmit: true, skipLibCheck: true, types: ['node'] },
      files: ['types-entry.ts'],
    };
    fs.writeFileSync(path.join(project, `tsconfig.${name}.json`), JSON.stringify(cfg, null, 2));
    const res = run(process.execPath, [tsc, '-p', `tsconfig.${name}.json`], project);
    if (res.status !== 0) fail(`tsc (${name}) failed:\n${res.stdout}${res.stderr}`);
    else log(`tsc --noEmit (${name}): root + ./testing + ./tools + ./hooks types resolve`);
  }
}

function main(): void {
  if (!args.has('--skip-build')) {
    mustRun('npm run build', 'npm', ['run', 'build'], REPO_ROOT);
    mustRun('npm run build (create-lousho-agent)', 'npm', ['run', 'build', '--workspace=packages/create-lousho-agent'], REPO_ROOT);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-pack-smoke-'));
  log(`temp dir ${base}`);
  const packDir = path.join(base, 'tarballs');
  const project = path.join(base, 'project');
  fs.mkdirSync(packDir);
  fs.mkdirSync(project);
  try {
    const sdk = pack('(sdk)', REPO_ROOT, packDir);
    const creator = pack('(create-lousho-agent)', path.join(REPO_ROOT, 'packages', 'create-lousho-agent'), packDir);
    checkTarball(sdk.entry, sdk.tarball);
    dryRunPublish('(sdk)', sdk.tarball, base);
    dryRunPublish('(create-lousho-agent)', creator.tarball, base);

    const peers = (process.env.PACK_SMOKE_PEERS ?? DEFAULT_PEERS).split(/\s+/).filter(Boolean);
    const fileUrl = (p: string) => `file:${p.replace(/\\/g, '/')}`;
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'pack-smoke-project', version: '0.0.0', private: true }, null, 2)
    );
    mustRun(`npm install ${peers.join(' ')} typescript @types/node + sdk tarball`, 'npm', ['install', '--no-audit', '--no-fund', sdk.tarball, ...peers, 'typescript@5', '@types/node@22'], project);
    // create-lousho-agent depends on the SDK by a registry range that does not exist yet: point it at the tarball.
    const creatorProject = path.join(base, 'creator-project');
    fs.mkdirSync(creatorProject);
    fs.writeFileSync(
      path.join(creatorProject, 'package.json'),
      JSON.stringify({ name: 'pack-smoke-creator', version: '0.0.0', private: true, overrides: { [SDK_NAME]: fileUrl(sdk.tarball) } }, null, 2)
    );
    mustRun('npm install create-lousho-agent tarball', 'npm', ['install', '--no-audit', '--no-fund', creator.tarball, ...peers], creatorProject);

    const pkgDir = path.join(project, 'node_modules', ...SDK_NAME.split('/'));
    checkModuleLoads(rep, project, pkgDir);
    checkBin(rep, project);
    checkTypes(project);
    const creatorBin = path.join(creatorProject, 'node_modules', '.bin', IS_WIN ? 'create-lousho-agent.cmd' : 'create-lousho-agent');
    if (!fs.existsSync(creatorBin)) fail('create-lousho-agent bin was not installed');
    else {
      const res = run('npx', ['--no-install', 'create-lousho-agent', '--help'], creatorProject);
      if (res.status !== 0) fail(`create-lousho-agent --help failed: ${res.stdout}${res.stderr}`);
      else log('create-lousho-agent --help: ok');
    }
  } finally {
    if (args.has('--keep')) log(`kept ${base}`);
    else fs.rmSync(base, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\n[pack-smoke] ${failures.length} failure(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  log('all checks passed');
}

main();
