/**
 * The triggered-run failure streak (L12, PLAN §4/§9): five consecutive
 * `'trigger'`-sourced runs ending in `error` auto-disable the agent
 * (`enabled: false`, `disabledReason: 'auto_failure_streak'`) and raise an
 * `auto_disabled` inbox alert. A triggered `done` resets the streak;
 * manual runs neither count nor reset (their status payloads carry no
 * `source: 'trigger'`); `stopped`/`paused`/`idle` are ignored.
 *
 * Attached per workspace inside `createWorkspaceContext` - the RunManager,
 * repo and event bus are the workspace's, the AlertStore is Studio-global.
 */
import type { AgentRunStatusPayload, RunStatus } from '../../shared/wireTypes';
import type { AlertStore } from '../inbox/alertStore';
import type { StudioEventBus } from '../events/eventBus';
import type { AgentRepo } from '../storage/agentRepo';
import { withAgentLock } from '../storage/atomic';
import type { RunManager } from '../runRegistry';
import { enabledPatch } from './enabledState';

/** Consecutive failed triggered runs that auto-disable an agent. */
export const FAILURE_STREAK_LIMIT = 5;

/** What {@link attachFailureStreak} needs: the workspace's run/repo/events plus the Studio-global alerts. */
export interface FailureStreakDeps {
  runManager: RunManager;
  repo: AgentRepo;
  alerts: AlertStore;
  events: StudioEventBus;
  /** The workspace the attached runs belong to - stamped on every alert the pass raises. */
  workspaceId: string;
  now?: () => string;
}

/**
 * Subscribes the streak counter to the run manager's `status` events and
 * returns the unsubscribe (W02a's context `dispose()` runs it). Only a
 * `running -> done|error` transition whose payload still carries
 * `source: 'trigger'` counts - `setEntry` re-emits `status` for unrelated
 * patches, so the last-seen status per agent is tracked to tell a real
 * transition from a repeat.
 */
export function attachFailureStreak(deps: FailureStreakDeps): () => void {
  const lastStatus = new Map<string, RunStatus>();
  const now = deps.now ?? (() => new Date().toISOString());

  const onStatus = (payload: AgentRunStatusPayload): void => {
    const previous = lastStatus.get(payload.agentId);
    lastStatus.set(payload.agentId, payload.status);
    if (previous !== 'running' || payload.source !== 'trigger') return;
    if (payload.status === 'done') {
      void resetStreak(deps, payload.agentId, now()).catch(reportFailure(payload.agentId, 'reset'));
    } else if (payload.status === 'error') {
      void countFailure(deps, payload, now()).catch(reportFailure(payload.agentId, 'count'));
    }
  };

  deps.runManager.on('status', onStatus);
  return () => {
    deps.runManager.off('status', onStatus);
    lastStatus.clear();
  };
}

function reportFailure(agentId: string, phase: string): (error: unknown) => void {
  return (error: unknown) => {
    console.warn(`[agent-forge] failure streak ${phase} for '${agentId}' failed:`, error);
  };
}

/** A triggered run succeeded: zero the streak, but only when it is not already 0 (no write, no churn). */
async function resetStreak(deps: FailureStreakDeps, agentId: string, timestamp: string): Promise<void> {
  await withAgentLock(agentId, async () => {
    const meta = await deps.repo.readMeta(agentId);
    if (meta.failureStreak === 0) return;
    await deps.repo.writeMeta(agentId, { ...meta, failureStreak: 0, updatedAt: timestamp });
  });
}

/** A triggered run failed: increment the streak; at the limit, auto-disable once and alert. */
async function countFailure(
  deps: FailureStreakDeps,
  payload: AgentRunStatusPayload,
  timestamp: string
): Promise<void> {
  const agentId = payload.agentId;
  await withAgentLock(agentId, async () => {
    const meta = await deps.repo.readMeta(agentId);
    const streak = meta.failureStreak + 1;
    if (streak < FAILURE_STREAK_LIMIT || !meta.enabled) {
      await deps.repo.writeMeta(agentId, { ...meta, failureStreak: streak, updatedAt: timestamp });
      return;
    }
    const next = { ...meta, ...enabledPatch(meta, false, 'auto_failure_streak', timestamp), failureStreak: streak };
    await deps.repo.writeMeta(agentId, { ...next, updatedAt: timestamp });
    // The alert names the agent; the spec read stays inside the lock so a
    // mid-write delete can't race it, and falls back to the id.
    const spec = await deps.repo.readSpec(agentId);
    await deps.alerts.add({
      kind: 'auto_disabled',
      agentId,
      workspaceId: deps.workspaceId,
      title: `${spec?.name ?? agentId} was turned off after ${FAILURE_STREAK_LIMIT} failed runs`,
      detail: payload.error ?? null,
      payload: { failureStreak: streak, lastTraceId: payload.traceId ?? null },
    });
    deps.events.publish({ type: 'agent.changed', agentId, reason: 'meta' });
  });
}
