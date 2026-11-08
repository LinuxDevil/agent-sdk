import type { CheckpointStore } from '../execution/checkpoint';
import { exampleFromTrace } from '../observe/datasets';
import { readAudit } from './audit';
import { admitProtectedCases, type CapturedCase } from './cases';
import { addToCorpus, readCorpus, type CorpusCase } from './corpus';
import { guardCorpus, type GuardCorpusResult } from './corpusGuard';
import { dayStart, readCycles, usageToday, type HealCycle } from './cycles';
import { corpusCases } from './healApply';
import { caseProbe, libraryOf, unscored } from './healState';
import type { MonitorVerdict } from './monitor';
import { voteOnOutcome } from './reflect';
import { harnessHash, readAgentHarness } from './revisions';
import type { ImproveSettings } from './settings';
import { readState, updateState } from './state';
import type { ImproveOptions } from './types';
import type { WatchOptions } from './watch';

export interface WatchContext {
  owner: string;
  store: CheckpointStore;
  editor: ImproveOptions['editor'];
  signal?: AbortSignal;
}

export interface WatchMemory {
  paused?: string;
  signatures?: string[];
  revision?: string;
  failed?: number;
  outages?: number;
  guardAt?: number;
  spentDay?: number;
  spent?: number;
  harvested?: number;
}

export interface WatchState {
  cooldownUntil?: string;
  monitor?: { applySeq?: number };
  watch?: WatchMemory;
}

const HOUR_MS = 60 * 60 * 1000;
const ADMISSION_RUNS = 6;
const GUARD_FIRST_REPEAT = 200;
const GUARD_RANGE = 20;

export const watchOf = (dir: string): WatchMemory => readState<WatchState>(dir).watch ?? {};

export async function saveWatch(dir: string, change: Partial<WatchMemory>): Promise<void> {
  await updateState<WatchState>(dir, (current) => ({ watch: { ...current.watch, ...change } }));
}

export function budgetLeft(dir: string, settings: ImproveSettings, now: number): number {
  const watch = watchOf(dir);
  const spent = watch.spentDay === dayStart(now) ? (watch.spent ?? 0) : 0;
  return settings.budget.maxTokensPerDay - spent - usageToday(dir, now).tokens;
}

async function addSpent(dir: string, tokens: number, now: number): Promise<void> {
  if (tokens <= 0) return;
  const day = dayStart(now);
  await updateState<WatchState>(dir, (current) => {
    const watch = current.watch ?? {};
    return { watch: { ...watch, spentDay: day, spent: (watch.spentDay === day ? (watch.spent ?? 0) : 0) + tokens } };
  });
}

function counting(probe: ImproveOptions['probe'], spent: { tokens: number }): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    const run = await probe(harness, caseId, repeat);
    spent.tokens += run.tokens;
    return run;
  };
}

function corpusProbe(options: WatchOptions, cases: readonly CapturedCase[], spent: { tokens: number }): ImproveOptions['probe'] {
  return counting(unscored(caseProbe(cases, options.runCase, options.check), new Set(), undefined), spent);
}

function cycleOfApply(dir: string, applySeq: number): HealCycle | undefined {
  const id = readAudit(dir).find((entry) => entry.seq === applySeq)?.cycle;
  return id === undefined ? undefined : readCycles(dir).find((cycle) => cycle.id === id);
}

function fixedCases(options: WatchOptions, cycle: HealCycle): CapturedCase[] {
  const kept = new Set(readCorpus(options.dir).map((item) => item.traceId));
  return (cycle.result?.cases ?? []).flatMap((verdict) => {
    const traceId = verdict.caseId.slice(verdict.caseId.indexOf(':') + 1);
    if (verdict.role !== 'training' || kept.has(traceId)) return [];
    const example = exampleFromTrace(options.db, traceId);
    return typeof example === 'string' ? [] : [{ id: verdict.caseId, input: example.input, traceId, kind: 'protected' as const }];
  });
}

async function admitFixed(options: WatchOptions, cycle: HealCycle, now: number): Promise<void> {
  const cases = fixedCases(options, cycle);
  if (cases.length === 0 || budgetLeft(options.dir, options.settings, now) <= 0) return;
  const spent = { tokens: 0 };
  const harness = readAgentHarness(options.dir);
  const { admitted } = await admitProtectedCases({ harness, cases, probe: corpusProbe(options, cases, spent), runs: ADMISSION_RUNS });
  await addSpent(options.dir, spent.tokens, now);
  const revision = harnessHash(harness);
  const addedAt = new Date(now).toISOString();
  const fixed = admitted.map((item): CorpusCase => ({ id: item.id, traceId: item.traceId, input: item.input, addedAt, revision, origin: 'fixed', baseline: { passed: ADMISSION_RUNS, scored: ADMISSION_RUNS } }));
  if (fixed.length > 0) await addToCorpus(options.dir, fixed, options.settings.guard.maxCases);
}

/** Votes once on the library entries behind an apply the monitor decided, and adds the cases a kept edit fixed to the corpus once they pass 6 of 6. */
export async function harvest(options: WatchOptions, monitor: MonitorVerdict, now: number): Promise<void> {
  if (monitor.state !== 'kept' && monitor.state !== 'rolled-back') return;
  const state = readState<WatchState>(options.dir);
  const applySeq = state.monitor?.applySeq;
  if (applySeq === undefined || state.watch?.harvested === applySeq) return;
  await saveWatch(options.dir, { harvested: applySeq });
  const cycle = cycleOfApply(options.dir, applySeq);
  if (!cycle?.result) return;
  const library = libraryOf(options.dir, options.settings);
  if (library) voteOnOutcome(library.dir, { outcome: monitor.state, result: cycle.result, domain: library.domain });
  if (monitor.state === 'kept') await admitFixed(options, cycle, now);
}

/** Replays the corpus under the current revision once `guard.everyHours` have passed, rolling back on a regression. */
export async function guardScheduled(options: WatchOptions, now: number): Promise<GuardCorpusResult | undefined> {
  const { dir, settings } = options;
  const last = watchOf(dir).guardAt;
  if (last !== undefined && now - last < settings.guard.everyHours * HOUR_MS) return undefined;
  const corpus = readCorpus(dir);
  if (corpus.length === 0 || budgetLeft(dir, settings, now) <= 0) return undefined;
  const revision = harnessHash(readAgentHarness(dir));
  const earlier = readAudit(dir).filter((entry) => (entry.action === 'guard-pass' || entry.action === 'guard-fail') && entry.to === revision).length;
  const spent = { tokens: 0 };
  const guard = await guardCorpus(dir, { probe: corpusProbe(options, corpusCases(corpus), spent), runs: settings.guard.runs, rollback: true, firstRepeat: GUARD_FIRST_REPEAT + earlier * GUARD_RANGE });
  await addSpent(dir, spent.tokens, now);
  await saveWatch(dir, { guardAt: now });
  return guard;
}
