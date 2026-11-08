import { ConfigurationError } from '../execution/errors';
import { applyProposal, rollbackHarness } from './apply';
import type { CapturedCase } from './cases';
import { readCorpus, type CorpusCase } from './corpus';
import { guardCorpus, type GuardCorpusResult } from './corpusGuard';
import { readCycles, writeCycle, type HealCycle } from './cycles';
import type { HealOptions } from './heal';
import { STALE_FIELD } from './harnessWriter';
import { caseProbe, checkpoint, counted, finish, libraryOf, MAX_ALWAYS_ON, messageOf, reflectAndVote, rejected, shortId, unscored, type HealState } from './healState';
import { harnessHash } from './revisions';
import type { Harness, ImproveResult } from './types';

interface GuardCheck {
  guard?: GuardCorpusResult;
  reason: string;
  undo: boolean;
  regressed: boolean;
}

export function corpusCases(corpus: readonly CorpusCase[]): CapturedCase[] {
  return corpus.map((item) => ({ id: item.id, input: item.input, traceId: item.traceId, kind: 'protected' }));
}

async function runGuard(state: HealState): Promise<GuardCheck> {
  let guard: GuardCorpusResult;
  try {
    guard = await guardCorpus(state.dir, { probe: counted(state), runs: state.settings.guard.runs, rollback: false });
  } catch (error) {
    return { reason: `The corpus guard could not run (${messageOf(error)}), so the edit is undone.`, undo: true, regressed: false };
  }
  if (guard.passed) return { guard, reason: guard.reason, undo: false, regressed: false };
  const regressed = guard.cases.some((item) => item.class === 'regressed');
  return { guard, reason: regressed ? guard.reason : `${guard.reason} A guard that can't judge counts as a failure, so the edit is undone.`, undo: true, regressed };
}

async function undoApply(state: HealState, to: string, reason: string): Promise<{ to: string } | { refused: string }> {
  try {
    return { to: (await rollbackHarness(state.dir, state.cycle.from as string, { actor: 'guard', reason, expectedFrom: to })).to };
  } catch (error) {
    if (error instanceof ConfigurationError) return { refused: error.message };
    throw error;
  }
}

async function guardApplied(state: HealState, to: string): Promise<HealCycle> {
  const check = await runGuard(state);
  if (check.guard) state.cycle.guard = check.guard;
  checkpoint(state);
  if (!check.undo) return finish(state, 'applied', `Applied ${shortId(to)}. ${check.reason}`);
  const undone = await undoApply(state, to, check.reason);
  if ('refused' in undone) return finish(state, 'applied', `Applied ${shortId(to)}. ${check.reason} The rollback to ${shortId(state.cycle.from)} was refused (${undone.refused}), so the edit stays and the monitor still checks it.`);
  const reason = `Applied ${shortId(to)}, then rolled back to ${shortId(undone.to)}: ${check.reason}`;
  if (check.regressed) await reflectAndVote(state, 'rolled-back');
  return finish(state, 'guard-rolled-back', reason, { rolledBackTo: undone.to });
}

function guardShortfall(state: HealState): string | undefined {
  const { canary } = state.cycle;
  const size = readCorpus(state.dir).length;
  if (!canary || size === 0) return undefined;
  const runs = canary.cases.reduce((sum, verdict) => sum + verdict.final.scored + verdict.base.scored, 0);
  const needed = Math.ceil(size * state.settings.guard.runs * (canary.tokens / Math.max(1, runs)));
  const left = state.cap - state.spent;
  if (needed <= left) return undefined;
  return `The corpus guard that must follow an apply needs about ${needed} tokens, more than the ${Math.max(0, left)} left, so nothing was applied.`;
}

/** Applies a proposal that passed the gate and the canary, then guards it with the corpus and undoes it on a regression or a guard that can't judge. */
export async function applyAndGuard(state: HealState, result: ImproveResult): Promise<HealCycle> {
  const shortfall = guardShortfall(state);
  if (shortfall) return finish(state, 'budget-exceeded', shortfall);
  let to: string;
  try {
    to = (await applyProposal(state.dir, { result, base: state.harness, cycle: state.cycle.id, maxAlwaysOnChars: MAX_ALWAYS_ON }, { mode: 'auto', by: 'canary' })).to;
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    if (error.field === STALE_FIELD) return finish(state, 'stale', error.message);
    return rejected(state, 'refused', error.message);
  }
  state.cycle.to = to;
  checkpoint(state);
  return guardApplied(state, to);
}

/** Guards an apply whose cycle stopped before its guard ran, when the directory still holds that revision. */
export async function guardUnfinished(options: HealOptions, harness: Harness, cap: number): Promise<HealCycle | undefined> {
  const last = readCycles(options.dir)[0];
  if (last?.outcome !== 'interrupted' || last.to === undefined || last.guard !== undefined || harnessHash(harness) !== last.to) return undefined;
  const errors = new Set<string>();
  const probe = unscored(caseProbe(corpusCases(readCorpus(options.dir)), options.runCase, options.check), errors, undefined);
  const state: HealState = { options, dir: options.dir, settings: options.settings, cycle: last, harness, cap, spent: last.tokens, errors, probe, library: libraryOf(options.dir, options.settings) };
  const done = await guardApplied(state, last.to);
  done.reason = `Guarded after an interruption. ${done.reason}`;
  writeCycle(options.dir, done);
  return done;
}
