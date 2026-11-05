import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFsTools, defineTool, MemoryWorkspace } from 'lousho';
import { z } from 'zod';
import type { BenchmarkAgent } from './agents';

const TEST_HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\n";
const TEST_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_CHARS = 3_000;
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission' : '--experimental-permission';

const FIXTURE: Readonly<Record<string, string>> = {
  'src/pages.js': 'exports.pageCount = (total, size) => Math.floor(total / size);\n',
  'test/pages.test.js': `${TEST_HEAD}const { pageCount } = require('../src/pages');\n\ntest('counts a partial page', () => assert.strictEqual(pageCount(10, 3), 4));\n`,
  'src/csv.js': "exports.parseLine = (line) => line.split(',');\n",
  'test/csv.test.js': `${TEST_HEAD}const { parseLine } = require('../src/csv');\n\ntest('keeps a comma inside quotes', () => assert.deepStrictEqual(parseLine('"a,b",c'), ['a,b', 'c']));\n`,
  'src/dedupe.js': 'exports.dedupeBy = (items, key) => {\n  const seen = new Map();\n  for (const item of items) seen.set(key(item), item);\n  return [...seen.values()];\n};\n',
  'test/dedupe.test.js': `${TEST_HEAD}const { dedupeBy } = require('../src/dedupe');\n\ntest('keeps the first item for a key', () => assert.deepStrictEqual(dedupeBy([{ id: 1, v: 'a' }, { id: 1, v: 'b' }], (x) => x.id), [{ id: 1, v: 'a' }]));\n`,
  'src/retry.js': 'exports.retry = async (fn, times) => {\n  for (let i = 0; i < times; i++) {\n    try {\n      return await fn();\n    } catch {}\n  }\n};\n',
  'test/retry.test.js': `${TEST_HEAD}const { retry } = require('../src/retry');\n\ntest('rejects when every attempt fails', () => assert.rejects(retry(async () => { throw new Error('boom'); }, 2), /boom/));\n`,
  'src/round.js': 'exports.round2 = (n) => Math.floor(n * 100) / 100;\n',
  'src/cart.js': "const { round2 } = require('./round');\n\nexports.total = (items) => round2(items.reduce((sum, item) => sum + item.price * item.qty, 0));\n",
  'src/tax.js': "const { round2 } = require('./round');\n\nexports.tax = (amount) => round2(amount * 0.1);\n",
  'test/cart.test.js': `${TEST_HEAD}const { total } = require('../src/cart');\n\ntest('rounds a total to the nearest cent', () => assert.strictEqual(total([{ price: 1.339, qty: 2 }]), 2.68));\n`,
};

interface CodingTask {
  id: string;
  input: string;
  mayChange: readonly string[];
  hidden: string;
  fix: Record<string, string>;
}

const TASKS: readonly CodingTask[] = [
  {
    id: 'page-count',
    input: 'test/pages.test.js fails. Fix the bug.',
    mayChange: ['src/pages.js'],
    hidden: `${TEST_HEAD}const { pageCount } = require('../src/pages');\n\ntest('hidden', () => {\n  assert.strictEqual(pageCount(10, 3), 4);\n  assert.strictEqual(pageCount(9, 3), 3);\n  assert.strictEqual(pageCount(0, 3), 0);\n});\n`,
    fix: { 'src/pages.js': 'exports.pageCount = (total, size) => Math.ceil(total / size);\n' },
  },
  {
    id: 'csv-quotes',
    input: 'test/csv.test.js fails. parseLine should follow normal CSV quoting rules. Fix it.',
    mayChange: ['src/csv.js'],
    hidden: `${TEST_HEAD}const { parseLine } = require('../src/csv');\n\ntest('hidden', () => {\n  assert.deepStrictEqual(parseLine('"a,b",c'), ['a,b', 'c']);\n  assert.deepStrictEqual(parseLine('a,,b'), ['a', '', 'b']);\n  assert.deepStrictEqual(parseLine('"say ""hi"", ok",c'), ['say "hi", ok', 'c']);\n});\n`,
    fix: {
      'src/csv.js': `exports.parseLine = (line) => {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === '"' && line[i + 1] === '"') {
      field += '"';
      i++;
    } else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields;
};
`,
    },
  },
  {
    id: 'dedupe-first',
    input: 'test/dedupe.test.js fails. Fix the bug.',
    mayChange: ['src/dedupe.js'],
    hidden: `${TEST_HEAD}const { dedupeBy } = require('../src/dedupe');\n\ntest('hidden', () => {\n  const items = [{ id: 1, v: 'a' }, { id: 2, v: 'x' }, { id: 1, v: 'b' }, { id: 3, v: 'y' }];\n  assert.deepStrictEqual(dedupeBy(items, (x) => x.id).map((x) => x.v), ['a', 'x', 'y']);\n  assert.deepStrictEqual(dedupeBy([{ id: undefined, v: 'p' }, { id: undefined, v: 'q' }], (x) => x.id).map((x) => x.v), ['p']);\n});\n`,
    fix: { 'src/dedupe.js': 'exports.dedupeBy = (items, key) => {\n  const seen = new Map();\n  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);\n  return [...seen.values()];\n};\n' },
  },
  {
    id: 'retry-errors',
    input: 'test/retry.test.js fails. Fix the bug. retry should make exactly the number of attempts it is given.',
    mayChange: ['src/retry.js'],
    hidden: `${TEST_HEAD}const { retry } = require('../src/retry');\n\ntest('hidden', async () => {\n  let calls = 0;\n  await assert.rejects(retry(async () => { calls++; throw new Error('e' + calls); }, 3), /^Error: e3$/);\n  assert.strictEqual(calls, 3);\n  let tries = 0;\n  assert.strictEqual(await retry(async () => { tries++; if (tries < 2) throw new Error('x'); return 'ok'; }, 3), 'ok');\n  assert.strictEqual(tries, 2);\n});\n`,
    fix: { 'src/retry.js': 'exports.retry = async (fn, times) => {\n  let last;\n  for (let i = 0; i < times; i++) {\n    try {\n      return await fn();\n    } catch (error) {\n      last = error;\n    }\n  }\n  throw last;\n};\n' },
  },
  {
    id: 'round-root-cause',
    input: 'test/cart.test.js fails: cart totals come out a cent low. Find the root cause and fix it.',
    mayChange: ['src/round.js'],
    hidden: `${TEST_HEAD}const { total } = require('../src/cart');\nconst { tax } = require('../src/tax');\nconst { round2 } = require('../src/round');\n\ntest('hidden', () => {\n  assert.strictEqual(total([{ price: 1.339, qty: 2 }]), 2.68);\n  assert.strictEqual(tax(26.78), 2.68);\n  assert.strictEqual(round2(2.671), 2.67);\n});\n`,
    fix: { 'src/round.js': 'exports.round2 = (n) => Math.round(n * 100) / 100;\n' },
  },
];

const insideProject = (file: string) => !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');

function runTestFile(root: string, file: string): { exitCode: number; output: string } {
  const result = spawnSync(process.execPath, [PERMISSION_FLAG, `--allow-fs-read=${root}/*`, `--allow-fs-write=${root}/*`, file], { cwd: root, env: {}, encoding: 'utf8', timeout: TEST_TIMEOUT_MS });
  if (result.error) return { exitCode: 1, output: `${file}: ${result.error.message}` };
  return { exitCode: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

/** Runs a project's tests in a throwaway directory, with no environment and no file access outside it. */
export function runProjectTests(files: Readonly<Record<string, string>>, file?: string): { exitCode: number; output: string } {
  const outside = [...Object.keys(files), ...(file === undefined ? [] : [file])].find((candidate) => !insideProject(candidate));
  if (outside !== undefined) return { exitCode: 1, output: `Refused: ${outside} is outside the project.` };
  const targets = file === undefined ? Object.keys(files).filter((name) => name.endsWith('.test.js')).sort() : [file];
  if (targets.length === 0) return { exitCode: 1, output: 'No test files found.' };
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'heal-coding-')));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), content);
    }
    const runs = targets.map((target) => runTestFile(root, target));
    return { exitCode: runs.find((run) => run.exitCode !== 0)?.exitCode ?? 0, output: runs.map((run) => run.output).join('\n').slice(-MAX_OUTPUT_CHARS) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function changedFiles(files: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(FIXTURE), ...Object.keys(files)])].filter((name) => files[name] !== FIXTURE[name]);
}

/** A coding agent with a real test runner, scored by hidden tests and by which files it changed. */
export function codingAgent(seed: Readonly<Record<string, string>> = {}): BenchmarkAgent & { readonly files: Record<string, string> } {
  const workspace = new MemoryWorkspace({ files: { ...FIXTURE, ...seed } });
  const fileTools = createFsTools(workspace).filter((tool) => ['read_file', 'list_dir', 'grep', 'edit_file', 'write_file'].includes(tool.name));
  const runTests = defineTool({
    name: 'run_tests',
    description: 'Run the project tests with Node. Pass a test file to run only that file.',
    input: z.object({ file: z.string().optional() }),
    execute: async ({ file }) => runProjectTests(workspace.snapshot(), file),
  });
  return {
    name: 'coding-agent',
    instructions: 'You fix bugs in a small JavaScript project. Read the code, change it with your file tools, and run the tests with run_tests before you answer.',
    tools: [...fileTools, runTests],
    get files() {
      return workspace.snapshot();
    },
    tasks: TASKS.map(({ id, input, mayChange, hidden }) => ({
      id,
      input,
      check: () => {
        const files = workspace.snapshot();
        if (changedFiles(files).some((name) => !mayChange.includes(name))) return false;
        return runProjectTests({ ...files, 'test/hidden.test.js': hidden }, 'test/hidden.test.js').exitCode === 0;
      },
    })),
  };
}

/** The reference fix for each task, so tests can prove every task can pass. */
export const FIXES: Readonly<Record<string, Record<string, string>>> = Object.fromEntries(TASKS.map((task) => [task.id, task.fix]));
