/**
 * `lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]`
 * - run eval files under vitest and report the results.
 * `--record` / `--replay` / `--drift` run every case through a cassette (src/evals/cassettes.ts).
 * `--url <base> [--token t]` runs the cases against a deployed agent instead (src/evals/remoteTarget.ts).
 *
 * vitest is the user's dependency, not ours: it is resolved from the
 * project's own node_modules and the command exits 2 with the install
 * command when it is missing. Results travel back through a JSON-lines
 * file (see src/evals/recorder.ts for why that beats a custom reporter).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CASSETTES_ENV, CONFIG_ENV, DRIFT_DIR_ENV, driftCassettePath } from '../evals/cassettes';
import { diffTrajectories, trajectoryOf, type Trajectory } from '../evals/drift';
import type { EvalResult } from '../evals/evalResult';
import { RESULTS_ENV, TAGS_ENV } from '../evals/recorder';
import { REMOTE_TOKEN_ENV, REMOTE_URL_ENV } from '../evals/remoteTarget';
import { SDKError } from '../execution/errors';
import { readCassette } from '../testing/cassette';
import { USAGE_EXIT_CODE, parseCommand, stringValue, usageError, type CommandSpec } from './args';
import { failsRun, parseResults, renderDriftTable, renderJson, renderJunit, renderTable, unreportedFailures, vitestError, type DriftRow } from './evalReport';

const USAGE =
  'Usage: lousho eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--record | --replay | --drift [--drift-usage]] [--url <base> [--token <bearer>]] [--config vitest.config.ts] [--timeout <ms>]';

/** Parsed `lousho eval` arguments. */
export interface EvalCliArgs {
  /** Eval files to run; empty means every `*.eval.ts` (or `*.judge.eval.ts` with `--judge`). */
  globs: string[];
  /** Only run evals with one of these `tags`. */
  tags: string[];
  junit?: string;
  json?: string;
  /** Soft assertion failures fail the run. */
  strict: boolean;
  /** Run `*.judge.eval.ts` files (real judge providers allowed) instead of the normal ones. */
  judge: boolean;
  /** Use this vitest config instead of the generated one. */
  config?: string;
  /**
   * Per-case time limit in ms (0 = none). Without it the generated config
   * allows {@link LIVE_TEST_TIMEOUT_MS} except under `--replay`, and a `--config`
   * keeps its own `testTimeout`. `defineEval({ timeoutMs })` wins over both.
   */
  timeout?: number;
  /** Run the cases against the deployed agent at this base URL instead of in-process. */
  url?: string;
  /** Bearer token for `url`; defaults to the `LOUSHO_EVAL_TOKEN` environment variable. Never printed. */
  token?: string;
  /** Record a cassette per case from the real provider. */
  record?: boolean;
  /** Replay every case from its cassette; a missing cassette fails the case. */
  replay?: boolean;
  /** Re-record into a temp dir and report how each case's trajectory drifted from its cassette. */
  drift?: boolean;
  /** With `drift`: compare token usage too. */
  driftUsage?: boolean;
  /** `-h` / `--help` was given: print the usage, run nothing. */
  help?: boolean;
}

const HELP = `${USAGE}

Runs *.eval.ts files (defineEval()) under the vitest installed in your project and prints one row
per case, with totals and the gate and soft failures. Exit code 1 on a gate failure, a vitest
failure or when no case ran; 2 for a usage error.

Options:
  globs...              eval files to run (default **/*.eval.ts, or **/*.judge.eval.ts with --judge)
  --tag t               only cases with this tag (repeat, or comma-separate, for several)
  --junit path          write a JUnit XML report
  --json path           write the summary and every result as JSON
  --strict              soft failures fail the run too
  --judge               run the *.judge.eval.ts files (llmJudge(); they call a real model)
  --record              run against the real provider and write one cassette per case
  --replay              run every case from its cassette, offline; a missing cassette fails the case
  --drift               re-record into a temp directory and report how each trajectory changed
  --drift-usage         with --drift: compare token usage too
  --url <base>          run the cases against the agent deployed at <base> instead of in-process
  --token <bearer>      with --url: the bearer token (default LOUSHO_EVAL_TOKEN)
  --config <file>       use your own vitest config instead of the generated one
  --timeout <ms>        time limit per case (0 = none; live runs default to 10 minutes)
  -h, --help            show this help

See docs/evals.md.`;

const SPEC: CommandSpec = {
  command: 'eval',
  usage: USAGE,
  positionals: Infinity,
  options: {
    tag: { type: 'string', multiple: true },
    junit: { type: 'string' },
    json: { type: 'string' },
    config: { type: 'string' },
    timeout: { type: 'string' },
    url: { type: 'string' },
    token: { type: 'string' },
    strict: { type: 'boolean' },
    judge: { type: 'boolean' },
    record: { type: 'boolean' },
    replay: { type: 'boolean' },
    drift: { type: 'boolean' },
    'drift-usage': { type: 'boolean' },
  },
};

/**
 * The default per-case limit for runs that may call a real model (live,
 * `--record`, `--drift`, CI auto): vitest's own 5 s default fails nearly every
 * agent run on a real model. `--replay` keeps vitest's default.
 */
export const LIVE_TEST_TIMEOUT_MS = 10 * 60_000;

function parseTimeout(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms < 0) throw usageError(SPEC, `--timeout must be a whole number of milliseconds (0 = no limit), got '${value}'.`);
  return ms;
}

function assertOneCassetteMode(args: EvalCliArgs): void {
  if (args.driftUsage) args.drift = true;
  if (args.url && (args.record || args.replay || args.drift)) {
    throw new SDKError(
      'lousho eval: --url cannot be combined with --record, --replay or --drift: cassettes record a provider in-process, and a deployed agent runs its own.',
      'LOUSHO_CONFIG_CONFLICTING_OPTIONS'
    );
  }
  if ([args.record, args.replay, args.drift].filter(Boolean).length > 1) {
    throw usageError(SPEC, 'use only one of --record, --replay and --drift.');
  }
}

/** Parses `lousho eval` arguments; throws a `LOUSHO_CONFIG_INVALID` error (usage as the hint) for a bad invocation. */
export function parseEvalArgs(rest: string[]): EvalCliArgs {
  const { values: v, positionals, help } = parseCommand(SPEC, rest);
  if (help) return { globs: [], tags: [], strict: false, judge: false, help };
  const args: EvalCliArgs = {
    globs: positionals,
    tags: ((v.tag as string[] | undefined) ?? []).flatMap((tag) => tag.split(',')).filter(Boolean),
    strict: v.strict === true,
    judge: v.judge === true,
    junit: stringValue(v.junit),
    json: stringValue(v.json),
    config: stringValue(v.config),
    timeout: parseTimeout(stringValue(v.timeout)),
    url: stringValue(v.url),
    token: stringValue(v.token),
    record: v.record === true || undefined,
    replay: v.replay === true || undefined,
    drift: v.drift === true || undefined,
    driftUsage: v['drift-usage'] === true || undefined,
  };
  assertOneCassetteMode(args);
  return args;
}

/** Runs vitest and resolves with its exit code. Injectable so tests need not spawn a process. */
export type VitestSpawner = (vitestBin: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>;

/** Test seams of {@link runEval}. */
export interface EvalDeps {
  /** Path to the project's vitest executable, or undefined when not installed. */
  resolveVitest?: (cwd: string) => string | undefined;
  spawnVitest?: VitestSpawner;
  cwd?: string;
  log?: (message: string) => void;
}

/** Finds `node_modules/vitest`'s CLI script from `cwd`, or undefined when vitest is not installed. */
export function resolveVitestBin(cwd: string): string | undefined {
  try {
    const pkgPath = createRequire(path.join(cwd, 'noop.js')).resolve('vitest/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vitest;
    return bin ? path.join(path.dirname(pkgPath), bin) : undefined;
  } catch {
    return undefined;
  }
}

/** Spawns vitest as a child process; `stdio: 'ignore'` discards its console output. */
export function createVitestSpawner(stdio: 'inherit' | 'ignore' = 'inherit'): VitestSpawner {
  return (bin, args, env) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [bin, ...args], { stdio, env });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
}

/**
 * The generated vitest config: a plain object (no imports, so it loads from
 * a temp directory). Normal runs never include `*.judge.eval.*`; judge runs
 * only include them and set the env var llmJudge() requires.
 */
export function buildVitestConfig(
  args: Pick<EvalCliArgs, 'globs' | 'judge' | 'replay' | 'timeout'>,
  vitestJson?: string
): string {
  const defaults = args.judge ? ['**/*.judge.eval.{ts,mts,js,mjs}'] : ['**/*.eval.{ts,mts,js,mjs}'];
  const exclude = ['**/node_modules/**', '**/dist/**', ...(args.judge ? [] : ['**/*.judge.eval.*'])];
  const test = {
    globals: true,
    environment: 'node',
    include: args.globs.length > 0 ? args.globs : defaults,
    exclude,
    env: args.judge ? { LOUSHO_ALLOW_LLM_JUDGE: '1' } : {},
    ...testTimeout(args),
    // vitest's own JSON report names the files that failed without an eval result (a load error).
    ...(vitestJson ? { reporters: ['default', 'json'], outputFile: { json: vitestJson } } : {}),
  };
  return `export default ${JSON.stringify({ test }, null, 2)};\n`;
}

function testTimeout(args: Pick<EvalCliArgs, 'replay' | 'timeout'>): { testTimeout?: number } {
  if (args.timeout !== undefined) return { testTimeout: args.timeout };
  return args.replay ? {} : { testTimeout: LIVE_TEST_TIMEOUT_MS };
}

function writeReport(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

interface VitestInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  resultsFile: string;
  /** vitest's JSON report (generated config only). */
  vitestJson?: string;
}

/** Drops VITEST_* variables, so running inside another vitest run (a test, an npm script) cannot confuse the child. */
function withoutVitestVars(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('VITEST')));
}

/** vitest matches globs relative to the root with `/` separators; absolute and Windows-style paths are converted. */
export function toRootRelativeGlob(glob: string, cwd: string): string {
  const relative = path.isAbsolute(glob) ? path.relative(cwd, glob) : glob;
  return relative.split(path.sep).join('/');
}

function prepareInvocation(args: EvalCliArgs, cwd: string, workDir: string): VitestInvocation {
  const resultsFile = path.join(workDir, 'results.jsonl');
  fs.writeFileSync(resultsFile, '');
  const globs = args.globs.map((glob) => toRootRelativeGlob(glob, cwd));
  let config = args.config;
  let vitestJson: string | undefined;
  if (!config) {
    config = path.join(workDir, 'vitest.eval.config.mjs');
    vitestJson = path.join(workDir, 'vitest.json');
    fs.writeFileSync(config, buildVitestConfig({ ...args, globs }, vitestJson));
  }
  // With the user's own config, globs narrow its files as vitest filters; its
  // own testTimeout stands unless --timeout was given.
  const filters = args.config ? globs : [];
  const timeout = args.config && args.timeout !== undefined ? [`--testTimeout=${args.timeout}`] : [];
  return {
    args: ['run', '--config', config, '--root', cwd, ...timeout, ...filters],
    env: {
      ...withoutVitestVars(process.env),
      [RESULTS_ENV]: resultsFile,
      [TAGS_ENV]: args.tags.join(','),
      ...(args.judge ? { LOUSHO_ALLOW_LLM_JUDGE: '1' } : {}),
      ...(args.token ? { [REMOTE_TOKEN_ENV]: args.token } : {}),
      [CASSETTES_ENV]: cassetteMode(args),
      [REMOTE_URL_ENV]: args.url ?? '',
      [DRIFT_DIR_ENV]: args.drift ? path.join(workDir, 'drift') : '',
      [CONFIG_ENV]: args.config ? toRootRelativeGlob(args.config, cwd) : '',
    },
    resultsFile,
    vitestJson,
  };
}

/** `--record`/`--drift` record, `--replay` replays; under CI a case with a cassette replays. '' runs live. */
function cassetteMode(args: EvalCliArgs): string {
  if (args.url) return '';
  if (args.record || args.drift) return 'record';
  if (args.replay) return 'replay';
  const ci = process.env.CI;
  return ci && ci !== 'false' && ci !== '0' ? 'auto' : '';
}

function loadTrajectory(file: string): Trajectory | undefined {
  return fs.existsSync(file) ? trajectoryOf(readCassette(file)) : undefined;
}

/** How the fresh recording of `committed` differs from it. */
function cassetteDrift(committed: string, driftDir: string, usage: boolean | undefined): DriftRow['entry'][] {
  const before = loadTrajectory(committed);
  const after = loadTrajectory(driftCassettePath(driftDir, committed));
  if (before && after) return diffTrajectories(before, after, { usage });
  return [{ field: 'cassette', committed: before ? 'present' : 'missing', current: after ? 'recorded' : 'not recorded' }];
}

/**
 * Compares every re-recorded cassette with the committed one and adds a
 * `drift` assertion (soft, or gate with `--strict`) to each drifted case.
 */
function applyDrift(results: EvalResult[], args: EvalCliArgs, driftDir: string): DriftRow[] {
  const rows: DriftRow[] = [];
  for (const result of results) {
    for (const committed of result.cassettes ?? []) {
      const entries = cassetteDrift(committed, driftDir, args.driftUsage);
      if (entries.length === 0) continue;
      rows.push(...entries.map((entry) => ({ result, entry })));
      const message = `drift from ${path.basename(committed)}: ${entries.map((e) => `${e.field} ${e.committed} -> ${e.current}`).join('; ')}`;
      result.assertions.push({ name: 'drift', kind: args.strict ? 'gate' : 'soft', passed: false, score: 0, message });
      if (args.strict) result.passed = false;
    }
  }
  return rows;
}

function readVitestJson(file: string | undefined): unknown {
  if (!file || !fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * True when vitest found no test file: with the generated config it then exits 1
 * without writing its JSON report (a file that fails to load is still in the
 * report). Unknown (false) under the user's own config, which has no report.
 */
function ranNoFiles(vitestJson: string | undefined, report: unknown): boolean {
  if (!vitestJson) return false;
  if (report === undefined) return !fs.existsSync(vitestJson);
  const { testResults } = report as { testResults?: unknown };
  return Array.isArray(testResults) && testResults.length === 0;
}

function noFilesLooked(args: EvalCliArgs): string {
  if (args.globs.length > 0) return `nothing matches ${args.globs.join(', ')}`;
  return args.judge ? 'looked for **/*.judge.eval.{ts,mts,js,mjs}' : 'looked for **/*.eval.{ts,mts,js,mjs}';
}

async function runAndReport(args: EvalCliArgs, deps: Required<EvalDeps>, vitestBin: string): Promise<number> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lousho-eval-'));
  try {
    const invocation = prepareInvocation(args, deps.cwd, workDir);
    const vitestCode = await deps.spawnVitest(vitestBin, invocation.args, invocation.env);
    const results = parseResults(fs.readFileSync(invocation.resultsFile, 'utf8'));
    const vitestReport = readVitestJson(invocation.vitestJson);
    const noFiles = results.length === 0 && vitestCode !== 0 && ranNoFiles(invocation.vitestJson, vitestReport);
    if (noFiles) {
      const message = `no eval files found (${noFilesLooked(args)}). Name eval files *.eval.ts, or pass globs. If vitest printed an error above instead, fix that first.`;
      // The reports still record the failed run.
      results.push(vitestError('run', message));
      deps.log(`\nlousho eval: ${message}`);
    } else {
      results.push(...unreportedFailures(results, vitestReport, vitestCode, { cwd: deps.cwd, strict: args.strict }));
    }
    const drift = args.drift ? applyDrift(results, args, invocation.env[DRIFT_DIR_ENV] as string) : undefined;
    // Nothing recorded verifies nothing: like a glob that matches no file, it fails (a mistyped --tag skips every case).
    const nothingRan = !noFiles && results.length === 0;
    const skipped = args.tags.length > 0 ? ` (no eval case has the tag ${args.tags.join(' or ')})` : '';
    if (!noFiles) deps.log(results.length > 0 ? `\n${renderTable(results, args.strict)}` : `\nlousho eval: no eval results were recorded${skipped}.`);
    if (drift) deps.log(`\n${renderDriftTable(drift)}`);
    if (args.junit) writeReport(args.junit, renderJunit(results, args.strict));
    if (args.json) writeReport(args.json, renderJson(results, args.strict));
    // A non-zero vitest code with no recorded failure (a file that failed to
    // load, an ordinary test failing) must not read as success.
    return results.some((r) => failsRun(r, args.strict)) || vitestCode !== 0 || nothingRan ? 1 : 0;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * CLI entry point. Resolves with the exit code: 0 all good, 1 a gate failure
 * (or soft failure with `--strict`, vitest missing or failing, a report that
 * cannot be written), 2 a usage error (bad arguments).
 */
export async function runEval(rest: string[], deps: EvalDeps = {}): Promise<number> {
  const resolved: Required<EvalDeps> = {
    resolveVitest: deps.resolveVitest ?? resolveVitestBin,
    spawnVitest: deps.spawnVitest ?? createVitestSpawner(),
    cwd: deps.cwd ?? process.cwd(),
    log: deps.log ?? ((message) => console.log(message)),
  };
  let args: EvalCliArgs;
  try {
    args = parseEvalArgs(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return USAGE_EXIT_CODE;
  }
  if (args.help) {
    resolved.log(HELP);
    return 0;
  }
  try {
    const vitestBin = resolved.resolveVitest(resolved.cwd);
    if (!vitestBin) {
      console.error('lousho eval: vitest is not installed in this project. Install it with:\n  npm install --save-dev vitest');
      return 1;
    }
    return await runAndReport(args, resolved, vitestBin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
