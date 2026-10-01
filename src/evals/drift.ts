/**
 * Trajectory drift (LOU-D46): what an eval case did, read from its cassette,
 * and how two such trajectories differ. Pure, so `loushy eval --drift` can
 * compare a committed cassette with a fresh recording of the same case.
 */
import type { Cassette } from '../testing/cassette';
import { stableStringify } from '../testing/fingerprint';

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
