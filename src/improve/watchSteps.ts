import type { CheckpointStore } from '../execution/checkpoint';
import { exampleFromTrace } from '../observe/datasets';
import { readAudit } from './audit';
import { admitProtectedCases, type CapturedCase } from './cases';
import { addToCorpus, readCorpus, type CorpusCase } from './corpus';
import { guardCorpus, type GuardCorpusResult } from './corpusGuard';
import { dayStart, readCycles, usageToday, type HealCycle } from './cycles';
import { corpusCases } from './healApply';
import { BudgetSpent, caseProbe, libraryOf, unscored } from './healState';
import type { MonitorVerdict } from './monitor';
import type { Notify } from './notify';
import { voteOnOutcome } from './reflect';
import { harnessHash, readAgentHarness } from './revisions';
import type { ImproveSettings } from './settings';
import { readState, updateState } from './state';
import type { ImproveOptions } from './types';
import type { WatchOptions } from './watch';

export interface WatchContext {
  owner: string;
  leaseId: string;
  store: CheckpointStore;
  editor: ImproveOptions['editor'];
  notify: Notify;
  signal?: AbortSignal;
}

export interface WatchMemory {
  paused?: string;
  revision?: string;
  signatures?: string[];
  failed?: number;
  newest?: string;
  outages?: number;
  guardAt?: number;
  spentDay?: number;
  spent?: number;
  harvested?: number;
  guardNotified?: string;
  scoreAt?: number;
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
  return settings.budget.maxTokensPerDay - usageToday(dir, now).tokens;
}

async function addSpent(dir: string, tokens: number, now: number): Promise<void> {
  if (tokens <= 0) return;
  const day = dayStart(now);
  await updateState<WatchState>(dir, (current) => {
    const watch = current.watch ?? {};
    return { watch: { ...watch, spentDay: day, spent: (watch.spentDay === day ? (watch.spent ?? 0) : 0) + tokens } };
  });
}

interface Spend {
  tokens: number;
  limit: number;
}

function metered(probe: ImproveOptions['probe'], spend: Spend): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    if (spend.tokens >= spend.limit) throw new BudgetSpent();
    const run = await probe(harness, caseId, repeat);
    spend.tokens += run.tokens;
    return run;
  };
}

async function withSpend<T>(options: WatchOptions, now: number, task: (spend: Spend) => Promise<T>): Promise<T | undefined> {
  const spend: Spend = { tokens: 0, limit: budgetLeft(options.dir, options.settings, now) };
  if (spend.limit <= 0) return undefined;
  try {
    return await task(spend);
  } catch (error) {
    if (error instanceof BudgetSpent) return undefined;
    throw error;
  } finally {
    await addSpent(options.dir, spend.tokens, now);
  }
}

function corpusProbe(options: WatchOptions, cases: readonly CapturedCase[], spend: Spend, signal: AbortSignal | undefined): ImproveOptions['probe'] {
  return metered(unscored(caseProbe(cases, options.runCase, options.check), new Set(), signal), spend);
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

async function admitFixed(options: WatchOptions, cycle: HealCycle, now: number, signal: AbortSignal | undefined): Promise<void> {
  const cases = fixedCases(options, cycle);
  if (cases.length === 0) return;
  const harness = readAgentHarness(options.dir);
  const admitted = await withSpend(options, now, async (spend) => (await admitProtectedCases({ harness, cases, probe: corpusProbe(options, cases, spend, signal), runs: ADMISSION_RUNS })).admitted);
  if (!admitted || admitted.length === 0) return;
  const revision = harnessHash(harness);
  const addedAt = new Date(now).toISOString();
  const fixed = admitted.map((item): CorpusCase => ({ id: item.id, traceId: item.traceId, input: item.input, addedAt, revision, origin: 'fixed', baseline: { passed: ADMISSION_RUNS, scored: ADMISSION_RUNS } }));
  await addToCorpus(options.dir, fixed, options.settings.guard.maxCases);
}

function harvestClaim(current: Partial<WatchState>): number | undefined {
  const applySeq = current.monitor?.applySeq;
  return applySeq !== undefined && current.watch?.harvested !== applySeq ? applySeq : undefined;
}

async function claimHarvest(dir: string): Promise<number | undefined> {
  let claimed: number | undefined;
  await updateState<WatchState>(dir, (current) => {
    claimed = harvestClaim(current);
    return claimed === undefined ? {} : { watch: { ...current.watch, harvested: claimed } };
  });
  return claimed;
}

const DECIDED: readonly MonitorVerdict['state'][] = ['kept', 'rolled-back', 'regressed'];

const MONITOR_EVENTS: Partial<Record<MonitorVerdict['state'], 'improve.rolled_back' | 'improve.guard_failed'>> = { 'rolled-back': 'improve.rolled_back', regressed: 'improve.guard_failed' };

export async function harvest(options: WatchOptions, monitor: MonitorVerdict, now: number, context: Pick<WatchContext, 'notify' | 'signal'>): Promise<void> {
  if (!DECIDED.includes(monitor.state)) return;
  const applySeq = await claimHarvest(options.dir);
  if (applySeq === undefined) return;
  const cycle = cycleOfApply(options.dir, applySeq);
  const type = MONITOR_EVENTS[monitor.state];
  if (type) context.notify({ type, reason: monitor.reason ?? `The monitor says ${monitor.state}.`, ...(cycle?.id && { cycle: cycle.id }), ...(cycle?.to && { from: cycle.to }), ...(monitor.to && { to: monitor.to }) });
  if (!cycle?.result || monitor.state === 'regressed') return;
  const signal = context.signal;
  const library = libraryOf(options.dir, options.settings);
  if (library) voteOnOutcome(library.dir, { outcome: monitor.state === 'kept' ? 'kept' : 'rolled-back', result: cycle.result, domain: library.domain });
  if (monitor.state === 'kept') await admitFixed(options, cycle, now, signal);
}

export async function guardScheduled(options: WatchOptions, now: number, context: Pick<WatchContext, 'notify' | 'signal'>): Promise<GuardCorpusResult | undefined> {
  const { signal } = context;
  const { dir, settings } = options;
  const last = watchOf(dir).guardAt;
  if (last !== undefined && now - last < settings.guard.everyHours * HOUR_MS) return undefined;
  const corpus = readCorpus(dir);
  if (corpus.length === 0) return undefined;
  const revision = harnessHash(readAgentHarness(dir));
  const earlier = readAudit(dir).filter((entry) => (entry.action === 'guard-pass' || entry.action === 'guard-fail') && entry.to === revision).length;
  const firstRepeat = GUARD_FIRST_REPEAT + earlier * GUARD_RANGE;
  const guard = await withSpend(options, now, (spend) => guardCorpus(dir, { probe: corpusProbe(options, corpusCases(corpus), spend, signal), runs: settings.guard.runs, rollback: true, firstRepeat, ...(signal && { signal }) }));
  if (!guard) return undefined;
  await saveWatch(dir, { guardAt: now });
  const regressed = guard.cases.some((item) => item.class === 'regressed');
  const type = guard.rolledBackTo ? 'improve.rolled_back' : 'improve.guard_failed';
  if (regressed && watchOf(dir).guardNotified !== `${revision}:${type}`) {
    await saveWatch(dir, { guardNotified: `${revision}:${type}` });
    context.notify({ type, reason: guard.reason, from: revision, ...(guard.rolledBackTo && { to: guard.rolledBackTo }) });
  }
  return guard;
}
