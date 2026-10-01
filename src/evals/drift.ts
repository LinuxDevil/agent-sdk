/**
 * Trajectory drift (LOU-D46): what an eval case did, read from its cassette,
 * and how two such trajectories differ. Pure, so `loushy eval --drift` can
 * compare a committed cassette with a fresh recording of the same case.
 */
import type { Cassette } from '../testing/cassette';
import { stableStringify } from '../testing/fingerprint';
import type { Checkpoint } from '../execution/checkpoint';
import type { Message } from '../providers';
import { textOf } from '../providers/content';

/** What a recorded case did. */
export interface Trajectory {
  /** Tool calls in order; `args` is the JSON-normalized (key-sorted) argument string. */
  tools: { name: string; args: string }[];
  /** Model calls (steps). */
  steps: number;
  /** Finish reason of the last model call (or the name of the error it threw). */
  finishReason?: string;
  /** Total tokens, when the provider reported usage. */
  totalTokens?: number;
}

/** One difference between a committed and a current trajectory. */
export interface DriftEntry {
  field: 'tools' | 'args' | 'steps' | 'finishReason' | 'tokens';
  committed: string;
  current: string;
}

function normalizeArgs(raw: string): string {
  try {
    return stableStringify(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/** The trajectory a cassette recorded. */
export function trajectoryOf(cassette: Pick<Cassette, 'entries'>): Trajectory {
  const { entries } = cassette;
  const tools = entries.flatMap((entry) =>
    (entry.response?.toolCalls ?? []).map((call) => ({ name: call.function.name, args: normalizeArgs(call.function.arguments) }))
  );
  const usage = entries.flatMap((entry) => (entry.response?.usage ? [entry.response.usage.totalTokens] : []));
  const last = entries.at(-1);
  return {
    tools,
    steps: entries.length,
    finishReason: last?.response?.finishReason ?? last?.error?.name,
    ...(usage.length > 0 ? { totalTokens: usage.reduce((sum, tokens) => sum + tokens, 0) } : {}),
  };
}

/**
 * Differences from `committed` to `current`: tool order, then (when the
 * order matches) each call's arguments, step count and finish reason. Token
 * usage varies between runs of a real model, so it is compared only with
 * `{ usage: true }`.
 */
export function diffTrajectories(committed: Trajectory, current: Trajectory, options: { usage?: boolean } = {}): DriftEntry[] {
  const drift: DriftEntry[] = [];
  const compare = (field: DriftEntry['field'], before: string, after: string) => {
    if (before !== after) drift.push({ field, committed: before, current: after });
  };
  const names = (t: Trajectory) => t.tools.map((call) => call.name).join(' > ') || 'none';
  compare('tools', names(committed), names(current));
  if (names(committed) === names(current)) {
    committed.tools.forEach((call, i) => compare('args', `${call.name} ${call.args}`, `${call.name} ${current.tools[i].args}`));
  }
  compare('steps', String(committed.steps), String(current.steps));
  compare('finishReason', committed.finishReason ?? '-', current.finishReason ?? '-');
  if (options.usage) compare('tokens', String(committed.totalTokens ?? '-'), String(current.totalTokens ?? '-'));
  return drift;
}

/** One model turn of a transcript (LOU-D44). */
export interface TrajectoryStep {
  /** The assistant's text this turn (`''` for none). */
  text: string;
  /** Its tool calls; `result` is the recorded result's content, absent while the call has none. */
  tools: { id: string; name: string; args: string; result?: string }[];
}

/** How two runs differ (LOU-D44): e.g. a session and a fork of it, for side-by-side rendering. */
export interface TrajectoryComparison {
  /** Each run's model turns, in order (step `n` is index `n - 1`). */
  a: TrajectoryStep[];
  b: TrajectoryStep[];
  /** The first step (from 1) whose text, tool calls or tool results differ (call ids aside); absent when none does. */
  divergedAt?: number;
  /** Tool order, arguments, step count and finish reason differences, as `diffTrajectories()` (`a` as committed). */
  drift: DriftEntry[];
}

function stepsOf(run: Checkpoint | Message[]): TrajectoryStep[] {
  const messages = Array.isArray(run) ? run : run.messages;
  const results = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.toolCallId, textOf(m)]));
  return messages
    .filter((m) => m.role === 'assistant')
    .map((m) => ({
      text: textOf(m),
      tools: (m.toolCalls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        args: normalizeArgs(call.function.arguments),
        ...(results.has(call.id) ? { result: results.get(call.id) } : {}),
      })),
    }));
}

function trajectoryOfSteps(steps: TrajectoryStep[], run: Checkpoint | Message[]): Trajectory {
  const tools = steps.flatMap((step) => step.tools.map(({ name, args }) => ({ name, args })));
  return { tools, steps: steps.length, finishReason: Array.isArray(run) ? undefined : run.finishReason };
}

/** A step as compared: its call ids left out (each run gets its own). */
function stepKey(step: TrajectoryStep | undefined): string {
  return step ? stableStringify({ ...step, tools: step.tools.map(({ name, args, result }) => ({ name, args, result })) }) : '-';
}

/**
 * Compares two runs (LOU-D44) - checkpoints, such as a session's and its
 * `AgentExecutor.fork()`'s, or transcripts - turn by turn. A step is one
 * assistant turn of the transcript.
 */
export function compareTrajectories(a: Checkpoint | Message[], b: Checkpoint | Message[]): TrajectoryComparison {
  const left = stepsOf(a);
  const right = stepsOf(b);
  const length = Math.max(left.length, right.length);
  const index = Array.from({ length }, (_, i) => i).find((i) => stepKey(left[i]) !== stepKey(right[i]));
  return {
    a: left,
    b: right,
    ...(index !== undefined ? { divergedAt: index + 1 } : {}),
    drift: diffTrajectories(trajectoryOfSteps(left, a), trajectoryOfSteps(right, b)),
  };
}
