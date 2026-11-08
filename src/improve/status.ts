import { readAudit, type AuditEntry } from './audit';
import { cooldownEnds, pausedBy, readCycles, usageToday } from './cycles';
import type { MonitorVerdict } from './monitor';
import { listPending } from './pending';
import { currentRevision } from './revisions';
import { loadImproveSettings } from './settings';
import { readState } from './state';

const RECENT = 5;

/** What `lousho improve status` shows for one agent directory. */
export interface ImproveStatus {
  /** The agent directory. */
  dir: string;
  /** The approval mode. */
  approval: 'auto' | 'manual';
  /** Why the loop is paused, or `null` when it may run. */
  paused: string | null;
  /** The active harness revision, or `null` when the instructions can't be read. */
  revision: string | null;
  /** The newest audit entries, newest first. */
  audit: Pick<AuditEntry, 'seq' | 'at' | 'actor' | 'action' | 'reason'>[];
  /** Proposals waiting for a person. */
  pending: {
    /** The proposal id. */
    id: string;
    /** When it was queued. */
    createdAt: string;
    /** Whether an approval found it stale. */
    stale: boolean;
  }[];
  /** The monitor's last verdict on the last apply, or `null`. */
  monitor: MonitorVerdict | null;
  /** What is left of today's budget (UTC). */
  budget: {
    /** Cycles run and allowed today. */
    cycles: { used: number; max: number };
    /** Automatic applies made and allowed today. */
    applies: { used: number; max: number };
    /** Tokens spent and allowed today. */
    tokens: { used: number; max: number };
  };
  /** When the cooldown after a rollback ends, or `null`. */
  cooldownUntil: string | null;
  /** The canary: the opt-in traffic canary's settings, and the last replay canary's verdict. */
  canary: {
    /** The traffic canary, or `null` when it is off. */
    traffic: { share: number; sessions: number } | null;
    /** The last replay canary, or `null`. */
    last: { cycle: string; passed: boolean; reason: string } | null;
  };
  /** The newest cycle record, or `null`. */
  lastCycle: { id: string; outcome: string; reason: string; startedAt: string } | null;
  /** Things a person should know, such as a monitor that can't judge yet. */
  warnings: string[];
}

function revisionOf(dir: string): string | null {
  try {
    return currentRevision(dir);
  } catch {
    return null;
  }
}

function cooldownOf(dir: string, hours: number, now: number, stored: string | undefined): string | null {
  const audited = cooldownEnds(dir, hours, now);
  const fromState = Date.parse(stored ?? '');
  const ends = Math.max(audited ?? 0, Number.isFinite(fromState) ? fromState : 0);
  return ends > now ? new Date(ends).toISOString() : null;
}

function warningsOf(monitor: MonitorVerdict | null, minRuns: number): string[] {
  if (monitor?.state === 'pending') return [`The monitor is waiting: ${monitor.runs ?? 0} of the ${minRuns} runs it needs under the new revision, so it holds rather than passes.`];
  if (monitor?.state === 'kept-unverified') return [`The last apply was kept unverified: ${monitor.reason ?? 'too few runs to judge'}. Consider manual mode for an agent with this little traffic.`];
  if (monitor?.state === 'regressed') return [`The monitor saw a regression it did not roll back: ${monitor.reason ?? ''}`.trim()];
  return [];
}

/** The self-healing state of an agent directory: mode, revision, recent audit entries, pending proposals, monitor, budget, cooldown, kill switch and canary. */
export function improveStatus(dir: string, options: { now?: number; env?: NodeJS.ProcessEnv } = {}): ImproveStatus {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const settings = loadImproveSettings(dir, {}, env);
  const state = readState<{ cooldownUntil?: string; monitor?: { verdict?: MonitorVerdict } }>(dir);
  const used = usageToday(dir, now);
  const monitor = state.monitor?.verdict ?? null;
  const cycles = readCycles(dir);
  const lastCanary = cycles.find((cycle) => cycle.canary !== undefined);
  const last = cycles[0];
  const { budget } = settings;
  return {
    dir,
    approval: settings.approval,
    paused: pausedBy(dir, settings, env) ?? null,
    revision: revisionOf(dir),
    audit: readAudit(dir)
      .slice(-RECENT)
      .reverse()
      .map(({ seq, at, actor, action, reason }) => ({ seq, at, actor, action, reason })),
    pending: listPending(dir).map((item) => ({ id: item.id, createdAt: item.createdAt, stale: item.staleAt !== undefined })),
    monitor,
    budget: { cycles: { used: used.cycles, max: budget.maxCyclesPerDay }, applies: { used: used.applies, max: budget.maxAppliesPerDay }, tokens: { used: used.tokens, max: budget.maxTokensPerDay } },
    cooldownUntil: cooldownOf(dir, settings.cooldownHours, now, state.cooldownUntil),
    canary: { traffic: settings.canary.traffic ?? null, last: lastCanary?.canary ? { cycle: lastCanary.id, passed: lastCanary.canary.passed, reason: lastCanary.canary.reason } : null },
    lastCycle: last ? { id: last.id, outcome: last.outcome, reason: last.reason, startedAt: last.startedAt } : null,
    warnings: warningsOf(monitor, Math.max(settings.monitor.minRuns, settings.monitor.window)),
  };
}
