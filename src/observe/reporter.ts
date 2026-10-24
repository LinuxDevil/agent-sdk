/**
 * `observeExporter()` - the SDK's reporter: a `TraceExporter` that drains
 * finished spans into batched `POST /api/v1/ingest` calls to the collector
 * daemon (`lousho observe start`). Wire it explicitly, or let the
 * `LOUSHO_OBSERVE` env do it with zero code changes:
 *
 * - `LOUSHO_OBSERVE=1`/`true` → `http://127.0.0.1:$LOUSHO_OBSERVE_PORT(7777)`
 * - `LOUSHO_OBSERVE=<url>` → that collector
 * - unset/`0`/`false` → nothing is emitted
 * - `LOUSHO_OBSERVE_PROJECT` labels rows; `LOUSHO_OBSERVE_TOKEN` sends a bearer.
 *
 * Rules it lives by (the tracing-insights spec):
 * - One event per FINISHED span (`start`+`end`); `obs_id` is the span's own
 *   id (the `TraceLine.id`), so a resent batch upserts by key.
 * - Flush on size (50), on interval (5s), and on process exit (~2s cap).
 *   Crash loss is accepted and bounded: nothing persists mid run.
 * - The daemon being down, or a full buffer, drops events into a `dropped`
 *   counter and warns ONCE - the reporter never blocks or throws into a run.
 *   Timers are unref'd so observation never keeps a process alive.
 * - Its own HTTP calls are plain `fetch`, outside any span: instrumenting
 *   them would recurse.
 *
 * Identity: `agent_id`/`session_id` come from `.lousho/identity/` in the
 * project dir (see identity.ts); `session_id` is the span's
 * `gen_ai.conversation.id` when the run has a real session.
 */

import { GenAiAttr, GenAiOperation, LegacyAttr, SdkAttr } from '../execution/semconv';
import { SDKError } from '../execution/errors';
import type { Span, TraceExporter } from '../execution/tracing';
import { VERSION } from '../version';
import { OBSERVE_DEFAULT_PORT, type IngestEvent, type ObservationData, type ObservationKind, type PromptUseData } from './envelope';
import { hostName, resolveIdentity, resolveProject } from './identity';

/** The registry prompt a run used (`prompt_use` minus its `obs_id`, which the reporter fills with the root span's id). */
export type PromptUseRef = Pick<PromptUseData, 'prompt_id' | 'version'>;

/** Resolves the run's registry prompt once fetched; `undefined` means no `prompt_use` is emitted (fetch pending or failed). */
export type PromptUseProvider = () => PromptUseRef | undefined;

export interface ObserveExporterOptions {
  /** Collector base URL (default `http://127.0.0.1:7777`). */
  url?: string;
  /** Project label on every row; default `LOUSHO_OBSERVE_PROJECT` else the cwd's package.json name. */
  project?: string;
  /** Registry name; default `'agent'`. The env wiring passes the createAgent config's `name`. */
  agentName?: string;
  /** Bearer token for a daemon that demands one (`LOUSHO_OBSERVE_TOKEN`). */
  token?: string;
  /** Explicit fallback `session_id`; default `sha256(agent_id+cwd)` from the identity file. */
  sessionId?: string;
  /** Flush when this many events are buffered (default 50). */
  flushSize?: number;
  /** Flush interval (default 5000ms). */
  flushIntervalMs?: number;
  /** Heartbeat cadence (default 60000ms); `0` disables heartbeats. */
  heartbeatIntervalMs?: number;
  /** Buffer cap; events past it drop into `dropped` (default 5000). */
  maxBuffered?: number;
  /** Per-request timeout (default 5000ms); the exit flush always caps at ~2000ms. */
  requestTimeoutMs?: number;
  /** Project dir for `.lousho/identity/`; default `process.cwd()`. */
  cwd?: string;
  /** Version reported on heartbeats; default the SDK's. */
  version?: string;
  /** Injectable transport (tests); default the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Register process exit hooks (deregister + final flush); default true. */
  registerExitHooks?: boolean;
  /** Injectable clock (tests); default `Date.now`. */
  now?: () => number;
  /**
   * The registry prompt this agent's runs resolved (the `prompt` opt-in).
   * When a span with no parent starts - a run's root `invoke_agent` - and
   * this provider returns a ref, a `prompt_use` event is queued with
   * `obs_id` = that root span's id.
   */
  promptUse?: PromptUseProvider;
}

export interface ObserveReporter extends TraceExporter {
  /** Events dropped because the daemon was unreachable or the buffer was full. */
  readonly dropped: number;
  /** This reporter's persisted `agent_id`. */
  readonly agentId: string;
  /** The fallback `session_id` (non-session spans). */
  readonly sessionId: string;
  /**
   * The registry prompt ref provider (see {@link ObserveExporterOptions.promptUse}).
   * Mutable because `LOUSHO_OBSERVE` reporters are memoized per agent
   * name: a later {@link observeExporterFromEnv} call with a prompt sets it
   * on the shared reporter.
   */
  promptUse?: PromptUseProvider;
  /** Deregister, flush once, and release timers/hooks. Idempotent. */
  close(): Promise<void>;
}

const DEFAULT_FLUSH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_MAX_BUFFERED = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const EXIT_FLUSH_TIMEOUT_MS = 2000;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** JSON for a non-string attribute value (args/result objects); strings pass through. */
function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The first defined attribute among `keys`, as a string. */
function pickAttr(attrs: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const text = textOf(attrs[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

const KIND_OF: Record<string, ObservationKind> = {
  [GenAiOperation.CHAT]: 'generation',
  [GenAiOperation.EXECUTE_TOOL]: 'tool',
  [GenAiOperation.INVOKE_AGENT]: 'span',
  [GenAiOperation.INVOKE_WORKFLOW]: 'span',
};

/** Which attributes carry a span's payload, per operation. */
const INPUT_KEYS: Record<string, readonly string[]> = {
  [GenAiOperation.CHAT]: [GenAiAttr.INPUT_MESSAGES, LegacyAttr.PROMPT],
  [GenAiOperation.EXECUTE_TOOL]: [GenAiAttr.TOOL_CALL_ARGUMENTS, LegacyAttr.ARGS],
  [GenAiOperation.INVOKE_AGENT]: [GenAiAttr.INPUT_MESSAGES, LegacyAttr.INPUT],
};
const OUTPUT_KEYS: Record<string, readonly string[]> = {
  [GenAiOperation.CHAT]: [GenAiAttr.OUTPUT_MESSAGES],
  [GenAiOperation.EXECUTE_TOOL]: [GenAiAttr.TOOL_CALL_RESULT, LegacyAttr.RESULT],
  [GenAiOperation.INVOKE_AGENT]: [GenAiAttr.OUTPUT_MESSAGES],
};
const GENERIC_INPUT_KEYS = [GenAiAttr.INPUT_MESSAGES, LegacyAttr.INPUT] as const;
const GENERIC_OUTPUT_KEYS = [GenAiAttr.OUTPUT_MESSAGES, LegacyAttr.RESULT] as const;

/** One finished span → one `observation` event (StepUsage fields carried verbatim from the gen_ai/lousho attrs). */
function observationOf(span: Span, traceId: string, agentId: string, fallbackSessionId: string, now: () => number): ObservationData {
  const attrs = span.attributes;
  const op = str(attrs[GenAiAttr.OPERATION_NAME]) ?? '';
  const status = span.status?.code;
  return {
    obs_id: span.id,
    trace_id: traceId,
    session_id: str(attrs[GenAiAttr.CONVERSATION_ID]) ?? fallbackSessionId,
    agent_id: agentId,
    ...(span.parentId !== undefined ? { parent_obs_id: span.parentId } : {}),
    kind: KIND_OF[op] ?? 'span',
    name: span.name,
    start: span.startTime,
    end: span.endTime ?? now(),
    ...(status === 'ok' || status === 'error' ? { status } : {}),
    ...(pickAttr(attrs, INPUT_KEYS[op] ?? GENERIC_INPUT_KEYS) !== undefined
      ? { input: pickAttr(attrs, INPUT_KEYS[op] ?? GENERIC_INPUT_KEYS) }
      : {}),
    ...(pickAttr(attrs, OUTPUT_KEYS[op] ?? GENERIC_OUTPUT_KEYS) !== undefined
      ? { output: pickAttr(attrs, OUTPUT_KEYS[op] ?? GENERIC_OUTPUT_KEYS) }
      : {}),
    ...(str(attrs[GenAiAttr.RESPONSE_MODEL] ?? attrs[GenAiAttr.REQUEST_MODEL] ?? attrs[LegacyAttr.MODEL]) !== undefined
      ? { model: str(attrs[GenAiAttr.RESPONSE_MODEL] ?? attrs[GenAiAttr.REQUEST_MODEL] ?? attrs[LegacyAttr.MODEL]) }
      : {}),
    ...(num(attrs[GenAiAttr.USAGE_INPUT_TOKENS] ?? attrs[LegacyAttr.PROMPT_TOKENS]) !== undefined
      ? { usage_input_tokens: num(attrs[GenAiAttr.USAGE_INPUT_TOKENS] ?? attrs[LegacyAttr.PROMPT_TOKENS]) }
      : {}),
    ...(num(attrs[GenAiAttr.USAGE_OUTPUT_TOKENS] ?? attrs[LegacyAttr.COMPLETION_TOKENS]) !== undefined
      ? { usage_output_tokens: num(attrs[GenAiAttr.USAGE_OUTPUT_TOKENS] ?? attrs[LegacyAttr.COMPLETION_TOKENS]) }
      : {}),
    ...(num(attrs['gen_ai.usage.cached_input_tokens']) !== undefined
      ? { usage_cached_tokens: num(attrs['gen_ai.usage.cached_input_tokens']) }
      : {}),
    ...(num(attrs[SdkAttr.USAGE_REASONING_TOKENS]) !== undefined
      ? { usage_reasoning_tokens: num(attrs[SdkAttr.USAGE_REASONING_TOKENS]) }
      : {}),
    ...(num(attrs[SdkAttr.COST_USD]) !== undefined ? { cost_usd: num(attrs[SdkAttr.COST_USD]) } : {}),
    ...(attrs['lousho.cost_partial'] === true ? { cost_partial: true } : {}),
    ...(attrs[SdkAttr.USAGE_ESTIMATED] === true ? { usage_estimated: true } : {}),
    attrs,
  };
}

/**
 * A `TraceExporter` that batches finished spans to a collector daemon. The
 * returned object is also an {@link ObserveReporter}: `close()` sends
 * `agent.deregister` and the final flush.
 */
export function observeExporter(options: ObserveExporterOptions = {}): ObserveReporter {
  const cwd = options.cwd ?? (typeof process !== 'undefined' ? process.cwd() : '.');
  const project = resolveProject(options.project, cwd);
  const agentName = options.agentName ?? 'agent';
  const identity = resolveIdentity({ name: agentName, project, cwd });
  const fallbackSessionId = options.sessionId ?? identity.sessionId;
  const url = (options.url ?? `http://127.0.0.1:${OBSERVE_DEFAULT_PORT}`).replace(/\/+$/, '');
  const token = options.token;
  const version = options.version ?? VERSION;
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const flushSize = options.flushSize ?? DEFAULT_FLUSH_SIZE;
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let promptUse = options.promptUse;

  const pending: IngestEvent[] = [];
  let droppedCount = 0;
  let closed = false;
  let warned = false;

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;

  const warnOnce = (what: string, error: unknown) => {
    if (warned) return;
    warned = true;
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[lousho] observe: ${what} (${reason}); events are counted in 'dropped' and the run is unaffected.`);
  };

  const push = (event: IngestEvent) => {
    if (pending.length >= maxBuffered) {
      droppedCount++;
      warnOnce(`buffer is full (${maxBuffered} events); dropping`, new SDKError('observe buffer full', 'LOUSHO_REMOTE_REQUEST_FAILED', { appendHelp: false }));
      return;
    }
    pending.push(event);
    if (pending.length >= flushSize) void flush(requestTimeoutMs);
  };

  const enqueue = (event: IngestEvent) => {
    // A span ending after close() has no flush left to catch it - count it as dropped.
    if (closed) {
      droppedCount++;
      return;
    }
    push(event);
  };

  const post = async (events: IngestEvent[], timeoutMs: number): Promise<void> => {
    const res = await fetchFn(`${url}/api/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ batch: events }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new SDKError(`ingest answered ${res.status}`, 'LOUSHO_REMOTE_REQUEST_FAILED', { appendHelp: false });
    }
  };

  // Flushes are serialized on a chain: a fire-and-forget size flush and the
  // exit flush can overlap, and close() must not resolve while its own POST
  // is still in flight.
  let chain: Promise<void> = Promise.resolve();
  const flush = (timeoutMs: number): Promise<void> => {
    const run = chain.then(async () => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      try {
        await post(batch, timeoutMs);
      } catch (error) {
        // Drop-and-count by contract: a missing daemon must never slow or fail a run.
        droppedCount += batch.length;
        warnOnce(`could not reach the observe daemon at ${url}`, error);
      }
    });
    chain = run;
    return run;
  };

  const heartbeat = (): void => {
    if (heartbeatIntervalMs <= 0) return;
    enqueue({
      type: 'agent.heartbeat',
      data: {
        agent_id: identity.agentId,
        project,
        name: agentName,
        version,
        ts: now(),
        heartbeat_interval_ms: heartbeatIntervalMs,
        ...(hostName() !== undefined ? { hostname: hostName() } : {}),
        ...(typeof process !== 'undefined' && typeof process.pid === 'number' ? { pid: process.pid } : {}),
      },
    });
  };

  /** span.id -> trace_id; a span whose parent is unknown roots a trace of its own. */
  const targets = new Map<string, string>();

  const timers: ReturnType<typeof setInterval>[] = [];
  if (flushIntervalMs > 0) {
    const t = setInterval(() => void flush(requestTimeoutMs), flushIntervalMs);
    t.unref?.();
    timers.push(t);
  }
  if (heartbeatIntervalMs > 0) {
    heartbeat(); // register at once so the fleet registry sees the agent on start, not 60s in
    const t = setInterval(heartbeat, heartbeatIntervalMs);
    t.unref?.();
    timers.push(t);
  }

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    for (const [signal, handler] of exitHooks) {
      try {
        process.off(signal, handler);
      } catch {
        // no process.off in this runtime
      }
    }
    // Graceful exit: say goodbye, then flush with the ~2s cap. push() directly so a
    // full buffer can't eat the deregister - one pending event drops instead.
    if (pending.length >= maxBuffered) pending.splice(0, 1);
    push({ type: 'agent.deregister', data: { agent_id: identity.agentId, ts: now() } });
    await flush(EXIT_FLUSH_TIMEOUT_MS);
  };

  const exitHooks: Array<[string, () => void]> = [];
  if (options.registerExitHooks !== false && typeof process !== 'undefined' && typeof process.once === 'function') {
    // 'beforeExit' fires while async work still runs; the in-flight POST keeps the loop
    // alive until it settles (the ~2s cap bounds the wait). Signals get an explicit
    // exit afterwards because installing a handler replaces the default kill.
    const onBeforeExit = () => void close();
    const onSignal = (code: number) => () => {
      void close().finally(() => process.exit(code));
    };
    const hooks: Array<[NodeJS.Signals | 'beforeExit', () => void]> = [
      ['beforeExit', onBeforeExit],
      ['SIGINT', onSignal(130)],
      ['SIGTERM', onSignal(143)],
    ];
    for (const [signal, handler] of hooks) {
      process.once(signal as NodeJS.Signals, handler);
      exitHooks.push([signal, handler]);
    }
  }

  return {
    get dropped() {
      return droppedCount;
    },
    agentId: identity.agentId,
    sessionId: fallbackSessionId,
    get promptUse() {
      return promptUse;
    },
    set promptUse(provider: PromptUseProvider | undefined) {
      promptUse = provider;
    },
    onSpanStart(span) {
      const parent = span.parentId !== undefined ? targets.get(span.parentId) : undefined;
      targets.set(span.id, parent ?? span.id);
      // A parentless span is a run's root `invoke_agent`: one `prompt_use`
      // per run, keyed by the root span's id (the run's obs_id). Sub-agent
      // runs arrive with parentSpanId set and never re-emit it.
      if (span.parentId === undefined && promptUse !== undefined) {
        const use = promptUse();
        if (use !== undefined) {
          enqueue({
            type: 'prompt_use',
            data: { obs_id: span.id, prompt_id: use.prompt_id, ...(use.version !== undefined ? { version: use.version } : {}) },
          });
        }
      }
    },
    onSpanEnd(span) {
      const traceId = targets.get(span.id) ?? span.id;
      enqueue({ type: 'observation', data: observationOf(span, traceId, identity.agentId, fallbackSessionId, now) });
      if (traceId !== span.id) return;
      // The root ended: forget every span of this trace so the map does not grow forever.
      for (const [id, tid] of targets) if (tid === traceId) targets.delete(id);
    },
    close,
  };
}

/* ------------------------------------------------------- env wiring + fanout */

/** What a fan-out resolves to, so re-composing does not double-deliver (see below). */
const composedParts = new WeakMap<TraceExporter, readonly TraceExporter[]>();

/**
 * Fan several exporters out to one: every span goes to each. Composed
 * exporters remember their parts, so composing `fanOut([a, b])` with `b`
 * again yields `a, b` once - `createAgent` composing over an exporter that
 * `AgentExecutor.execute` already env-composed must not deliver twice. An
 * inner exporter's throw is reported (through withSpan's once-warning) but
 * never keeps the remaining exporters from seeing the span.
 */
export function fanOutExporters(exporters: readonly (TraceExporter | undefined | null)[]): TraceExporter | undefined {
  const flat: TraceExporter[] = [];
  const seen = new Set<TraceExporter>();
  for (const exporter of exporters) {
    for (const inner of exporter ? (composedParts.get(exporter) ?? [exporter]) : []) {
      if (!seen.has(inner)) {
        seen.add(inner);
        flat.push(inner);
      }
    }
  }
  if (flat.length === 0) return undefined;
  if (flat.length === 1) return flat[0];
  const fan: TraceExporter = {
    onSpanStart(span) {
      let first: unknown;
      for (const exporter of flat) {
        try {
          exporter.onSpanStart(span);
        } catch (error) {
          first ??= error;
        }
      }
      if (first !== undefined) throw first;
    },
    onSpanEnd(span) {
      let first: unknown;
      for (const exporter of flat) {
        try {
          exporter.onSpanEnd(span);
        } catch (error) {
          first ??= error;
        }
      }
      if (first !== undefined) throw first;
    },
  };
  composedParts.set(fan, flat);
  return fan;
}

const envReporters = new Map<string, ObserveReporter>();
/** Every reporter {@link observeExporterFromEnv} made - so a composed exporter can be checked for an env member. */
const envReporterSet = new WeakSet<TraceExporter>();

/**
 * The collector base URL the env points at: `LOUSHO_OBSERVE=1`/`true` →
 * `http://127.0.0.1:$LOUSHO_OBSERVE_PORT(7777)`, a URL → itself, unset/`0`/
 * `false` → `undefined`. Shared by the reporter, the prompt fetch and the
 * hub client - they must all agree on where the daemon lives.
 */
export function observeUrlFromEnv(
  env: NodeJS.ProcessEnv | undefined = typeof process !== 'undefined' ? process.env : undefined
): string | undefined {
  const flag = env?.LOUSHO_OBSERVE?.trim();
  if (!flag || flag === '0' || flag.toLowerCase() === 'false' || env === undefined) return undefined;
  return flag === '1' || flag.toLowerCase() === 'true'
    ? `http://127.0.0.1:${env.LOUSHO_OBSERVE_PORT || String(OBSERVE_DEFAULT_PORT)}`
    : flag;
}

/**
 * The `LOUSHO_OBSERVE`-driven reporter, memoized per (agent name, project,
 * url): every `execute()` call resolves the same instance, so an agent never
 * heartbeats twice. `undefined` when the env is unset/`0`/`false`.
 *
 * `promptUse` is the registry prompt the agent resolved (`createAgent({
 * prompt })`/`LOUSHO_PROMPT`): it is set on the shared reporter, so the last
 * agent built under one name wins.
 *
 * Pass `env` only in tests.
 */
export function observeExporterFromEnv(
  options: { agentName?: string; promptUse?: PromptUseProvider; env?: NodeJS.ProcessEnv } = {}
): ObserveReporter | undefined {
  const env = options.env ?? (typeof process !== 'undefined' ? process.env : undefined);
  const url = observeUrlFromEnv(env);
  if (url === undefined) return undefined;
  const name = options.agentName ?? 'agent';
  const project = env?.LOUSHO_OBSERVE_PROJECT;
  const key = `${name} ${project ?? ''} ${url}`;
  let reporter = envReporters.get(key);
  if (!reporter) {
    reporter = observeExporter({
      url,
      agentName: name,
      ...(project ? { project } : {}),
      ...(env?.LOUSHO_OBSERVE_TOKEN ? { token: env.LOUSHO_OBSERVE_TOKEN } : {}),
    });
    envReporters.set(key, reporter);
    envReporterSet.add(reporter);
  }
  if (options.promptUse !== undefined) reporter.promptUse = options.promptUse;
  return reporter;
}

/** The parts `explicit` flattens to (itself when it was never composed). */
function exporterParts(explicit: TraceExporter): readonly TraceExporter[] {
  return composedParts.get(explicit) ?? [explicit];
}

/**
 * The exporter a run reports with: the caller's, the env's, or both fanned
 * out. When `explicit` already carries an env reporter - a delegated
 * sub-agent inherits its lead's exporter - the env step is skipped, so one
 * process reports under ONE agent identity and child spans are not
 * double-posted stamped with two agent_ids.
 *
 * `options.promptUse` is the registry prompt the agent resolved; it lands on
 * the env reporter (the only path to the daemon's ingest API).
 */
export function withObserveExporter(
  explicit: TraceExporter | undefined,
  agentName: string | undefined,
  options: { promptUse?: PromptUseProvider } = {}
): TraceExporter | undefined {
  if (explicit && exporterParts(explicit).some((part) => envReporterSet.has(part))) return explicit;
  return fanOutExporters([explicit, observeExporterFromEnv({ agentName, ...(options.promptUse ? { promptUse: options.promptUse } : {}) })]);
}
