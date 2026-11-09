import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CheckpointStore } from '../execution/checkpoint';
import { ConfigurationError } from '../execution/errors';
import { failureReportFromDb } from '../observe/failures';
import { runsByRevision } from '../observe/store';
import { scoreRegressionsSince } from '../observe/sweep';
import type { LLMProvider } from '../providers';
import { createRateLimiter, withRateLimit } from '../providers/rateLimit';
import { resolveProvider } from '../providers/resolveProvider';
import { defineSchedule, type DefinedSchedule } from '../schedules/defineSchedule';
import { fileStore } from '../storage/fileStore';
import { appendAudit } from './audit';
import type { Alerter } from '../observe/alerts';
import type { GuardCorpusResult } from './corpusGuard';
import { cycleNotice, notifier, type Notify } from './notify';
import { pausedBy, type HealCycle } from './cycles';
import { healOnce, type HealOptions } from './heal';
import { stopCanary, type CanarySettlement } from './trafficCanary';
import { settleTraffic } from './watchCanary';
import { checkApplied, type MonitorVerdict } from './monitor';
import { pauseImprove } from './pause';
import { harnessHash, readAgentHarness } from './revisions';
import { loadImproveSettings, type ImproveSettings } from './settings';
import { readState, updateState } from './state';
import type { ImproveOptions } from './types';
import { registerWatcher, unregisterWatcher } from './watchers';
import { budgetLeft, guardScheduled, harvest, saveWatch, watchOf, type WatchContext, type WatchMemory, type WatchState } from './watchSteps';

/** Options for {@link watchAgent} and {@link improveSchedule}. */
export interface WatchOptions extends Omit<HealOptions, 'trigger' | 'maxTokens' | 'agent'> {
  /** The agent's id or registered name in the observe database; the monitor judges its runs. */
  agent: string;
  /** Milliseconds between ticks (default 15 minutes); the lease lasts twice this and is renewed while a tick runs. */
  intervalMs?: number;
  /** Reads the settings afresh each tick, such as `() => loadImproveSettings(dir)`; without it `settings` is used, with `enabled` re-read from improve.json. */
  reloadSettings?: () => ImproveSettings;
  /** Called with each cycle that ran. */
  onCycle?: (cycle: HealCycle) => void;
  /** Called with each tick that finished, whether or not a cycle ran. */
  onTick?: (tick: WatchTick) => void;
  /** Called with an error a tick threw; the watcher keeps running (default: printed to stderr). */
  onError?: (error: unknown) => void;
  /** Holds the one-watcher-per-directory lease; it must support leases (default a file store in `.lousho/watch`). */
  store?: CheckpointStore;
  /** Posts `improve.*` events to webhooks, such as `createAlerter(resolveAlertConfig(dbPath))`; a failed post never fails a tick. */
  alerter?: Alerter;
  /** Writes one line per `improve.*` event (default stderr). */
  log?: (line: string) => void;
  /** A `watchers.json` beside the observe db, where the watcher registers `{ agent, dir }` while it runs. */
  registry?: string;
}

/** What one watch tick did. */
export interface WatchTick {
  /** `paused` by the kill switch, `stopped` when the watcher was stopped, `leased` when another watcher holds the directory, `cooldown` after a rollback, `deduped` when nothing new arrived, else `ran`. */
  state: 'paused' | 'stopped' | 'leased' | 'cooldown' | 'deduped' | 'ran';
  /** Why, as plain text. */
  reason: string;
  /** The monitor's verdict on the last apply. */
  monitor?: MonitorVerdict;
  /** The scheduled corpus guard, when it ran. */
  guard?: GuardCorpusResult;
  /** The cycle, when one ran. */
  cycle?: HealCycle;
  /** What settling the opt-in traffic canary did, when one was settled. */
  canary?: CanarySettlement;
}

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const MAX_OUTAGES = 3;
const MAX_RUNS = 1000;
const RENEW_FRACTION = 3;
const MIN_RENEW_MS = 10;
const NOT_WORKED: readonly HealCycle['outcome'][] = ['outage', 'busy', 'budget', 'budget-exceeded', 'cooldown', 'paused', 'interrupted'];
const UNCOUNTED: readonly HealCycle['outcome'][] = ['idle', 'paused', 'busy', 'budget', 'cooldown'];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function rateLimited(editor: ImproveOptions['editor'], rpm: number): ImproveOptions['editor'] {
  const provider: LLMProvider = 'provider' in editor ? editor.provider : resolveProvider(editor.model);
  return { provider: withRateLimit(provider, createRateLimiter({ requestsPerMinute: rpm })) };
}

export function watchContext(options: WatchOptions, signal?: AbortSignal): WatchContext {
  const store = options.store ?? fileStore(path.join(options.dir, '.lousho', 'watch')).checkpoints;
  if (!store.acquireLease) throw new ConfigurationError('watchAgent: the store must support leases (acquireLease), so only one watcher runs per agent directory.', 'store');
  const leaseId = `improve-${createHash('sha256').update(path.resolve(options.dir)).digest('hex').slice(0, 32)}`;
  const log = options.log ?? ((line: string) => process.stderr.write(line));
  const notify = notifier({ agent: options.agent, dir: options.dir }, { log, ...(options.alerter && { alerter: options.alerter }) });
  return { owner: `${process.pid}:watch:${randomUUID()}`, leaseId, store, editor: rateLimited(options.editor, options.settings.rateLimit.rpm), notify, ...(signal && { signal }) };
}

function settingsOf(options: WatchOptions): ImproveSettings | string {
  try {
    if (options.reloadSettings) return options.reloadSettings();
    return { ...options.settings, enabled: options.settings.enabled && loadImproveSettings(options.dir).enabled };
  } catch (error) {
    return `improve.json can't be read (${messageOf(error)})`;
  }
}

async function pauseOnce(dir: string, reason: string, notify: Notify): Promise<WatchTick> {
  if (watchOf(dir).paused === undefined) {
    await appendAudit(dir, { actor: 'scheduler', action: 'pause', reason: `The self-healing loop is paused: ${reason}.` });
    await saveWatch(dir, { paused: reason });
    notify({ type: 'improve.paused', reason: `Paused: ${reason}.` });
  }
  await stopCanary(dir, { actor: 'scheduler', reason: `the self-healing loop is paused: ${reason}.` });
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

function halted(options: WatchOptions, signal: AbortSignal | undefined): WatchTick | undefined {
  if (signal?.aborted) return { state: 'stopped', reason: 'The watcher stopped, or lost its lease, before the next step.' };
  const settings = settingsOf(options);
  const paused = typeof settings === 'string' ? settings : pausedBy(options.dir, settings);
  return paused ? { state: 'paused', reason: `Paused before the next step: ${paused}.` } : undefined;
}

function failureKey(options: WatchOptions): { revision: string; signatures: string[]; failed: number; newest?: string } {
  const revision = harnessHash(readAgentHarness(options.dir));
  const runs = runsByRevision(options.db, { revision, agent: options.agent, limit: MAX_RUNS });
  const traceIds = runs.map((run) => run.traceId);
  const signatures = traceIds.length === 0 ? [] : [...new Set(failureReportFromDb(options.db, { traceIds }).groups.map((group) => group.signature))].sort();
  const failed = runs.filter((run) => run.failed);
  return { revision, signatures, failed: failed.length, ...(failed[0] && { newest: failed[0].traceId }) };
}

function cooldownUntil(dir: string, now: number): string | undefined {
  const until = readState<WatchState>(dir).cooldownUntil;
  const at = Date.parse(until ?? '');
  return Number.isFinite(at) && at > now ? until : undefined;
}

async function countOutage(dir: string, cycle: HealCycle, notify: Notify): Promise<void> {
  if (UNCOUNTED.includes(cycle.outcome)) return;
  if (cycle.outcome !== 'outage') {
    await saveWatch(dir, { outages: 0 });
    return;
  }
  const outages = (watchOf(dir).outages ?? 0) + 1;
  await saveWatch(dir, { outages });
  if (outages < MAX_OUTAGES) return;
  const reason = `The self-healing loop paused itself: ${MAX_OUTAGES} cycles in a row ended in a provider outage.`;
  await pauseImprove(dir, { reason });
  await saveWatch(dir, { outages: 0 });
  notify({ type: 'improve.paused', reason, cycle: cycle.id });
}

function sameFailures(last: WatchMemory, key: ReturnType<typeof failureKey>): boolean {
  if (last.signatures === undefined) return false;
  return last.revision === key.revision && last.failed === key.failed && last.newest === key.newest && last.signatures.join('\n') === key.signatures.join('\n');
}

async function runCycle(options: WatchOptions, context: WatchContext, trigger: HealCycle['trigger'], now: number): Promise<WatchTick> {
  const until = cooldownUntil(options.dir, now);
  if (until) return { state: 'cooldown', reason: `The monitor's cooldown runs until ${until}, so no cycle ran.` };
  const key = failureKey(options);
  const last = watchOf(options.dir);
  const marked = scoreRegressionsSince(options.db, options.agent, last.scoreAt ?? 0)
    .filter((mark) => mark.revision === null || mark.revision === key.revision)
    .at(-1)?.at;
  if (marked === undefined && sameFailures(last, key)) return { state: 'deduped', reason: 'The same failures as the last cycle and nothing new, so no cycle ran.' };
  const { intervalMs: _interval, reloadSettings: _reload, onCycle, onTick: _onTick, onError: _onError, store: _store, alerter: _alerter, log: _log, registry: _registry, ...heal } = options;
  const cycle = await healOnce({ ...heal, editor: context.editor, trigger: marked === undefined ? trigger : 'score', maxTokens: budgetLeft(options.dir, options.settings, now), ...(context.signal && { signal: context.signal }) });
  if (!NOT_WORKED.includes(cycle.outcome)) await saveWatch(options.dir, { revision: key.revision, signatures: key.signatures, failed: key.failed, ...(key.newest && { newest: key.newest }), ...(marked !== undefined && { scoreAt: marked }) });
  await countOutage(options.dir, cycle, context.notify);
  const notice = cycleNotice(cycle, options.dir);
  if (notice) context.notify(notice);
  onCycle?.(cycle);
  return { state: 'ran', reason: cycle.reason, cycle };
}

function holdLease(context: WatchContext, ttl: number): { signal: AbortSignal; release(): Promise<void> } {
  const lost = new AbortController();
  let renewing: Promise<void> | undefined;
  const renew = () => {
    renewing ??= (context.store.acquireLease?.(context.leaseId, context.owner, ttl) ?? Promise.resolve(true))
      .then(
        (held) => (held ? undefined : lost.abort()),
        () => lost.abort()
      )
      .finally(() => {
        renewing = undefined;
      });
  };
  const timer = setInterval(renew, Math.max(MIN_RENEW_MS, Math.floor(ttl / RENEW_FRACTION)));
  (timer as { unref?: () => void }).unref?.();
  const release = async (): Promise<void> => {
    clearInterval(timer);
    await renewing;
  };
  return { signal: context.signal ? AbortSignal.any([context.signal, lost.signal]) : lost.signal, release };
}

async function steps(options: WatchOptions, context: WatchContext, trigger: HealCycle['trigger'], now: number): Promise<WatchTick> {
  const monitor = await checkApplied(options.db, options.dir, options.settings, { agent: options.agent, now });
  const stopAfterMonitor = halted(options, context.signal);
  if (stopAfterMonitor) return { ...stopAfterMonitor, monitor };
  await harvest(options, monitor, now, context);
  const stopAfterHarvest = halted(options, context.signal);
  if (stopAfterHarvest) return { ...stopAfterHarvest, monitor };
  const traffic = await settleTraffic(options, now, context);
  const guard = traffic.guard ?? (await guardScheduled(options, now, context));
  const done = { monitor, ...(guard && { guard }), ...(traffic.canary && { canary: traffic.canary }) };
  const stopAfterGuard = halted(options, context.signal);
  if (stopAfterGuard) return { ...stopAfterGuard, ...done };
  const ran = await runCycle(options, context, trigger, now);
  return { ...ran, ...done };
}

/** Runs one watch tick: the kill switch, the lease, the monitor, the scheduled corpus guard, then a cycle within the budgets. */
export async function watchTick(options: WatchOptions, context: WatchContext, trigger: HealCycle['trigger'] = 'failures'): Promise<WatchTick> {
  const now = Date.now();
  const settings = settingsOf(options);
  const paused = typeof settings === 'string' ? settings : pausedBy(options.dir, settings);
  if (paused) return pauseOnce(options.dir, paused, context.notify);
  await resumeIfPaused(options.dir);
  if (context.signal?.aborted) return { state: 'stopped', reason: 'The watcher stopped.' };
  const ttl = 2 * (options.intervalMs ?? DEFAULT_INTERVAL_MS);
  if (!(await context.store.acquireLease?.(context.leaseId, context.owner, ttl))) return { state: 'leased', reason: 'Another watcher holds this agent directory.' };
  const lease = holdLease(context, ttl);
  try {
    return await steps({ ...options, settings: settings as ImproveSettings }, { ...context, signal: lease.signal }, trigger, now);
  } finally {
    await lease.release();
  }
}

/** Runs healOnce, the monitor and the corpus guard on a timer, within the settings' budgets; stops on the kill switch. */
export function watchAgent(options: WatchOptions): {
  /** Stops after the current step, waits for the tick in progress and releases the lease. */
  stop(): Promise<void>;
} {
  const controller = new AbortController();
  const context = watchContext(options, controller.signal);
  const report = options.onError ?? ((error: unknown) => process.stderr.write(`lousho improve --watch: a tick failed: ${messageOf(error)}\n`));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const loop = (): void => {
    running = watchTick(options, context)
      .then(
        (tick) => {
          try {
            options.onTick?.(tick);
          } catch (error) {
            report(error);
          }
        },
        (error: unknown) => (controller.signal.aborted ? undefined : report(error))
      )
      .finally(() => {
        if (!stopped) timer = setTimeout(loop, options.intervalMs ?? DEFAULT_INTERVAL_MS);
      });
  };
  const registered = options.registry ? registerWatcher(options.registry, { agent: options.agent, dir: options.dir, owner: context.owner }).catch(report) : Promise.resolve();
  loop();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      await running;
      await context.store.releaseLease?.(context.leaseId, context.owner);
      await registered;
      if (options.registry) await unregisterWatcher(options.registry, context.owner).catch(report);
    },
  };
}

/** A defineSchedule() schedule that runs one watch tick, for agents that already use schedules/. */
export function improveSchedule(
  options: WatchOptions & {
    /** When to tick (default every 15 minutes); set `intervalMs` to the same spacing so the lease spans two ticks. */
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
