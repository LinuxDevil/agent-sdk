import path from 'node:path';
import { ConfigurationError, SDKError } from '../execution/errors';
import type { AgentHook } from '../execution/hooks';
import { runsByRevision } from '../observe/store';
import { withFileLock } from '../storage/fileLock';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { appendAudit } from './audit';
import { canaryReplay, type CanaryReplayResult } from './canary';
import { admitProtectedCases, casesFromFailures, protectedCasesFromPasses, scoreCase, type CapturedCase, type CaseCheck } from './cases';
import { addToCorpus, readCorpus, type CorpusCase } from './corpus';
import { cooldownEnds, newCycleId, ownLousho, pausedBy, readCycles, usageToday, writeCycle, type HealCycle } from './cycles';
import { formatImproveResult } from './format';
import { applyAndGuard, corpusCases, guardUnfinished } from './healApply';
import {
  BudgetSpent,
  caseProbe,
  checkpoint,
  counts,
  DEFAULT_EDITOR_TIMEOUT_MS,
  fileApprovalOf,
  finish,
  libraryOf,
  MAX_ALWAYS_ON,
  messageOf,
  metered,
  recheck,
  rejected,
  shortId,
  unscored,
  type HealState,
} from './healState';
import { improveAgent } from './improve';
import { savePending } from './pending';
import { casesFromRecoveries, readableInput } from './recoveries';
import { harnessHash, readAgentHarness } from './revisions';
import { editorsOf, type ImproveSettings } from './settings';
import type { Harness, ImproveOptions, ImproveResult, RecoveryEvidence } from './types';

/** Options for {@link healOnce}. */
export interface HealOptions {
  /** The agent directory; its instructions must live in instructions.md. */
  dir: string;
  /** The local observe database the failed runs come from. */
  db: SqlDatabase;
  /** Scores each answer; it gets the user's text for a one-message run, else the recorded messages as JSON. */
  check: CaseCheck;
  /** Runs the agent on one recorded input, as captured (JSON text), under a harness. */
  runCase: (
    harness: Harness,
    input: string
  ) => Promise<{
    /** The agent's final answer. */
    answer: string;
    /** What happened, built with `renderTranscript`. */
    transcript: string;
    /** Tokens the run used. */
    tokens: number;
    /** How the run ended. */
    ended: string;
  }>;
  /** The model for the editors and the reflection. */
  editor: ImproveOptions['editor'];
  /** The directory's settings, from `loadImproveSettings`. */
  settings: ImproveSettings;
  /** What started the cycle (default `failures`, which waits for `settings.trigger.minNewFailures` new failed runs). */
  trigger?: HealCycle['trigger'];
  /** Only runs of this agent, by id or registered name. */
  agent?: string;
  /** Only runs that started at or after this time, in epoch ms. */
  since?: number;
  /** Trace ids of runs that went well; each joins the corpus once it passes 6 of 6 fresh runs. */
  protect?: readonly string[];
  /** Show the editors each failed run's `.heal` retry whose answer passes `check`. */
  withRecoveries?: boolean;
  /** Most tokens this cycle may spend, within the settings' caps. */
  maxTokens?: number;
  /** Hooks for the editor and reflection sessions, such as a rate limit. */
  editorHooks?: readonly AgentHook[];
  /** Most milliseconds one editor or reflection session may run (default 600000). */
  editorTimeoutMs?: number;
  /** Reflect on a decided outcome and store the lesson (default `settings.library.enabled`). */
  reflect?: boolean;
  /** Stops the cycle between steps; an apply and its corpus guard always finish. */
  signal?: AbortSignal;
}

const LOUSHO = '.lousho';
const MAX_RUNS = 1000;
const ADMISSION_RUNS = 6;
const CANARY_FIRST_REPEAT = 100;
const UNLIMITED = Number.POSITIVE_INFINITY;

interface Captured {
  failures: CapturedCase[];
  passes: CapturedCase[];
  corpus: CorpusCase[];
}

type Start = Pick<HealCycle, 'id' | 'trigger' | 'approval' | 'startedAt' | 'tokens'>;

function ended(start: Start, outcome: HealCycle['outcome'], reason: string): HealCycle {
  return { ...start, outcome, reason, endedAt: new Date().toISOString() };
}

function lockFile(dir: string): string {
  return path.join(ownLousho(dir), 'cycle.lock');
}

function blocked(options: HealOptions, start: Start, now: number): HealCycle | number {
  const { dir, settings } = options;
  const ends = cooldownEnds(dir, settings.cooldownHours, now);
  if (ends !== undefined) return ended(start, 'cooldown', `A rollback started a ${settings.cooldownHours} hour cooldown, which ends at ${new Date(ends).toISOString()}.`);
  const used = usageToday(dir, now);
  const { budget } = settings;
  if (used.cycles >= budget.maxCyclesPerDay) return ended(start, 'budget', `Today's ${budget.maxCyclesPerDay} cycles have run; the count resets at 00:00 UTC.`);
  if (settings.approval === 'auto' && used.applies >= budget.maxAppliesPerDay) return ended(start, 'budget', `Today's ${budget.maxAppliesPerDay} automatic apply has been made; the count resets at 00:00 UTC.`);
  const cap = Math.min(budget.maxTokensPerDay - used.tokens, budget.maxTokensPerCycle ?? UNLIMITED, options.maxTokens ?? UNLIMITED);
  if (cap <= 0) return ended(start, 'budget', `The token budget is spent: ${used.tokens} of ${budget.maxTokensPerDay} tokens today.`);
  return cap;
}

function revisionTraces(options: HealOptions, revision: string, since: number | undefined): ReturnType<typeof runsByRevision> {
  return runsByRevision(options.db, { revision, limit: MAX_RUNS, ...(options.agent !== undefined && { agent: options.agent }), ...(since !== undefined && { since }) });
}

function enoughNewFailures(options: HealOptions, revision: string): boolean {
  const last = readCycles(options.dir)[0];
  const since = Math.max(options.since ?? 0, last ? Date.parse(last.startedAt) : 0);
  const failed = revisionTraces(options, revision, since).filter((run) => run.failed).length;
  return failed >= options.settings.trigger.minNewFailures;
}

const recurringOnly = (options: HealOptions, trigger: HealCycle['trigger']): boolean => options.settings.trigger.requireRecurring && trigger !== 'score';

function capture(options: HealOptions, trigger: HealCycle['trigger'], revision: string): Captured {
  const corpus = readCorpus(options.dir);
  const traceIds = revisionTraces(options, revision, options.since).map((run) => run.traceId);
  if (traceIds.length === 0) return { failures: [], passes: [], corpus };
  const filter = { traceIds, recurring: recurringOnly(options, trigger), ...(options.since !== undefined && { since: options.since }) };
  const inCorpus = new Set(corpus.map((item) => item.traceId));
  const recovered = new Map(options.withRecoveries ? casesFromRecoveries(options.db, filter).map((captured) => [captured.id, captured]) : []);
  const failures = casesFromFailures(options.db, filter)
    .filter((captured) => !inCorpus.has(captured.traceId))
    .map((captured) => recovered.get(captured.id) ?? captured);
  const failed = new Set(failures.map((captured) => captured.traceId));
  const passes = protectedCasesFromPasses(options.db, options.protect ?? []).filter((captured) => !failed.has(captured.traceId) && !inCorpus.has(captured.traceId));
  return { failures, passes, corpus };
}

function checkedRecoveries(captured: Captured, check: CaseCheck): RecoveryEvidence[] {
  const guarded = new Set([...captured.passes, ...captured.corpus].map((item) => item.traceId));
  return captured.failures.flatMap(({ input, recovery }) => (recovery && !guarded.has(recovery.traceId) && scoreCase(check, readableInput(input), recovery.answer).passed === true ? [recovery] : []));
}

async function admit(state: HealState, captured: Captured): Promise<CorpusCase[]> {
  if (captured.passes.length === 0) return captured.corpus;
  const { admitted } = await admitProtectedCases({ harness: state.harness, cases: captured.passes, probe: metered(state), runs: ADMISSION_RUNS });
  if (admitted.length === 0) return captured.corpus;
  const addedAt = new Date().toISOString();
  const revision = state.cycle.from as string;
  const cases = admitted.map((item): CorpusCase => ({ id: item.id, traceId: item.traceId, input: item.input, addedAt, revision, origin: 'protected', baseline: { passed: ADMISSION_RUNS, scored: ADMISSION_RUNS } }));
  return addToCorpus(state.dir, cases, state.settings.guard.maxCases);
}

function propose(state: HealState, captured: Captured, holdout: readonly string[]): Promise<ImproveResult> {
  const { options, settings } = state;
  const { proposers, mode, select, parallel } = editorsOf(settings);
  const recoveries = checkedRecoveries(captured, options.check);
  const library = state.library?.files ?? {};
  return improveAgent({
    harness: state.harness,
    cases: captured.failures.map((item) => item.id),
    holdout,
    probe: state.probe,
    editor: options.editor,
    quotedChecks: settings.approval === 'manual' ? 'flag' : 'reject',
    maxTokens: state.cap - state.spent,
    maxAlwaysOnChars: MAX_ALWAYS_ON,
    editorTimeoutMs: options.editorTimeoutMs ?? DEFAULT_EDITOR_TIMEOUT_MS,
    cacheDir: path.join(state.dir, LOUSHO, 'cache'),
    proposers,
    mode,
    select,
    parallelEditors: parallel,
    ...(recoveries.length > 0 && { recoveries }),
    ...(Object.keys(library).length > 0 && { library }),
    ...(options.editorHooks && { editorHooks: options.editorHooks }),
    ...(options.signal && { signal: options.signal }),
  });
}

const proposersIn = (result: ImproveResult): number => Math.max(1, result.stages.filter((stage) => stage.label.startsWith('invariant')).length);

function editorShortfall(state: HealState): string | undefined {
  const k = editorsOf(state.settings).proposers;
  if (k <= 1) return undefined;
  const last = readCycles(state.dir).find((cycle) => cycle.id !== state.cycle.id && cycle.result !== undefined);
  if (!last?.result) return undefined;
  const before = proposersIn(last.result);
  const after = (last.canary?.tokens ?? 0) + (last.guard?.tokens ?? 0);
  const needed = Math.ceil((last.result.spend.tokens / before) * k) + after;
  const left = state.cap - state.spent;
  if (needed <= left) return undefined;
  return `With ${k} proposers the editors, their runs and what follows need about ${needed} tokens, scaled from the last cycle's ${last.result.spend.tokens} with ${before}, more than the ${Math.max(0, left)} left, so the editors didn't run.`;
}

async function noProposal(state: HealState, result: ImproveResult & { outcome: Exclude<ImproveResult['outcome'], 'proposal'> }): Promise<HealCycle> {
  if (result.outcome !== 'keep-base' || !result.gate?.length) return finish(state, result.outcome, result.reason);
  const { cycle } = state;
  await appendAudit(state.dir, { actor: 'gate', action: 'reject', from: cycle.from, cycle: cycle.id, reason: `Not applied, the gate rejected it: ${result.reason}`, evidence: { gate: result.reason, cases: counts(result.cases) } });
  return rejected(state, result.outcome, result.reason);
}

async function runCanary(state: HealState, result: ImproveResult, candidate: Harness, holdout: readonly string[]): Promise<CanaryReplayResult> {
  const training = (result.cases ?? []).filter((verdict) => verdict.role === 'training').map((verdict) => verdict.caseId);
  const canary = await canaryReplay({
    base: state.harness,
    candidate,
    training,
    protected: holdout,
    probe: metered(state),
    runs: state.settings.canary.replayRuns,
    firstRepeat: CANARY_FIRST_REPEAT,
    ...(state.options.signal && { signal: state.options.signal }),
  });
  const verdict = canary.passed ? 'passed' : 'failed';
  await appendAudit(state.dir, { actor: 'canary', action: 'canary-end', from: state.cycle.from, to: harnessHash(candidate), cycle: state.cycle.id, reason: `The replay canary ${verdict}: ${canary.reason}`, evidence: { cases: counts(canary.cases) } });
  return canary;
}

async function queue(state: HealState, result: ImproveResult): Promise<HealCycle> {
  try {
    const pending = await savePending(state.dir, { result, base: state.harness, card: formatImproveResult(result), cycle: state.cycle.id, maxAlwaysOnChars: MAX_ALWAYS_ON });
    return finish(state, 'pending', `Queued for approval as ${pending.id}; approve it with lousho improve approve.`, { pending: pending.id });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return rejected(state, 'refused', error.message);
  }
}

function pausedStop(state: HealState, when: string): HealCycle | undefined {
  const { paused } = recheck(state);
  return paused ? finish(state, 'paused', `Paused ${when}: ${paused}. Nothing was applied.`) : undefined;
}

async function decide(state: HealState, result: ImproveResult, candidate: Harness, holdout: readonly string[]): Promise<HealCycle> {
  const before = pausedStop(state, 'before the canary');
  if (before) return before;
  const canary = await runCanary(state, result, candidate, holdout);
  state.cycle.canary = canary;
  checkpoint(state);
  if (!canary.passed) return rejected(state, 'canary-failed', canary.reason);
  const now = recheck(state);
  if (now.paused) return finish(state, 'paused', `Paused before the write: ${now.paused}. Nothing was applied.`);
  state.cycle.approval = now.approval;
  return now.approval === 'auto' ? applyAndGuard(state, result) : queue(state, result);
}

async function work(state: HealState, captured: Captured): Promise<HealCycle> {
  try {
    const corpus = await admit(state, captured);
    checkpoint(state);
    const holdout = [...new Set(corpus.map((item) => item.id))];
    const paused = pausedStop(state, 'before the editors ran');
    if (paused) return paused;
    if (state.spent >= state.cap) throw new BudgetSpent();
    const shortfall = editorShortfall(state);
    if (shortfall) return finish(state, 'budget-exceeded', shortfall);
    const result = await propose(state, captured, holdout);
    state.cycle.result = result;
    state.spent += result.spend.tokens;
    checkpoint(state);
    if (result.outcome !== 'proposal') return await noProposal(state, { ...result, outcome: result.outcome });
    if (!result.harness) return finish(state, 'keep-base', result.reason);
    return await decide(state, result, result.harness, holdout);
  } catch (error) {
    if (error instanceof BudgetSpent) return finish(state, 'budget-exceeded', `Stopped at the cycle's ${state.cap} token budget; nothing was applied.`);
    throw error;
  }
}

function idleReason(options: HealOptions, trigger: HealCycle['trigger'], revision: string): string {
  const twice = recurringOnly(options, trigger) ? ' that failed the same way in two or more runs' : '';
  return `No failed run under revision ${shortId(revision)} with a recorded input${twice}, so there is nothing to learn from.`;
}

async function run(options: HealOptions, start: Start, harness: Harness, cap: number): Promise<HealCycle> {
  const revision = harnessHash(harness);
  if (start.trigger === 'failures' && !enoughNewFailures(options, revision)) {
    return ended(start, 'idle', `Fewer than ${options.settings.trigger.minNewFailures} new failed runs under revision ${shortId(revision)} since the last cycle.`);
  }
  const captured = capture(options, start.trigger, revision);
  if (captured.failures.length === 0) return ended(start, 'idle', idleReason(options, start.trigger, revision));
  const cycle: HealCycle = { ...start, outcome: 'interrupted', reason: 'The cycle stopped before it finished.', from: revision };
  const errors = new Set<string>();
  const probe = unscored(caseProbe([...captured.failures, ...captured.passes, ...corpusCases(captured.corpus)], options.runCase, options.check), errors, options.signal);
  const fileApproval = fileApprovalOf(options.dir);
  const state: HealState = { options, dir: options.dir, settings: options.settings, cycle, harness, cap, spent: 0, errors, probe, library: libraryOf(options.dir, options.settings), ...(fileApproval && { fileApproval }) };
  writeCycle(options.dir, cycle);
  try {
    const done = await work(state, captured);
    writeCycle(options.dir, done);
    return done;
  } catch (error) {
    writeCycle(options.dir, finish(state, 'interrupted', `The cycle stopped before it finished: ${messageOf(error)}`));
    throw error;
  }
}

async function locked(options: HealOptions, start: Start, now: number): Promise<HealCycle> {
  const harness = readAgentHarness(options.dir);
  const recovered = await guardUnfinished(options, harness, UNLIMITED);
  const current = recovered?.rolledBackTo ? readAgentHarness(options.dir) : harness;
  const cap = blocked(options, start, now);
  if (typeof cap !== 'number') return cap;
  return run(options, start, current, cap);
}

/** Runs one detect, capture, propose, gate, canary, apply-or-queue and guard cycle for an agent directory, and records it under .lousho/cycles/. */
export async function healOnce(options: HealOptions): Promise<HealCycle> {
  const now = Date.now();
  const start: Start = { id: newCycleId(now), trigger: options.trigger ?? 'failures', approval: options.settings.approval, startedAt: new Date(now).toISOString(), tokens: 0 };
  const paused = pausedBy(options.dir, options.settings);
  if (paused) return ended(start, 'paused', `Paused: ${paused}.`);
  let held = false;
  try {
    return await withFileLock(
      lockFile(options.dir),
      () => {
        held = true;
        return locked(options, start, now);
      },
      { timeoutMs: 0, busyCode: 'LOUSHO_STORAGE_BUSY' }
    );
  } catch (error) {
    if (!held && error instanceof SDKError && error.code === 'LOUSHO_STORAGE_BUSY') return ended(start, 'busy', 'Another cycle is running for this agent directory.');
    throw error;
  }
}
