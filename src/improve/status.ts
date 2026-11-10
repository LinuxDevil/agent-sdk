import { lstatSync } from 'node:fs';
import { ConfigurationError } from '../execution/errors';
import { plain, readAudit, type AuditEntry } from './audit';
import { cooldownEnds, pausedBy, readCycles, usageToday } from './cycles';
import type { MonitorVerdict } from './monitor';
import { listPending } from './pending';
import { currentRevision } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import { readState } from './state';

const RECENT = 5;
const MAX_REASON = 500;

/** A count used so far today and its daily cap. */
export interface StatusCount {
  /** Used so far today (UTC). */
  used: number;
  /** The daily cap. */
  max: number;
}

/** What `lousho improve status` shows for one agent directory. */
export interface ImproveStatus {
  /** The agent directory. */
  dir: string;
  /** The approval mode. */
  approval: 'auto' | 'manual';
  /** The editor options a cycle passes to `improveAgent()`, from improve.json and the defaults. */
  editors: ImproveSettings['editors'];
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
    cycles: StatusCount;
    /** Automatic applies made and allowed today. */
    applies: StatusCount;
    /** Tokens spent and allowed today. */
    tokens: StatusCount;
  };
  /** When the cooldown after a rollback ends, or `null`. */
  cooldownUntil: string | null;
  /** The canary: the opt-in traffic canary's settings, and the last replay canary's verdict. */
  canary: {
    /** The traffic canary, or `null` when it is off. */
    traffic: {
      /** The share of new sessions that run the candidate. */
      share: number;
      /** Sessions before a verdict. */
      sessions: number;
    } | null;
    /** The last replay canary, or `null`. */
    last: {
      /** The cycle it ran in. */
      cycle: string;
      /** Whether it passed. */
      passed: boolean;
      /** Why, as plain text. */
      reason: string;
    } | null;
  };
  /** The newest cycle record, or `null`. */
  lastCycle: {
    /** The cycle id. */
    id: string;
    /** How it ended. */
    outcome: string;
    /** Why, as plain text. */
    reason: string;
    /** When it started. */
    startedAt: string;
  } | null;
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
  if (monitor?.state === 'pending') return [`The monitor hasn't judged the last apply yet; it needs ${minRuns} runs under the new revision, and holds rather than passes until then.`];
  if (monitor?.state === 'kept-unverified') return [`The last apply was kept unverified: ${monitor.reason ?? 'too few runs to judge'}. Consider manual mode for an agent with this little traffic.`];
  if (monitor?.state === 'regressed') return [`The monitor saw a regression it did not roll back: ${monitor.reason ?? ''}`.trim()];
  return [];
}

type StoredState = { cooldownUntil?: string; monitor?: { applySeq?: number; verdict?: MonitorVerdict } };

function storedState(dir: string, warnings: string[]): StoredState {
  try {
    return readState<StoredState>(dir);
  } catch (error) {
    warnings.push(`.lousho/state.json can't be read, so the monitor and the cooldown are unknown: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

function monitorOf(audit: readonly AuditEntry[], revision: string | null, state: StoredState): MonitorVerdict | null {
  const change = [...audit].reverse().find((entry) => entry.action === 'apply' || entry.action === 'rollback');
  if (change?.action !== 'apply' || change.to !== revision) return state.monitor?.verdict ?? null;
  if (state.monitor?.applySeq === change.seq && state.monitor.verdict) return { ...state.monitor.verdict, ...(state.monitor.verdict.reason !== undefined && { reason: plain(state.monitor.verdict.reason, MAX_REASON) }) };
  return { state: 'pending' };
}

function usageOf(dir: string, now: number): ReturnType<typeof usageToday> {
  try {
    return usageToday(dir, now);
  } catch {
    return { cycles: 0, tokens: 0, applies: 0 };
  }
}

/** The self-healing state of an agent directory: mode, revision, recent audit entries, pending proposals, monitor, budget, cooldown, kill switch and canary. */
export function improveStatus(dir: string, options: { now?: number; env?: NodeJS.ProcessEnv } = {}): ImproveStatus {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new ConfigurationError(`improveStatus: ${dir} is not an agent directory.`, 'dir');
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const settings = loadImproveSettings(dir, {}, env);
  const warnings: string[] = [];
  const state = storedState(dir, warnings);
  const used = usageOf(dir, now);
  const audit = readAudit(dir);
  const revision = revisionOf(dir);
  if (revision === null) warnings.push("The instructions don't live in instructions.md, so the loop can't change this agent.");
  const monitor = monitorOf(audit, revision, state);
  const cycles = readCycles(dir);
  const lastCanary = cycles.find((cycle) => cycle.canary !== undefined);
  const last = cycles[0];
  const { budget } = settings;
  return {
    dir,
    approval: settings.approval,
    editors: settings.editors,
    paused: pausedBy(dir, settings, env) ?? null,
    revision,
    audit: audit
      .slice(-RECENT)
      .reverse()
      .map(({ seq, at, actor, action, reason }) => ({ seq, at, actor, action, reason })),
    pending: listPending(dir).map((item) => ({ id: item.id, createdAt: item.createdAt, stale: item.staleAt !== undefined })),
    monitor,
    budget: { cycles: { used: used.cycles, max: budget.maxCyclesPerDay }, applies: { used: used.applies, max: budget.maxAppliesPerDay }, tokens: { used: used.tokens, max: budget.maxTokensPerDay } },
    cooldownUntil: cooldownOf(dir, settings.cooldownHours, now, state.cooldownUntil),
    canary: { traffic: settings.canary.traffic ?? null, last: lastCanary?.canary ? { cycle: lastCanary.id, passed: lastCanary.canary.passed, reason: plain(lastCanary.canary.reason, MAX_REASON) } : null },
    lastCycle: last ? { id: last.id, outcome: last.outcome, reason: plain(last.reason, MAX_REASON), startedAt: last.startedAt } : null,
    warnings: [...warnings, ...warningsOf(monitor, Math.max(settings.monitor.minRuns, settings.monitor.window))],
  };
}
