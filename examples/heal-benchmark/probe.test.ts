import { describe, expect, it } from 'vitest';
import { codingAgent } from './codingAgent';
import { benchmarkProbe, checkFailureNames, failureFor, nameFailures, parseFailureNames, SHUFFLED_FAILURES } from './probe';

describe('failureFor', () => {
  it('failureFor keeps, hides or swaps the name', () => {
    expect(failureFor('real', 'add-months', 'x')).toBe('x');
    expect(failureFor('none', 'add-months', 'x')).toBeUndefined();
    expect(failureFor('shuffled', 'add-months', 'x')).toBe('other callers keep their behaviour');
    expect(failureFor('shuffled', 'invoice-rounding', 'x')).toBe('follows project conventions');
    expect(failureFor('shuffled', 'add-months', undefined)).toBeUndefined();
  });

  it('swaps each name for the real failed check of the other task', () => {
    const realFailure = (id: string, files: Record<string, string>) => codingAgent(files).tasks.find((task) => task.id === id)?.failure?.();
    const invoice = realFailure('invoice-rounding', { 'src/money.js': 'exports.roundCents = (n) => Math.round(n * 100) / 100;\n' });
    const months = realFailure('add-months', { 'src/months.js': 'exports.addMonths = (date, n) => {\n  const day = date.getUTCDate();\n  date.setUTCDate(1);\n  date.setUTCMonth(date.getUTCMonth() + n);\n  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();\n  date.setUTCDate(Math.min(day, last));\n  return date;\n};\n' });
    expect(SHUFFLED_FAILURES).toEqual({ 'add-months': invoice, 'invoice-rounding': months });
  });

  it('failureFor refuses shuffled for a task with no pair', () => {
    expect(() => failureFor('shuffled', 'page-count', 'x')).toThrow(/only for add-months and invoice-rounding/);
  });
});

describe('nameFailures', () => {
  const harness = { instructions: 'Fix it.', skills: {} };
  const realRun = async () => ({ passed: false, transcript: 't', tokens: 1, ended: 'stop', failure: 'x' });

  it('keeps the real run, and changes only the name the editors see', async () => {
    let calls = 0;
    const inner = async () => {
      calls += 1;
      return realRun();
    };
    expect((await nameFailures(inner, 'real')(harness, 'add-months', 0)).failure).toBe('x');
    expect(await nameFailures(inner, 'none')(harness, 'add-months', 0)).toEqual({ passed: false, transcript: 't', tokens: 1, ended: 'stop' });
    expect((await nameFailures(inner, 'shuffled')(harness, 'add-months', 0)).failure).toBe('other callers keep their behaviour');
    expect(calls).toBe(3);
  });

  it('throws, instead of scoring the run unknown, when shuffled meets a task with no pair', async () => {
    await expect(nameFailures(realRun, 'shuffled')(harness, 'page-count', 0)).rejects.toThrow(/only for add-months and invoice-rounding, not 'page-count'/);
  });

  it('benchmarkProbe still reports the real failed check', async () => {
    const run = await benchmarkProbe({ agent: 'coding-agent', model: 'm', live: false, gapMs: 0 })(harness, 'add-months');
    expect(run.passed).toBe(false);
    expect(run.failure).toBeTruthy();
    expect(run.failure).not.toBe('other callers keep their behaviour');
  });
});

describe('checkFailureNames', () => {
  it('accepts any cases unless shuffled, and paired cases when shuffled', () => {
    expect(() => checkFailureNames('real', ['page-count'])).not.toThrow();
    expect(() => checkFailureNames('none', ['page-count'])).not.toThrow();
    expect(() => checkFailureNames('shuffled', ['add-months', 'invoice-rounding'])).not.toThrow();
  });

  it('refuses shuffled when any case has no pair', () => {
    expect(() => checkFailureNames('shuffled', ['add-months', 'dedupe-first'])).toThrow(/only for add-months and invoice-rounding, not 'dedupe-first'/);
  });
});

describe('parseFailureNames', () => {
  it('accepts the three modes', () => {
    expect(parseFailureNames('real')).toBe('real');
    expect(parseFailureNames('none')).toBe('none');
    expect(parseFailureNames('shuffled')).toBe('shuffled');
  });

  it('refuses anything else', () => {
    expect(() => parseFailureNames('hidden')).toThrow("--failure-names must be real, none or shuffled, not 'hidden'.");
  });
});
