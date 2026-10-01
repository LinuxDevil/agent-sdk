/**
 * pack-smoke (LOU-D49)
 *
 * Proves that what `npm pack` produces installs and works, in a fresh project
 * that has never seen this checkout:
 *
 *   1. builds the SDK and `create-loushy-agent` (skip with --skip-build),
 *   2. `npm pack`s both into a temp dir and checks the SDK tarball (no `.env`,
 *      tests, fixtures or secret-looking strings; entry count and unpacked size
 *      under the thresholds below),
 *   3. `npm publish <tarball> --dry-run` for both packages (nothing is
 *      published; a tarball argument also skips the prepublishOnly build),
 *   4. installs the tarballs plus the required peers from the REGISTRY into a
 *      temp project,
 *   5. in that project, runs Node: ESM `import` and CJS `require` of the root
 *      and of every `exports` subpath, a mock-model agent turn in both formats,
 *      `loushy --help` / `loushy doctor` through the installed bin, and
 *      `tsc --noEmit` with `moduleResolution` bundler and node16.
 *
 * Usage: npm run pack-smoke [-- --skip-build] [--keep]
 * Peer versions can be overridden for a matrix run, e.g.
 *   PACK_SMOKE_PEERS="ai@4 zod@3 @ai-sdk/openai@0.0.42" npm run pack-smoke
 *
 * Needs network access to the npm registry. It is deliberately NOT part of
 * `npm test`. It never publishes: `npm publish` is only ever run with --dry-run.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');
const SDK_NAME = '@loushy/build-ai-agent';
const IS_WIN = process.platform === 'win32';

/** Thresholds: the 1.0.0-alpha.8 tarball is ~705 entries / ~11.4 MB unpacked / ~3.1 MB packed; headroom ~25%. */
const MAX_ENTRIES = 900;
const MAX_UNPACKED_BYTES = 14 * 1024 * 1024;
const MAX_PACKED_BYTES = 4 * 1024 * 1024;

const DEFAULT_PEERS = 'ai@7 zod@4 @ai-sdk/openai@4 react@19 vue@3 @opentelemetry/api@1';
/** Optional peers: a subpath whose load fails because one of these is absent is checked by file existence only. */
const OPTIONAL_PEERS = ['vue', 'react', 'svelte', '@opentelemetry/api', '@modelcontextprotocol/sdk', 'dockerode', 'prompts', 'tsup', 'better-sqlite3'];
/** Files the `files` allowlist ships on purpose that look like tests (`.test-d.ts` type tests live next to source). */
const ALLOWED_TEST_LIKE = [/\.test-d\.ts$/];
const FORBIDDEN_PATHS = [/(^|\/)\.env(\.|$)/, /\.test\.[cm]?[jt]sx?$/, /\.eval\.ts$/, /__fixtures__\//, /(^|\/)node_modules\//, /\.pem$/, /\.key$/];
const SECRET_PATTERNS = [/sk-[A-Za-z0-9]{32,}/, /AKIA[0-9A-Z]{16}/, /ghp_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /_authToken\s*=/];

const args = new Set(process.argv.slice(2));
const failures: string[] = [];

function log(msg: string): void {
  console.log(`[pack-smoke] ${msg}`);
}

function fail(msg: string): void {
  failures.push(msg);
  console.error(`[pack-smoke] FAIL: ${msg}`);
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run a command; `npm`/`npx` go through the shell on Windows (they are .cmd shims). */
function run(cmd: string, argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): RunResult {
  const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const useShell = IS_WIN && (cmd === 'npm' || cmd === 'npx');
  const res = useShell
    ? spawnSync([cmd, ...argv.map(quote)].join(' '), { cwd, env, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 })
    : spawnSync(cmd, argv, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

function mustRun(label: string, cmd: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  log(label);
  const res = run(cmd, argv, cwd, env);
  if (res.status !== 0) {
    console.error(res.stdout + res.stderr);
    throw new Error(`${label} failed (exit ${res.status})`);
  }
  return res;
}

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
  if (res.status !== 0 || /npm (error|ERR!)/.test(out)) {
    fail(`npm publish --dry-run ${label} failed:\n${out}`);
  } else {
    log(`npm publish --dry-run ${label}: ok`);
  }
}

/** All `exports` subpaths with their targets, from the installed package.json. */
function listExports(pkgDir: string): { subpath: string; spec: string; targets: string[] }[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  return Object.entries<Record<string, string>>(pkg.exports).map(([subpath, conds]) => ({
    subpath,
    spec: subpath === '.' ? SDK_NAME : `${SDK_NAME}/${subpath.slice(2)}`,
    targets: Object.values(conds),
  }));
}

/** Source of a probe script that loads every spec in one module format and prints JSON results. */
function probeSource(format: 'esm' | 'cjs', specs: string[]): string {
  const load = format === 'esm' ? 'await import(spec)' : 'require(spec)';
  const body = `
const specs = ${JSON.stringify(specs)};
const optional = ${JSON.stringify(OPTIONAL_PEERS)};
const results = [];
for (const spec of specs) {
  try { ${load}; results.push({ spec, ok: true }); }
  catch (e) {
    const msg = String(e && e.message);
    const missingCode = e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND');
    const peer = missingCode && optional.find((p) => msg.includes("'" + p + "'") || msg.includes('"' + p + '"') || msg.includes('/' + p + '/'));
    results.push({ spec, ok: false, peer: peer || null, error: msg.split('\\n')[0] });
  }
}
console.log('RESULTS ' + JSON.stringify(results));
`;
  return format === 'esm' ? body : `(async () => {${body}})().catch((e) => { console.error(e); process.exit(1); });`;
}

function turnSource(format: 'esm' | 'cjs'): string {
  const body = `
const agent = createAgent({ provider: mockModel(['hello from the mock']), prompt: 'You are a test.' });
const result = await agent.send('hi');
if (result.text !== 'hello from the mock') throw new Error('unexpected reply: ' + result.text);
console.log('TURN_OK');
`;
  if (format === 'esm') {
    return `import { createAgent } from '${SDK_NAME}';\nimport { mockModel } from '${SDK_NAME}/testing';\n${body}`;
  }
  return `const { createAgent } = require('${SDK_NAME}');\nconst { mockModel } = require('${SDK_NAME}/testing');\n(async () => {${body}})().catch((e) => { console.error(e); process.exit(1); });\n`;
}

function checkModuleLoads(project: string, pkgDir: string): void {
  const exportsList = listExports(pkgDir);
  for (const e of exportsList) {
    for (const t of e.targets) {
      if (!fs.existsSync(path.join(pkgDir, t))) fail(`export ${e.subpath}: target ${t} does not exist in the installed package`);
    }
  }
  const specs = exportsList.map((e) => e.spec);
  for (const format of ['esm', 'cjs'] as const) {
    const file = path.join(project, `probe.${format === 'esm' ? 'mjs' : 'cjs'}`);
    fs.writeFileSync(file, probeSource(format, specs));
    const res = run(process.execPath, [file], project);
    const line = res.stdout.split('\n').find((l) => l.startsWith('RESULTS '));
    if (res.status !== 0 || !line) {
      fail(`${format} probe crashed: ${res.stderr || res.stdout}`);
      continue;
    }
    const results = JSON.parse(line.slice(8)) as { spec: string; ok: boolean; peer: string | null; error?: string }[];
    for (const r of results) {
      if (r.ok) continue;
      if (r.peer) log(`${format} ${r.spec}: optional peer ${r.peer} not installed, checked by file existence only`);
      else fail(`${format} ${r.spec} failed to load: ${r.error}`);
    }
    log(`${format}: ${results.filter((r) => r.ok).length}/${results.length} entries loaded`);

    const turn = path.join(project, `turn.${format === 'esm' ? 'mjs' : 'cjs'}`);
    fs.writeFileSync(turn, turnSource(format));
    const t = run(process.execPath, [turn], project);
    if (!t.stdout.includes('TURN_OK')) fail(`${format} mock agent turn failed: ${t.stderr || t.stdout}`);
    else log(`${format}: createAgent + mockModel turn ok`);
  }
}

function checkBin(project: string): void {
  const installed = path.join(project, 'node_modules', '.bin', IS_WIN ? 'loushy.cmd' : 'loushy');
  if (!fs.existsSync(installed)) return fail(`node_modules/.bin/loushy was not created (${installed})`);
  const help = run('npx', ['--no-install', 'loushy', '--help'], project);
  if (help.status !== 0 || !/loushy init/.test(help.stdout + help.stderr)) fail(`npx loushy --help failed: ${help.stdout}${help.stderr}`);
  else log('npx loushy --help: ok');
  const clean = { ...process.env };
  for (const k of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete clean[k];
  const doctor = run('npx', ['--no-install', 'loushy', 'doctor', '--json'], project, clean);
  // doctor exits non-zero when a check fails (e.g. no API key); only a crash is a smoke failure.
  try {
    const parsed = JSON.parse(doctor.stdout);
    log(`loushy doctor: ran (exit ${doctor.status}, ${JSON.stringify(parsed).length} bytes of JSON)`);
  } catch {
    fail(`loushy doctor did not produce JSON: ${doctor.stdout}${doctor.stderr}`);
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
    mustRun('npm run build (create-loushy-agent)', 'npm', ['run', 'build', '--workspace=packages/create-loushy-agent'], REPO_ROOT);
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-pack-smoke-'));
  log(`temp dir ${base}`);
  const packDir = path.join(base, 'tarballs');
  const project = path.join(base, 'project');
  fs.mkdirSync(packDir);
  fs.mkdirSync(project);
  try {
    const sdk = pack('(sdk)', REPO_ROOT, packDir);
    const creator = pack('(create-loushy-agent)', path.join(REPO_ROOT, 'packages', 'create-loushy-agent'), packDir);
    checkTarball(sdk.entry, sdk.tarball);
    dryRunPublish('(sdk)', sdk.tarball, base);
    dryRunPublish('(create-loushy-agent)', creator.tarball, base);

    const peers = (process.env.PACK_SMOKE_PEERS ?? DEFAULT_PEERS).split(/\s+/).filter(Boolean);
    const fileUrl = (p: string) => `file:${p.replace(/\\/g, '/')}`;
    fs.writeFileSync(
      path.join(project, 'package.json'),
      JSON.stringify({ name: 'pack-smoke-project', version: '0.0.0', private: true }, null, 2)
    );
    mustRun(`npm install ${peers.join(' ')} typescript @types/node + sdk tarball`, 'npm', ['install', '--no-audit', '--no-fund', sdk.tarball, ...peers, 'typescript@5', '@types/node@22'], project);
    // create-loushy-agent depends on the SDK by a registry range that does not exist yet: point it at the tarball.
    const creatorProject = path.join(base, 'creator-project');
    fs.mkdirSync(creatorProject);
    fs.writeFileSync(
      path.join(creatorProject, 'package.json'),
      JSON.stringify({ name: 'pack-smoke-creator', version: '0.0.0', private: true, overrides: { [SDK_NAME]: fileUrl(sdk.tarball) } }, null, 2)
    );
    mustRun('npm install create-loushy-agent tarball', 'npm', ['install', '--no-audit', '--no-fund', creator.tarball, ...peers], creatorProject);

    const pkgDir = path.join(project, 'node_modules', ...SDK_NAME.split('/'));
    checkModuleLoads(project, pkgDir);
    checkBin(project);
    checkTypes(project);
    const creatorBin = path.join(creatorProject, 'node_modules', '.bin', IS_WIN ? 'create-loushy-agent.cmd' : 'create-loushy-agent');
    if (!fs.existsSync(creatorBin)) fail('create-loushy-agent bin was not installed');
    else {
      const res = run('npx', ['--no-install', 'create-loushy-agent', '--help'], creatorProject);
      if (res.status !== 0) fail(`create-loushy-agent --help failed: ${res.stdout}${res.stderr}`);
      else log('create-loushy-agent --help: ok');
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
