import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { SqlDatabase } from 'lousho/improve';
import { renderLoopReport, type LoopRowLike } from './armSummary';
import { spawnCollector, type Collector } from './improve-cli/record';
import { AGENT_MODEL, assertSynthetic, EDITOR_MODEL, LOOP_PREFIX, syntheticOnly, type LoopEnv } from './loopRuntime';
import { runAttempt, SCENARIOS, type LoopRow, type Scenario } from './loopScenarios';

export interface LoopArgs {
  live: boolean;
  scenarios: Scenario[];
  offline: string[];
  attempts?: number;
  out: string;
  report: boolean;
  intervalMs: number;
  gapMs: number;
  agentModel: string;
  editorModel: string;
}

function count(flag: string, text: string | undefined, min: number): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text) || Number(text) < min) throw new Error(`${flag} must be a whole number of at least ${min}, not '${text}'.`);
  return Number(text);
}

function scenariosOf(text: string): Scenario[] {
  if (text === 'all') return [...SCENARIOS];
  if (text === '') return [];
  return text.split(',').map((id) => {
    const found = SCENARIOS.find((scenario) => scenario.id === id.trim());
    if (!found) throw new Error(`--scenarios: unknown scenario '${id}'. Scenarios: all, ${SCENARIOS.map((scenario) => scenario.id).join(', ')}.`);
    return found;
  });
}

export function parseLoopArgs(argv: string[]): LoopArgs {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      live: { type: 'boolean', default: false },
      scenarios: { type: 'string', default: 'all' },
      'offline-scenarios': { type: 'string', default: '' },
      attempts: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'boolean', default: false },
      'interval-ms': { type: 'string', default: '1000' },
      'gap-ms': { type: 'string', default: '0' },
      'agent-model': { type: 'string', default: AGENT_MODEL },
      'editor-model': { type: 'string', default: EDITOR_MODEL },
    },
  });
  if (values.out === undefined) throw new Error('--out <file.jsonl> is required; the observe db and agent directories go beside it, and a rerun resumes from it.');
  const attempts = count('--attempts', values.attempts, 1);
  return {
    live: values.live,
    scenarios: scenariosOf(values.scenarios),
    offline: scenariosOf(values['offline-scenarios']).map((scenario) => scenario.id),
    ...(attempts !== undefined && { attempts }),
    out: path.resolve(values.out),
    report: values.report,
    intervalMs: count('--interval-ms', values['interval-ms'], 10) as number,
    gapMs: count('--gap-ms', values['gap-ms'], 0) as number,
    agentModel: values['agent-model'].replace(/^openrouter\//, ''),
    editorModel: values['editor-model'].replace(/^openrouter\//, ''),
  };
}

function readRows(file: string): LoopRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LoopRow);
}

export function plannedAttempts(args: Pick<LoopArgs, 'scenarios' | 'attempts' | 'live'>, done: readonly Pick<LoopRowLike, 'scenario' | 'attempt' | 'status' | 'run'>[]): { scenario: Scenario; attempt: number }[] {
  const run = args.live ? 'live' : 'offline';
  const finished = new Set(done.filter((row) => row.status !== 'error' && row.run === run).map((row) => `${row.scenario}#${row.attempt}`));
  return args.scenarios.flatMap((scenario) => Array.from({ length: args.attempts ?? scenario.attempts }, (_, attempt) => ({ scenario, attempt })).filter((planned) => !finished.has(`${scenario.id}#${planned.attempt}`)));
}

function openDb(file: string): SqlDatabase {
  const sqlite = process.getBuiltinModule('node:sqlite') as { DatabaseSync: new (file: string) => SqlDatabase };
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

async function runLoop(args: LoopArgs, log: (line: string) => void): Promise<void> {
  if (args.live && !process.env.OPENROUTER_API_KEY) throw new Error('Set OPENROUTER_API_KEY for --live.');
  process.env.LOUSHO_OBSERVE = '0';
  const planned = plannedAttempts(args, readRows(args.out));
  const dbFile = `${args.out.replace(/\.jsonl$/, '')}.db`;
  const collector: Collector = await spawnCollector(dbFile);
  const db = openDb(dbFile);
  const env: LoopEnv = {
    live: args.live,
    run: args.live ? 'live' : 'offline',
    db,
    collectorUrl: collector.url,
    workDir: `${args.out.replace(/\.jsonl$/, '')}.work`,
    runId: randomBytes(3).toString('hex'),
    intervalMs: args.intervalMs,
    agentModel: args.agentModel,
    editorModel: args.editorModel,
    gapMs: args.gapMs,
    editorHooks: [syntheticOnly(db, LOOP_PREFIX)],
  };
  log(`${planned.length} attempts to run, ${args.live ? `live: agent ${args.agentModel}, editor ${args.editorModel}, on synthetic fixtures only` : 'offline'}.`);
  try {
    for (const { scenario, attempt } of planned) {
      assertSynthetic(db, LOOP_PREFIX);
      const row = await runAttempt({ ...env, live: env.live && !args.offline.includes(scenario.id) }, scenario, attempt);
      appendFileSync(args.out, `${JSON.stringify(row)}\n`);
      log(`${scenario.id} #${attempt}: ${row.passed ? 'passed' : 'FAILED'} (${row.outcome}) ${row.requests} requests, ${row.tokens} tokens${row.error ? `, error: ${row.error}` : ''}`);
    }
  } finally {
    db.close();
    await collector.stop();
  }
}

async function main(): Promise<void> {
  const args = parseLoopArgs(process.argv.slice(2));
  if (!args.report) await runLoop(args, (line) => console.log(line));
  console.log(renderLoopReport(readRows(args.out)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
