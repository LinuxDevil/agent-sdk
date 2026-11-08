import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createAgent, type AgentHook, type LLMProvider } from 'lousho';
import { observeExporter, type ObserveReporter, type TraceExporter } from 'lousho/traces';
import agent from './agent.ts';
import check from './check.ts';
import { DEFAULT_MODEL, refuseUnsharedModel } from './modelRule.ts';
import { codingTasks, latestProjectRun } from './projectRuns.ts';

export interface RecordOptions {
  db: string;
  model: string;
  cases: string[];
  repeats: number;
  gapMs: number;
}

export interface Collector {
  url: string;
  stop(): Promise<void>;
}

export interface RecordDeps {
  startCollector(db: string): Promise<Collector>;
  provider?: LLMProvider;
  log(line: string): void;
}

export interface RecordedRun {
  caseId: string;
  repeat: number;
  traceId?: string;
  passed: boolean | null;
  error?: string;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOUSHO_BIN = path.resolve(HERE, '../../../bin/lousho.js');
const SCORE_NAME = 'hidden-tests';
const SCORE_ATTEMPTS = 3;

function positiveInteger(flag: string, text: string, min: number): number {
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < min) throw new Error(`${flag} must be a whole number of at least ${min}, not '${text}'.`);
  return value;
}

function caseIds(text: string | undefined): string[] {
  if (text === undefined || text === 'all') return codingTasks.map((task) => task.id);
  const ids = text.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.find((id) => !codingTasks.some((task) => task.id === id));
  if (unknown !== undefined) throw new Error(`--cases: unknown case '${unknown}'. Cases: ${codingTasks.map((task) => task.id).join(', ')}.`);
  return ids;
}

export function parseRecordArgs(argv: string[]): RecordOptions {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' }, model: { type: 'string', default: DEFAULT_MODEL }, cases: { type: 'string' }, repeats: { type: 'string', default: '1' }, 'gap-ms': { type: 'string', default: '0' } },
  });
  if (values.db === undefined) throw new Error('--db <path> is required: the observe database to record into. This script never writes to ~/.lousho.');
  const model = values.model.replace(/^openrouter\//, '');
  refuseUnsharedModel('--model', model);
  return { db: path.resolve(values.db), model, cases: caseIds(values.cases), repeats: positiveInteger('--repeats', values.repeats, 1), gapMs: positiveInteger('--gap-ms', values['gap-ms'], 0) };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port.'))));
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function servedDb(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/health`);
    return res.ok ? ((await res.json()) as { db?: string }).db : undefined;
  } catch {
    return undefined;
  }
}

async function waitForHealth(url: string, db: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`lousho observe start exited with code ${child.exitCode}.`);
    const served = await servedDb(url);
    if (served !== undefined && served !== db) throw new Error(`${url} serves ${served}, not ${db}.`);
    if (served === db) return;
    await sleep(100);
  }
  throw new Error(`lousho observe start did not answer at ${url}.`);
}

function pidFileOf(db: string): string {
  return path.join(path.dirname(db), `${path.basename(db).replace(/\.db$/i, '')}.pid`);
}

async function stopChild(child: ChildProcess, db: string): Promise<void> {
  if (child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(killer);
  }
  rmSync(pidFileOf(db), { force: true });
}

export async function spawnCollector(db: string): Promise<Collector> {
  if (!existsSync(path.resolve(HERE, '../../../dist/cli/observe.mjs'))) throw new Error('Run npm run build first: this script starts the built lousho observe daemon.');
  const port = await freePort();
  const child = spawn(process.execPath, [LOUSHO_BIN, 'observe', 'start', '--db', db, '--port', String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, db, child);
  } catch (error) {
    await stopChild(child, db);
    throw error;
  }
  return { url, stop: () => stopChild(child, db) };
}

function rootTracking(reporter: ObserveReporter): { exporter: TraceExporter; lastRoot(): string | undefined } {
  let root: string | undefined;
  return {
    exporter: {
      onSpanStart(span) {
        if (span.parentId === undefined) root = span.id;
        reporter.onSpanStart(span);
      },
      onSpanEnd: (span) => reporter.onSpanEnd(span),
    },
    lastRoot: () => root,
  };
}

const throttle = (gapMs: number): AgentHook[] => (gapMs > 0 ? [{ name: 'throttle', preGenerate: () => new Promise<void>((resolve) => setTimeout(resolve, gapMs)) }] : []);

async function postScore(url: string, traceId: string, passed: boolean, comment: string | undefined): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/api/v1/scores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trace_id: traceId, name: SCORE_NAME, value: passed ? 1 : 0, ...(comment && { comment }) }),
    });
    return res.ok ? undefined : `HTTP ${res.status} ${await res.text()}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function scoreTrace(context: { collector: Collector; reporter: ObserveReporter }, traceId: string, passed: boolean, comment: string | undefined): Promise<string | undefined> {
  let problem: string | undefined;
  for (let attempt = 0; attempt < SCORE_ATTEMPTS; attempt += 1) {
    await context.reporter.flush();
    problem = await postScore(context.collector.url, traceId, passed, comment);
    if (problem === undefined) return undefined;
    await sleep(500 * (attempt + 1));
  }
  return `could not score trace ${traceId}: ${problem}`;
}

async function answerOf(input: string, options: RecordOptions, deps: RecordDeps, exporter: TraceExporter): Promise<{ answer: string; error?: string }> {
  const run = createAgent({ ...agent, ...(deps.provider ? { model: undefined, provider: deps.provider } : { model: `openrouter/${options.model}` }), hooks: [...agent.hooks, ...throttle(options.gapMs)], exporter, captureContent: true });
  try {
    return { answer: (await run.send(input)).text ?? '' };
  } catch (error) {
    return { answer: '', error: error instanceof Error ? error.message : String(error) };
  } finally {
    await run.close().catch(() => undefined);
  }
}

function failureOf(input: string): string | undefined {
  return latestProjectRun()?.project.tasks.find((task) => task.input === input)?.failure?.();
}

async function recordOne(caseId: string, repeat: number, context: { options: RecordOptions; deps: RecordDeps; collector: Collector; reporter: ObserveReporter }): Promise<RecordedRun> {
  const { options, deps, collector, reporter } = context;
  const input = codingTasks.find((task) => task.id === caseId)?.input ?? '';
  const tracking = rootTracking(reporter);
  const { answer, error } = await answerOf(input, options, deps, tracking.exporter);
  const traceId = tracking.lastRoot();
  const verdict = error === undefined ? check(input, answer) : null;
  await reporter.flush();
  const scoreError = traceId !== undefined && verdict !== null ? await scoreTrace({ collector, reporter }, traceId, verdict, verdict ? undefined : failureOf(input)) : undefined;
  const passed = scoreError === undefined ? verdict : null;
  const problem = error ?? scoreError;
  return { caseId, repeat, ...(traceId !== undefined && { traceId }), passed, ...(problem !== undefined && { error: problem }) };
}

function describe(run: RecordedRun): string {
  const verdict = run.error !== undefined ? `error: ${run.error}` : run.passed === null ? 'unscored' : run.passed ? 'passed' : 'failed';
  return `${run.caseId} #${run.repeat + 1}: ${verdict}${run.traceId ? ` (trace ${run.traceId})` : ''}`;
}

async function withoutEnvObserve<T>(work: () => Promise<T>): Promise<T> {
  const saved = process.env.LOUSHO_OBSERVE;
  process.env.LOUSHO_OBSERVE = '0';
  try {
    return await work();
  } finally {
    if (saved === undefined) delete process.env.LOUSHO_OBSERVE;
    else process.env.LOUSHO_OBSERVE = saved;
  }
}

export async function record(options: RecordOptions, deps: RecordDeps): Promise<RecordedRun[]> {
  mkdirSync(path.dirname(options.db), { recursive: true });
  const collector = await deps.startCollector(options.db);
  const runs: RecordedRun[] = [];
  let reporter: ObserveReporter | undefined;
  try {
    reporter = observeExporter({ url: collector.url, agentName: agent.name, cwd: path.dirname(options.db), registerExitHooks: false });
    const context = { options, deps, collector, reporter };
    await withoutEnvObserve(async () => {
      for (let repeat = 0; repeat < options.repeats; repeat += 1) {
        for (const caseId of options.cases) {
          const run = await recordOne(caseId, repeat, context);
          deps.log(describe(run));
          runs.push(run);
        }
      }
    });
  } finally {
    await reporter?.close();
    await collector.stop();
  }
  return runs;
}

export function summary(runs: readonly RecordedRun[], db: string): string {
  const failed = runs.filter((run) => run.passed === false).length;
  const passed = runs.filter((run) => run.passed === true).length;
  return `Recorded ${runs.length} run(s) into ${db}: ${passed} passed, ${failed} failed, ${runs.length - passed - failed} unscored.`;
}

async function main(): Promise<void> {
  const options = parseRecordArgs(process.argv.slice(2));
  if (!process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY: record.ts runs the agent on a live model.');
  const runs = await record(options, { startCollector: spawnCollector, log: (line) => console.log(line) });
  console.log(summary(runs, options.db));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
