import { SDKError } from '../execution/errors';
import type { GoalCheck, GoalCheckResult, GoalSpec } from './contract';
import { progressOf, toCheckpoint, type GoalCheckpointStore, type GoalProgress } from './goalCheckpoint';

/** Tokens and spend of a goal run or one of its iterations. */
export interface GoalUsage {
  /** Tokens sent to models. */
  inputTokens: number;
  /** Tokens models generated. */
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
  /** USD; absent when no turn reported a price. */
  costUsd?: number;
}

/** What one lead turn returns. */
export interface GoalLeadTurn {
  /** The lead's final text. */
  text: string;
  /** The lead's structured output, when it has one; the check reads it, else the text. */
  output?: unknown;
  /** The turn's usage, delegates included. */
  usage: GoalUsage;
}

/** The lead of a goal loop: one turn per iteration in one session. The engine (P3.6) builds it from the page's lead attachment and its delegate tools. */
export interface GoalLead {
  /** Runs one turn; `stepIndex` is the iteration's step index, the parent of any delegate step the turn starts. */
  run(prompt: string, context: { iteration: number; stepIndex: number; signal: AbortSignal }): Promise<GoalLeadTurn>;
}

/** Hands out the run-wide step index shared with delegate steps (`PageStepLabels.stepIndex`). */
export interface GoalStepCounter {
  /** The next index; each call returns one more than the last. */
  next(): number;
  /** The index `next()` would return, without taking it. */
  peek(): number;
}

/** A `goal-iteration` step began or ended. */
export interface GoalStepEvent {
  /** Always `goal-iteration`. */
  kind: 'goal-iteration';
  /** `start` or `done`. */
  phase: 'start' | 'done';
  /** The iteration, from 1. */
  iteration: number;
  /** Its run-wide step index. */
  stepIndex: number;
}

/** Why a goal run ended. */
export type GoalOutcome = 'done' | 'max-iterations' | 'max-duration' | 'budget' | 'stalled' | 'aborted' | 'error';

/** One finished iteration. */
export interface GoalIteration {
  /** The iteration, from 1. */
  index: number;
  /** Its run-wide step index. */
  stepIndex: number;
  /** The lead's text. */
  text: string;
  /** What the check read. */
  output: unknown;
  /** The check's verdict. */
  check: GoalCheckResult;
  /** The turn's usage. */
  usage: GoalUsage;
}

/** Runtime limits added on top of `goal.json` `stop`; the lower value of each wins. */
export interface GoalRunLimits {
  /** The run's spend cap (P5.30) or the page's `maxCostUsd`. */
  maxCostUsd?: number;
  /** The page's `maxDurationMs`. */
  maxDurationMs?: number;
  /** A token ceiling for the whole loop (the pilot's shared `maxTokens`, P3.7). */
  maxTokens?: number;
}

/** What `runGoal` returns; the status words are `PageRunStatus` words. */
export interface GoalRunResult {
  /** `ok` when the goal was met; `failed`, `timed-out` or `cancelled` otherwise. */
  status: 'ok' | 'failed' | 'timed-out' | 'cancelled';
  /** Why the loop ended. */
  outcome: GoalOutcome;
  /** Every finished iteration, in order. */
  iterations: GoalIteration[];
  /** The last iteration's output, when there is one. */
  output?: unknown;
  /** The last iteration's text, or `''`. */
  text: string;
  /** Usage summed over every iteration. */
  usage: GoalUsage;
  /** Why the run did not end `ok`. */
  error?: {
    /** `max-iterations`, `budget`, `timeout`, `stalled`, `cancelled` or `engine`. */
    kind: string;
    /** For people; starts with `iteration <n>: ` when an iteration failed. */
    message: string;
    /** The iteration the failure belongs to, when it belongs to one. */
    iteration?: number;
  };
}

/** Options of {@link runGoal}. */
export interface RunGoalOptions {
  /** The lead. */
  lead: GoalLead;
  /** The delegate aliases the lead may call; named in the first prompt. */
  delegates?: readonly string[];
  /** The parsed `goal.json`. */
  goal: GoalSpec;
  /** The check, usually `goalCheck(goal, checks)`. */
  check: GoalCheck;
  /** Cancels the run; the result is `cancelled`. */
  signal?: AbortSignal;
  /** Runtime limits on top of `goal.stop`. */
  limits?: GoalRunLimits;
  /** Receives each iteration's start and done events. */
  emit?: (event: GoalStepEvent) => void;
  /** The shared step counter; defaults to one starting at 0. */
  steps?: GoalStepCounter;
  /** Clock in epoch ms, for tests. */
  now?: () => number;
  /** The page run id the checkpoints are saved under; required with `checkpoints`. */
  runId?: string;
  /** Saves a checkpoint after every iteration and at the end. */
  checkpoints?: GoalCheckpointStore;
  /** Progress to continue from; set by `resumeGoal`. */
  resume?: GoalProgress;
}

const MAX_REASON = 500;
const DEFAULT_STALL_AFTER = 2;
const ZERO: GoalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

interface Caps {
  maxIterations: number;
  maxCostUsd: number;
  deadline?: number;
  maxTokens?: number;
  stallAfter: number;
  stopOnStall: boolean;
}

interface LoopState {
  iterations: GoalIteration[];
  usage: GoalUsage;
  best: number;
  flat: number;
}

const OUTCOMES: Record<GoalOutcome, { status: GoalRunResult['status']; error?: { kind: string; message: (state: LoopState, caps: Caps) => string } }> = {
  done: { status: 'ok' },
  'max-iterations': { status: 'failed', error: { kind: 'max-iterations', message: (state) => `the goal was not met in ${state.iterations.length} iterations` } },
  budget: { status: 'failed', error: { kind: 'budget', message: () => 'the goal loop reached its spend or token cap' } },
  'max-duration': { status: 'timed-out', error: { kind: 'timeout', message: () => 'the goal loop reached maxDurationMs' } },
  stalled: { status: 'failed', error: { kind: 'stalled', message: (_state, caps) => `the check score did not improve for ${caps.stallAfter} iterations` } },
  aborted: { status: 'cancelled', error: { kind: 'cancelled', message: () => 'the goal run was cancelled' } },
  error: { status: 'failed', error: { kind: 'engine', message: () => 'the goal iteration failed' } },
};

function clip(text: string): string {
  return text.length > MAX_REASON ? `${text.slice(0, MAX_REASON - 3)}...` : text;
}

function firstPrompt(goal: GoalSpec, delegates: readonly string[], max: number): string {
  const base = `Iteration 1 of at most ${max}.\nGoal: ${goal.goal}\nPlan, then act. When you think the goal is met, say so.`;
  return delegates.length === 0 ? base : `${base}\nYou may delegate to: ${delegates.join(', ')}.`;
}

function nextPrompt(options: RunGoalOptions, state: LoopState, index: number): string {
  const max = options.goal.stop.maxIterations;
  if (index === 1) return firstPrompt(options.goal, options.delegates ?? [], max);
  const last = state.iterations[state.iterations.length - 1];
  return `Iteration ${index} of at most ${max}.\nThe check says the goal isn't met: <untrusted>${clip(last.check.reason)}</untrusted>. Continue.`;
}

function addUsage(a: GoalUsage, b: GoalUsage): GoalUsage {
  const cost = a.costUsd === undefined && b.costUsd === undefined ? undefined : (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, totalTokens: a.totalTokens + b.totalTokens, ...(cost !== undefined && { costUsd: cost }) };
}

function isGoalUsage(value: unknown): value is GoalUsage {
  if (typeof value !== 'object' || value === null) return false;
  const usage = value as Record<string, unknown>;
  return (
    typeof usage.inputTokens === 'number' &&
    typeof usage.outputTokens === 'number' &&
    typeof usage.totalTokens === 'number' &&
    (usage.costUsd === undefined || typeof usage.costUsd === 'number')
  );
}

function usageOf(error: unknown): GoalUsage | undefined {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return undefined;
  const usage: unknown = (error as { usage?: unknown }).usage;
  return isGoalUsage(usage) ? usage : undefined;
}

const lower = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

function capsOf(goal: GoalSpec, limits: GoalRunLimits | undefined, start: number): Caps {
  const duration = lower(goal.stop.maxDurationMs, limits?.maxDurationMs);
  return {
    maxIterations: goal.stop.maxIterations,
    maxCostUsd: lower(goal.stop.maxCostUsd, limits?.maxCostUsd)!,
    ...(duration !== undefined && { deadline: start + duration }),
    ...(limits?.maxTokens !== undefined && { maxTokens: limits.maxTokens }),
    stallAfter: goal.stop.stallAfter ?? DEFAULT_STALL_AFTER,
    stopOnStall: (goal.stop.onStall ?? 'stop') === 'stop',
  };
}

function stopBefore(state: LoopState, caps: Caps, now: number, signal: AbortSignal | undefined): GoalOutcome | undefined {
  if (signal?.aborted) return 'aborted';
  if (state.iterations.length >= caps.maxIterations) return 'max-iterations';
  if ((state.usage.costUsd ?? 0) >= caps.maxCostUsd) return 'budget';
  if (caps.maxTokens !== undefined && state.usage.totalTokens >= caps.maxTokens) return 'budget';
  if (caps.deadline !== undefined && now >= caps.deadline) return 'max-duration';
  return undefined;
}

function stalled(state: LoopState, caps: Caps): boolean {
  return caps.stopOnStall && state.flat >= caps.stallAfter;
}

function iterationSignal(options: RunGoalOptions, caps: Caps, now: number): AbortSignal {
  if (caps.deadline === undefined) return options.signal ?? new AbortController().signal;
  const timeout = AbortSignal.timeout(Math.max(0, caps.deadline - now));
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

async function iterate(options: RunGoalOptions, state: LoopState, index: number, steps: GoalStepCounter, signal: AbortSignal): Promise<GoalIteration> {
  const stepIndex = steps.next();
  options.emit?.({ kind: 'goal-iteration', phase: 'start', iteration: index, stepIndex });
  try {
    const prompt = nextPrompt(options, state, index);
    const turn = await options.lead.run(prompt, { iteration: index, stepIndex, signal });
    const output = turn.output ?? turn.text;
    const check = await options.check({ iteration: index, output });
    return { index, stepIndex, text: turn.text, output, check, usage: turn.usage };
  } finally {
    options.emit?.({ kind: 'goal-iteration', phase: 'done', iteration: index, stepIndex });
  }
}

function record(state: LoopState, iteration: GoalIteration): void {
  state.iterations.push(iteration);
  state.usage = addUsage(state.usage, iteration.usage);
  if (iteration.check.score > state.best) {
    state.best = iteration.check.score;
    state.flat = 0;
  } else {
    state.flat += 1;
  }
}

function finish(state: LoopState, outcome: GoalOutcome, caps: Caps): GoalRunResult {
  const spec = OUTCOMES[outcome];
  const last = state.iterations.at(-1);
  return {
    status: spec.status,
    outcome,
    iterations: state.iterations,
    ...(last !== undefined && { output: last.output }),
    text: last?.text ?? '',
    usage: { ...state.usage },
    ...(spec.error !== undefined && { error: { kind: spec.error.kind, message: spec.error.message(state, caps) } }),
  };
}

function failIteration(state: LoopState, index: number, error: unknown, signal: AbortSignal | undefined, caps: Caps, now: number): GoalRunResult {
  const usage = usageOf(error);
  if (usage !== undefined) state.usage = addUsage(state.usage, usage);
  if (signal?.aborted) return finish(state, 'aborted', caps);
  if (caps.deadline !== undefined && now >= caps.deadline) return finish(state, 'max-duration', caps);
  const message = error instanceof Error ? error.message : String(error);
  return { ...finish(state, 'error', caps), error: { kind: 'engine', message: `iteration ${index}: ${message}`, iteration: index } };
}

async function save(options: RunGoalOptions, state: LoopState, steps: GoalStepCounter, elapsedMs: number, finished?: GoalRunResult): Promise<void> {
  if (!options.checkpoints || options.runId === undefined) return;
  const progress: GoalProgress = {
    iteration: state.iterations.length,
    iterations: state.iterations,
    usage: state.usage,
    best: state.best,
    flat: state.flat,
    elapsedMs,
    nextStepIndex: steps.peek(),
    ...(finished && { finished }),
  };
  await options.checkpoints.save(options.runId, toCheckpoint(options.runId, progress, finished ? 'finished' : 'in-progress'));
}

/** A step counter starting at `start` (default 0). */
export function goalStepCounter(start = 0): GoalStepCounter {
  let next = start;
  return { next: () => next++, peek: () => next };
}

/** Runs `lead` one turn per iteration until `check` passes or a limit stops it; never throws for a stop. */
export async function runGoal(options: RunGoalOptions): Promise<GoalRunResult> {
  if ((options.runId === undefined) !== (options.checkpoints === undefined)) {
    throw new SDKError('runGoal: pass runId and checkpoints together, or neither.', 'LOUSHO_CONFIG_INVALID');
  }
  const now = options.now ?? Date.now;
  const startedAt = now();
  const before = options.resume?.elapsedMs ?? 0;
  const caps = capsOf(options.goal, options.limits, startedAt - before);
  const steps = options.steps ?? goalStepCounter(options.resume?.nextStepIndex ?? 0);
  const state: LoopState =
    options.resume === undefined
      ? { iterations: [], usage: ZERO, best: -1, flat: 0 }
      : { iterations: [...options.resume.iterations], usage: options.resume.usage, best: options.resume.best, flat: options.resume.flat };
  const elapsed = () => before + (now() - startedAt);
  const done = async (outcome: GoalOutcome): Promise<GoalRunResult> => {
    const result = finish(state, outcome, caps);
    await save(options, state, steps, elapsed(), result);
    return result;
  };
  for (;;) {
    const stop = stopBefore(state, caps, now(), options.signal);
    if (stop !== undefined) return done(stop);
    const index = state.iterations.length + 1;
    let iteration: GoalIteration;
    try {
      iteration = await iterate(options, state, index, steps, iterationSignal(options, caps, now()));
    } catch (error) {
      const result = failIteration(state, index, error, options.signal, caps, now());
      await save(options, state, steps, elapsed(), result);
      return result;
    }
    record(state, iteration);
    await save(options, state, steps, elapsed());
    if (iteration.check.done) return done('done');
    if (stalled(state, caps)) return done('stalled');
  }
}

/** Continues a goal run from its last checkpoint at the next iteration; returns the saved result for a finished run. */
export async function resumeGoal(options: RunGoalOptions & { runId: string; checkpoints: GoalCheckpointStore }): Promise<GoalRunResult> {
  const checkpoint = await options.checkpoints.load(options.runId);
  const progress = checkpoint ? progressOf(checkpoint) : undefined;
  if (!progress) throw new SDKError(`resumeGoal: run '${options.runId}' has no goal checkpoint.`, 'LOUSHO_CHECKPOINT_NOT_FOUND');
  if (progress.finished) return progress.finished;
  return runGoal({ ...options, resume: progress });
}
