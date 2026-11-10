import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgent } from 'lousho';
import { casesFromFailures, createShadowHook } from 'lousho/improve';
import { mockModel, type MockRequest, type MockStaticTurn } from 'lousho/testing';
import { runImprove } from '../../../src/cli/improve';
import { startObserveDaemon } from '../../../src/observe/daemon';
import { openDb } from '../../../src/observe/store';
import { FIXES } from '../codingAgent';
import agent from './agent';
import check from './check';
import { refuseUnsharedModels } from './modelRule';
import { codingTasks } from './projectRuns';
import { parseRecordArgs, record, spawnCollector, summary, type Collector } from './record';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HINT = 'Follow normal CSV quoting rules, including doubled quotes inside a quoted field.';
const inputOf = (id: string) => codingTasks.find((task) => task.id === id)?.input ?? '';

const writeFix = (id: string): MockStaticTurn => {
  const [file, content] = Object.entries(FIXES[id])[0];
  return { toolCalls: [{ name: 'write_file', args: { path: file, content } }] };
};

function codingModel(request: MockRequest): MockStaticTurn {
  if (request.messages.some((message) => message.role === 'tool')) return 'Done. The tests pass.';
  const seen = JSON.stringify(request.messages);
  if (seen.includes('test/pages.test.js')) return writeFix('page-count');
  if (seen.includes('test/csv.test.js') && seen.includes(HINT)) return writeFix('csv-quotes');
  return 'The code looks right to me, so I changed nothing.';
}

const model = () => mockModel([codingModel], { onExhausted: 'repeat-last' });

async function answer(id: string, hooks = agent.hooks): Promise<string> {
  const run = createAgent({ ...agent, model: undefined, provider: model(), hooks });
  try {
    return (await run.send(inputOf(id))).text ?? '';
  } finally {
    await run.close();
  }
}

let root: string;
let db: string;

const inProcessCollector = async (file: string): Promise<Collector> => {
  const daemon = await startObserveDaemon({ dbPath: file, port: 0, sweepIntervalMs: 0, retentionDays: 0 });
  return { url: `http://127.0.0.1:${daemon.port}`, stop: () => daemon.close() };
};

const recordInto = (file: string, cases: string[], repeats = 1) =>
  record({ db: file, model: 'qwen/qwen3.7-flash', cases, repeats, gapMs: 0 }, { startCollector: inProcessCollector, provider: model(), log: () => undefined });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-improve-cli-'));
  db = path.join(root, 'observe.db');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the check module', () => {
  it('passes a run that fixed its own case and fails one that did not', async () => {
    const pages = await answer('page-count');
    expect(check(inputOf('page-count'), pages)).toBe(true);
    const csv = await answer('csv-quotes');
    expect(check(inputOf('csv-quotes'), csv)).toEqual({ passed: false, failure: 'hidden' });
  });

  it('names the real hidden tests a run failed', async () => {
    const months = await answer('add-months');
    expect(check(inputOf('add-months'), months)).toEqual({ passed: false, failure: 'follows project conventions; the reported bug is fixed' });
  });

  it('leaves a run unscored when it is not the latest run of that case', async () => {
    await answer('page-count');
    expect(check(inputOf('csv-quotes'), 'Fixed.')).toBeNull();
  });

  it('leaves a run unscored when the project tools were simulated', async () => {
    await answer('page-count', [createShadowHook({ readOnly: [] }), ...agent.hooks]);
    expect(check(inputOf('page-count'), 'Fixed.')).toBeNull();
  });
});

describe('the model rule', () => {
  it('refuses a model that must never see captured traces', () => {
    expect(() => refuseUnsharedModels(['improve', '--editor', 'stealth/crouton-alpha'])).toThrow(/must never see captured traces/);
    expect(() => refuseUnsharedModels(['improve', '--model=openrouter/stealth/crouton-alpha'])).toThrow(/--model/);
    expect(() => parseRecordArgs(['--db', db, '--model', 'stealth/crouton-alpha'])).toThrow(/must never see captured traces/);
    expect(() => refuseUnsharedModels(['improve', '--model', 'openrouter/qwen/qwen3.7-flash'])).not.toThrow();
  });
});

describe('record.ts', () => {
  it('requires --db and reads the other flags', () => {
    expect(() => parseRecordArgs(['--cases', 'page-count'])).toThrow(/--db <path> is required/);
    expect(parseRecordArgs(['--db', db, '--cases', 'page-count,csv-quotes', '--repeats', '2', '--gap-ms', '500'])).toEqual({ db, model: 'qwen/qwen3.7-flash', cases: ['page-count', 'csv-quotes'], repeats: 2, gapMs: 500 });
    expect(parseRecordArgs(['--db', db]).cases).toHaveLength(codingTasks.length);
    expect(() => parseRecordArgs(['--db', db, '--cases', 'nope'])).toThrow(/unknown case 'nope'/);
    expect(() => parseRecordArgs(['--db', db, '--repeats', '0'])).toThrow(/--repeats/);
    expect(parseRecordArgs(['--db', db, '--model', 'openrouter/qwen/qwen3.7-flash']).model).toBe('qwen/qwen3.7-flash');
  });

  it('leaves a run unscored, and keeps recording, when its score cannot be written', async () => {
    const gone: Collector = { url: 'http://127.0.0.1:9', stop: async () => undefined };
    const runs = await record({ db, model: 'qwen/qwen3.7-flash', cases: ['page-count'], repeats: 1, gapMs: 0 }, { startCollector: async () => gone, provider: model(), log: () => undefined });
    expect(runs).toHaveLength(1);
    expect(runs[0].passed).toBeNull();
    expect(runs[0].error).toMatch(/could not score trace/);
  }, 20_000);

  it('records each run with its input and scores it, so failed runs become cases', async () => {
    const runs = await recordInto(db, ['page-count', 'csv-quotes'], 2);
    expect(runs.map(({ caseId, passed }) => [caseId, passed])).toEqual([
      ['page-count', true],
      ['csv-quotes', false],
      ['page-count', true],
      ['csv-quotes', false],
    ]);
    expect(summary(runs, db)).toBe(`Recorded 4 run(s) into ${db}: 2 passed, 2 failed, 0 unscored.`);
    const store = openDb(db);
    try {
      const failures = casesFromFailures(store);
      expect(failures.map((captured) => captured.traceId).sort()).toEqual(runs.filter((run) => run.passed === false).map((run) => run.traceId).sort());
      expect(failures.every((captured) => captured.input.includes('test/csv.test.js'))).toBe(true);
      const comments = store.prepare("SELECT value, comment FROM scores WHERE name = 'hidden-tests' ORDER BY value").all() as { value: number; comment: string | null }[];
      expect(comments.map((row) => row.value)).toEqual([0, 0, 1, 1]);
      expect(comments[0].comment).toBe('hidden');
    } finally {
      store.close();
    }
  });
});

function sink() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function fingerprint(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(dir, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
      })
  );
}

const BUILT_CLI = path.resolve(HERE, '../../../dist/cli/improve.mjs');

function runBuiltCli(args: string[]): { status: number | null; output: string } {
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const result = spawnSync(process.execPath, [path.resolve(HERE, '../../../bin/lousho.js'), 'improve', path.join(HERE, 'agent.ts'), '--check', path.join(HERE, 'check.ts'), '--db', db, ...args], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe.skipIf(!fs.existsSync(BUILT_CLI))('the built lousho CLI', () => {
  beforeEach(() => {
    openDb(db).close();
  });

  it('loads the agent and check modules with Node itself', () => {
    const { status, output } = runBuiltCli(['--agent', 'coding-agent']);
    expect(output).toContain('No failed runs with a recorded input match');
    expect(status).toBe(0);
  });

  it('records through the built lousho observe daemon and stops it', async () => {
    const runs = await record({ db, model: 'qwen/qwen3.7-flash', cases: ['csv-quotes'], repeats: 1, gapMs: 0 }, { startCollector: spawnCollector, provider: model(), log: () => undefined });
    expect(runs.map((run) => run.passed)).toEqual([false]);
    expect(fs.existsSync(path.join(root, 'observe.pid'))).toBe(false);
    const { output } = runBuiltCli(['--agent', 'coding-agent', '--max-tokens', '1']);
    expect(output).toContain('1 failed run(s) to learn from');
  }, 60_000);

  it('refuses an editor that must never see captured traces', () => {
    const { status, output } = runBuiltCli(['--editor', 'openrouter/stealth/crouton-alpha']);
    expect(output).toContain('must never see captured traces');
    expect(status).not.toBe(0);
  });
});

const editorWrites = (instructions: string): MockStaticTurn[] => [{ toolCalls: [{ name: 'write_file', args: { path: 'harness/instructions.md', content: instructions } }] }, '<notes>The failed runs left parseLine splitting on every comma.</notes>'];

describe('lousho improve on the recorded runs', () => {
  it('turns the failed runs into cases, prints a proposal card and changes no agent file', async () => {
    await recordInto(db, ['page-count', 'csv-quotes']);
    const before = fingerprint(path.dirname(HERE));
    const out = sink();
    const err = sink();
    const fixed = `${agent.instructions} ${HINT}`;
    const tools = agent.tools.flatMap((tool) => ['--read-only', tool.name]);
    const code = await runImprove([path.join(HERE, 'agent.ts'), '--check', path.join(HERE, 'check.ts'), '--db', db, '--agent', 'coding-agent', ...tools], {
      stdout: out.stream,
      stderr: err.stream,
      overrides: { provider: model() },
      editor: mockModel(['<notes>KEEP_BASE. Nothing to add.</notes>', ...editorWrites(fixed), ...editorWrites(fixed)]),
    });
    expect(err.text()).toContain('1 failed run(s) to learn from');
    expect(code).toBe(0);
    expect(out.text()).toMatch(/^# Improve result: proposal/);
    expect(out.text()).toContain(HINT);
    expect(fingerprint(path.dirname(HERE))).toEqual(before);
  });
});
