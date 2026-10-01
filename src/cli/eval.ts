/**
 * `loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge]`
 * - run eval files under vitest and report the results (LOU-D8).
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
import { RESULTS_ENV, TAGS_ENV } from '../evals/recorder';
import { failsRun, parseResults, renderJson, renderJunit, renderTable } from './evalReport';

const USAGE =
  'Usage: loushy eval [globs...] [--tag t] [--junit path] [--json path] [--strict] [--judge] [--config vitest.config.ts]';

/** Parsed `loushy eval` arguments. */
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
}

const VALUE_FLAGS = new Set(['tag', 'junit', 'json', 'config']);
const BOOLEAN_FLAGS = new Set(['strict', 'judge']);

/** Parses `loushy eval` arguments; throws an Error that says how to fix a bad invocation. */
export function parseEvalArgs(rest: string[]): EvalCliArgs {
  const args: EvalCliArgs = { globs: [], tags: [], strict: false, judge: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      args.globs.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.has(name)) {
      args[name as 'strict' | 'judge'] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`loushy eval: unknown option '--${name}'. ${USAGE}`);
    const value = inline ?? rest[++i];
    if (!value || value.startsWith('--')) throw new Error(`loushy eval: --${name} needs a value. ${USAGE}`);
    if (name === 'tag') args.tags.push(...value.split(',').filter(Boolean));
    else args[name as 'junit' | 'json' | 'config'] = value;
  }
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
export function buildVitestConfig(args: Pick<EvalCliArgs, 'globs' | 'judge'>): string {
  const defaults = args.judge ? ['**/*.judge.eval.{ts,mts,js,mjs}'] : ['**/*.eval.{ts,mts,js,mjs}'];
  const exclude = ['**/node_modules/**', '**/dist/**', ...(args.judge ? [] : ['**/*.judge.eval.*'])];
  const test = {
    globals: true,
    environment: 'node',
    include: args.globs.length > 0 ? args.globs : defaults,
    exclude,
    env: args.judge ? { LOUSHY_ALLOW_LLM_JUDGE: '1' } : {},
  };
  return `export default ${JSON.stringify({ test }, null, 2)};\n`;
}

function writeReport(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content);
}

interface VitestInvocation {
  args: string[];
  env: NodeJS.ProcessEnv;
  resultsFile: string;
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
  if (!config) {
    config = path.join(workDir, 'vitest.eval.config.mjs');
    fs.writeFileSync(config, buildVitestConfig({ ...args, globs }));
  }
  // With the user's own config, globs narrow its files as vitest filters.
  const filters = args.config ? globs : [];
  return {
    args: ['run', '--config', config, '--root', cwd, ...filters],
    env: {
      ...withoutVitestVars(process.env),
      [RESULTS_ENV]: resultsFile,
      [TAGS_ENV]: args.tags.join(','),
      ...(args.judge ? { LOUSHY_ALLOW_LLM_JUDGE: '1' } : {}),
    },
    resultsFile,
  };
}

async function runAndReport(args: EvalCliArgs, deps: Required<EvalDeps>, vitestBin: string): Promise<number> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loushy-eval-'));
  try {
    const invocation = prepareInvocation(args, deps.cwd, workDir);
    const vitestCode = await deps.spawnVitest(vitestBin, invocation.args, invocation.env);
    const results = parseResults(fs.readFileSync(invocation.resultsFile, 'utf8'));
    deps.log(results.length > 0 ? `\n${renderTable(results, args.strict)}` : '\nloushy eval: no eval results were recorded.');
    if (args.junit) writeReport(args.junit, renderJunit(results, args.strict));
    if (args.json) writeReport(args.json, renderJson(results, args.strict));
    // A non-zero vitest code with no recorded failure (a file that failed to
    // load, an ordinary test failing) must not read as success.
    return results.some((r) => failsRun(r, args.strict)) || vitestCode !== 0 ? 1 : 0;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * CLI entry point. Resolves with the exit code: 0 all good, 1 a gate failure
 * (or soft failure with `--strict`, or vitest itself failing), 2 the command
 * could not run (bad arguments, vitest missing).
 */
export async function runEval(rest: string[], deps: EvalDeps = {}): Promise<number> {
  const resolved: Required<EvalDeps> = {
    resolveVitest: deps.resolveVitest ?? resolveVitestBin,
    spawnVitest: deps.spawnVitest ?? createVitestSpawner(),
    cwd: deps.cwd ?? process.cwd(),
    log: deps.log ?? ((message) => console.log(message)),
  };
  try {
    const args = parseEvalArgs(rest);
    const vitestBin = resolved.resolveVitest(resolved.cwd);
    if (!vitestBin) {
      console.error('loushy eval: vitest is not installed in this project. Install it with:\n  npm install --save-dev vitest');
      return 2;
    }
    return await runAndReport(args, resolved, vitestBin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
