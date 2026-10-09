/**
 * LOU-V2: `AgentRun`, the handle `agent.stream()` / `AgentExecutor.stream()`
 * return - an async iterable of {@link AgentEvent}s plus a `result` promise.
 *
 * LOU-D41: this module is the run's one event system. The AgentExecutor loop
 * reports everything through a {@link RunEventSink} (under the
 * {@link RUN_EVENTS} key of its options), including how one model step is
 * obtained (streamed, with `text.delta` per chunk). The sink turns it into
 * AgentEvents for the run's listeners: an AgentRun's buffer and
 * `onAgentEvent`. A run that is not iterated but has a listener (`send()`,
 * `execute({ onAgentEvent })`) gets a sink too, and (M9) streams its model
 * calls as well (see {@link observeRun}).
 *
 * Backpressure: none. The run never waits for the consumer; events are
 * buffered without loss until they are read.
 */

import { newId } from '../utils/id';
import type { GenerateOptions, GenerateResult, HostedToolCall, LLMProvider, ToolCall } from '../providers';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { StepUsage } from '../models/usage';
import { describeApproval, type PendingApproval } from './ApprovalGate';
import type { HookEventPayload, SubagentInfo } from './hooks';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  AgentEvent,
  AgentEventError,
  AgentEventPayload,
  AgentEventUsage,
} from './agentEvents';
import { decodeToolArguments } from './toolArgsValidation';
import type { PermissionDecisionEntry } from './permissions';
import { canStream, generateViaStream, reportReasoning, type StepSink } from './streamStep';
import { measureUsage } from './runUsage';
import { SDKError, compactProviderError } from './errors';
import { withProviderEvents, type ProviderEventListener } from '../providers/providerEvents';
import type { Usage } from '../models/usage';
import type { BudgetExceeded } from './budget';
import type { AgentInput } from '../providers/content';
import { InputQueue, type EnqueueResult, type QueuedInput, type SteerResult } from './inputQueue';
import type { GuardrailTrip } from './ioGuardrails';
import type { AgentDrift } from './agentFingerprint';
import { isTodoListResult } from '../tools/built-in/todo';
import { cappedHostedResult, settleHostedFinish } from './hostedToolCalls';

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
export interface AgentRun<TObject = unknown> extends AsyncIterable<AgentEvent> {
  /** The `runId` every event of this run carries. */
  readonly runId: string;
  /**
   * Settles when the run ends, whether or not the events are read: resolves
   * with the ExecutionResult (`finishReason: 'aborted'` after an abort or an
   * early `break`), or rejects with the error that failed the run - the same
   * outcomes as `send()`/`execute()`. Not awaiting it never causes an
   * unhandled rejection.
   */
  readonly result: Promise<ExecutionResult<TObject>>;
  /**
   * LOU-V9: adds user input to the running run. It joins the transcript at
   * the next safe point (after the current step's tool results, before the
   * next model call) and the run continues as if the user had typed it;
   * `input.queued` and `input.applied` events mark both moments. Returns
   * `{ applied: false }` when the run has already finished: send the input
   * as a new turn then (`session.send()`). See {@link EnqueueResult}.
   *
   * @example
   * ```ts
   * const run = agent.stream('Plan a trip to Rome.');
   * run.enqueue('Keep it under 500 EUR.');
   * ```
   */
  enqueue(input: AgentInput): EnqueueResult;
  /**
   * LOU-V10: redirects the running run to `input`. When the model call in
   * flight has not emitted text or tool calls yet, it is aborted, its partial
   * output discarded, and the run calls the model again with `input` appended
   * (`applied: 'immediate'`); otherwise `input` waits for the next safe point
   * like `enqueue()` (`'queued'`). Tool calls already running finish; those
   * not started yet get a "not run" result. `false` once the run has
   * finished. Emits `input.steered`, then `input.applied`. See {@link SteerResult}.
   *
   * @example
   * ```ts
   * const run = agent.stream('Plan a trip to Rome.');
   * run.steer('Actually, make it Paris.');
   * ```
   */
  steer(input: AgentInput): SteerResult;
}

/** A tool call's outcome, as the loop reports it (`tool.done` / `tool.error`). */
export interface ToolSettled {
  toolCallId: string;
  toolName: string;
  result: unknown;
  error?: string;
  /** LOU-X3: the hook whose `{ result }` outcome became this call's result. */
  replacedByHook?: string;
}

/** The listener a run's options can carry (LOU-D41), and whether it gets model calls streamed (M9). */
export type RunListeners = Pick<ExecuteOptions, 'onAgentEvent' | 'streamModelCalls'>;

/**
 * Everything AgentExecutor reports about a run, as AgentEvents. Internal:
 * reached through `options[RUN_EVENTS]`.
 */
export interface RunEventSink {
  /**
   * Whether the caller iterates the run (a `stream()` run). Output guardrails
   * then check every step's text, not only the final reply. `send()` and
   * `execute()` with listeners are not iterated, even though (M9) their
   * model calls are streamed.
   */
  readonly iterated: boolean;
  /** Adds `options`' listeners to the run's (each listener once). */
  listen(options: RunListeners): void;
  /** A top-level run reports one `run.start`, however often it is (re)started. */
  runStart(agent: { id?: string; name: string }): void;
  textDone(text: string, stepUsage?: StepUsage): void;
  /** N14: `parentToolCallId` for an inner call of a `run_code` script (also on the next two). */
  toolStart(toolCall: ToolCall, parentToolCallId?: string): void;
  /**
   * The call this run was resumed for (`tool.resume`): it already had its
   * `tool.start` in the run that paused, so it is reported separately and a
   * call keeps exactly one `tool.start` across a pause.
   */
  toolResume(toolCall: ToolCall): void;
  /** N13b: a snapshot a generator tool yielded (`tool.partial`). */
  toolPartial(toolCallId: string, toolName: string, output: unknown, parentToolCallId?: string): void;
  toolSettled(outcome: ToolSettled, parentToolCallId?: string): void;
  error(error: unknown): void;
  /** `run.done` (a sub-agent's is internal and reaches no listener). */
  runDone(result: ExecutionResult): void;
  /** `error` (unless just reported) then `run.done` with `finishReason: 'error'`. */
  runFailed(error: unknown): void;
  stepStart(step: number): void;
  /** `finishReason` overrides the step's own (the model's) finish reason. */
  stepDone(step: number, finishReason?: string): void;
  approvalRequested(pending: PendingApproval): void;
  /** LOU-X2: a tool call's permission decision. */
  permissionDecision(entry: PermissionDecisionEntry): void;
  /** LOU-V6: a `limits` budget tripped. */
  budgetExceeded(budget: BudgetExceeded): void;
  /** LOU-V9: an input was queued (LOU-V10: or steered), then applied before the model call of `step`. */
  inputQueued(input: QueuedInput): void;
  inputApplied(id: string, step: number): void;
  /** LOU-X4: a guardrail blocked or rewrote. */
  guardrail(event: GuardrailTrip & { type: 'guardrail.tripped' | 'guardrail.rewrote' }): void;
  /** LOU-W3.2: an event a hook emits (`GenerateHookContext.emit`). */
  hookEvent(event: HookEventPayload): void;
  /** LOU-W9.2: the resuming agent differs from the one that saved the run. */
  agentDrift(drift: AgentDrift): void;
  /** N6: the run handed off to another agent. */
  handoff(handoff: { from: string; to: string; toolCallId: string }): void;
  /**
   * Obtains one model step - streamed when the provider can; `onOutput` before its first text or tool call is reported.
   * N5b: with `hold`, the step's `text.delta`, `reasoning.*` and provider-run tool events wait for it: released
   * in order when it resolves `true`, dropped when `false`.
   */
  generate(provider: LLMProvider, request: GenerateOptions, onOutput?: () => void, hold?: Promise<boolean>): Promise<GenerateResult>;
  /** LOU-Y1: the sink for a sub-agent's run, whose events carry `subagent`. */
  forSubagent(subagent: SubagentInfo): RunEventSink;
}

/** Options key under which a streaming run hands the loop its {@link RunEventSink}. */
export const RUN_EVENTS: unique symbol = Symbol('lousho.agentRunEvents');

/** Options key under which a sub-agent's run carries the name its parent knows it by (the `task` call's `agent`). */
export const SUBAGENT_NAME: unique symbol = Symbol('lousho.subagentName');

/** The name a sub-agent's run is known by to its parent, or undefined for a top-level run. */
export function subagentNameOf(options: object): string | undefined {
  return (options as { [SUBAGENT_NAME]?: string })[SUBAGENT_NAME];
}

/** ExecuteOptions as passed through the loop of a streaming run. */
export type StreamingExecuteOptions = ExecuteOptions & { [RUN_EVENTS]?: RunEventSink };

/** The run's event sink, when `options` belong to a streaming run. */
export function runEventsOf(options: object): RunEventSink | undefined {
  return (options as StreamingExecuteOptions)[RUN_EVENTS];
}

/** N13b: where a run's generator tools report their snapshots - its sink's `tool.partial` - when the run has a sink. */
export function partialSink(options: object): ((toolCallId: string, toolName: string, output: unknown) => void) | undefined {
  const sink = runEventsOf(options);
  return sink && ((toolCallId, toolName, output) => sink.toolPartial(toolCallId, toolName, output));
}

/** Starts the run with the composed signal, sink and the queue behind `run.enqueue()`. */
export type RunStarter = (wiring: {
  signal: AbortSignal;
  sink: RunEventSink;
  inputQueue: InputQueue;
}) => Promise<ExecutionResult>;

function toEventError(error: unknown): AgentEventError {
  const err = error as { name?: unknown; message?: unknown; code?: unknown } | null | undefined;
  return {
    name: typeof err?.name === 'string' && err.name ? err.name : 'Error',
    message: typeof err?.message === 'string' ? err.message : String(error),
    ...(typeof err?.code === 'string' && err.code && { code: err.code }),
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
  hostedToolCalls?: Partial<Record<string, number>>;
}): AgentEventUsage {
  const { inputTokens, outputTokens, totalTokens, estimated, costUsd, modelCalls, hostedToolCalls } = usage;
  return {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    inputTokens,
    outputTokens,
    estimated,
    ...(costUsd !== undefined && { costUsd }),
    ...(modelCalls !== undefined && { modelCalls }),
    ...(hostedToolCalls && Object.keys(hostedToolCalls).length > 0 && { hostedToolCalls: { ...hostedToolCalls } }),
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

/** A finished model step's finish reason and measured usage (LOU-V5). */
type MeasuredStep = { finishReason: GenerateResult['finishReason']; usage: Usage; estimated: boolean; costUsd?: number };

/** `run.done` of a finished run. */
function runDonePayload(result: ExecutionResult): AgentEventPayload {
  return {
    type: 'run.done',
    finishReason: result.finishReason,
    text: result.text,
    usage: toEventUsage(result.usage),
    ...(result.object !== undefined && { object: toJsonValue(result.object) }),
  };
}

/** A run's events and listeners; `sink()` is what the loop reports to. */
class RunEvents {
  readonly runId = newId();
  closed = false;
  private seq = 0;
  private started = false;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly toolStarts = new Map<string, number>();
  /** N13b: how many snapshots each running call has yielded (keyed like `toolStarts`). */
  private readonly partials = new Map<string, number>();

  /**
   * `iterated`: the caller iterates a `stream()` (see {@link RunEventSink.iterated}).
   * `streamModelCalls` (M9): each model call is streamed when the provider
   * can, so its text arrives as several `text.delta`; otherwise each step is
   * generated whole and its text is one `text.delta`.
   */
  constructor(private readonly mode: { readonly iterated: boolean; readonly streamModelCalls: boolean }) {}

  listen({ onAgentEvent }: RunListeners): void {
    if (onAgentEvent) this.listeners.add(onAgentEvent);
  }

  /**
   * Sends an event to the listeners; `subagent` tags one of a sub-agent's run
   * (LOU-Y1). A sub-agent's `run.start`/`run.done` are internal: they mark
   * the sub-agent's own run, not the top-level one, so they are never built
   * and never reach a listener (and `seq` does not move for them).
   */
  private emit(payload: AgentEventPayload, subagent?: SubagentInfo): void {
    if (this.closed || (payload.type === 'run.start' && !subagent && this.started)) return;
    if (subagent !== undefined && (payload.type === 'run.start' || payload.type === 'run.done')) return;
    const event = {
      ...payload,
      ...(subagent && { subagent }),
      runId: this.runId,
      seq: this.seq++,
      timestamp: new Date().toISOString(),
      v: AGENT_EVENT_SCHEMA_VERSION,
    } as AgentEvent;
    if (!subagent) this.started ||= payload.type === 'run.start';
    if (!subagent) this.closed = payload.type === 'run.done';
    // Eve CORE-F2: a listener is the caller's telemetry; a throw in it must not fail a run whose tools already ran.
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.listenerFailed(error);
      }
    }
  }

  private listenerErrorReported = false;

  /** Reports a throwing listener once per run, then keeps quiet. */
  private listenerFailed(error: unknown): void {
    if (this.listenerErrorReported) return;
    this.listenerErrorReported = true;
    console.warn(`[lousho] An onEvent listener threw (${error instanceof Error ? error.message : String(error)}); the run continues. Further listener errors in this run are not reported.`);
  }

  private toolStarted(toolCall: ToolCall, subagent?: SubagentInfo, parent?: string): void {
    this.toolBegan('tool.start', toolCall, subagent, parent);
  }

  /** A resumed call: like `toolStarted`, but as `tool.resume` (see {@link RunEventSink.toolResume}). */
  private toolResumed(toolCall: ToolCall, subagent?: SubagentInfo): void {
    this.toolBegan('tool.resume', toolCall, subagent);
  }

  private toolBegan(type: 'tool.start' | 'tool.resume', toolCall: ToolCall, subagent?: SubagentInfo, parent?: string): void {
    this.toolStarts.set(toolStartKey(toolCall.id, subagent), Date.now());
    // N13b: a call that runs again (after a sign-in, or on a resume) counts its snapshots from 0.
    this.partials.delete(toolStartKey(toolCall.id, subagent));
    const decoded = decodeToolArguments(toolCall.function.arguments);
    const args = decoded.ok ? decoded.value : {};
    this.emit(
      {
        type,
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        args: (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>,
        // F7: the text the model sent, when it was not valid JSON as sent.
        ...((!decoded.ok || decoded.repaired) && { rawArgs: String(toolCall.function.arguments) }),
        ...parentOf(parent),
      },
      subagent
    );
  }

  /** N13b: `tool.partial`, the snapshot JSON-round-tripped like `tool.done`'s result. */
  private toolPartial(toolCallId: string, toolName: string, output: unknown, subagent?: SubagentInfo, parent?: string): void {
    const key = toolStartKey(toolCallId, subagent);
    const index = this.partials.get(key) ?? 0;
    this.partials.set(key, index + 1);
    this.emit({ type: 'tool.partial', toolCallId, toolName, output: toJsonValue(output), index, ...parentOf(parent) }, subagent);
  }

  private toolSettled(outcome: ToolSettled, subagent?: SubagentInfo, parent?: string): void {
    const { toolCallId, toolName } = outcome;
    this.partials.delete(toolStartKey(toolCallId, subagent));
    const durationMs = Date.now() - (this.toolStarts.get(toolStartKey(toolCallId, subagent)) ?? Date.now());
    if (outcome.error === undefined) {
      const replaced = outcome.replacedByHook !== undefined && { replacedByHook: outcome.replacedByHook };
      this.emit({ type: 'tool.done', toolCallId, toolName, result: toJsonValue(outcome.result), durationMs, ...replaced, ...parentOf(parent) }, subagent);
      // The brand is checked on the raw result, before `toJsonValue` drops it.
      if (isTodoListResult(outcome.result)) {
        const { todos, counts } = outcome.result;
        this.emit({ type: 'todo.updated', todos: toJsonValue(todos) as typeof todos, counts: { ...counts }, toolCallId }, subagent);
      }
      return;
    }
    const name = (outcome.result as { error?: unknown } | null)?.error;
    this.emit(
      {
        type: 'tool.error',
        toolCallId,
        toolName,
        error: { name: typeof name === 'string' ? name : 'Error', message: outcome.error },
        durationMs,
        ...parentOf(parent),
      },
      subagent
    );
  }

  /** N1a: a hosted call the provider started: `tool.start` with `executedBy: 'provider'`. */
  private hostedStarted(call: HostedToolCall, subagent?: SubagentInfo): void {
    this.toolStarts.set(toolStartKey(call.id, subagent), Date.now());
    const args = toJsonValue(call.args);
    const event = { type: 'tool.start', toolCallId: call.id, toolName: call.name, executedBy: 'provider' } as const;
    this.emit({ ...event, args: (typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {}) as Record<string, unknown> }, subagent);
  }

  /** N1a: a hosted call the provider finished: `tool.done` (result capped), or `tool.error` when it failed. */
  private hostedSettled(call: HostedToolCall, subagent?: SubagentInfo): void {
    const key = toolStartKey(call.id, subagent);
    if (!this.toolStarts.has(key)) this.hostedStarted(call, subagent);
    const durationMs = Date.now() - (this.toolStarts.get(key) ?? Date.now());
    const base = { toolCallId: call.id, toolName: call.name, durationMs, executedBy: 'provider' } as const;
    if (!call.isError) {
      this.emit({ type: 'tool.done', ...base, result: cappedHostedResult(call.result) }, subagent);
      return;
    }
    const message = typeof call.result === 'string' ? call.result : JSON.stringify(cappedHostedResult(call.result));
    this.emit({ type: 'tool.error', ...base, error: { name: 'HostedToolError', message } }, subagent);
  }

  /**
   * The sink for the top-level run, or (LOU-Y1) for a sub-agent's run, whose
   * events carry `subagent`. A sub-agent's approval request is reported by
   * the top-level run it pauses, so its own sink does not emit one.
   */
  sink(subagent?: SubagentInfo): RunEventSink {
    let stepResult: MeasuredStep | undefined;
    let lastError: unknown;
    const reportError = (error: unknown) => {
      lastError = error;
      this.emit({ type: 'error', error: toEventError(error) }, subagent);
    };
    return {
      iterated: this.mode.iterated,
      listen: (options) => this.listen(options),
      runStart: ({ id, name }) => this.emit({ type: 'run.start', agentName: name ?? '', ...(id !== undefined && { agentId: id }) }, subagent),
      textDone: (text) => this.emit({ type: 'text.done', text }, subagent),
      toolStart: (toolCall, parent) => this.toolStarted(toolCall, subagent, parent),
      toolResume: (toolCall) => this.toolResumed(toolCall, subagent),
      toolPartial: (toolCallId, toolName, output, parent) => this.toolPartial(toolCallId, toolName, output, subagent, parent),
      toolSettled: (outcome, parent) => this.toolSettled(outcome, subagent, parent),
      error: reportError,
      runDone: (result) => this.emit(runDonePayload(result), subagent),
      runFailed: (error) => {
        if (error !== lastError) reportError(error);
        this.emit({ type: 'run.done', finishReason: 'error', text: '' }, subagent);
      },
      stepStart: (step) => {
        stepResult = undefined;
        this.emit({ type: 'step.start', step }, subagent);
      },
      stepDone: (step, finishReason) => {
        const measured = stepResult;
        this.emit(
          {
            type: 'step.done',
            step,
            finishReason: finishReason ?? measured?.finishReason ?? 'error',
            ...(measured && {
              usage: toEventUsage({ ...measured.usage, estimated: measured.estimated, costUsd: measured.costUsd }),
            }),
          },
          subagent
        );
      },
      approvalRequested: (paused) => {
        if (subagent) return;
        const pending = describeApproval(paused);
        this.emit({
          type: 'approval.requested',
          approvalId: pending.id,
          toolCallId: pending.toolCallId,
          toolName: pending.toolName,
          args: toJsonValue(pending.args) as Record<string, unknown>,
          // LOU-X9: an `ask_question` call carries its question.
          ...(pending.kind && { kind: pending.kind }),
          ...(pending.question && { question: pending.question }),
          // N9b: the link only (never the declined flag, which a later callback sets).
          ...(pending.signIn && { signIn: { provider: pending.signIn.provider, ...(pending.signIn.displayName !== undefined && { displayName: pending.signIn.displayName }), url: pending.signIn.url } }),
          // TTL: the pause's deadline, so a UI can show it.
          ...(pending.expiresAt && { expiresAt: pending.expiresAt }),
        });
      },
      permissionDecision: (entry) =>
        this.emit(
          { type: 'permission.decision', ...entry, ...(entry.args && { args: toJsonValue(entry.args) as Record<string, unknown> }) },
          subagent
        ),
      budgetExceeded: (budget) => this.emit({ type: 'budget.exceeded', ...budget }, subagent),
      inputQueued: ({ id, text, steered }) =>
        this.emit(steered ? { type: 'input.steered', id, text, mode: steered } : { type: 'input.queued', id, text }, subagent),
      inputApplied: (id, step) => this.emit({ type: 'input.applied', id, step }, subagent),
      hookEvent: (event) => this.emit(event, subagent),
      agentDrift: (drift) => this.emit({ type: 'agent.drift', ...drift }, subagent),
      handoff: (handoff) => this.emit({ type: 'handoff', ...handoff }, subagent),
      guardrail: (event) => this.emit(event, subagent),
      generate: async (provider, request, onOutput, hold) => {
        const call = withProviderEvents(request, this.providerEvents(subagent));
        const generated = settleHostedFinish(await this.generateStep(provider, call, subagent, onOutput, hold));
        const measured = measureUsage(generated.servedBy?.model ?? request.model ?? provider.name, request.messages, generated);
        const measuredStep = { finishReason: generated.finishReason, ...measured, usage: measured.usage };
        // N5b: a step a parallel input guardrail blocked reports only the usage the provider reported.
        if (!hold || !measured.estimated) stepResult = measuredStep;
        else void hold.then((passed) => passed && (stepResult = measuredStep));
        return generated;
      },
      forSubagent: (child) => this.sink(subagent ? { ...child, depth: subagent.depth + 1, parent: subagent } : child),
    };
  }

  /** Reports what `withRetry()` / `withFallback()` do with this run's model calls (LOU-V7.2). */
  private providerEvents(subagent: SubagentInfo | undefined): ProviderEventListener {
    return {
      retry: ({ attempt, maxRetries, delayMs, error, provider }) => {
        const { error: message, category } = compactProviderError(error);
        const eventError = { message, ...(category !== 'unknown' && { category }) };
        this.emit({ type: 'provider.retry', attempt, maxRetries, delayMs, error: eventError, provider }, subagent);
      },
      fallback: ({ from, to, error }) =>
        this.emit({ type: 'provider.fallback', from, to, error: { message: compactProviderError(error).error } }, subagent),
    };
  }

  /** Streams the step when the provider can; otherwise one `generate()` and a single `text.delta`. */
  private async generateStep(
    provider: LLMProvider,
    request: GenerateOptions,
    subagent: SubagentInfo | undefined,
    onOutput?: () => void,
    hold?: Promise<boolean>
  ): Promise<GenerateResult> {
    const report = heldUntil(hold);
    const sink: StepSink = {
      onTextDelta: (text) => report(() => this.emit({ type: 'text.delta', text }, subagent)),
      onReasoning: (event) => report(() => this.emit(event, subagent)),
      onHostedToolCall: (hosted) => report(() => this.hostedStarted(hosted, subagent)),
      onHostedToolResult: (hosted) => report(() => this.hostedSettled(hosted, subagent)),
      onOutput,
    };
    if (this.mode.streamModelCalls && canStream(provider, request)) {
      return generateViaStream(provider, request, sink);
    }
    const generated = await provider.generate(request);
    // LOU-V10: a call steered away from while it ran reports nothing.
    request.signal?.throwIfAborted();
    onOutput?.();
    reportReasoning(generated, sink);
    // N1a: the provider's calls, in call order, before the text that follows them.
    for (const hosted of generated.hostedToolCalls ?? []) this.hostedSettled(hosted, subagent);
    if (generated.text) sink.onTextDelta(generated.text);
    return generated;
  }
}

/**
 * N5b: reports events at once without `hold`; with it, holds them in order
 * until it settles: released when it resolves `true` (and later ones then go
 * out at once), dropped for good when `false`.
 */
function heldUntil(hold: Promise<boolean> | undefined): (report: () => void) => void {
  if (!hold) return (report) => report();
  let held: Array<() => void> | undefined = [];
  let dropped = false;
  void hold.then((passed) => {
    const waiting = held ?? [];
    held = undefined;
    dropped = !passed;
    if (passed) for (const report of waiting) report();
  });
  return (report) => {
    if (dropped) return;
    if (held) held.push(report);
    else report();
  };
}

/** N14: the `parentToolCallId` field of an inner call's tool event (none for a direct call). */
function parentOf(parent: string | undefined): { parentToolCallId?: string } {
  return parent === undefined ? {} : { parentToolCallId: parent };
}

/** Identifies a sub-agent run within the stream: the chain of tool calls that started it. */
function subagentKey(subagent: SubagentInfo): string {
  return subagent.parent ? `${subagentKey(subagent.parent)}/${subagent.toolCallId}` : subagent.toolCallId;
}

/** Tool call ids are only unique per run, so a sub-agent's are keyed by its chain. */
function toolStartKey(toolCallId: string, subagent: SubagentInfo | undefined): string {
  return subagent ? `${subagentKey(subagent)}:${toolCallId}` : toolCallId;
}

/** Options a streamed run is wired through: its signal and input queue. */
type WiredOptions = Pick<ExecuteOptions, 'signal' | 'inputQueue'>;

/**
 * LOU-V14: streams a resume after an approval. `resume` runs it with the
 * options `wire()` returns, which carry the run's signal, input queue and
 * event sink. The resume reports its own `run.start` before the decided
 * call; the continuation's is dropped (one per top-level run).
 */
export function streamResumed(
  resume: (wire: <T extends WiredOptions>(options: T) => T) => Promise<ExecutionResult>,
  signal?: AbortSignal,
  inputQueue?: InputQueue
): AgentRun {
  return startAgentRun(({ signal: runSignal, sink, inputQueue: queue }) => {
    const wire = <T extends WiredOptions>(options: T): T => ({ ...options, signal: runSignal, inputQueue: queue, [RUN_EVENTS]: sink });
    return resume(wire);
  }, signal, inputQueue);
}

/**
 * LOU-D41: runs `run` with the run's event sink in its options - the
 * stream's, or a new one when `options` has listeners - after adding
 * `options`' listeners to it, then reports how it ended (`run.done`, or
 * `error` and `run.done`). Without a sink or listeners, just runs it.
 *
 * M9: a new sink (listeners, no iteration) streams the run's model calls
 * like `stream()` does, unless `options.streamModelCalls` is `false`; it is
 * not `iterated`, so output guardrails behave as on a run without listeners.
 */
export async function observeRun<T extends RunListeners & WiredOptions>(
  options: T,
  run: (options: T) => Promise<ExecutionResult>
): Promise<ExecutionResult> {
  const { onAgentEvent, streamModelCalls = true } = options;
  const sink =
    runEventsOf(options) ?? (onAgentEvent ? new RunEvents({ iterated: false, streamModelCalls }).sink() : undefined);
  if (!sink) return run(options);
  sink.listen(options);
  try {
    const result = await run({ ...options, [RUN_EVENTS]: sink });
    sink.runDone(result);
    return result;
  } catch (error) {
    sink.runFailed(error);
    throw error;
  }
}

class AgentRunImpl implements AgentRun {
  readonly result: Promise<ExecutionResult>;
  private readonly events = new RunEvents({ iterated: true, streamModelCalls: true });
  private readonly controller = new AbortController();
  private readonly queue: AgentEvent[] = [];
  private iterated = false;
  private wake: (() => void) | undefined;

  constructor(start: RunStarter, signal: AbortSignal | undefined, private readonly inputs: InputQueue) {
    this.events.listen({ onAgentEvent: (event) => this.push(event) });
    const runSignal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    const sink = this.events.sink();
    // `run.done` was sent already unless the run ended outside the loop (e.g. its setup failed).
    this.result = start({ signal: runSignal, sink, inputQueue: inputs }).then(
      (result) => {
        sink.runDone(result);
        return result;
      },
      (error: unknown) => {
        sink.runFailed(error);
        throw error;
      }
    );
    this.result.catch(() => undefined);
    // A run that ended before its loop took the queue over (e.g. setup failed) takes no input either.
    inputs.closeAfter(this.result);
  }

  get runId(): string {
    return this.events.runId;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    if (this.iterated) {
      throw new SDKError(
        'AgentRun can only be iterated once. Collect the events in the first for-await loop, ' +
          'or call agent.stream() again for a new run.',
        'LOUSHO_RUN_ALREADY_ITERATED'
      );
    }
    this.iterated = true;
    try {
      yield* this.drain();
    } finally {
      if (!this.events.closed) {
        this.controller.abort(new DOMException('The AgentRun was not iterated to the end (the for-await loop exited early)', 'AbortError'));
      }
    }
  }

  enqueue(input: AgentInput): EnqueueResult {
    return this.inputs.push(input);
  }

  steer(input: AgentInput): SteerResult {
    return this.inputs.steer(input);
  }

  private push(event: AgentEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = undefined;
  }

  private async *drain(): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.queue.shift();
      if (next) {
        yield next;
      } else if (this.events.closed) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }
}

/**
 * Starts a run and returns its {@link AgentRun} handle. `signal` (the
 * caller's) and an early `break` both abort the run; `inputQueue` is the one
 * `run.enqueue()` pushes to.
 */
export function startAgentRun(start: RunStarter, signal?: AbortSignal, inputQueue = new InputQueue()): AgentRun {
  return new AgentRunImpl(start, signal, inputQueue);
}

/**
 * Eve CORE-F10: `run` whose iterator also rethrows, after the last event, the
 * error that failed the run (`run.done { finishReason: 'error' }`): the one
 * `run.result` rejects with, the same `send()` would throw. An early `break`,
 * an abort and a pause for approval end it normally.
 */
export function throwingRun<TObject>(run: AgentRun<TObject>): AgentRun<TObject> {
  return {
    runId: run.runId,
    result: run.result,
    enqueue: (input) => run.enqueue(input),
    steer: (input) => run.steer(input),
    async *[Symbol.asyncIterator]() {
      yield* run;
      await run.result;
    },
  };
}
