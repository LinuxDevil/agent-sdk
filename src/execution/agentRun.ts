/**
 * LOU-V2: `AgentRun`, the handle `agent.stream()` / `AgentExecutor.stream()`
 * return - an async iterable of {@link AgentEvent}s plus a `result` promise.
 *
 * The run itself is the ordinary AgentExecutor loop. This module only
 * (1) translates the loop's existing `onEvent` callbacks into AgentEvents,
 * (2) hands the loop a {@link RunEventSink} (under the {@link RUN_EVENTS}
 * key of its options) for what those callbacks do not cover - step
 * boundaries, approval requests and how one model step is obtained
 * (streamed, with `text.delta` per chunk) - and (3) buffers the events
 * for the consumer.
 *
 * Backpressure: none. The run never waits for the consumer; events are
 * buffered without loss until they are read.
 */

import { nanoid } from 'nanoid';
import type { GenerateOptions, GenerateResult, LLMProvider } from '../providers';
import type { ExecuteOptions, ExecutionEvent, ExecutionResult } from './AgentExecutor';
import type { PendingApproval } from './ApprovalGate';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AgentEvent,
  AgentEventError,
  AgentEventPayload,
  AgentEventUsage,
} from './agentEvents';
import { parseToolArguments } from './toolCallExecution';
import { canStream, generateViaStream } from './streamStep';
import { measureUsage } from './runUsage';
import type { Usage } from '../models/usage';

/**
 * The handle returned by `agent.stream()` and `AgentExecutor.stream()`.
 *
 * Iterate it with `for await` to get the run's {@link AgentEvent}s (the run
 * starts right away and events are buffered until you read them), or just
 * await `result`. Breaking out of the loop early aborts the run. It can be
 * iterated once.
 *
 * @example
 * ```ts
 * const run = agent.stream('Weather in Paris?');
 * for await (const event of run) {
 *   if (event.type === 'text.delta') process.stdout.write(event.text);
 * }
 * const result = await run.result; // the same ExecutionResult send() returns
 * ```
 */
export interface AgentRun extends AsyncIterable<AgentEvent> {
  /** The `runId` every event of this run carries. */
  readonly runId: string;
  /**
   * Settles when the run ends, whether or not the events are read: resolves
   * with the ExecutionResult (`finishReason: 'aborted'` after an abort or an
   * early `break`), or rejects with the error that failed the run - the same
   * outcomes as `send()`/`execute()`. Not awaiting it never causes an
   * unhandled rejection.
   */
  readonly result: Promise<ExecutionResult>;
}

/**
 * The parts of a run AgentExecutor reports to an AgentRun directly, beyond
 * its `onEvent` callbacks. Internal: reached through `options[RUN_EVENTS]`.
 */
export interface RunEventSink {
  stepStart(step: number): void;
  /** `finishReason` overrides the step's own (the model's) finish reason. */
  stepDone(step: number, finishReason?: string): void;
  approvalRequested(pending: PendingApproval): void;
  /** Obtains one model step - streamed when the provider can. */
  generate(provider: LLMProvider, request: GenerateOptions): Promise<GenerateResult>;
}

/** Options key under which a streaming run hands the loop its {@link RunEventSink}. */
export const RUN_EVENTS: unique symbol = Symbol('loushy.agentRunEvents');

/** ExecuteOptions as passed through the loop of a streaming run. */
export type StreamingExecuteOptions = ExecuteOptions & { [RUN_EVENTS]?: RunEventSink };

/** The run's event sink, when `options` belong to a streaming run. */
export function runEventsOf(options: ExecuteOptions): RunEventSink | undefined {
  return (options as StreamingExecuteOptions)[RUN_EVENTS];
}

/** Starts the run with the composed signal, `onEvent` and sink. */
export type RunStarter = (wiring: {
  signal: AbortSignal;
  onEvent: (event: ExecutionEvent) => void;
  sink: RunEventSink;
}) => Promise<ExecutionResult>;

function toEventError(error: unknown): AgentEventError {
  const err = error as { name?: unknown; message?: unknown } | null | undefined;
  return {
    name: typeof err?.name === 'string' && err.name ? err.name : 'Error',
    message: typeof err?.message === 'string' ? err.message : String(error),
  };
}

/** Usage of one step, or (with `modelCalls`) of the whole run, as event usage. */
function toEventUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
  costUsd?: number;
  modelCalls?: number;
}): AgentEventUsage {
  const { inputTokens, outputTokens, totalTokens, estimated, costUsd, modelCalls } = usage;
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    inputTokens,
    outputTokens,
    estimated,
    ...(costUsd !== undefined && { costUsd }),
    ...(modelCalls !== undefined && { modelCalls }),
  };
}

/** `value` as it survives a JSON round trip (`undefined` -> `null`; unserializable -> its string form). */
function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) ?? null;
  } catch {
    return String(value);
  }
}

class AgentRunImpl implements AgentRun {
  readonly runId = nanoid();
  readonly result: Promise<ExecutionResult>;
  private readonly controller = new AbortController();
  private readonly queue: AgentEvent[] = [];
  private readonly toolStarts = new Map<string, number>();
  private seq = 0;
  private closed = false;
  private iterated = false;
  private wake: (() => void) | undefined;
  private stepResult: { finishReason: GenerateResult['finishReason']; usage: Usage; estimated: boolean; costUsd?: number } | undefined;
  private lastError: unknown;

  constructor(start: RunStarter, signal: AbortSignal | undefined) {
    const runSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.result = start({
      signal: runSignal,
      onEvent: (event) => this.translate(event),
      sink: this.sink(),
    }).then(
      (result) => this.finish(result),
      (error: unknown) => this.fail(error)
    );
    this.result.catch(() => undefined);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) {
      throw new Error(
        'AgentRun can only be iterated once. Collect the events in the first for-await loop, ' +
          'or call agent.stream() again for a new run.'
      );
    }
    this.iterated = true;
    try {
      yield* this.drain();
    } finally {
      if (!this.closed) {
        this.controller.abort(new DOMException('The AgentRun was not iterated to the end (the for-await loop exited early)', 'AbortError'));
      }
    }
  }

  private async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
      } else if (this.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }

  private emit(payload: AgentEventPayload): void {
    if (this.closed) return;
    const event = {
      ...payload,
      runId: this.runId,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      v: AGENT_EVENT_SCHEMA_VERSION,
    } as AgentEvent;
    this.queue.push(event);
    if (payload.type === 'run.done') this.closed = true;
    this.wake?.();
    this.wake = undefined;
  }

  private finish(result: ExecutionResult): ExecutionResult {
    this.emit({
      type: 'run.done',
      finishReason: result.finishReason,
      text: result.text,
      usage: toEventUsage(result.usage),
    });
    return result;
  }

  private fail(error: unknown): never {
    if (error !== this.lastError) {
      this.emit({ type: 'error', error: toEventError(error) });
    }
    this.emit({ type: 'run.done', finishReason: 'error', text: '' });
    throw error;
  }

  /** Maps the loop's `onEvent` callbacks to AgentEvents (`abort`/`finish` are covered by `run.done`). */
  private translate(event: ExecutionEvent): void {
    switch (event.type) {
      case 'start':
        this.emit({
          type: 'run.start',
          agentName: event.agentName ?? '',
          ...(event.agentId !== undefined && { agentId: event.agentId }),
        });
        break;
      case 'text-complete':
        this.emit({ type: 'text.done', text: event.text ?? '' });
        break;
      case 'tool-call':
        if (event.toolCall) this.toolStarted(event.toolCall);
        break;
      case 'tool-result':
        if (event.toolResult) this.toolSettled(event.toolResult);
        break;
      case 'error':
        this.lastError = event.error;
        this.emit({ type: 'error', error: toEventError(event.error) });
        break;
    }
  }

  private toolStarted(toolCall: NonNullable<ExecutionEvent['toolCall']>): void {
    this.toolStarts.set(toolCall.id, Date.now());
    const args = parseToolArguments(toolCall, {});
    this.emit({
      type: 'tool.start',
      toolCallId: toolCall.id,
      toolName: toolCall.function.name,
      args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
    });
  }

  private toolSettled(outcome: NonNullable<ExecutionEvent['toolResult']>): void {
    const { toolCallId, toolName } = outcome;
    const durationMs = Date.now() - (this.toolStarts.get(toolCallId) ?? Date.now());
    if (outcome.error === undefined) {
      this.emit({ type: 'tool.done', toolCallId, toolName, result: toJsonValue(outcome.result), durationMs });
      return;
    }
    const name = (outcome.result as { error?: unknown } | null)?.error;
    this.emit({
      type: 'tool.error',
      toolCallId,
      toolName,
      error: { name: typeof name === 'string' ? name : 'Error', message: outcome.error },
      durationMs,
    });
  }

  private sink(): RunEventSink {
    return {
      stepStart: (step) => {
        this.stepResult = undefined;
        this.emit({ type: 'step.start', step });
      },
      stepDone: (step, finishReason) => {
        const measured = this.stepResult;
        this.emit({
          type: 'step.done',
          step,
          finishReason: finishReason ?? measured?.finishReason ?? 'error',
          ...(measured && { usage: toEventUsage({ ...measured.usage, estimated: measured.estimated, costUsd: measured.costUsd }) }),
        });
      },
      approvalRequested: (pending) =>
        this.emit({
          type: 'approval.requested',
          approvalId: pending.id,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          args: toJsonValue(pending.args) as Record<string, unknown>,
        }),
      generate: async (provider, request) => {
        const generated = await this.generateStep(provider, request);
        const measured = measureUsage(request.model ?? provider.name, request.messages, generated);
        this.stepResult = { finishReason: generated.finishReason, ...measured, usage: measured.usage };
        return generated;
      },
    };
  }

  /** Streams the step when the provider can; otherwise one `generate()` and a single `text.delta`. */
  private async generateStep(provider: LLMProvider, request: GenerateOptions): Promise<GenerateResult> {
    const onTextDelta = (text: string) => this.emit({ type: 'text.delta', text });
    if (canStream(provider, request)) {
      return generateViaStream(provider, request, onTextDelta);
    }
    const generated = await provider.generate(request);
    if (generated.text) onTextDelta(generated.text);
    return generated;
  }
}

/**
 * Starts a run and returns its {@link AgentRun} handle. `signal` (the
 * caller's) and an early `break` both abort the run.
 */
export function startAgentRun(start: RunStarter, signal?: AbortSignal): AgentRun {
  return new AgentRunImpl(start, signal);
}
