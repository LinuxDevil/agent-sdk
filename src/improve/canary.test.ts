import { describe, expect, it } from 'vitest';
import { canaryReplay } from './canary';
import type { Harness, ProbeRun } from './types';

const base: Harness = { instructions: 'base', skills: {} };
const candidate: Harness = { instructions: 'candidate', skills: {} };

type Outcomes = Record<string, (boolean | null)[]>;

function probeFrom(outcomes: { base?: Outcomes; candidate: Outcomes }) {
  const calls: { harness: string; caseId: string; repeat: number }[] = [];
  const probe = async (harness: Harness, caseId: string, repeat: number): Promise<ProbeRun> => {
    calls.push({ harness: harness.instructions, caseId, repeat });
    const table = harness === candidate ? outcomes.candidate : (outcomes.base ?? {});
    const results = table[caseId] ?? [];
    const passed = results[(repeat - 100) % Math.max(results.length, 1)] ?? null;
    return { passed, transcript: '', tokens: 1, ended: 'stop' };
  };
  return { probe, calls };
}

const T = true;
const F = false;
const N = null;

describe('canaryReplay', () => {
  it('a true fix passes', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, F], keep: [T, T, T, T, T, T] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(true);
    expect(result.cases.map((verdict) => [verdict.caseId, verdict.role, verdict.final])).toEqual([
      ['fix', 'training', { passed: 5, scored: 6 }],
      ['keep', 'holdout', { passed: 6, scored: 6 }],
    ]);
    expect(result.reason).toMatch(/^[^.]+\.$/);
  });

  it('a candidate that drops a protected case to 4/6 fails', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], keep: [T, T, T, T, F, F] }, base: { keep: [T, T, T, T, T, T] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/keep/);
    const keep = result.cases.find((verdict) => verdict.caseId === 'keep');
    expect(keep).toMatchObject({ base: { passed: 6, scored: 6 }, final: { passed: 4, scored: 6 } });
  });

  it('fails a training case below 5/6', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, F, F] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: [], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/fix/);
  });

  it('lets a protected case the base also fails stay within 1 of the base', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], flaky: [T, T, T, F, F, F] }, base: { flaky: [T, T, T, T, F, F] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['flaky'], probe });
    expect(result.passed).toBe(true);
  });

  it('fails a protected case 2 below a base that also misses the bar', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], flaky: [T, T, F, F, F, F] }, base: { flaky: [T, T, T, T, F, F] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['flaky'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/flaky/);
  });

  it('too many unscored runs fail closed', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, N, N, N], keep: [T, T, T, T, T, T] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/too few scored runs/i);
  });

  it('fails closed on an outage', async () => {
    const { probe } = probeFrom({ candidate: { fix: [N], keep: [N] }, base: { keep: [N] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/too few scored runs/i);
  });

  it('fails closed when the base is unscored on a protected case below the bar', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], keep: [T, T, T, T, F, F] }, base: { keep: [N] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/too few scored runs/i);
  });

  it('fails closed with nothing to replay', async () => {
    const { probe } = probeFrom({ candidate: {} });
    const result = await canaryReplay({ base, candidate, training: [], protected: [], probe });
    expect(result.passed).toBe(false);
  });

  it('repeats start at 100', async () => {
    const { probe, calls } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], keep: [T, T, T, T, F, F] }, base: { keep: [T, T, T, T, T, T] } });
    await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(Math.min(...calls.map((call) => call.repeat))).toBe(100);
    expect(calls.filter((call) => call.harness === 'candidate' && call.caseId === 'fix').map((call) => call.repeat)).toEqual([100, 101, 102, 103, 104, 105]);
    expect(calls.filter((call) => call.harness === 'base').map((call) => call.repeat)).toEqual([100, 101, 102, 103, 104, 105]);
  });

  it('runs the base only on protected cases the candidate misses', async () => {
    const { probe, calls } = probeFrom({ candidate: { fix: [T, T, T, T, T, T], keep: [T, T, T, T, T, T] } });
    await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep'], probe });
    expect(calls.some((call) => call.harness === 'base')).toBe(false);
  });

  it('honours runs and firstRepeat', async () => {
    const { probe, calls } = probeFrom({ candidate: { fix: [T, T, T, T, T, T, T, T, T, T, T, T] } });
    await canaryReplay({ base, candidate, training: ['fix'], protected: [], probe, runs: 4, firstRepeat: 200 });
    expect(calls.map((call) => call.repeat)).toEqual([200, 201, 202, 203]);
  });

  it.each([{ runs: 0 }, { runs: 2.5 }, { firstRepeat: -1 }])('rejects bad options $runs $firstRepeat', async (bad) => {
    const { probe } = probeFrom({ candidate: {} });
    await expect(canaryReplay({ base, candidate, training: ['fix'], protected: [], probe, ...bad })).rejects.toThrow(/canaryReplay/);
  });

  it('stops when aborted', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T] } });
    const controller = new AbortController();
    controller.abort();
    await expect(canaryReplay({ base, candidate, training: ['fix'], protected: [], probe, signal: controller.signal })).rejects.toThrow();
  });

  it('gives one sentence per case reason', async () => {
    const { probe } = probeFrom({ candidate: { fix: [T, T, T, N, N, N], keep: [T, T, T, T, F, F], ok: [T, T, T, T, T, T] }, base: { keep: [T, T, T, T, T, T] } });
    const result = await canaryReplay({ base, candidate, training: ['fix'], protected: ['keep', 'ok'], probe });
    for (const verdict of result.cases) {
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0]).toMatch(/^[^.]+\.$/);
    }
    expect(result.reason).toMatch(/^[^.]+\.$/);
  });
});
