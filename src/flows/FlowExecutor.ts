/**
 * Flow Executor
 * Executes flow-based agents with full LLM and tool integration
 */

import { LLMProvider, Message, ProviderUsage } from '../providers';
import { ToolRegistry } from '../tools';
import {
  AgentFlow,
  EditorStep,
  EndNode,
  ExpressionEvaluatorNode,
  ForEachItemsNode,
  LLMCallNode,
  NodeRunOptions,
  OneOfOption,
  OneOfOptionsNode,
  ParallelNode,
  ReturnNode,
  SequenceNode,
  SetVariableNode,
  ThrowNode,
  ToolCallNode,
} from '../types/flow';
import { AgentConfig } from '../types';
import { SandboxAdapter, NoopSandbox } from '../security/sandboxCore';
import { executeToolWithSandboxGuard } from '../execution/sandboxGuard';
import { evaluateSafeExpression, ExpressionError } from './safeExpression';
import { isCreateAgentResult } from './validators';
import { Span, TraceExporter, recordSpanError, withSpan } from '../execution/tracing';
import {
  defined,
  llmSpanInit,
  recordLlmResult,
  recordToolOutcome,
  resolveCaptureContent,
  toolSpanInit,
} from '../execution/genAiSpans';
import { FLOW_NODE_SPAN_NAME, FlowAttr, GenAiAttr, GenAiOperation } from '../execution/semconv';
import { ConfigurationError, SDKError, TimeoutError, ValidationError } from '../execution/errors';
import type { PermissionOptions } from '../execution/permissions';
import type { ApproveToolCall } from '../createAgentApprovals';
import { gateFlowToolCall } from './flowToolGate';
import { validateFlowInput } from './inputs';
import type { CheckpointStore } from '../execution/checkpoint';
import { FlowRun, addUsage, durableOptions, flowStateOf } from './flowCheckpoint';

/**
 * Flow execution context
 */
export interface FlowExecutionContext {
  /**
   * The plain agent config the flow's steps run under: `prompt` is the
   * system message of every `llmCall`, `settings.model` its default model.
   * A `createAgent()` result (a `SimpleAgent`, which runs itself) is NOT one
   * and is rejected with `LOUSHO_CONFIG_INVALID` (LOU-R14).
   */
  agent: AgentConfig;
  session?: unknown;
  variables: Record<string, unknown>;
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  memory?: unknown[];
  maxDepth?: number;
  currentDepth?: number;
  /**
   * SandboxAdapter used for tool-call nodes whose tool is flagged
   * `requiresSandbox` (LOU-F fix). Mirrors AgentExecutor's
   * `ExecuteOptions.sandbox` (LOU-F5): read per-call
   * (`context.sandbox ?? NoopSandbox`) rather than held as construction
   * state, since FlowExecutor is a static, instance-free API. Defaults to
   * NoopSandbox - the zero-isolation, trusted-host adapter - when omitted,
   * so existing callers see no behavior change.
   */
  sandbox?: SandboxAdapter;
  /**
   * Trace exporter (LOU-D9). When provided, the run is wrapped in an
   * `invoke_workflow {flow name}` span, every node execution in a
   * `flow.node {type}` span, and each `llmCall`/`toolCall` node's model/tool
   * call in a `chat {model}` / `execute_tool {tool}` span (OpenTelemetry
   * GenAI conventions, see `semconv.ts`).
   */
  exporter?: TraceExporter;
  /**
   * Id of the span this flow run should nest under, e.g. an agent's
   * `invoke_agent` span (`withSpan` hands the span to its callback).
   */
  parentSpanId?: string;
  /**
   * Record prompt/tool-argument content on the `gen_ai.*` attributes. Off by
   * default; see `ExecuteOptions.captureContent`.
   */
  captureContent?: boolean;
  /** Omit the deprecated `prompt`/`args`/`result` attributes. */
  redactContent?: boolean;
  /**
   * A8: decides `toolCall` steps that need approval (the tool's
   * `needsApproval`, or an `ask` permission rule), as `createAgent({ approve })`
   * does: `true` (or a note) runs the tool, anything else fails the step with
   * `LOUSHO_FLOW_TOOL_DENIED`. A flow cannot pause, so `'defer'` refuses too.
   * Without it, a call that needs approval is refused, never run.
   *
   * @example
   * ```ts
   * await FlowExecutor.execute(flow, { agent, provider, variables, toolRegistry, approve: ({ args }) => Number(args.amount) < 1000 });
   * ```
   */
  approve?: ApproveToolCall;
  /** A8: permission rules for `toolCall` steps, checked as in an agent run (see `PermissionOptions.permissions`). */
  permissions?: PermissionOptions['permissions'];
  /** A8: the permission mode `toolCall` steps run under (see `PermissionOptions.permissionMode`). */
  permissionMode?: PermissionOptions['permissionMode'];
  /** A8: called with an audit entry for each `toolCall` step's permission decision. */
  onPermissionDecision?: PermissionOptions['onPermissionDecision'];
  /**
   * A8: cancels the run. It is checked before every step, so once it is
   * aborted no further step starts and the flow fails with the signal's
   * `reason`; the step running then gets it too (`llmCall` as the request's
   * `signal`, `toolCall` as the tool's `ctx.abortSignal`).
   *
   * @example
   * ```ts
   * await FlowExecutor.execute(flow, { agent, provider, variables, signal: AbortSignal.timeout(30_000) });
   * ```
   */
  signal?: AbortSignal;
  /**
   * Eve DUR-F17: makes the run durable, with {@link FlowExecutionContext.runId}.
   * The run's variables, completed nodes and usage are saved under `runId`
   * after every node that completes, and when the flow finishes; continue an
   * interrupted or failed run with `FlowExecutor.resume()`. Any
   * `CheckpointStore` works (e.g. `memoryStore().checkpoints`). Variables and
   * node results must be serializable (`structuredClone`).
   *
   * @example
   * ```ts
   * const checkpointStore = memoryStore().checkpoints;
   * await FlowExecutor.execute(flow, { agent, provider, variables, checkpointStore, runId: 'order-42' });
   * // after a crash or a failed step:
   * await FlowExecutor.resume(flow, { agent, provider, checkpointStore, runId: 'order-42' });
   * ```
   */
  checkpointStore?: CheckpointStore;
  /** Eve DUR-F17: the durable run's id in `checkpointStore` (see {@link FlowExecutionContext.checkpointStore}). */
  runId?: string;
}

/**
 * The context of `FlowExecutor.resume()`: a durable run's `checkpointStore`
 * and `runId` are required, and `variables` are restored from the checkpoint
 * (any given here are ignored).
 */
export type FlowResumeContext = Omit<FlowExecutionContext, 'variables' | 'checkpointStore' | 'runId'> & {
  /** The store the run was started with. */
  checkpointStore: CheckpointStore;
  /** The run to continue. */
  runId: string;
  /** Ignored: the run continues with its saved variables. */
  variables?: Record<string, unknown>;
};

/**
 * Flow execution event types
 */
export type FlowExecutionEventType =
  | 'flow-start'
  | 'flow-complete'
  | 'flow-error'
  | 'step-start'
  | 'step-complete'
  | 'step-error'
  | 'step-retry'
  | 'variable-set'
  | 'llm-call'
  | 'llm-response'
  | 'tool-call'
  | 'tool-result'
  | 'condition-evaluated'
  | 'loop-iteration';

/**
 * The `data` each flow event type carries. `step-complete` carries the node's
 * result, which can be any value; the step and error events carry none.
 */
export interface FlowExecutionEventDataMap {
  'flow-start': { flowCode: string; flowName: string };
  'flow-complete': { output: unknown; steps: number };
  'flow-error': undefined;
  'step-start': undefined;
  'step-complete': unknown;
  'step-error': undefined;
  /** DUR-F17: attempt `attempt` of `maxAttempts` failed (the event's `error`); the next starts after `delayMs`. */
  'step-retry': { attempt: number; maxAttempts: number; delayMs: number };
  'variable-set': { variable: string; value: unknown };
  'llm-call': { model: string | undefined; prompt: string };
  'llm-response': { text: string; usage: ProviderUsage | undefined };
  'tool-call': { tool: string; arguments: Record<string, unknown> };
  'tool-result': { tool: string; result: unknown };
  'condition-evaluated': { condition: string; result: boolean };
  'loop-iteration': { item: unknown; index: number };
}

/** A flow event of one type; narrow a {@link FlowExecutionEvent} on `type` to get its `data`. */
export interface FlowExecutionEventOf<T extends FlowExecutionEventType> {
  type: T;
  timestamp: Date;
  stepId?: string;
  stepType?: string;
  data?: FlowExecutionEventDataMap[T];
  variables?: Record<string, unknown>;
  error?: Error;
}

/**
 * Flow execution event, discriminated on `type`.
 */
export type FlowExecutionEvent = {
  [T in FlowExecutionEventType]: FlowExecutionEventOf<T>;
}[FlowExecutionEventType];

/**
 * Flow execution result
 */
export interface FlowExecutionResult {
  success: boolean;
  output: unknown;
  variables: Record<string, unknown>;
  steps: number;
  events: FlowExecutionEvent[];
  error?: Error;
  /**
   * MA-F11: the model usage of every `llmCall` step of the run, summed (zeros
   * when no step reported usage). `cachedInputTokens`, `cacheWriteTokens`, `reasoningTokens` and
   * `costUsd` are present only when some call reported them.
   */
  usage: ProviderUsage;
}

/** The summed usage of a run's `llm-response` events. */
function sumUsage(events: FlowExecutionEvent[]): ProviderUsage {
  let total: ProviderUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const event of events) {
    const usage = event.type === 'llm-response' ? event.data?.usage : undefined;
    if (usage) {
      total = addUsage(total, usage);
    }
  }
  return total;
}

/** Record an event and notify the optional listener. */
function emitEvent(
  events: FlowExecutionEvent[],
  onEvent: ((event: FlowExecutionEvent) => void) | undefined,
  event: FlowExecutionEvent
): void {
  events.push(event);
  onEvent?.(event);
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

/** The node shapes FlowExecutor runs (the executor-side `oneOf` / `forEach` / `evaluator`). */
type ExecutableNode =
  | SequenceNode
  | ParallelNode
  | OneOfOptionsNode
  | ForEachItemsNode
  | ExpressionEvaluatorNode
  | LLMCallNode
  | ToolCallNode
  | SetVariableNode
  | ReturnNode
  | EndNode
  | ThrowNode;

type NodeHandler<N extends ExecutableNode = ExecutableNode> = (
  node: N,
  context: FlowExecutionContext,
  events: FlowExecutionEvent[],
  onEvent?: (event: FlowExecutionEvent) => void
) => unknown;

/** One handler per node type, each typed with its own node shape. */
type NodeHandlers = { [T in ExecutableNode['type']]: NodeHandler<Extract<ExecutableNode, { type: T }>> };

/**
 * DUR-F1: the scope objects of `forEach` iterations. Each iteration runs with
 * its own variables object whose prototype is the enclosing scope, holding
 * only the loop's item/index variables, so parallel branches and iterations
 * never overwrite each other's `{{item}}`. Reads fall through to the enclosing
 * scope; writes of any other name go to the nearest scope that owns it (the
 * flow's variables, unless an outer loop declared it), as before.
 */
const loopScopes = new WeakSet<Record<string, unknown>>();

/** A new iteration scope over `parent` with the given loop variables. */
function loopScope(parent: Record<string, unknown>, locals: Record<string, unknown>): Record<string, unknown> {
  const scope = Object.assign(Object.create(parent) as Record<string, unknown>, locals);
  loopScopes.add(scope);
  return scope;
}

/** Write a variable to the scope that owns it (see {@link loopScopes}). */
function writeVariable(variables: Record<string, unknown>, name: string, value: unknown): void {
  let target = variables;
  while (loopScopes.has(target) && !Object.hasOwn(target, name)) {
    target = Object.getPrototypeOf(target) as Record<string, unknown>;
  }
  target[name] = value;
}

/** A plain object of every variable visible in a scope, for the expression evaluator (own properties only). */
function flattenScope(variables: Record<string, unknown>): Record<string, unknown> {
  if (!loopScopes.has(variables)) {
    return variables;
  }
  return { ...flattenScope(Object.getPrototypeOf(variables) as Record<string, unknown>), ...variables };
}

/** A8: the number of step ids handed out so far in each run, keyed by the run's event list. */
const stepCounts = new WeakMap<FlowExecutionEvent[], number>();

/** A8: a run-unique id for a node without one (`step-1`, `step-2`, ... in start order). */
function nextStepId(events: FlowExecutionEvent[]): string {
  const count = (stepCounts.get(events) ?? 0) + 1;
  stepCounts.set(events, count);
  return `step-${count}`;
}

/** DUR-F17: the durable state of each run, keyed by the run's event list. */
const flowRuns = new WeakMap<FlowExecutionEvent[], FlowRun>();

/** DUR-F17: a node's place in the flow (`0`, `0.1`, ...), carried on its context. */
const NODE_PATH = Symbol('lousho.flowNodePath');
type PathedContext = FlowExecutionContext & { [NODE_PATH]?: string };

function nodePath(context: FlowExecutionContext): string {
  return (context as PathedContext)[NODE_PATH] ?? '0';
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Flow Executor
 */
export class FlowExecutor {
  /**
   * Execute a flow
   */
  static async execute(
    flow: AgentFlow,
    context: FlowExecutionContext,
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<FlowExecutionResult> {
    this.assertRunnableAgent(context.agent);
    const durable = durableOptions(context, 'execute');
    if (durable) {
      const existing = await durable.store.load(durable.runId);
      if (existing && existing.status !== 'finished') {
        throw new ConfigurationError(
          `FlowExecutor.execute: run '${durable.runId}' has an unfinished checkpoint (status '${existing.status ?? 'in-progress'}'). ` +
            `Continue it with FlowExecutor.resume(flow, { ...context, checkpointStore, runId }), or start a new run with another runId.`,
          'runId'
        );
      }
    }
    const variables = { ...context.variables };
    const run = durable ? new FlowRun(durable.store, durable.runId, flow.code, variables) : undefined;
    return this.traced(flow, { ...context, variables }, onEvent, run);
  }

  /**
   * Eve DUR-F17: continue a durable run started by `execute()` with the same
   * `checkpointStore` and `runId` - after a crash, or after a step failed.
   * Nodes that completed are not run again (each returns its saved result,
   * and a `oneOf` takes the branch it took before); the rest run as usual,
   * from the saved variables. `result.usage` and `result.steps` include the
   * earlier attempts'. A finished run is not run again: its saved result is
   * returned. Rejects with `LOUSHO_CHECKPOINT_NOT_FOUND` when the run has no
   * checkpoint, and `LOUSHO_CONFIG_INVALID` when it belongs to another flow.
   *
   * @example
   * ```ts
   * const result = await FlowExecutor.resume(flow, { agent, provider, toolRegistry, checkpointStore, runId: 'order-42' });
   * ```
   */
  static async resume(
    flow: AgentFlow,
    context: FlowResumeContext,
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<FlowExecutionResult> {
    this.assertRunnableAgent(context.agent);
    const { store, runId } = durableOptions(context, 'resume')!;
    const checkpoint = await store.load(runId);
    const saved = flowStateOf(checkpoint, runId, flow.code);
    if (checkpoint?.status === 'finished') {
      return { success: true, output: saved.output, variables: saved.variables, steps: saved.steps, events: [], usage: saved.usage };
    }
    const variables = { ...saved.variables };
    const run = new FlowRun(store, runId, flow.code, variables, saved);
    return this.traced(flow, { ...context, variables }, onEvent, run);
  }

  /** Runs the flow in its `invoke_workflow` span. */
  private static traced(
    flow: AgentFlow,
    context: FlowExecutionContext,
    onEvent: ((event: FlowExecutionEvent) => void) | undefined,
    run: FlowRun | undefined
  ): Promise<FlowExecutionResult> {
    return withSpan(
      context.exporter,
      `${GenAiOperation.INVOKE_WORKFLOW} ${flow.name}`,
      defined({
        [GenAiAttr.OPERATION_NAME]: GenAiOperation.INVOKE_WORKFLOW,
        [GenAiAttr.WORKFLOW_NAME]: flow.name,
        [FlowAttr.CODE]: flow.code,
      }),
      async (flowSpan) => {
        const result = await this.runFlow(flow, { ...context, parentSpanId: flowSpan.id }, onEvent, run);
        this.recordOutcome(flowSpan, result.error);
        return result;
      },
      context.parentSpanId,
      'internal'
    );
  }

  /**
   * `context.agent` is the plain config `buildLLMMessages()`/`resolveLLMModel()`
   * read (`{ name, prompt?, settings }`); a `createAgent()` agent is a live
   * object that runs itself through `send()`, so its instructions, model and
   * tools are not readable here - it was silently accepted and dropped before
   * LOU-R14. Reject it, naming the expected shape.
   */
  private static assertRunnableAgent(agent: AgentConfig): void {
    if (isCreateAgentResult(agent)) {
      throw new SDKError(
        `FlowExecutor.execute: 'agent' is a createAgent() agent, which runs itself. ` +
          `A flow's steps run under a plain config instead. ` +
          `Example: FlowExecutor.execute(flow, { agent: { name: 'my-agent', prompt: 'You are a triager.' }, provider, variables })`,
        'LOUSHO_CONFIG_INVALID'
      );
    }
  }

  /** Records a flow/node outcome (and the error, when it failed) on its span. */
  private static recordOutcome(span: Span, error?: unknown): void {
    span.attributes = { ...span.attributes, [FlowAttr.OUTCOME]: error ? 'error' : 'success' };
    if (error) {
      recordSpanError(span, error);
    }
  }

  private static async runFlow(
    flow: AgentFlow,
    context: FlowExecutionContext,
    onEvent: ((event: FlowExecutionEvent) => void) | undefined,
    run: FlowRun | undefined
  ): Promise<FlowExecutionResult> {
    const events: FlowExecutionEvent[] = [];
    // execute()/resume() made this run's own copy (the object a durable run's checkpoints save).
    const variables = context.variables;
    if (run) {
      flowRuns.set(events, run);
      run.progress = () => ({ usage: sumUsage(events), steps: this.countCompletedSteps(events) });
    }
    // DUR-F17: the totals include a resumed run's earlier attempts.
    const totals = () => run?.totals() ?? { usage: sumUsage(events), steps: this.countCompletedSteps(events) };

    // Emit flow start event
    emitEvent(events, onEvent, {
      type: 'flow-start',
      timestamp: new Date(),
      data: { flowCode: flow.code, flowName: flow.name },
    });

    try {
      // A8: the flow's declared inputs (required ones, and their types) are checked before any step runs.
      this.assertValidInputs(flow, variables);

      // Execute the flow
      // A flow without a root node fails in executeNode with a TypeError, reported as a flow-error.
      const output = await this.executeNode(
        flow.flow as EditorStep,
        { ...context, variables, currentDepth: 0 },
        events,
        onEvent
      );
      const { steps, usage } = totals();
      await run?.save('finished', { output });

      // Emit flow complete event
      emitEvent(events, onEvent, {
        type: 'flow-complete',
        timestamp: new Date(),
        data: { output, steps },
        variables,
      });

      return {
        success: true,
        output,
        variables,
        steps,
        events,
        usage,
      };
    } catch (error) {
      // Emit flow error event
      emitEvent(events, onEvent, {
        type: 'flow-error',
        timestamp: new Date(),
        error: error as Error,
      });

      const { steps, usage } = totals();
      return {
        success: false,
        output: null,
        variables,
        steps,
        events,
        error: error as Error,
        usage,
      };
    }
  }

  private static assertValidInputs(flow: AgentFlow, variables: Record<string, unknown>): void {
    const { valid, errors } = validateFlowInput(variables, flow.inputs ?? []);
    if (!valid) {
      throw new ValidationError(`Flow '${flow.code}' inputs are invalid: ${errors.join('; ')}`, { inputs: errors });
    }
  }

  private static countCompletedSteps(events: FlowExecutionEvent[]): number {
    return events.filter(e => e.type === 'step-complete').length;
  }

  /** Handler per node type, each typed with its node shape. */
  private static readonly handlersByType: NodeHandlers = {
    sequence: (node, context, events, onEvent) => this.executeSequence(node, context, events, onEvent),
    parallel: (node, context, events, onEvent) => this.executeParallel(node, context, events, onEvent),
    oneOf: (node, context, events, onEvent) => this.executeOneOf(node, context, events, onEvent),
    forEach: (node, context, events, onEvent) => this.executeForEach(node, context, events, onEvent),
    evaluator: (node, context) => this.executeEvaluator(node, context),
    llmCall: (node, context, events, onEvent) => this.executeLLMCall(node, context, events, onEvent),
    toolCall: (node, context, events, onEvent) => this.executeToolCall(node, context, events, onEvent),
    setVariable: (node, context, events, onEvent) => this.executeSetVariable(node, context, events, onEvent),
    return: (node, context) => this.executeReturn(node, context),
    end: (node, context) => this.executeEnd(node, context),
    throw: (node, context) => {
      throw new Error(this.interpolate(node.message || 'Flow error', context.variables));
    },
  };

  /**
   * Handler per node type, looked up by the node's `type` (a Map, so a type
   * such as 'constructor' finds nothing). Handlers dispatch through the class.
   * Synchronous handlers return their value directly (not a promise) so
   * executeNode() doesn't add an extra await. A handler takes the node shape
   * of its own type; the map erases that pairing, which dispatchNode() restores
   * by looking the handler up by the node's own `type`.
   */
  private static readonly nodeHandlers: ReadonlyMap<string, NodeHandler> = new Map(
    Object.entries(this.handlersByType) as Array<[string, NodeHandler]>
  );

  /**
   * Run the handler for a node's type; unknown types are rejected.
   */
  private static dispatchNode(
    node: EditorStep,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): unknown {
    const handler = this.nodeHandlers.get(node.type);
    if (!handler) {
      throw new SDKError(`Unknown node type: ${node.type}`, 'LOUSHO_FLOW_INVALID');
    }
    // The handler was found by `node.type`, so `node` has that handler's shape.
    return handler(node as ExecutableNode, context, events, onEvent);
  }

  /**
   * Throw if the flow has recursed deeper than the context allows
   */
  private static assertWithinDepthLimit(context: FlowExecutionContext): void {
    // Check depth to prevent infinite recursion
    const maxDepth = context.maxDepth || 100;
    const currentDepth = context.currentDepth || 0;
    if (currentDepth > maxDepth) {
      throw new SDKError(`Maximum flow depth ${maxDepth} exceeded`, 'LOUSHO_FLOW_EXECUTION_FAILED');
    }
  }

  /**
   * Execute a single flow node
   */
  private static async executeNode(
    node: EditorStep,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    this.assertWithinDepthLimit(context);
    // A8: an aborted run starts no further step.
    context.signal?.throwIfAborted();

    // Editor-side shapes have no `id`; the executor-side ones may. A8: a
    // missing id is unique within the run (it was `step-${Date.now()}`, which collided).
    const stepId = (node as { id?: string }).id || nextStepId(events);

    // DUR-F17: a node a resumed run already completed is not run again.
    const run = flowRuns.get(events);
    const path = nodePath(context);
    if (run?.isCompleted(path)) {
      return run.resultOf(path);
    }

    return withSpan(
      context.exporter,
      `${FLOW_NODE_SPAN_NAME} ${node.type}`,
      defined({ [FlowAttr.NODE_ID]: stepId, [FlowAttr.NODE_TYPE]: node.type }),
      async (nodeSpan) => {
        try {
          const result = await this.runNode(node, stepId, { ...context, parentSpanId: nodeSpan.id }, events, onEvent);
          this.recordOutcome(nodeSpan);
          return result;
        } catch (error) {
          this.recordOutcome(nodeSpan, error);
          throw error;
        }
      },
      context.parentSpanId,
      'internal'
    );
  }

  /** The step-start/step-complete/step-error event bracket around a node's handler. */
  private static async runNode(
    node: EditorStep,
    stepId: string,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {

    // Emit step start event
    emitEvent(events, onEvent, {
      type: 'step-start',
      timestamp: new Date(),
      stepId,
      stepType: node.type,
    });

    try {
      const options = this.runOptions(node, stepId);
      const output = options ? this.runWithRetry(node, stepId, options, context, events, onEvent) : this.dispatchNode(node, context, events, onEvent);
      const result = output instanceof Promise ? await output : output;

      // Emit step complete event
      emitEvent(events, onEvent, {
        type: 'step-complete',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        data: result,
      });

      // DUR-F17: a durable run saves its state after every completed node.
      await flowRuns.get(events)?.complete(nodePath(context), result);

      return result;
    } catch (error) {
      // Emit step error event
      emitEvent(events, onEvent, {
        type: 'step-error',
        timestamp: new Date(),
        stepId,
        stepType: node.type,
        error: error as Error,
      });

      throw error;
    }
  }

  /** DUR-F17: a node's `retry` / `timeoutMs`, checked; `undefined` when it has neither. */
  private static runOptions(node: EditorStep, stepId: string): { maxAttempts: number; backoffMs: number; timeoutMs?: number } | undefined {
    const { retry, timeoutMs } = node as NodeRunOptions;
    if (retry === undefined && timeoutMs === undefined) {
      return undefined;
    }
    const maxAttempts = retry?.maxAttempts ?? 1;
    const backoffMs = retry?.backoffMs ?? 0;
    const invalid =
      (!Number.isInteger(maxAttempts) || maxAttempts < 1 ? `retry.maxAttempts must be an integer >= 1, got ${maxAttempts}` : undefined) ??
      (!Number.isFinite(backoffMs) || backoffMs < 0 ? `retry.backoffMs must be a number >= 0, got ${backoffMs}` : undefined) ??
      (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0) ? `timeoutMs must be a number > 0, got ${timeoutMs}` : undefined);
    if (invalid) {
      throw new SDKError(`Flow step '${stepId}' (${node.type}): ${invalid}`, 'LOUSHO_FLOW_INVALID');
    }
    return { maxAttempts, backoffMs, timeoutMs };
  }

  /**
   * DUR-F17: run a node's handler up to `maxAttempts` times, each attempt
   * limited to `timeoutMs`. A cancelled run is not retried. In a durable run,
   * the children an earlier attempt completed are not run again.
   */
  private static async runWithRetry(
    node: EditorStep,
    stepId: string,
    options: { maxAttempts: number; backoffMs: number; timeoutMs?: number },
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runAttempt(node, stepId, options.timeoutMs, context, events, onEvent);
      } catch (error) {
        if (attempt >= options.maxAttempts || context.signal?.aborted) {
          throw error;
        }
        const delayMs = options.backoffMs * 2 ** (attempt - 1);
        emitEvent(events, onEvent, {
          type: 'step-retry',
          timestamp: new Date(),
          stepId,
          stepType: node.type,
          data: { attempt, maxAttempts: options.maxAttempts, delayMs },
          error: error as Error,
        });
        await abortableDelay(delayMs, context.signal);
      }
    }
  }

  /** One attempt at a node, failed with `LOUSHO_OPERATION_TIMEOUT` (and its signal aborted) past `timeoutMs`. */
  private static async runAttempt(
    node: EditorStep,
    stepId: string,
    timeoutMs: number | undefined,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    if (timeoutMs === undefined) {
      return this.dispatchNode(node, context, events, onEvent);
    }
    const controller = new AbortController();
    const parentSignal = context.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
    }
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new TimeoutError(`Flow step '${stepId}' (${node.type}) timed out after ${timeoutMs} ms`, timeoutMs, `flow.node ${node.type}`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      const attempt = Promise.resolve().then(() => this.dispatchNode(node, { ...context, signal: controller.signal }, events, onEvent));
      return await Promise.race([attempt, timedOut]);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  /**
   * Context for a node nested one level below the given context
   */
  private static childContext(context: FlowExecutionContext): FlowExecutionContext {
    return { ...context, currentDepth: (context.currentDepth || 0) + 1 };
  }

  /** The context of a node's child at `index` (its step, branch, option or iteration). */
  private static childAt(context: FlowExecutionContext, index: number): FlowExecutionContext {
    const child: PathedContext = { ...this.childContext(context), [NODE_PATH]: `${nodePath(context)}.${index}` };
    return child;
  }


  /**
   * Execute sequence node
   */
  private static async executeSequence(
    node: SequenceNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    const steps = node.steps || [];
    let lastResult: unknown = null;

    for (const [index, step] of steps.entries()) {
      lastResult = await this.executeNode(step, this.childAt(context, index), events, onEvent);
    }

    return lastResult;
  }

  /**
   * Execute parallel node
   */
  private static async executeParallel(
    node: ParallelNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown[]> {
    const steps = node.steps || [];

    // DUR-F12 / MA-F11: the branches share a signal linked to the run's. The
    // first branch to fail aborts it, so its siblings start no further step
    // and their in-flight model/tool calls get the abort; the node settles only
    // once every branch has, so nothing runs (or emits events) after the flow
    // has reported the failure.
    const controller = new AbortController();
    const parentSignal = context.signal;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      abortFromParent();
    }
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });

    let failure: { error: unknown } | undefined;
    try {
      const settled = await Promise.allSettled(
        steps.map((step, index) =>
          this.executeNode(step, { ...this.childAt(context, index), signal: controller.signal }, events, onEvent).catch((error: unknown) => {
            if (!failure) {
              failure = { error };
              controller.abort(error);
            }
            throw error;
          })
        )
      );
      if (failure) {
        throw failure.error;
      }
      return settled.map((outcome) => (outcome as PromiseFulfilledResult<unknown>).value);
    } finally {
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  }

  /**
   * Whether a oneOf option should run. An option with no condition is the default option.
   */
  private static optionApplies(
    option: OneOfOption,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): boolean {
    return !option.condition || this.checkOptionCondition(option.condition, context, events, onEvent);
  }

  /**
   * Evaluate a oneOf option's condition and emit the condition-evaluated event
   */
  private static checkOptionCondition(
    condition: string,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): boolean {
    const conditionMet = this.evaluateCondition(condition, context.variables);

    // Emit condition evaluated event
    emitEvent(events, onEvent, {
      type: 'condition-evaluated',
      timestamp: new Date(),
      data: { condition, result: conditionMet },
    });

    return conditionMet;
  }

  /**
   * Execute oneOf (conditional) node
   */
  private static async executeOneOf(
    node: OneOfOptionsNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    const index = this.selectOption(node, context, events, onEvent);
    const option = node.options?.[index];

    return option ? await this.executeNode(option.step, this.childAt(context, index), events, onEvent) : null;
  }

  /**
   * Index of the first option whose condition holds (or that has none), or -1.
   * DUR-F17: a durable run remembers the pick, so a resume takes the same branch.
   */
  private static selectOption(
    node: OneOfOptionsNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): number {
    const run = flowRuns.get(events);
    const path = nodePath(context);
    const saved = run?.choiceOf(path);
    if (saved !== undefined) {
      return saved;
    }
    const options = node.options || [];
    const index = options.findIndex((option) => this.optionApplies(option, context, events, onEvent));
    run?.setChoice(path, index);
    return index;
  }

  /**
   * Execute forEach loop node
   */
  private static async executeForEach(
    node: ForEachItemsNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown[]> {
    // `items` resolves to an array, or to whatever a `$variable` holds; the
    // loop reads `length` and indexes, as for any array-like value.
    const items = (this.resolveValue(node.items, context.variables) || []) as ArrayLike<unknown>;
    const { itemVar, indexVar } = this.loopVariableNames(node);
    const results: unknown[] = [];

    for (let i = 0; i < items.length; i++) {
      // DUR-F1: the loop variables live in this iteration's own scope, not the
      // shared variables, so a parallel sibling cannot overwrite them.
      const variables = loopScope(context.variables, { [itemVar]: items[i], [indexVar]: i });

      // Emit loop iteration event
      emitEvent(events, onEvent, {
        type: 'loop-iteration',
        timestamp: new Date(),
        data: { item: items[i], index: i },
      });

      // Execute step with the iteration's scope
      if (node.step) {
        const result = await this.executeNode(node.step, { ...this.childAt(context, i), variables }, events, onEvent);
        results.push(result);
      }
    }

    return results;
  }

  private static loopVariableNames(node: ForEachItemsNode): { itemVar: string; indexVar: string } {
    return {
      itemVar: node.itemVariable || 'item',
      indexVar: node.indexVariable || 'index',
    };
  }

  /**
   * Execute evaluator node
   */
  private static async executeEvaluator(
    node: ExpressionEvaluatorNode,
    context: FlowExecutionContext
  ): Promise<unknown> {
    const expression = node.expression || '';
    return this.evaluateExpression(expression, context.variables);
  }

  /**
   * Store a node's result in its outputVariable, if it has one, and emit variable-set
   */
  private static storeOutputVariable(
    node: { outputVariable?: string },
    value: unknown,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): void {
    if (!node.outputVariable) {
      return;
    }

    writeVariable(context.variables, node.outputVariable, value);

    emitEvent(events, onEvent, {
      type: 'variable-set',
      timestamp: new Date(),
      data: { variable: node.outputVariable, value },
    });
  }

  /**
   * Build the chat messages for an LLM call node
   */
  private static buildLLMMessages(context: FlowExecutionContext, prompt: string): Message[] {
    const messages: Message[] = [];

    // Add system prompt if available
    if (context.agent.prompt) {
      messages.push({
        role: 'system',
        content: context.agent.prompt,
      });
    }

    // Add user message
    messages.push({
      role: 'user',
      content: prompt,
    });

    return messages;
  }

  private static resolveLLMModel(
    node: LLMCallNode,
    context: FlowExecutionContext
  ): string | undefined {
    return node.model || context.agent.settings?.model || context.provider.defaultModel;
  }

  /**
   * Execute LLM call node
   */
  private static async executeLLMCall(
    node: LLMCallNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<string> {
    const prompt = this.interpolate(node.prompt || '', context.variables);
    const model = this.resolveLLMModel(node, context);
    const messages = this.buildLLMMessages(context, prompt);

    // Emit LLM call event
    emitEvent(events, onEvent, {
      type: 'llm-call',
      timestamp: new Date(),
      data: { model, prompt },
    });

    // Call LLM, in a `chat {model}` span under this node's span
    const request = { model, messages, temperature: node.temperature, maxTokens: node.maxTokens, signal: context.signal };
    const captureContent = resolveCaptureContent(context.captureContent);
    const init = llmSpanInit(context.provider, request, {
      redactContent: context.redactContent,
      captureContent,
    });
    const result = await withSpan(
      context.exporter,
      init.name,
      init.attributes,
      async (llmSpan) => {
        const generated = await context.provider.generate(request);
        recordLlmResult(llmSpan, generated, captureContent);
        return generated;
      },
      context.parentSpanId,
      init.kind
    );

    // Emit LLM response event
    emitEvent(events, onEvent, {
      type: 'llm-response',
      timestamp: new Date(),
      data: { text: result.text, usage: result.usage },
    });

    // Store result in variable if specified
    this.storeOutputVariable(node, result.text, context, events, onEvent);

    return result.text;
  }

  private static requireToolRegistry(context: FlowExecutionContext): ToolRegistry {
    if (!context.toolRegistry) {
      throw new SDKError('Tool registry not available', 'LOUSHO_FLOW_EXECUTION_FAILED');
    }
    return context.toolRegistry;
  }

  /**
   * Resolve the tool a toolCall node refers to, failing if it isn't available
   */
  private static lookupTool(
    node: ToolCallNode,
    context: FlowExecutionContext
  ): { toolName: string; toolDesc: NonNullable<ReturnType<ToolRegistry['get']>> } {
    const toolRegistry = this.requireToolRegistry(context);

    const toolName = node.tool || '';
    const toolDesc = toolRegistry.get(toolName);

    if (!toolDesc || !toolDesc.tool) {
      throw new SDKError(`Tool '${toolName}' not found`, 'LOUSHO_TOOL_NOT_FOUND');
    }

    return { toolName, toolDesc };
  }

  /**
   * Run the tool in an `execute_tool {tool}` span under the node's span
   */
  private static executeToolInSpan(
    toolName: string,
    toolDesc: NonNullable<ReturnType<ToolRegistry['get']>>,
    args: Record<string, unknown>,
    sandbox: SandboxAdapter,
    context: FlowExecutionContext,
    toolCallId: string
  ): Promise<unknown> {
    const init = toolSpanInit(
      { name: toolName },
      { agent: context.agent, toolRegistry: context.toolRegistry }
    );
    return withSpan(
      context.exporter,
      init.name,
      init.attributes,
      async (toolSpan) => {
        const start = Date.now();
        // A8: the tool gets the run's signal as `ctx.abortSignal`, and the gate's call id.
        const result = await executeToolWithSandboxGuard(toolName, toolDesc, args, sandbox, context.signal, { toolCallId });
        recordToolOutcome(
          toolSpan,
          { args, result, latencyMs: Date.now() - start },
          {
            redactContent: context.redactContent,
            captureContent: resolveCaptureContent(context.captureContent),
          }
        );
        return result;
      },
      context.parentSpanId,
      init.kind
    );
  }

  /**
   * Execute tool call node
   */
  private static async executeToolCall(
    node: ToolCallNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    const { toolName, toolDesc } = this.lookupTool(node, context);

    // Interpolate arguments (an object, so interpolation returns an object)
    const rawArgs = this.interpolateObject(node.arguments || {}, context.variables) as Record<string, unknown>;

    // A8: the same gate as an agent run's tool call - schema validation,
    // permission rules and modes, `needsApproval` (decided by `approve`, or
    // refused) - so a flow step cannot run a tool the agent would not.
    const toolCallId = `flow-${globalThis.crypto.randomUUID()}`;
    const args = await gateFlowToolCall(toolName, toolDesc, rawArgs, context, toolCallId);

    // Emit tool call event
    emitEvent(events, onEvent, {
      type: 'tool-call',
      timestamp: new Date(),
      data: { tool: toolName, arguments: args },
    });

    // Execute tool. Tools flagged `requiresSandbox` are routed through the
    // configured SandboxAdapter instead of being invoked directly here -
    // mirrors AgentExecutor.executeToolCall()'s fail-closed handling
    // (LOU-F5) via the shared executeToolWithSandboxGuard() helper
    // (LOU-F fix), so this entry point can't silently bypass the sandbox
    // seam the way it previously did.
    const sandbox = context.sandbox ?? NoopSandbox;
    const result = await this.executeToolInSpan(toolName, toolDesc, args, sandbox, context, toolCallId);

    // Emit tool result event
    emitEvent(events, onEvent, {
      type: 'tool-result',
      timestamp: new Date(),
      data: { tool: toolName, result },
    });

    // Store result in variable if specified
    this.storeOutputVariable(node, result, context, events, onEvent);

    return result;
  }

  /**
   * Execute setVariable node
   */
  private static async executeSetVariable(
    node: SetVariableNode,
    context: FlowExecutionContext,
    events: FlowExecutionEvent[],
    onEvent?: (event: FlowExecutionEvent) => void
  ): Promise<unknown> {
    const variableName = node.variable || '';
    const value = this.resolveValue(node.value, context.variables);

    writeVariable(context.variables, variableName, value);

    emitEvent(events, onEvent, {
      type: 'variable-set',
      timestamp: new Date(),
      data: { variable: variableName, value },
    });

    return value;
  }

  /**
   * Execute return node
   */
  private static executeReturn(
    node: ReturnNode,
    context: FlowExecutionContext
  ): unknown {
    return this.resolveValue(node.value, context.variables);
  }

  /**
   * Execute end node
   */
  private static executeEnd(
    node: EndNode,
    context: FlowExecutionContext
  ): unknown {
    return this.resolveValue(node.value, context.variables);
  }

  /**
   * Interpolate string with variables
   */
  private static interpolate(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      // Every value but null/undefined has toString() (or throws, as before, for a null-prototype object).
      const value = variables[key] as { toString(): string } | null | undefined;
      return value?.toString() || '';
    });
  }

  /**
   * Interpolate object with variables
   */
  private static interpolateObject(obj: unknown, variables: Record<string, unknown>): unknown {
    if (typeof obj === 'string') {
      return this.interpolate(obj, variables);
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.interpolateObject(item, variables));
    }
    if (isObjectLike(obj)) {
      return this.interpolateRecord(obj, variables);
    }
    return obj;
  }

  private static interpolateRecord(obj: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.interpolateObject(value, variables);
    }
    return result;
  }

  /**
   * Resolve a value (can be literal or variable reference)
   */
  private static resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
    if (typeof value === 'string' && value.startsWith('$')) {
      const varName = value.substring(1);
      return variables[varName];
    }
    return value;
  }

  /**
   * Evaluate a condition
   */
  private static evaluateCondition(condition: string, variables: Record<string, unknown>): boolean {
    try {
      // Evaluate with the safe expression evaluator (./safeExpression), which
      // binds {{vars}} as values. Invalid/unsupported syntax is a failed
      // condition (false), exactly as a throwing eval() was before.
      return !!evaluateSafeExpression(condition, flattenScope(variables), { bindPlaceholders: true });
    } catch {
      return false;
    }
  }

  /**
   * Evaluate an expression
   */
  private static evaluateExpression(expression: string, variables: Record<string, unknown>): unknown {
    try {
      return evaluateSafeExpression(expression, flattenScope(variables), { bindPlaceholders: true });
    } catch (error) {
      const detail = error instanceof ExpressionError ? ` (${error.message})` : '';
      throw new SDKError(`Failed to evaluate expression: ${expression}${detail}`, 'LOUSHO_FLOW_EXECUTION_FAILED');
    }
  }
}
