/**
 * The per-workspace trigger host (R08a; R08b/R08c/R07 dispatch through the
 * same queue). It keeps each agent's `spec.triggers`, turns a
 * {@link DispatchRequest} into a queued {@link HostRun}, launches at most
 * one run per agent through `RunManager`, and reports exactly one
 * {@link RunEnd} per finished host run before starting the next queued
 * request FIFO.
 *
 * Status contract with RunManager: our run is "running" from the moment
 * `run()` resolves until a `status` event leaves `running` for
 * `done`/`error`/`stopped`. `paused` (awaiting approval) is still running;
 * `idle` never occurs mid-run. A `run()` that loses the race to a manual
 * run throws `AlreadyRunningError` - the request stays queued and is
 * retried on the next status transition.
 */
import { randomUUID } from 'node:crypto';

import type { AgentSpecV2 } from 'lousho';
import type { TriggerSpec } from 'lousho/spec';

import type { AgentRepo } from '../storage/agentRepo';
import type { RunManager } from '../runRegistry';
import { AlreadyRunningError } from '../runRegistry';
import type { StudioEventBus } from '../events/eventBus';

/** A trigger request the host accepted, queued or in flight. */
export interface HostRun {
  /** `${triggerId}:${uuid}` - stable for the run's whole queue+flight life. */
  runKey: string;
  agentId: string;
  triggerId: string;
  /** The trigger's raw event payload (webhook body, cron fire, ...). */
  event: unknown;
  /** The rendered prompt `run()` receives as its input. */
  input: string;
  status: 'queued' | 'running';
  enqueuedAt: string;
}

/** What a trigger surface (webhook route, cron ticker, channel adapter) asks the host to run. */
export interface DispatchRequest {
  agentId: string;
  triggerId: string;
  input: string;
  event: unknown;
}

export type DispatchResult =
  | { ok: true; runKey: string; started: boolean }
  | { ok: false; reason: 'queue_full' | 'disabled' | 'unknown_trigger' };

/** One finished host run - fired exactly once, before the next queued request starts. */
export interface RunEnd {
  run: HostRun;
  status: 'done' | 'error' | 'stopped';
  resultText: string | null;
  traceId: string | null;
  /** `stopped` counts as cancelled (stop() or an abort), as does an `error` carrying an abort. */
  cancelled: boolean;
}

export interface TriggerHostDeps {
  repo: AgentRepo;
  runManager: RunManager;
  events: StudioEventBus;
  /** Studio run-log sink (phase `trigger`); the host never logs payloads. */
  log: (agentId: string, message: string, level?: 'info' | 'warn' | 'error') => void;
  /** Queued-request cap per agent; the in-flight run does not count. Default 20. */
  queueCap?: number;
  /**
   * Called once per agent at the end of every `reload()` pass over it
   * (R08b: the channel mount follows spec changes). Fire-and-forget -
   * the hook's own errors are its caller's problem, never the reload's.
   */
  onReload?: (agentId: string) => void;
}

interface AgentTriggers {
  triggers: TriggerSpec[];
  /** FIFO of accepted-but-not-started requests. */
  queue: HostRun[];
  /** The host run currently in flight, if any. */
  current?: HostRun;
}

/** The subset of RunManager's `status()` payload the host reads. */
interface StatusPayload {
  agentId: string;
  status: string;
  resultText?: string;
  traceId?: string;
  abortReason?: string;
}

/** Statuses that end a host run; `paused` deliberately absent (still running). */
const END_STATUSES = new Set(['done', 'error', 'stopped']);

export class TriggerHost {
  private readonly queueCap: number;
  private readonly agents = new Map<string, AgentTriggers>();
  /** `meta.enabled` per agent, refreshed on every reload (R09); absent means enabled. */
  private readonly enabled = new Map<string, boolean>();
  private readonly endListeners = new Set<(end: RunEnd) => void>();
  private unsubscribers: Array<() => void> = [];
  private stopped = false;

  constructor(private readonly deps: TriggerHostDeps) {
    this.queueCap = deps.queueCap ?? 20;
  }

  /** Loads every agent's triggers and subscribes to spec + run-status changes. */
  async start(): Promise<void> {
    for (const agentId of this.deps.repo.listIds()) {
      await this.reload(agentId);
    }
    const onStatus = (payload: StatusPayload): void => this.onStatus(payload);
    this.unsubscribers.push(
      this.deps.events.subscribe((event) => {
        if (event.type === 'agent.changed') void this.reload(event.agentId);
      }),
      // RunManager is an EventEmitter; 'status' carries the status() payload.
      (() => {
        this.deps.runManager.on('status', onStatus);
        return () => this.deps.runManager.off('status', onStatus);
      })()
    );
  }

  stop(): void {
    this.stopped = true;
    for (const unsub of this.unsubscribers.splice(0)) unsub();
  }

  /** Re-reads `spec.triggers` for one agent (or all when omitted); drops queued runs whose trigger vanished. */
  async reload(agentId?: string): Promise<void> {
    const ids = agentId === undefined ? this.deps.repo.listIds() : [agentId];
    for (const id of ids) {
      const spec = await this.deps.repo.readSpec(id).catch(() => undefined);
      const triggers = (spec as AgentSpecV2 | undefined)?.triggers ?? [];
      const state = this.stateFor(id);
      state.triggers = triggers;
      await this.refreshEnabled(id, state);
      const known = new Set(triggers.map((t) => t.id));
      const dropped = state.queue.filter((run) => !known.has(run.triggerId));
      if (dropped.length > 0) {
        state.queue = state.queue.filter((run) => known.has(run.triggerId));
        for (const run of dropped) {
          this.deps.log(id, `Dropped queued run: trigger ${run.triggerId} was removed`, 'warn');
        }
      }
      // A vanished trigger cannot be the in-flight one (its run already started); leave it.
      try {
        this.deps.onReload?.(id);
      } catch {
        // A reload hook must never break the host's own reload.
      }
    }
  }

  triggersOf(agentId: string): TriggerSpec[] {
    return this.agents.get(agentId)?.triggers ?? [];
  }

  /**
   * `meta.enabled` for the agent (R09): false rejects every trigger
   * dispatch while manual runs stay untouched. Unknown agents read as
   * enabled, matching `defaultMeta`.
   */
  isEnabled(agentId: string): boolean {
    return this.enabled.get(agentId) ?? true;
  }

  /**
   * Re-reads `meta.enabled` into the cache; on a transition to disabled
   * every queued host run is dropped (a running one finishes - R09).
   */
  private async refreshEnabled(agentId: string, state: AgentTriggers): Promise<void> {
    // Test fakes may omit readMeta; a missing meta reads as enabled.
    const meta =
      this.deps.repo.readMeta === undefined
        ? undefined
        : await this.deps.repo.readMeta(agentId).catch(() => undefined);
    const nowEnabled = meta?.enabled ?? true;
    const wasEnabled = this.enabled.get(agentId) ?? true;
    this.enabled.set(agentId, nowEnabled);
    if (wasEnabled && !nowEnabled && state.queue.length > 0) {
      const dropped = state.queue.splice(0);
      this.deps.log(agentId, `Dropped ${dropped.length} queued runs: the agent was turned off`, 'warn');
    }
  }

  /** Accepts a trigger request: enqueues FIFO, starts immediately when the agent is free. */
  dispatch(req: DispatchRequest): DispatchResult {
    // R09: a turned-off agent starts no triggered run (webhook/channel map
    // this to their own skip responses; cron/chain log the skip).
    if (!this.isEnabled(req.agentId)) return { ok: false, reason: 'disabled' };
    const trigger = this.triggersOf(req.agentId).find((t) => t.id === req.triggerId);
    if (!trigger) return { ok: false, reason: 'unknown_trigger' };

    const state = this.stateFor(req.agentId);
    if (state.queue.length >= this.queueCap) {
      return { ok: false, reason: 'queue_full' };
    }

    const run: HostRun = {
      runKey: `${req.triggerId}:${randomUUID()}`,
      agentId: req.agentId,
      triggerId: req.triggerId,
      event: req.event,
      input: req.input,
      status: 'queued',
      enqueuedAt: new Date().toISOString(),
    };
    state.queue.push(run);
    this.deps.log(req.agentId, `${this.labelOf(state, req.triggerId)} queued a run`);
    return { ok: true, runKey: run.runKey, started: this.startNext(req.agentId) };
  }

  /** The agent's runs: the in-flight one first, then the queue oldest-first. */
  runsOf(agentId: string): HostRun[] {
    const state = this.agents.get(agentId);
    if (!state) return [];
    return [...(state.current ? [state.current] : []), ...state.queue];
  }

  /**
   * Cancels a queued or running host run. Queued: removed, `'queued'`
   * returned. Running: `runManager.stop()` aborts it (its status event
   * produces the RunEnd), `'running'` returned. Unknown key: `undefined`.
   */
  cancel(runKey: string, reason: string): 'queued' | 'running' | undefined {
    for (const state of this.agents.values()) {
      const qi = state.queue.findIndex((r) => r.runKey === runKey);
      if (qi >= 0) {
        state.queue.splice(qi, 1);
        return 'queued';
      }
      if (state.current?.runKey === runKey) {
        void this.deps.runManager.abort(state.current.agentId, reason).catch(() => {});
        return 'running';
      }
    }
    return undefined;
  }

  /** Subscribes to run endings; returns the unsubscribe. */
  onRunEnd(listener: (end: RunEnd) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  /**
   * The workspace run-log sink (phase `trigger`) - trigger adapters
   * (cron R08c, channels R08b, chains R07) log their own lines through
   * it so every trigger message lands on the same stream.
   */
  log(agentId: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.deps.log(agentId, message, level);
  }

  private stateFor(agentId: string): AgentTriggers {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { triggers: [], queue: [] };
      this.agents.set(agentId, state);
    }
    return state;
  }

  /** The log prefix for a trigger: `Webhook <path>` for webhook triggers (R08a's contract), `Trigger '<id>'` otherwise. */
  private labelOf(state: AgentTriggers, triggerId: string): string {
    const trigger = state.triggers.find((t) => t.id === triggerId);
    return trigger?.type === 'webhook' ? `Webhook ${trigger.path}` : `Trigger '${triggerId}'`;
  }

  /** Starts the queue head when the agent has no in-flight host run; returns whether one started. */
  private startNext(agentId: string): boolean {
    const state = this.agents.get(agentId);
    if (this.stopped || !state || state.current || state.queue.length === 0) return false;
    const run = state.queue.shift();
    if (!run) return false;
    run.status = 'running';
    state.current = run;
    void this.launch(state, run);
    return true;
  }

  private async launch(state: AgentTriggers, run: HostRun): Promise<void> {
    try {
      await this.deps.runManager.run(run.agentId, run.input, undefined, {
        source: 'trigger',
        triggerId: run.triggerId,
        triggerEvent: run.event,
      });
      this.deps.log(run.agentId, `${this.labelOf(state, run.triggerId)} started a run`);
    } catch (error) {
      // Lost the race to a manual run (or another transition beat us): put
      // the request back at the head and retry on the next status event.
      if (error instanceof AlreadyRunningError) {
        run.status = 'queued';
        state.current = undefined;
        state.queue.unshift(run);
        return;
      }
      // Any other launch failure (bad spec, missing provider): drop the run
      // rather than let one poison request block the queue forever.
      state.current = undefined;
      this.deps.log(run.agentId, `${this.labelOf(state, run.triggerId)} run failed to start: ${error instanceof Error ? error.message : String(error)}`, 'error');
      this.startNext(run.agentId);
    }
  }

  /** RunManager 'status' payload handler: ends the in-flight host run on a terminal status, then retries the queue. */
  private onStatus(payload: StatusPayload): void {
    const state = this.agents.get(payload.agentId);
    if (!state) return;
    const run = state.current;
    if (run !== undefined && END_STATUSES.has(payload.status)) {
      state.current = undefined;
      const end: RunEnd = {
        run,
        status: payload.status as RunEnd['status'],
        resultText: payload.resultText ?? null,
        traceId: payload.traceId ?? null,
        // `stopped` counts as cancelled (stop() or an abort), as does an
        // `error` carrying an abort reason.
        cancelled: payload.status === 'stopped' || (payload.status === 'error' && payload.abortReason !== undefined),
      };
      for (const listener of this.endListeners) listener(end);
    } else if (!END_STATUSES.has(payload.status)) {
      // 'running'/'paused'/'idle': the agent is still busy (a pause awaits
      // approval - not an end) or nothing terminal happened.
      return;
    }
    // Terminal status with the queue non-empty and nothing in flight -
    // either the run above just ended, or a manual run that beat a queued
    // dispatch to AlreadyRunningError just finished. Start the head.
    this.startNext(payload.agentId);
  }
}
