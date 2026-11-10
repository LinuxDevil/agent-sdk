import { ConfigurationError } from '../execution/errors';
import { rollbackHarness } from './apply';
import { guardCorpus, type GuardCorpusResult } from './corpusGuard';
import { addSpentToday } from './cycles';
import { messageOf } from './healState';
import { harnessHash, readAgentHarness } from './revisions';
import type { ImproveOptions } from './types';

export interface GuardCheck {
  guard?: GuardCorpusResult;
  reason: string;
  undo: boolean;
  regressed: boolean;
}

export async function judgeGuard(dir: string, probe: ImproveOptions['probe'], runs: number): Promise<GuardCheck> {
  let guard: GuardCorpusResult;
  try {
    guard = await guardCorpus(dir, { probe, runs, rollback: false });
  } catch (error) {
    return { reason: `The corpus guard could not run (${messageOf(error)}), so the edit is undone.`, undo: true, regressed: false };
  }
  if (guard.passed) return { guard, reason: guard.reason, undo: false, regressed: false };
  const regressed = guard.cases.some((item) => item.class === 'regressed');
  return { guard, reason: regressed ? guard.reason : `${guard.reason} A guard that can't judge counts as a failure, so the edit is undone.`, undo: true, regressed };
}

/** Options for {@link guardApproval}. */
export interface GuardApprovalOptions {
  /** Runs one corpus case under a harness; it must resolve corpus ids to their inputs (see `readCorpus`). */
  probe: ImproveOptions['probe'];
  /** Fresh runs per corpus case (`settings.guard.runs`, default 3). */
  runs?: number;
}

/** What {@link guardApproval} found and did. */
export interface GuardApprovalResult {
  /** Whether the guard passed, so the approved edit stays. */
  passed: boolean;
  /** The guard's verdict, unless it could not run. */
  guard?: GuardCorpusResult;
  /** The approved revision's parent, when the edit was rolled back. */
  rolledBackTo?: string;
  /** Why, in a sentence or two. */
  reason: string;
}

/** Runs the corpus guard right after an approval, and rolls back to the approved revision's parent when a case regressed or the guard can't judge. */
export async function guardApproval(dir: string, applied: { from: string; to: string }, options: GuardApprovalOptions): Promise<GuardApprovalResult> {
  const current = harnessHash(readAgentHarness(dir));
  if (current !== applied.to) {
    return { passed: false, reason: `The directory changed after the approval (it is now ${current.slice(0, 12)}, not ${applied.to.slice(0, 12)}), so the guard didn't run; a watcher's scheduled guard checks what is there.` };
  }
  let tokens = 0;
  const probe: ImproveOptions['probe'] = async (harness, caseId, repeat) => {
    const run = await options.probe(harness, caseId, repeat);
    tokens += run.tokens;
    return run;
  };
  const check = await judgeGuard(dir, probe, options.runs ?? 3);
  await addSpentToday(dir, tokens, Date.now());
  const guard = check.guard ? { guard: check.guard } : {};
  if (!check.undo) return { passed: true, ...guard, reason: check.reason };
  try {
    const rolled = await rollbackHarness(dir, applied.from, { actor: 'guard', reason: check.reason, expectedFrom: applied.to });
    return { passed: false, ...guard, rolledBackTo: rolled.to, reason: `${check.reason} Rolled back to ${rolled.to.slice(0, 12)}.` };
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    return { passed: false, ...guard, reason: `${check.reason} The rollback to ${applied.from.slice(0, 12)} was refused (${error.message}), so the edit stays and the monitor still checks it.` };
  }
}
