import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ConfigurationError, SDKError } from '../execution/errors';
import type { AgentHook } from '../execution/hooks';
import { runsByRevision } from '../observe/store';
import { withFileLock } from '../storage/fileLock';
import type { SqlDatabase } from '../storage/sqlite/driver';
import { applyProposal, rollbackHarness } from './apply';
import { appendAudit } from './audit';
import { canaryReplay, type CanaryReplayResult } from './canary';
import { admitProtectedCases, casesFromFailures, probeCapturedCases, protectedCasesFromPasses, scoreCase, type CapturedCase, type CaseCheck } from './cases';
import { addToCorpus, readCorpus, type CorpusCase } from './corpus';
import { guardCorpus, type GuardCorpusResult } from './corpusGuard';
import { cooldownEnds, newCycleId, pausedBy, readCycles, usageToday, writeCycle, type HealCycle } from './cycles';
import { formatImproveResult } from './format';
import { STALE_FIELD } from './harnessWriter';
import { improveAgent } from './improve';
import { libraryFiles, libraryHome, type LibraryEntry } from './library';
import { savePending } from './pending';
import { casesFromRecoveries, readableInput } from './recoveries';
import { reflect, voteOnOutcome } from './reflect';
import { harnessHash, readAgentHarness } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import type { CaseVerdict, Harness, ImproveOptions, ImproveResult, RecoveryEvidence } from './types';

/** Options for {@link healOnce}. */
export interface HealOptions {
  /** The agent directory; its instructions must live in instructions.md. */
  dir: string;
  /** The local observe database the failed runs come from. */
  db: SqlDatabase;
  /** Scores each answer. */
  check: CaseCheck;
  /** Runs the agent on one recorded input under a harness. */
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
  /** Stops the cycle when aborted; an apply that has started always finishes. */
  signal?: AbortSignal;
}

const LOUSHO = '.lousho';
const MAX_RUNS = 1000;
const MAX_ERRORS = 10;
const ADMISSION_RUNS = 6;
const CANARY_FIRST_REPEAT = 100;
const MAX_ALWAYS_ON = 8000;
const DEFAULT_EDITOR_TIMEOUT_MS = 10 * 60 * 1000;
const UNLIMITED = Number.POSITIVE_INFINITY;

class BudgetSpent extends Error {}

interface Library {
  dir: string;
  domain: string;
  files: Record<string, string>;
}

interface State {
  options: HealOptions;
  dir: string;
  settings: ImproveSettings;
  cycle: HealCycle;
  harness: Harness;
  cap: number;
  spent: number;
  errors: Set<string>;
  probe: ImproveOptions['probe'];
  library?: Library;
}

interface Captured {
  failures: CapturedCase[];
  passes: CapturedCase[];
  corpus: CorpusCase[];
}

type Start = Pick<HealCycle, 'id' | 'trigger' | 'approval' | 'startedAt' | 'tokens'>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function ended(start: Start, outcome: HealCycle['outcome'], reason: string): HealCycle {
  return { ...start, outcome, reason, endedAt: new Date().toISOString() };
}

function lockFile(dir: string): string {
  const lousho = path.join(dir, LOUSHO);
  if (lstatSync(lousho, { throwIfNoEntry: false })?.isSymbolicLink()) throw new ConfigurationError(`${lousho} is a symlink; the self-healing state must live inside the agent directory.`, 'dir');
  mkdirSync(lousho, { recursive: true });
  return path.join(lousho, 'cycle.lock');
}

function pausedNow(dir: string, settings: ImproveSettings): string | undefined {
  try {
    return pausedBy(dir, { enabled: settings.enabled && loadImproveSettings(dir).enabled });
  } catch (error) {
    return `improve.json can't be read (${messageOf(error)})`;
  }
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

const readable = (captured: CapturedCase): CapturedCase => ({ ...captured, input: readableInput(captured.input) });

function capture(options: HealOptions, trigger: HealCycle['trigger'], revision: string): Captured {
  const corpus = readCorpus(options.dir);
  const traceIds = revisionTraces(options, revision, options.since).map((run) => run.traceId);
  if (traceIds.length === 0) return { failures: [], passes: [], corpus };
  const filter = { traceIds, recurring: options.settings.trigger.requireRecurring && trigger !== 'score', ...(options.since !== undefined && { since: options.since }) };
  const inCorpus = new Set(corpus.map((item) => item.traceId));
  const recovered = new Map(options.withRecoveries ? casesFromRecoveries(options.db, filter).map((captured) => [captured.id, captured]) : []);
  const failures = casesFromFailures(options.db, filter)
    .filter((captured) => !inCorpus.has(captured.traceId))
    .map((captured) => readable(recovered.get(captured.id) ?? captured));
  const failed = new Set(failures.map((captured) => captured.traceId));
  const passes = protectedCasesFromPasses(options.db, options.protect ?? [])
    .filter((captured) => !failed.has(captured.traceId) && !inCorpus.has(captured.traceId))
    .map(readable);
  return { failures, passes, corpus };
}

function unscored(probe: ImproveOptions['probe'], errors: Set<string>, signal: AbortSignal | undefined): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    try {
      return await probe(harness, caseId, repeat);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.add(messageOf(error));
      return { passed: null, transcript: '', tokens: 0, ended: `error: ${messageOf(error)}` };
    }
  };
}

function metered(state: State): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    if (state.spent >= state.cap) throw new BudgetSpent();
    const run = await state.probe(harness, caseId, repeat);
    state.spent += run.tokens;
    return run;
  };
}

function corpusProbeCases(corpus: readonly CorpusCase[]): CapturedCase[] {
  return corpus.map((item) => ({ id: item.id, input: item.input, traceId: item.traceId, kind: 'protected' }));
}

function libraryOf(dir: string, settings: ImproveSettings): Library | undefined {
  if (!settings.library.enabled) return undefined;
  const home = libraryHome(dir, settings.library.domain);
  return { ...home, files: libraryFiles(home.dir, home.domain) };
}

function checkedRecoveries(captured: Captured, check: CaseCheck): RecoveryEvidence[] {
  const guarded = new Set([...captured.passes, ...captured.corpus].map((item) => item.traceId));
  return captured.failures.flatMap(({ input, recovery }) => (recovery && !guarded.has(recovery.traceId) && scoreCase(check, input, recovery.answer).passed === true ? [recovery] : []));
}

function finish(state: State, outcome: HealCycle['outcome'], reason: string, extra: Partial<HealCycle> = {}): HealCycle {
  const errors = [...state.errors].slice(0, MAX_ERRORS);
  return Object.assign(state.cycle, extra, { outcome, reason, endedAt: new Date().toISOString(), tokens: state.spent, ...(errors.length > 0 && { errors }) });
}

const counts = (cases: readonly CaseVerdict[] | undefined) => cases?.map((verdict) => ({ caseId: verdict.caseId, base: `${verdict.base.passed}/${verdict.base.scored}`, final: `${verdict.final.passed}/${verdict.final.scored}` }));

async function admit(state: State, captured: Captured): Promise<CorpusCase[]> {
  if (captured.passes.length === 0) return captured.corpus;
  const { admitted } = await admitProtectedCases({ harness: state.harness, cases: captured.passes, probe: metered(state), runs: ADMISSION_RUNS });
  if (admitted.length === 0) return captured.corpus;
  const addedAt = new Date().toISOString();
  const revision = state.cycle.from as string;
  const cases = admitted.map((item): CorpusCase => ({ id: item.id, traceId: item.traceId, input: item.input, addedAt, revision, origin: 'protected', baseline: { passed: ADMISSION_RUNS, scored: ADMISSION_RUNS } }));
  return addToCorpus(state.dir, cases, state.settings.guard.maxCases);
}

function propose(state: State, captured: Captured, holdout: readonly string[]): Promise<ImproveResult> {
  const { options, settings } = state;
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
    ...(recoveries.length > 0 && { recoveries }),
    ...(Object.keys(library).length > 0 && { library }),
    ...(options.editorHooks && { editorHooks: options.editorHooks }),
    ...(options.signal && { signal: options.signal }),
  });
}

function sessionSignal(options: HealOptions): AbortSignal {
  const timer = AbortSignal.timeout(options.editorTimeoutMs ?? DEFAULT_EDITOR_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, timer]) : timer;
}

async function learn(state: State, outcome: LibraryEntry['outcome']): Promise<string | undefined> {
  const { options, library, cycle } = state;
  const result = cycle.result;
  const remaining = state.cap - state.spent;
  if (!library || !result || !(options.reflect ?? true) || remaining <= 0 || options.signal?.aborted) return undefined;
  const reflection = await reflect({
    dir: library.dir,
    domain: library.domain,
    result,
    outcome,
    revision: cycle.from as string,
    editor: options.editor,
    ...(Number.isFinite(remaining) && { maxTokens: remaining }),
    ...(options.editorHooks && { hooks: options.editorHooks }),
    signal: sessionSignal(options),
  });
  state.spent += reflection.tokens;
  if (reflection.error !== undefined) await appendAudit(state.dir, { actor: 'scheduler', action: 'reflect-fail', from: cycle.from, cycle: cycle.id, reason: `The reflection failed, so no lesson was stored: ${reflection.error}` });
  return reflection.entry?.id;
}

async function rejected(state: State, outcome: HealCycle['outcome'], reason: string, extra: Partial<HealCycle> = {}): Promise<HealCycle> {
  await learn(state, 'rejected');
  return finish(state, outcome, reason, extra);
}

async function noProposal(state: State, result: ImproveResult & { outcome: Exclude<ImproveResult['outcome'], 'proposal'> }): Promise<HealCycle> {
  if (result.outcome !== 'keep-base' || !result.gate?.length) return finish(state, result.outcome, result.reason);
  const { cycle } = state;
  await appendAudit(state.dir, { actor: 'gate', action: 'reject', from: cycle.from, cycle: cycle.id, reason: `Not applied, the gate rejected it: ${result.reason}`, evidence: { gate: result.reason, cases: counts(result.cases) } });
  return rejected(state, result.outcome, result.reason);
}

async function runCanary(state: State, result: ImproveResult, candidate: Harness, holdout: readonly string[]): Promise<CanaryReplayResult> {
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

async function undoApply(state: State, to: string, reason: string): Promise<string | undefined> {
  try {
    return (await rollbackHarness(state.dir, state.cycle.from as string, { actor: 'guard', reason, expectedFrom: to })).to;
  } catch (error) {
    if (error instanceof ConfigurationError) return undefined;
    throw error;
  }
}

async function runGuard(state: State, to: string): Promise<{ guard?: GuardCorpusResult; rolledBackTo?: string; reason: string }> {
  let guard: GuardCorpusResult;
  try {
    guard = await guardCorpus(state.dir, { probe: state.probe, runs: state.settings.guard.runs, rollback: true });
  } catch (error) {
    const reason = `The corpus guard could not run, so the edit was undone: ${messageOf(error)}`;
    return { reason, rolledBackTo: await undoApply(state, to, reason) };
  }
  if (guard.rolledBackTo || !guard.cases.some((item) => item.class === 'regressed')) return { guard, reason: guard.reason, ...(guard.rolledBackTo && { rolledBackTo: guard.rolledBackTo }) };
  const rolledBackTo = await undoApply(state, to, guard.reason);
  return { guard, reason: guard.reason, ...(rolledBackTo && { rolledBackTo }) };
}

async function rolledBack(state: State, reason: string, extra: Partial<HealCycle>): Promise<HealCycle> {
  const entryId = await learn(state, 'rolled-back');
  const { library, cycle } = state;
  if (library && cycle.result) voteOnOutcome(library.dir, { outcome: 'rolled-back', result: cycle.result, domain: library.domain, library: library.files, ...(entryId && { entryId }) });
  return finish(state, 'guard-rolled-back', reason, extra);
}

async function applyAndGuard(state: State, result: ImproveResult): Promise<HealCycle> {
  let to: string;
  try {
    to = (await applyProposal(state.dir, { result, base: state.harness, cycle: state.cycle.id, maxAlwaysOnChars: MAX_ALWAYS_ON }, { mode: 'auto', by: 'canary' })).to;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return rejected(state, error.field === STALE_FIELD ? 'stale' : 'refused', error.message);
  }
  state.cycle.to = to;
  const { guard, rolledBackTo, reason } = await runGuard(state, to);
  state.spent += guard?.tokens ?? 0;
  const extra = { ...(guard && { guard }), ...(rolledBackTo && { rolledBackTo }) };
  if (rolledBackTo) return rolledBack(state, `Applied ${to.slice(0, 12)}, then rolled back to ${rolledBackTo.slice(0, 12)}: ${reason}`, extra);
  const held = guard !== undefined && !guard.cases.some((item) => item.class === 'regressed');
  const note = held ? reason : `${reason} The rollback was refused, so the edit stays and the monitor still checks it.`;
  return finish(state, 'applied', `Applied ${to.slice(0, 12)}. ${note}`, extra);
}

async function queue(state: State, result: ImproveResult): Promise<HealCycle> {
  try {
    const pending = await savePending(state.dir, { result, base: state.harness, card: formatImproveResult(result), cycle: state.cycle.id, maxAlwaysOnChars: MAX_ALWAYS_ON });
    return finish(state, 'pending', `Queued for approval as ${pending.id}; approve it with lousho improve approve.`, { pending: pending.id });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return rejected(state, 'refused', error.message);
  }
}

async function decide(state: State, result: ImproveResult, candidate: Harness, holdout: readonly string[]): Promise<HealCycle> {
  const canary = await runCanary(state, result, candidate, holdout);
  state.cycle.canary = canary;
  if (!canary.passed) return rejected(state, 'canary-failed', canary.reason);
  const paused = pausedNow(state.dir, state.settings);
  if (paused) return finish(state, 'paused', `Paused before the write: ${paused}. Nothing was applied.`);
  return state.settings.approval === 'auto' ? applyAndGuard(state, result) : queue(state, result);
}

async function work(state: State, captured: Captured): Promise<HealCycle> {
  try {
    const corpus = await admit(state, captured);
    const holdout = [...new Set(corpus.map((item) => item.id))];
    if (state.spent >= state.cap) throw new BudgetSpent();
    const result = await propose(state, captured, holdout);
    state.cycle.result = result;
    state.spent += result.spend.tokens;
    if (result.outcome !== 'proposal') return await noProposal(state, { ...result, outcome: result.outcome });
    if (!result.harness) return finish(state, 'keep-base', result.reason);
    return await decide(state, result, result.harness, holdout);
  } catch (error) {
    if (error instanceof BudgetSpent) return finish(state, 'budget-exceeded', `Stopped at the cycle's ${state.cap} token budget; nothing was applied.`);
    throw error;
  }
}

async function locked(options: HealOptions, start: Start, now: number): Promise<HealCycle> {
  const cap = blocked(options, start, now);
  if (typeof cap !== 'number') return cap;
  const harness = readAgentHarness(options.dir);
  const revision = harnessHash(harness);
  if (start.trigger === 'failures' && !enoughNewFailures(options, revision)) {
    return ended(start, 'idle', `Fewer than ${options.settings.trigger.minNewFailures} new failed runs under revision ${revision.slice(0, 12)} since the last cycle.`);
  }
  const captured = capture(options, start.trigger, revision);
  if (captured.failures.length === 0) return ended(start, 'idle', `No failed run under revision ${revision.slice(0, 12)} with a recorded input${options.settings.trigger.requireRecurring && start.trigger !== 'score' ? ' failed the same way twice' : ''}, so there is nothing to learn from.`);
  const cycle: HealCycle = { ...start, outcome: 'interrupted', reason: 'The cycle stopped before it finished.', from: revision };
  const errors = new Set<string>();
  const all = [...captured.failures, ...captured.passes, ...corpusProbeCases(captured.corpus)];
  const probe = unscored(probeCapturedCases(all, options.runCase, options.check), errors, options.signal);
  const state: State = { options, dir: options.dir, settings: options.settings, cycle, harness, cap, spent: 0, errors, probe, library: libraryOf(options.dir, options.settings) };
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
