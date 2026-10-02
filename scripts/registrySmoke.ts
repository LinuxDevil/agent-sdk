// fallow-ignore-file complexity
/**
 * registry-smoke (R1b)
 *
 * Proves that what a stranger gets from the npm registry works. It never reads
 * the checkout: everything runs in a fresh temp directory with what npm
 * downloads. `pack-smoke` tests the tarball built from the checkout; this tests
 * the published copy. Run it right after a publish, and on the weekly CI job.
 *
 *   1. `npm view` of `@lousho/build-ai-agent` and `create-lousho-agent` (retried:
 *      a fresh publish can lag for a minute),
 *   2. `npm create lousho-agent demo -- --yes --provider openrouter --no-git`
 *      (installs from the registry) and a check of the installed SDK version,
 *   3. the generated project's own `npm test` and `npm run typecheck`,
 *   4. `lousho --help` and `lousho doctor --json`, and every `exports` subpath
 *      in ESM and CJS,
 *   5. `lousho studio` on a free port: `GET /health` is 200 and `GET /` is HTML
 *      with `id="root"`. Only for SDK versions >= STUDIO_FIXED_IN (see below),
 *   6. with `--live`: one real turn through OpenRouter (needs OPENROUTER_API_KEY).
 *
 * Usage: npm run registry-smoke -- [--version <semver|dist-tag>] [--live] [--keep]
 * `--version` defaults to `latest`. It needs network access and is NOT part of
 * `npm test`. It never publishes anything.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { IS_WIN, SDK_NAME, checkBin, checkModuleLoads, createReporter, run, type Reporter } from './smokeKit';

const CREATE_NAME = 'create-lousho-agent';
/**
 * `lousho studio` only works outside the SDK repository from this version on (R1a). Older
 * published versions print `SKIP studio` instead of failing, so the scheduled job is not red
 * for a release that is already out. It is a minimum, not a pin: once a release containing
 * R1a is published, the studio step runs for it and for everything newer.
 */
const STUDIO_FIXED_IN = '1.0.0-alpha.9';
const STUDIO_TIMEOUT_MS = 30_000;
const VIEW_ATTEMPTS = 3;
const VIEW_WAIT_MS = 10_000;
const KEY_VARS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
const SDK_DIR = ['node_modules', ...SDK_NAME.split('/')];

const rep = createReporter('registry-smoke');
const { log, fail } = rep;

/** Thrown for a failure that stops the run at once (the later steps depend on it). */
class StepError extends Error {}

function parseArgs(argv: string[]): { version: string; live: boolean; keep: boolean } {
  const out = { version: 'latest', live: false, keep: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--live') out.live = true;
    else if (argv[i] === '--keep') out.keep = true;
    else if (argv[i] === '--version' && argv[i + 1]) out.version = argv[++i];
    else throw new StepError(`unknown argument ${argv[i]}. Usage: registry-smoke [--version <semver|dist-tag>] [--live] [--keep]`);
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Compare two semver strings (prerelease aware); enough for STUDIO_FIXED_IN. Returns -1, 0 or 1. */
function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split('+')[0].split(/-(.+)/);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

interface ViewInfo {
  version: string;
  unpackedSize?: number;
  fileCount?: number;
}

/** One-line reason from a failed `npm view --json` (it prints `{ error: { code, summary } }`). */
function viewError(stdout: string, stderr: string, status: number): string {
  try {
    const err = JSON.parse(stdout).error as { code?: string; summary?: string } | undefined;
    if (err) return `${err.code ?? 'error'}: ${err.summary ?? 'no summary'}`;
  } catch {
    /* not JSON */
  }
  return (stdout + stderr).trim().split('\n')[0] || `npm view exited ${status} with no output`;
}

/** Step 1: `npm view` with retries; the exact version, size and file count. */
async function npmView(spec: string): Promise<ViewInfo> {
  let last = '';
  for (let attempt = 1; attempt <= VIEW_ATTEMPTS; attempt++) {
    const res = run('npm', ['view', spec, 'version', 'dist.unpackedSize', 'dist.fileCount', '--json'], os.tmpdir());
    if (res.status === 0 && res.stdout.trim()) {
      const parsed = JSON.parse(res.stdout);
      const info = (Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed) as Record<string, unknown>;
      return { version: String(info.version), unpackedSize: info['dist.unpackedSize'] as number, fileCount: info['dist.fileCount'] as number };
    }
    last = viewError(res.stdout, res.stderr, res.status);
    if (attempt < VIEW_ATTEMPTS) {
      log(`npm view ${spec}: not available yet (attempt ${attempt}/${VIEW_ATTEMPTS}), retrying in ${VIEW_WAIT_MS / 1000}s`);
      await sleep(VIEW_WAIT_MS);
    }
  }
  throw new StepError(`step 1: ${spec} is not on the npm registry (${last})`);
}

function describe(name: string, info: ViewInfo): void {
  const mb = info.unpackedSize ? `${(info.unpackedSize / 1048576).toFixed(2)} MB unpacked` : 'size unknown';
  log(`${name}@${info.version}: ${info.fileCount ?? '?'} files, ${mb}`);
}

/** The process environment without provider keys (the offline steps must not depend on them). */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of KEY_VARS) delete env[k];
  return env;
}

function readInstalledVersion(demo: string): string {
  return JSON.parse(fs.readFileSync(path.join(demo, ...SDK_DIR, 'package.json'), 'utf8')).version;
}

/** Step 2: scaffold from the registry and check which SDK version got installed. */
function scaffold(base: string, createVersion: string, sdkVersion: string): string {
  const demo = path.join(base, 'demo');
  const createCmd = CREATE_NAME.replace(/^create-/, ''); // `npm create x` runs the package `create-x`
  log(`npm create ${createCmd}@${createVersion} demo (installs from the registry; takes a few minutes)`);
  const res = run('npm', ['create', `${createCmd}@${createVersion}`, 'demo', '--', '--yes', '--provider', 'openrouter', '--no-git'], base, cleanEnv());
  if (res.status !== 0) throw new StepError(`step 2: npm create failed (exit ${res.status}):\n${res.stdout}${res.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(demo, 'package.json'), 'utf8'));
  const range = manifest.dependencies?.[SDK_NAME] ?? manifest.devDependencies?.[SDK_NAME];
  if (typeof range !== 'string' || !range.startsWith('^')) fail(`demo/package.json depends on ${SDK_NAME} as "${range}", expected a caret range`);
  else log(`demo depends on ${SDK_NAME} ${range}`);
  let installed = readInstalledVersion(demo);
  if (installed !== sdkVersion) {
    // The scaffold's caret range resolves to the newest matching release, which is not the one under test.
    log(`scaffold installed ${installed}, pinning the version under test: npm install ${SDK_NAME}@${sdkVersion}`);
    const pin = run('npm', ['install', '--no-audit', '--no-fund', `${SDK_NAME}@${sdkVersion}`], demo, cleanEnv());
    if (pin.status !== 0) throw new StepError(`step 2: could not install ${SDK_NAME}@${sdkVersion}:\n${pin.stdout}${pin.stderr}`);
    installed = readInstalledVersion(demo);
  }
  if (installed !== sdkVersion) fail(`installed ${SDK_NAME} is ${installed}, expected ${sdkVersion}`);
  else log(`installed ${SDK_NAME}@${installed} matches the resolved version`);
  return demo;
}

/** Step 3: the generated project's own tests and type check. */
function checkProject(demo: string): void {
  for (const script of ['test', 'typecheck']) {
    const res = run('npm', ['run', script], demo, cleanEnv());
    if (res.status !== 0) fail(`demo: npm run ${script} failed:\n${res.stdout}${res.stderr}`);
    else log(`demo: npm run ${script}: ok`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

async function waitForHealth(base: string, child: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + STUDIO_TIMEOUT_MS;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(`${base}/health`)).status === 200) return true;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  return false;
}

/** Step 5: `lousho studio` from the installed package (R1a). */
async function checkStudio(demo: string, version: string): Promise<void> {
  if (compareVersions(version, STUDIO_FIXED_IN) < 0) {
    log(`SKIP studio: ${version} < ${STUDIO_FIXED_IN} (this release predates the fix for running lousho studio outside the SDK repository; this is not a pass)`);
    return;
  }
  const port = await freePort();
  const bin = path.join(demo, ...SDK_DIR, 'bin', 'lousho.js');
  let output = '';
  const child = spawn(process.execPath, [bin, 'studio', '--port', String(port)], { cwd: demo, env: cleanEnv(), detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    if (!(await waitForHealth(base, child))) return fail(`lousho studio: GET /health did not answer 200 within ${STUDIO_TIMEOUT_MS / 1000}s:\n${output.slice(-2000)}`);
    log(`lousho studio: GET /health 200 on port ${port}`);
    const html = await (await fetch(`${base}/`)).text();
    if (!html.includes('id="root"')) fail('lousho studio: GET / did not return HTML containing id="root"');
    else log('lousho studio: GET / serves the UI (id="root")');
  } finally {
    killTree(child);
  }
}

/** Step 6: one real turn through OpenRouter. The key reaches the child only through its environment. */
function checkLive(demo: string): void {
  const file = path.join(demo, 'live-turn.mjs');
  fs.writeFileSync(
    file,
    [
      `import { createAgent } from '${SDK_NAME}';`,
      `const agent = createAgent({ model: 'openrouter/openai/gpt-4o-mini', instructions: 'Reply with one word.', maxSteps: 1 });`,
      `const result = await agent.send('Say ok.');`,
      `const tokens = result.usage && result.usage.totalTokens;`,
      `if (!result.text || !(tokens > 0)) throw new Error('empty reply or no usage');`,
      `console.log('LIVE_OK ' + JSON.stringify({ text: result.text, totalTokens: tokens }));`,
    ].join('\n') + '\n'
  );
  const res = run(process.execPath, [file], demo);
  const line = res.stdout.split('\n').find((l) => l.startsWith('LIVE_OK '));
  if (!line) fail(`live turn failed:\n${(res.stdout + res.stderr).slice(-1500)}`);
  else log(`live turn through OpenRouter: ${line.slice(8)}`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.live && !process.env.OPENROUTER_API_KEY) throw new StepError('--live needs OPENROUTER_API_KEY in the environment (it is never printed)');
  log(`node ${process.version}, ${process.platform}, SDK version spec "${opts.version}"`);
  const sdk = await npmView(`${SDK_NAME}@${opts.version}`);
  const creator = await npmView(`${CREATE_NAME}@latest`);
  describe(SDK_NAME, sdk);
  describe(CREATE_NAME, creator);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-registry-smoke-'));
  log(`temp dir ${base}`);
  try {
    const demo = scaffold(base, creator.version, sdk.version);
    checkProject(demo);
    checkBin(rep, demo);
    checkModuleLoads(rep, demo, path.join(demo, ...SDK_DIR));
    await checkStudio(demo, sdk.version);
    if (opts.live) checkLive(demo);
  } finally {
    if (opts.keep) log(`kept ${base}`);
    else fs.rmSync(base, { recursive: true, force: true });
  }
}

main()
  .catch((err: unknown) => {
    rep.failures.push(err instanceof StepError ? err.message : `unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
  })
  .finally(() => {
    if (rep.failures.length) {
      console.error(`\n[registry-smoke] ${rep.failures.length} failure(s):\n- ${rep.failures.join('\n- ')}`);
      process.exit(1);
    }
    log('all checks passed');
    process.exit(0);
  });
