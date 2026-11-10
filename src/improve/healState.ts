import { appendAudit } from './audit';
import { probeCapturedCases, type CapturedCase, type CaseCheck } from './cases';
import { pausedBy, writeCycle, type HealCycle } from './cycles';
import type { HealOptions } from './heal';
import { libraryFiles, libraryHome, type LibraryEntry } from './library';
import { readableInput } from './recoveries';
import { reflect, voteOnOutcome } from './reflect';
import { loadImproveSettings, type ImproveSettings } from './settings';
import type { CaseVerdict, Harness, ImproveOptions } from './types';

export const MAX_ALWAYS_ON = 8000;
export const DEFAULT_EDITOR_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERRORS = 10;

export class BudgetSpent extends Error {}

export interface Library {
  dir: string;
  domain: string;
  files: Record<string, string>;
}

export interface HealState {
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
  fileApproval?: ImproveSettings['approval'];
}

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const shortId = (id: string | undefined): string => (id ?? '').slice(0, 12);

export function caseProbe(cases: readonly CapturedCase[], runCase: HealOptions['runCase'], check: CaseCheck): ImproveOptions['probe'] {
  return probeCapturedCases(cases, runCase, (input, answer) => check(readableInput(input), answer));
}

export function unscored(probe: ImproveOptions['probe'], errors: Set<string>, signal: AbortSignal | undefined): ImproveOptions['probe'] {
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

export function counted(state: HealState): ImproveOptions['probe'] {
  return async (harness, caseId, repeat) => {
    const run = await state.probe(harness, caseId, repeat);
    state.spent += run.tokens;
    return run;
  };
}

export function metered(state: HealState): ImproveOptions['probe'] {
  const probe = counted(state);
  return async (harness, caseId, repeat) => {
    if (state.spent >= state.cap) throw new BudgetSpent();
    return probe(harness, caseId, repeat);
  };
}

export function finish(state: HealState, outcome: HealCycle['outcome'], reason: string, extra: Partial<HealCycle> = {}): HealCycle {
  const errors = [...state.errors].slice(0, MAX_ERRORS);
  return Object.assign(state.cycle, extra, { outcome, reason, endedAt: new Date().toISOString(), tokens: state.spent, ...(errors.length > 0 && { errors }) });
}

export function checkpoint(state: HealState): void {
  writeCycle(state.dir, { ...state.cycle, tokens: state.spent });
}

export function fileApprovalOf(dir: string): ImproveSettings['approval'] | undefined {
  try {
    return loadImproveSettings(dir).approval;
  } catch {
    return undefined;
  }
}

export function recheck(state: HealState): { paused?: string; approval: ImproveSettings['approval'] } {
  try {
    const file = loadImproveSettings(state.dir);
    const paused = pausedBy(state.dir, { enabled: state.settings.enabled && file.enabled });
    const switched = state.fileApproval === 'auto' && file.approval === 'manual';
    return { ...(paused && { paused }), approval: switched ? 'manual' : state.settings.approval };
  } catch (error) {
    return { paused: `improve.json can't be read (${messageOf(error)})`, approval: 'manual' };
  }
}

export function libraryOf(dir: string, settings: ImproveSettings): Library | undefined {
  if (!settings.library.enabled) return undefined;
  const home = libraryHome(dir, settings.library.domain);
  return { ...home, files: libraryFiles(home.dir, home.domain) };
}

export const counts = (cases: readonly CaseVerdict[] | undefined) => cases?.map((verdict) => ({ caseId: verdict.caseId, base: `${verdict.base.passed}/${verdict.base.scored}`, final: `${verdict.final.passed}/${verdict.final.scored}` }));

function sessionSignal(options: HealOptions): AbortSignal {
  const timer = AbortSignal.timeout(options.editorTimeoutMs ?? DEFAULT_EDITOR_TIMEOUT_MS);
  return options.signal ? AbortSignal.any([options.signal, timer]) : timer;
}

async function learn(state: HealState, outcome: LibraryEntry['outcome']): Promise<string | undefined> {
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

export async function rejected(state: HealState, outcome: HealCycle['outcome'], reason: string, extra: Partial<HealCycle> = {}): Promise<HealCycle> {
  await learn(state, 'rejected');
  return finish(state, outcome, reason, extra);
}

export async function reflectAndVote(state: HealState, outcome: 'rolled-back'): Promise<void> {
  const entryId = await learn(state, outcome);
  const { library, cycle } = state;
  if (library && cycle.result) voteOnOutcome(library.dir, { outcome, result: cycle.result, domain: library.domain, library: library.files, ...(entryId && { entryId }) });
}
