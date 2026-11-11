/**
 * PassRunner - the in-process queue every background model pass (version
 * summaries, draft reviews, portability checks, prompt suggestions, auto
 * approvals, eval judges) goes through.
 *
 * Guarantees (PLAN §9):
 * - concurrency `concurrency` (default 2), FIFO;
 * - dedupe: two `enqueue`s with the same `kind:key` while one is queued or
 *   running share the one promise - the pass runs once;
 * - 3 attempts with `backoffMs` backoff (default [1000, 4000]) between
 *   them; the settle-without-retry errors below skip straight to their
 *   outcome, and spend-log/exporter failures never fail a pass;
 * - every settled pass appends exactly one `PassRecord` line to the spend
 *   log and ends exactly one `pass.<kind>` span on the `studio-passes`
 *   observe reporter.
 *
 * `PassJob`s throw the exported error classes to settle without retry
 * (`callPassModel` in L06b throws them for a missing key, a provider
 * refusal, or a disabled kind).
 */
import { recordSpanError, withSpan } from 'lousho';
import type { TraceExporter } from 'lousho/traces';
import { observeReporting } from '../observeReporting';
import { studioPaths } from '../workspace/studioPaths';
import { SpendLog } from './spendLog';

export type PassKind =
  | 'version_summary'
  | 'draft_review'
  | 'portability_check'
  | 'prompt_suggestion'
  | 'auto_approval'
  | 'eval_judge';

// fallow-ignore-next-line unused-export -- the PassKind catalog is part of the L06 contract; L06b's settings and pass callers enumerate it
export const PASS_KINDS: readonly PassKind[] = [
  'version_summary',
  'draft_review',
  'portability_check',
  'prompt_suggestion',
  'auto_approval',
  'eval_judge',
];

export type PassOutcome = 'completed' | 'failed' | 'refused' | 'unavailable' | 'skipped';

export type PassFailure = 'timeout' | 'rate_limited' | 'auth' | 'provider' | 'invalid_output';

/** One line of `spend.jsonl` - the accounting record of a settled pass. */
export interface PassRecord {
  kind: PassKind;
  key: string;
  /** The workspace the pass ran for (`null` for Studio-global passes). */
  workspaceId: string | null;
  agentId: string | null;
  model: string | null;
  outcome: PassOutcome;
  failure?: PassFailure;
  /** Token usage summed over every attempt that reported it; `null` when none did. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Cost summed over every attempt that reported it; `null` when none did. */
  costUsd: number | null;
  /** Wall-clock milliseconds across all attempts. */
  ms: number;
  /** ISO end time of the pass. */
  at: string;
}

export interface PassContext {
  /** 1-based attempt number (1..3). */
  attempt: number;
  /** Aborted by `PassRunner.close()`; a job should pass it to its model call. */
  signal: AbortSignal;
  /**
   * Reports this attempt's model, usage and cost; values accumulate across
   * attempts into the final `PassRecord`.
   */
  record(partial: Partial<Pick<PassRecord, 'model' | 'usage' | 'costUsd'>>): void;
}

export interface PassJob<T> {
  kind: PassKind;
  /** Dedupe key - `${kind}:${key}` identifies one in-flight pass. */
  key: string;
  /** The workspace the pass runs for; `null` for Studio-global passes. */
  workspaceId: string | null;
  agentId: string | null;
  run(ctx: PassContext): Promise<T>;
}

export type PassResult<T> =
  | { ok: true; value: T }
  | { ok: false; outcome: Exclude<PassOutcome, 'completed'>; error: string };

/** Thrown by a job to settle without retry. L06b throws these from callPassModel. */
export class PassUnavailableError extends Error {}
export class PassRefusedError extends Error {}
export class PassSkippedError extends Error {}
/** Retried like any other failure; the final outcome is `failed`/`invalid_output`. */
export class PassOutputError extends Error {}

export interface PassRunnerOptions {
  baseDir: string;
  /** Default 2. */
  concurrency?: number;
  /** Delay before attempts 2 and 3; default [1000, 4000]. */
  backoffMs?: readonly number[];
  /** Default `new SpendLog(studioPaths().spend)` - resolved on first append. */
  spendLog?: SpendLog;
  /** Default the `studio-passes` observe reporter (lazy - a down daemon costs nothing). */
  exporter?: TraceExporter;
  /** Default `() => true`; L06b wires the `passes` settings. */
  isEnabled?: (kind: PassKind) => boolean;
  now?: () => number;
}

const MAX_ATTEMPTS = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Maps a final-attempt error to its `PassFailure` category (contract order). */
function classifyFailure(error: unknown): PassFailure {
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const status = (error as { status?: unknown } | null)?.status;
  const message = errorMessage(error);
  if (status === 429 || /\b429\b/.test(message) || /rate.?limit/i.test(message)) return 'rate_limited';
  const code = (error as { code?: unknown } | null)?.code;
  if (status === 401 || status === 403 || code === 'LOUSHO_PROVIDER_MISSING_API_KEY') return 'auth';
  if (error instanceof PassOutputError) return 'invalid_output';
  return 'provider';
}

/** The settle-without-retry outcome an error asks for, if any. */
function immediateOutcome(error: unknown): Exclude<PassOutcome, 'completed' | 'failed'> | undefined {
  if (error instanceof PassUnavailableError) return 'unavailable';
  if (error instanceof PassRefusedError) return 'refused';
  if (error instanceof PassSkippedError) return 'skipped';
  return undefined;
}

/** Abortable sleep; resolves `false` when `signal` fires first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(!signal.aborted);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface QueueEntry {
  job: PassJob<unknown>;
  resolve: (result: PassResult<unknown>) => void;
}

interface Settled {
  result: PassResult<unknown>;
  failure?: PassFailure;
  /** The error to mark the span with when the outcome is `failed`. */
  error?: unknown;
}

/**
 * The pass queue. `enqueue` never rejects: every job settles to a
 * `PassResult`, and every settle - including disabled, refused and
 * shutdown-skipped passes - writes its one `PassRecord`.
 */
export class PassRunner {
  private readonly options: PassRunnerOptions;
  private readonly spendLogInstance?: SpendLog;
  private spendLog?: SpendLog;
  private exporterInstance?: TraceExporter;
  private readonly queue: QueueEntry[] = [];
  private running = 0;
  private readonly controllers = new Set<AbortController>();
  private readonly inflight = new Map<string, Promise<PassResult<unknown>>>();
  private readonly idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(options: PassRunnerOptions) {
    this.options = options;
    this.spendLogInstance = options.spendLog;
  }

  private log(): SpendLog {
    return (this.spendLog ??= this.spendLogInstance ?? new SpendLog(studioPaths().spend));
  }

  private exporter(): TraceExporter | undefined {
    if (this.exporterInstance === undefined && this.options.exporter === undefined) {
      // observeReporting's exporter() memoizes the real reporter; building
      // the reporting object is side-effect free, so this stays lazy until
      // the first pass actually runs.
      this.exporterInstance = observeReporting({ agentName: 'studio-passes', baseDir: this.options.baseDir }).exporter();
    }
    return this.exporterInstance ?? this.options.exporter;
  }

  /**
   * Queues `job`; the same `${kind}:${key}` while queued or running
   * returns the same promise. Never rejects.
   */
  // fallow-ignore-next-line unused-class-member -- the PassRunner contract's entry point; L06b's callPassModel and the concrete passes enqueue through it
  enqueue<T>(job: PassJob<T>): Promise<PassResult<T>> {
    if (this.closed || !(this.options.isEnabled ?? (() => true))(job.kind)) {
      const error = this.closed ? 'Studio is shutting down' : 'Turned off in settings';
      return this.settleImmediately(job, 'skipped', error);
    }
    const id = `${job.kind}:${job.key}`;
    const existing = this.inflight.get(id);
    if (existing) return existing as Promise<PassResult<T>>;
    const promise = new Promise<PassResult<T>>((resolve) => {
      this.queue.push({ job: job as PassJob<unknown>, resolve: resolve as (r: PassResult<unknown>) => void });
      this.pump();
    });
    const stored = promise as unknown as Promise<PassResult<unknown>>;
    this.inflight.set(id, stored);
    void stored.then(() => {
      if (this.inflight.get(id) === stored) this.inflight.delete(id);
    });
    return promise;
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  // fallow-ignore-next-line unused-class-member -- part of the PassRunner contract; shutdown and drain tests await it
  idle(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Aborts running jobs' signals and settles queued ones as 'skipped'. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const entry of this.queue.splice(0)) {
      void this.settleRecord(entry.job, 'skipped', 0).then(() =>
        entry.resolve({ ok: false, outcome: 'skipped', error: 'Studio is shutting down' })
      );
    }
    this.notifyIdle();
  }

  /** A pass that never enters the queue still gets its one record. */
  private settleImmediately<T>(job: PassJob<T>, outcome: PassOutcome, error: string): Promise<PassResult<T>> {
    return this.settleRecord(job, outcome, 0).then(() => ({ ok: false, outcome, error }) as PassResult<T>);
  }

  private pump(): void {
    while (!this.closed && this.running < (this.options.concurrency ?? 2) && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      this.running += 1;
      void this.execute(entry.job)
        .then(entry.resolve)
        .finally(() => {
          this.running -= 1;
          this.pump();
          this.notifyIdle();
        });
    }
  }

  private notifyIdle(): void {
    if (this.running !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  /** Runs the job's attempts inside its `pass.<kind>` span, then records it. */
  private async execute(job: PassJob<unknown>): Promise<PassResult<unknown>> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const started = (this.options.now ?? Date.now)();
    const usage = { inputTokens: 0, outputTokens: 0, reported: false };
    let costUsd = 0;
    let costReported = false;
    let model: string | null = null;
    const ctx: PassContext = {
      attempt: 1,
      signal: controller.signal,
      record(partial) {
        if (partial.model !== undefined) model = partial.model;
        if (partial.usage != null) {
          usage.inputTokens += partial.usage.inputTokens;
          usage.outputTokens += partial.usage.outputTokens;
          usage.reported = true;
        }
        if (partial.costUsd != null) {
          costUsd += partial.costUsd;
          costReported = true;
        }
      },
    };

    const settled = await withSpan(
      this.exporter(),
      `pass.${job.kind}`,
      {
        'lousho.pass.kind': job.kind,
        'lousho.pass.key': job.key,
        'lousho.agent.id': job.agentId ?? '',
        ...(job.workspaceId !== null ? { 'lousho.workspace.id': job.workspaceId } : {}),
      },
      async (span) => {
        const outcome = await this.attempts(job, ctx);
        span.attributes['lousho.pass.outcome'] = outcome.result.ok ? 'completed' : outcome.result.outcome;
        if (costReported) span.attributes['lousho.pass.cost_usd'] = costUsd;
        if (!outcome.result.ok && outcome.result.outcome === 'failed') {
          recordSpanError(span, outcome.error ?? new Error(outcome.result.error));
        }
        return outcome;
      }
    );

    this.controllers.delete(controller);
    const ms = (this.options.now ?? Date.now)() - started;
    await this.settleRecord(job, settled.result.ok ? 'completed' : settled.result.outcome, ms, {
      model,
      usage: usage.reported ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : null,
      costUsd: costReported ? costUsd : null,
      failure: settled.failure,
    });
    return settled.result;
  }

  /** The attempt loop; resolves with the final `PassResult` plus record extras. */
  private async attempts(job: PassJob<unknown>, ctx: PassContext): Promise<Settled> {
    const backoff = this.options.backoffMs ?? [1000, 4000];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      ctx.attempt = attempt;
      try {
        const value = await job.run(ctx);
        return { result: { ok: true, value } };
      } catch (error) {
        const immediate = immediateOutcome(error);
        if (immediate !== undefined) {
          return { result: { ok: false, outcome: immediate, error: errorMessage(error) } };
        }
        if (attempt === MAX_ATTEMPTS) {
          return {
            result: { ok: false, outcome: 'failed', error: errorMessage(error) },
            failure: classifyFailure(error),
            error,
          };
        }
        const waited = await sleep(backoff[attempt - 1] ?? 0, ctx.signal);
        if (!waited) {
          const abort = new Error('Pass aborted');
          abort.name = 'AbortError';
          return {
            result: { ok: false, outcome: 'failed', error: 'Pass aborted' },
            failure: 'timeout',
            error: abort,
          };
        }
      }
    }
    // Unreachable: the loop always returns on attempt MAX_ATTEMPTS.
    throw new Error('unreachable');
  }

  /** Appends the pass's one `PassRecord`; log failures warn and never fail the pass. */
  private async settleRecord(
    job: PassJob<unknown>,
    outcome: PassOutcome,
    ms: number,
    extra?: {
      model?: string | null;
      usage?: { inputTokens: number; outputTokens: number } | null;
      costUsd?: number | null;
      failure?: PassFailure;
    }
  ): Promise<void> {
    const now = this.options.now ?? Date.now;
    const record: PassRecord = {
      kind: job.kind,
      key: job.key,
      workspaceId: job.workspaceId ?? null,
      agentId: job.agentId ?? null,
      model: extra?.model ?? null,
      outcome,
      ...(extra?.failure !== undefined ? { failure: extra.failure } : {}),
      usage: extra?.usage ?? null,
      costUsd: extra?.costUsd ?? null,
      ms,
      at: new Date(now()).toISOString(),
    };
    try {
      await this.log().append(record);
    } catch (error) {
      console.warn(`[lousho studio] pass spend log append failed: ${errorMessage(error)}`);
    }
  }
}
