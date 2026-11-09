import { describe, expect, it } from 'vitest';
import { mockModel } from 'lousho/testing';
import { codingAgent, FIXES, runProjectTests } from './codingAgent';
import { runBenchmark } from './run';

const taskOf = (id: string, build = codingAgent()) => {
  const task = build.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`No task ${id}`);
  return { task, tool: (name: string) => build.tools.find((candidate) => candidate.name === name) };
};

describe('codingAgent', () => {
  it('fails every task until its bug is fixed, whatever the answer says', () => {
    for (const { id } of codingAgent().tasks) expect(taskOf(id).task.check('Fixed, all tests pass.')).toBe(false);
  });

  it('passes every task once the reference fix is written', () => {
    for (const [id, files] of Object.entries(FIXES)) {
      const build = codingAgent(files);
      expect(taskOf(id, build).task.check('')).toBe(true);
    }
  });

  it('fails a shallow fix that only satisfies the visible test', () => {
    const build = codingAgent({ 'src/pages.js': 'exports.pageCount = (total, size) => Math.floor(total / size) + 1;\n' });
    expect(taskOf('page-count', build).task.check('')).toBe(false);
  });

  it('fails fixes that pass the visible test but break another test or a project convention', () => {
    const everyRoundingUp = codingAgent({ 'src/money.js': 'exports.roundCents = (n) => Math.round(n * 100) / 100;\n' });
    expect(taskOf('invoice-rounding', everyRoundingUp).task.check('')).toBe(false);
    const plainError = codingAgent({ 'src/signup.js': "exports.createAccount = ({ email }) => {\n  if (!email.trim()) throw new Error('Email is required.');\n  return { email: email.trim().toLowerCase() };\n};\n" });
    expect(runProjectTests(plainError.files, 'test/signup.test.js').exitCode).toBe(0);
    expect(taskOf('signup-conventions', plainError).task.check('')).toBe(false);
    const mutates = codingAgent({ 'src/months.js': 'exports.addMonths = (date, n) => {\n  const day = date.getUTCDate();\n  date.setUTCDate(1);\n  date.setUTCMonth(date.getUTCMonth() + n);\n  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();\n  date.setUTCDate(Math.min(day, last));\n  return date;\n};\n' });
    expect(runProjectTests(mutates.files, 'test/months.test.js').exitCode).toBe(0);
    expect(taskOf('add-months', mutates).task.check('')).toBe(false);
  });

  it('names the check a run failed, without giving away the fix', () => {
    const everyRoundingUp = codingAgent({ 'src/money.js': 'exports.roundCents = (n) => Math.round(n * 100) / 100;\n' });
    expect(taskOf('invoice-rounding', everyRoundingUp).task.failure?.()).toBe('other callers keep their behaviour');
    const mutates = codingAgent({ 'src/months.js': 'exports.addMonths = (date, n) => {\n  const day = date.getUTCDate();\n  date.setUTCDate(1);\n  date.setUTCMonth(date.getUTCMonth() + n);\n  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();\n  date.setUTCDate(Math.min(day, last));\n  return date;\n};\n' });
    expect(taskOf('add-months', mutates).task.failure?.()).toBe('follows project conventions');
    const plainError = codingAgent({ 'src/signup.js': "exports.createAccount = ({ email }) => {\n  if (!email.trim()) throw new Error('Email is required.');\n  return { email: email.trim().toLowerCase() };\n};\n" });
    expect(taskOf('signup-conventions', plainError).task.failure?.()).toBe('follows project conventions');
  });

  it('names no failed check once the reference fix is written, and always names one otherwise', () => {
    for (const [id, files] of Object.entries(FIXES)) expect(taskOf(id, codingAgent(files)).task.failure?.()).toBeUndefined();
    for (const { id } of codingAgent().tasks) expect(taskOf(id).task.failure?.()).toBeTruthy();
    const crashes = codingAgent({ 'src/money.js': 'syntax error here' });
    expect(taskOf('invoice-rounding', crashes).task.failure?.()).toBeTruthy();
    const extra = codingAgent({ ...FIXES['page-count'], 'src/dedupe.js': 'exports.dedupeBy = (items) => items;\n' });
    expect(taskOf('page-count', extra).task.failure?.()).toBe('changed only the files this task allows');
  });

  it('fails a run that edits a test, or a file the task should not touch', () => {
    const editedTest = codingAgent({ ...FIXES['page-count'], 'test/pages.test.js': "require('node:test')('x', () => {});\n" });
    expect(taskOf('page-count', editedTest).task.check('')).toBe(false);
    const extra = codingAgent({ ...FIXES['page-count'], 'src/dedupe.js': 'exports.dedupeBy = (items) => items;\n' });
    expect(taskOf('page-count', extra).task.check('')).toBe(false);
  });

  it('starts from extra project files without counting them as changes', () => {
    const start = { 'src/months.js': `// a note\n${codingAgent().files['src/months.js']}` };
    const build = codingAgent(FIXES['page-count'], start);
    expect(build.files['src/months.js']).toBe(start['src/months.js']);
    expect(taskOf('page-count', build).task.check('')).toBe(true);
    expect(taskOf('add-months', codingAgent(FIXES['add-months'], start)).task.check('')).toBe(true);
  });

  it('reports real test results through its run_tests tool', () => {
    expect(runProjectTests(codingAgent().files, 'test/pages.test.js').exitCode).not.toBe(0);
    expect(runProjectTests(codingAgent(FIXES['page-count']).files, 'test/pages.test.js').exitCode).toBe(0);
  });

  it('runs tests with no environment, and no access outside the project', () => {
    process.env.HEAL_BENCHMARK_SECRET = 'do-not-read';
    const probe = "const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs'); test('sandbox', () => { assert.strictEqual(process.env.HEAL_BENCHMARK_SECRET, undefined); assert.throws(() => fs.readFileSync('/etc/hosts')); assert.throws(() => fs.writeFileSync('/tmp/heal-benchmark-escape', 'x')); assert.throws(() => require('node:child_process').execSync('true')); });\n";
    const result = runProjectTests({ 'test/probe.test.js': probe }, 'test/probe.test.js');
    delete process.env.HEAL_BENCHMARK_SECRET;
    expect(result.exitCode).toBe(0);
  });

  it('refuses a test path outside the project', () => {
    expect(runProjectTests({}, '../outside.test.js').exitCode).not.toBe(0);
    expect(runProjectTests({ '../outside.js': 'x' }).exitCode).not.toBe(0);
  });

  it('fixes a task end to end through the benchmark, with file tools and run_tests', async () => {
    const provider = () =>
      mockModel([
        { toolCalls: [{ name: 'run_tests', args: { file: 'test/pages.test.js' } }] },
        { toolCalls: [{ name: 'read_file', args: { path: 'src/pages.js' } }] },
        { toolCalls: [{ name: 'write_file', args: { path: 'src/pages.js', content: FIXES['page-count']['src/pages.js'] } }] },
        'Fixed pageCount.',
      ]);
    const [row] = await runBenchmark({ agents: [() => codingAgent()], models: ['mock'], repeats: 1, only: 'page-count', provider, retry: false });
    expect(row).toMatchObject({ agent: 'coding-agent', outcome: 'passed', ended: 'stop' });
    expect(row.toolRuns).toBe(3);
  });
});
