import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CheckpointStore } from '../execution/checkpoint';
import { failureReportFromDb } from '../observe/failures';
import { runsByRevision } from '../observe/store';
import type { LLMProvider } from '../providers';
import { createRateLimiter, withRateLimit } from '../providers/rateLimit';
import { resolveProvider } from '../providers/resolveProvider';
import { defineSchedule, type DefinedSchedule } from '../schedules/defineSchedule';
import { fileStore } from '../storage/fileStore';
import { appendAudit } from './audit';
import { pausedBy, type HealCycle } from './cycles';
import { healOnce, type HealOptions } from './heal';
import { budgetLeft, guardScheduled, harvest, saveWatch, watchOf, type WatchContext, type WatchState } from './watchSteps';
import { checkApplied, type MonitorVerdict } from './monitor';
import { harnessHash, readAgentHarness } from './revisions';
import { loadImproveSettings } from './settings';
import { readState, updateState } from './state';
import type { GuardCorpusResult } from './corpusGuard';
import type { ImproveOptions } from './types';

/** Options for {@link watchAgent} and {@link improveSchedule}. */
export interface WatchOptions extends Omit<HealOptions, 'trigger' | 'maxTokens' | 'agent'> {
  /** The agent's id or registered name in the observe database; the monitor judges its runs. */
  agent: string;
  /** Milliseconds between ticks (default 15 minutes). */
  intervalMs?: number;
  /** Called with each cycle that ran. */
  onCycle?: (cycle: HealCycle) => void;
  /** Called with an error a tick threw; the watcher keeps running (default: printed to stderr). */
  onError?: (error: unknown) => void;
  /** Holds the one-watcher-per-directory lease (default a file store in `.lousho/watch`). */
  store?: CheckpointStore;
}

/** What one watch tick did. */
export interface WatchTick {
  /** `paused` by the kill switch, `leased` when another watcher holds the directory, `deduped` when nothing new arrived, else `ran`. */
  state: 'paused' | 'leased' | 'deduped' | 'ran';
  /** Why, as plain text. */
  reason: string;
  /** The monitor's verdict on the last apply. */
  monitor?: MonitorVerdict;
  /** The scheduled corpus guard, when it ran. */
  guard?: GuardCorpusResult;
  /** The cycle, when one ran. */
  cycle?: HealCycle;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_OUTAGES = 3;
const LEASE_ID = 'improve-watch';
const MAX_RUNS = 1000;
const STOP_FILE = path.join('.lousho', 'improve.stop');

function rateLimited(editor: ImproveOptions['editor'], rpm: number): ImproveOptions['editor'] {
  const provider: LLMProvider = 'provider' in editor ? editor.provider : resolveProvider(editor.model);
  return { provider: withRateLimit(provider, createRateLimiter({ requestsPerMinute: rpm })) };
}

/** The tick's shared parts: the lease owner and the rate-limited editor. */
export function watchContext(options: WatchOptions, signal?: AbortSignal): WatchContext {
  const store = options.store ?? fileStore(path.join(options.dir, '.lousho', 'watch')).checkpoints;
  return { owner: `${process.pid}:watch:${randomUUID()}`, store, editor: rateLimited(options.editor, options.settings.rateLimit.rpm), ...(signal && { signal }) };
}

function pausedReason(options: WatchOptions): string | undefined {
  try {
    return pausedBy(options.dir, { enabled: options.settings.enabled && loadImproveSettings(options.dir).enabled });
  } catch (error) {
    return `improve.json can't be read (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function pauseOnce(dir: string, reason: string): Promise<WatchTick> {
  if (watchOf(dir).paused === undefined) {
    await appendAudit(dir, { actor: 'scheduler', action: 'pause', reason: `The self-healing loop is paused: ${reason}.` });
    await saveWatch(dir, { paused: reason });
  }
  return { state: 'paused', reason: `Paused: ${reason}.` };
}

async function resumeIfPaused(dir: string): Promise<void> {
  if (watchOf(dir).paused === undefined) return;
  await appendAudit(dir, { actor: 'scheduler', action: 'resume', reason: 'The kill switch is off, so the self-healing loop runs again.' });
  await updateState<WatchState>(dir, (current) => {
    const { paused: _paused, ...rest } = current.watch ?? {};
    return { watch: rest };
  });
}

function failureSignatures(options: WatchOptions): { revision: string; signatures: string[]; failed: number } {
  const revision = harnessHash(readAgentHarness(options.dir));
  const runs = runsByRevision(options.db, { revision, agent: options.agent, limit: MAX_RUNS });
  const traceIds = runs.map((run) => run.traceId);
  const signatures = traceIds.length === 0 ? [] : [...new Set(failureReportFromDb(options.db, { traceIds }).groups.map((group) => group.signature))].sort();
  return { revision, signatures, failed: runs.filter((run) => run.failed).length };
}

function stateCooldown(dir: string, now: number): boolean {
  const until = Date.parse(readState<WatchState>(dir).cooldownUntil ?? '');
  return Number.isFinite(until) && until > now;
}

async function countOutage(dir: string, cycle: HealCycle): Promise<void> {
  if (cycle.outcome !== 'outage') {
    if (['idle', 'paused', 'busy', 'budget', 'cooldown'].includes(cycle.outcome)) return;
    await saveWatch(dir, { outages: 0 });
    return;
  }
  const outages = (watchOf(dir).outages ?? 0) + 1;
  await saveWatch(dir, { outages });
  if (outages < MAX_OUTAGES) return;
  const reason = `${MAX_OUTAGES} cycles in a row ended in a provider outage`;
  mkdirSync(path.join(dir, '.lousho'), { recursive: true });
  if (!lstatSync(path.join(dir, STOP_FILE), { throwIfNoEntry: false })) writeFileSync(path.join(dir, STOP_FILE), `${reason}\n`, { flag: 'wx' });
  await appendAudit(dir, { actor: 'scheduler', action: 'pause', reason: `The self-healing loop paused itself: ${reason}.` });
  await saveWatch(dir, { paused: `${STOP_FILE} exists`, outages: 0 });
}

async function runCycle(options: WatchOptions, context: WatchContext, trigger: HealCycle['trigger'], now: number): Promise<WatchTick> {
  if (stateCooldown(options.dir, now)) return { state: 'ran', reason: `The monitor's cooldown runs until ${readState<WatchState>(options.dir).cooldownUntil}, so no cycle ran.` };
  const { revision, signatures, failed } = failureSignatures(options);
  const watch = watchOf(options.dir);
  const same = watch.signatures !== undefined && watch.signatures.join('\n') === signatures.join('\n');
  if (same && watch.revision === revision && watch.failed === failed) return { state: 'deduped', reason: 'The same failures as the last cycle and nothing new, so no cycle ran.' };
  const { intervalMs: _interval, onCycle, onError: _onError, store: _store, ...heal } = options;
  const cycle = await healOnce({ ...heal, editor: context.editor, trigger, maxTokens: budgetLeft(options.dir, options.settings, now), ...(context.signal && { signal: context.signal }) });
  await saveWatch(options.dir, { revision, signatures, failed });
  await countOutage(options.dir, cycle);
  onCycle?.(cycle);
  return { state: 'ran', reason: cycle.reason, cycle };
}

/** Runs one watch tick: the kill switch, the lease, the monitor, the scheduled corpus guard, then a cycle within the budgets. */
export async function watchTick(options: WatchOptions, context: WatchContext, trigger: HealCycle['trigger'] = 'failures'): Promise<WatchTick> {
  const now = Date.now();
  const paused = pausedReason(options);
  if (paused) return pauseOnce(options.dir, paused);
  await resumeIfPaused(options.dir);
  const ttl = 2 * (options.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (context.store.acquireLease && !(await context.store.acquireLease(LEASE_ID, context.owner, ttl))) {
    return { state: 'leased', reason: 'Another watcher holds this agent directory.' };
  }
  const monitor = await checkApplied(options.db, options.dir, options.settings, { agent: options.agent, now });
  await harvest(options, monitor, now);
  const guard = await guardScheduled(options, now);
  const ran = await runCycle(options, context, trigger, now);
  return { ...ran, monitor, ...(guard && { guard }) };
}

/** Runs healOnce, the monitor and the corpus guard on a timer, within the settings' budgets; stops on the kill switch. */
export function watchAgent(options: WatchOptions): { stop(): Promise<void> } {
  const controller = new AbortController();
  const context = watchContext(options, controller.signal);
  const report = options.onError ?? ((error: unknown) => process.stderr.write(`lousho improve --watch: a tick failed: ${error instanceof Error ? error.message : String(error)}\n`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const loop = (): void => {
    running = watchTick(options, context)
      .then(() => undefined, (error: unknown) => (controller.signal.aborted ? undefined : report(error)))
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, options.intervalMs ?? DEFAULT_INTERVAL_MS);
      });
  };
  loop();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      await running;
      await context.store.releaseLease?.(LEASE_ID, context.owner);
    },
  };
}

/** A defineSchedule() schedule that runs one watch tick, for agents that already use schedules/. */
export function improveSchedule(
  options: WatchOptions & {
    /** When to tick (default every 15 minutes). */
    cron?: string;
    /** The schedule's name (default `improve`). */
    name?: string;
  }
): DefinedSchedule {
  const { cron = '*/15 * * * *', name = 'improve', ...watch } = options;
  const context = watchContext(watch);
  return defineSchedule({
    cron,
    name,
    run: async () => {
      await watchTick(watch, context);
    },
  });
}
