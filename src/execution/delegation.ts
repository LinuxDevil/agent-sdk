/**
 * The delegation core shared by the `task` tool (LOU-Y3) and
 * `createDelegateTool()`: runs a child agent for one tool call of a parent
 * run, inheriting the parent's runtime (LOU-Y1).
 *
 * The child keeps its own instructions, model/provider, tools, skills and
 * maxSteps, and sees only the input it is given (never the parent's
 * transcript). From the parent run it inherits, unless the child sets its
 * own: the abort signal, the trace exporter and span parent, the hooks
 * (tagged with `ctx.subagent`), the approval store (a paused child pauses the
 * parent), `toolConcurrency`, the sandbox and content-capture settings, and
 * the run's event listeners (events tagged with `event.subagent`). Its token
 * usage is added to the parent's.
 */

import type { LLMProvider, Message, ReasoningOption } from '../providers';
import type { AgentConfig } from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { Skill } from '../skills/defineSkill';
import type { Subagents } from '../subagents/types';
import type { StandardSchemaV1 } from '../utils/zodCompat';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { ResumeExecuteOptions } from './resume';
import type { ApprovalStore, ExecutionSnapshot } from './ApprovalGate';
import type { ToolConcurrency } from './toolBatch';
import { inheritPermissionMode, type PermissionOptions, type PermissionRule } from './permissions';
import { inheritGuardrails, type AgentGuardrails } from './ioGuardrails';
import { HookRegistry, type AgentHook, type HookContext, type SubagentInfo } from './hooks';
import { markPropagating } from './propagatingToolError';
import { SubagentApprovalPause, subagentBudget, toolCallScopeOf, type ToolCallScope } from './subagentRuntime';
import { RUN_EVENTS, runEventsOf, type StreamingExecuteOptions } from './agentRun';
import type { ToolRunContext } from './sandboxGuard';
import { SDKError } from './errors';
import type { HostedTool } from '../tools/hosted';

/** Everything needed to run an agent as a child: its own configuration. */
export interface SubagentSpec {
  agent: AgentConfig;
  provider: LLMProvider;
  toolRegistry?: ToolRegistry;
  skills?: readonly Skill[];
  subagents?: Subagents;
  maxSubagentDepth?: number;
  maxSteps?: number;
  toolConcurrency?: ToolConcurrency;
  /** LOU-X2: the sub-agent's own permission rules, checked after the ones it inherits. */
  permissions?: readonly PermissionRule[];
  /** N4: the sub-agent's own mode, used while the lead's is `'default'`. */
  permissionMode?: PermissionOptions['permissionMode'];
  /** LOU-X4: the sub-agent's own guardrails, run after the ones it inherits. */
  guardrails?: AgentGuardrails;
  /** LOU-V13: the sub-agent's own `reasoning` (not inherited: it may run another model). */
  reasoning?: ReasoningOption;
  /** LOU-V4.2: the sub-agent's own `output` schema (never the lead's); its validated object is the `task` result. */
  output?: StandardSchemaV1;
  /** N1a: the sub-agent's own hosted tools (never the lead's). */
  hostedTools?: readonly HostedTool[];
}

/** One child run requested by a parent tool call. */
export interface SubagentRequest {
  /** The name the parent knows the child by (used in events, hooks and errors). */
  name: string;
  input: Message[];
  /**
   * The options object the parent tool's `execute(args, options)` received:
   * its `abortSignal`, and the parent run it belongs to.
   */
  toolOptions?: { abortSignal?: AbortSignal } & ToolRunContext;
  /** Short label of the task, for events and hooks. */
  description?: string;
}

/**
 * Runs (or, inside resumeAfterApproval(), resumes) a child agent for the
 * current tool call. Throws {@link SubagentApprovalPause} when the child
 * pauses for approval, so the executor can pause the parent run.
 * `execute` runs the child when the tool was not started by an agent run
 * (e.g. a test calling a delegate tool's `execute` directly).
 */
export async function runSubagent(
  spec: SubagentSpec,
  request: SubagentRequest,
  execute?: (options: ExecuteOptions) => Promise<ExecutionResult>
): Promise<ExecutionResult> {
  const scope = toolCallScopeOf(request.toolOptions);
  const info = subagentInfo(scope, request);
  const capture = captureApproval(scope);
  const options = childOptions(spec, scope, info, capture.store, request.toolOptions?.abortSignal);
  const run = scope?.execute ?? execute;
  if (!run) {
    throw new SDKError(`Sub-agent '${request.name}' can only be started by a tool call of an agent run.`, 'LOUSHO_CONFIG_INVALID');
  }

  const resume = scope?.resume;
  const result =
    resume && capture.store
      ? // M10c: the paused child is compared with its current definition, under the lead's `onAgentDrift`.
        await resume.run(resume.decision, capture.store, spec.toolRegistry ?? new ToolRegistry(), spec.provider, {
          ...options,
          currentAgent: spec.agent,
        })
      : await run({
          ...options,
          agent: spec.agent,
          input: request.input,
          provider: spec.provider,
          toolRegistry: spec.toolRegistry,
          // LOU-D23.2: its own id under the parent's session, for its tools and hooks (not checkpointed).
          ...(scope?.runtime.sessionId && { sessionId: `${scope.runtime.sessionId}/${info.toolCallId}` }),
        });

  // LOU-V5: the child's usage rolls up into the parent run's totals.
  const reportUsage = scope?.onDelegatedUsage ?? request.toolOptions?.onDelegatedUsage;
  reportUsage?.(result.usage);
  const paused = capture.saved();
  if (result.finishReason === 'awaiting-approval' && paused) {
    throw new SubagentApprovalPause(request.name, paused);
  }
  return result;
}

function subagentInfo(scope: ToolCallScope | undefined, request: SubagentRequest): SubagentInfo {
  return {
    name: request.name,
    depth: 1,
    toolCallId: scope?.toolCallId ?? '',
    ...(request.description ? { description: request.description } : {}),
  };
}

/**
 * The child's approval store: it records the child's pause instead of
 * persisting it (the parent persists one record for the whole run), and on
 * resume hands back the child's paused state. Undefined when the parent run
 * has no approval store.
 */
function captureApproval(scope: ToolCallScope | undefined): {
  store?: ApprovalStore;
  saved: () => ExecutionSnapshot | undefined;
} {
  let saved: ExecutionSnapshot | undefined;
  if (!scope?.runtime.approvalStore) {
    return { saved: () => saved };
  }
  const resume = scope.resume;
  const store: ApprovalStore = {
    save: async (_pending, snapshot) => {
      saved = snapshot;
    },
    resolve: async (id) => {
      const paused = resume?.suspension.snapshot;
      if (!paused || id !== resume.decision.id) return null;
      // The child's usage up to the pause already rolled into the parent's
      // totals; the resumed child reports only what it spends from here.
      const snapshot = { ...paused, usage: undefined };
      return { pending: snapshot.pendingToolCall, snapshot };
    },
  };
  return { store, saved: () => saved };
}

/** The child's execute options: inherited runtime, overridden by the child's own settings. */
function childOptions(
  spec: SubagentSpec,
  scope: ToolCallScope | undefined,
  info: SubagentInfo,
  approvalStore: ApprovalStore | undefined,
  abortSignal: AbortSignal | undefined
): ResumeExecuteOptions {
  const runtime = scope?.runtime ?? {};
  return {
    ...inheritedObservability(scope, info),
    approvalStore,
    sandbox: runtime.sandbox,
    signal: abortSignal ?? runtime.signal,
    toolConcurrency: spec.toolConcurrency ?? runtime.toolConcurrency,
    skills: spec.skills,
    subagents: spec.subagents,
    // The top-level run's limit bounds the whole tree: one level used up here.
    maxSubagentDepth: Math.max(0, subagentBudget(runtime.maxSubagentDepth) - 1),
    maxSteps: spec.maxSteps,
    // LOU-X2: the parent's rules come first, so they win over the sub-agent's own.
    permissions:
      runtime.permissions && spec.permissions
        ? [...runtime.permissions, ...spec.permissions]
        : (runtime.permissions ?? spec.permissions),
    onPermissionDecision: runtime.onPermissionDecision,
    // N4: the lead's mode while it is not 'default', else the sub-agent's own; read at each of the child's tool calls.
    permissionMode: inheritPermissionMode(runtime.permissionMode, spec.permissionMode),
    // M10c: a paused child (and its own children) resumes under the top-level run's drift mode.
    onAgentDrift: runtime.onAgentDrift,
    guardrails: inheritGuardrails(runtime.guardrails, spec.guardrails),
    reasoning: spec.reasoning,
    output: spec.output,
    hostedTools: spec.hostedTools,
  };
}

/** Tracing, content capture, hooks and events, as inherited from the parent run. */
function inheritedObservability(
  scope: ToolCallScope | undefined,
  info: SubagentInfo
): ResumeExecuteOptions & Pick<StreamingExecuteOptions, typeof RUN_EVENTS> {
  const runtime = scope?.runtime ?? {};
  // The child reports to the parent run's listeners (a streamed or listened-to parent).
  const sink = runEventsOf(runtime as StreamingExecuteOptions)?.forSubagent(info);
  return {
    ...(sink && { [RUN_EVENTS]: sink }),
    exporter: runtime.exporter,
    parentSpanId: scope?.spanId,
    captureContent: runtime.captureContent,
    redactContent: runtime.redactContent,
    hooks: runtime.hooks && hooksForSubagent(runtime.hooks, info),
  };
}

/**
 * Adds `outer` (a depth-1 sub-agent of this run) as the outermost sub-agent
 * of an innermost-first chain, one level deeper each.
 */
function nestSubagent(inner: SubagentInfo | undefined, outer: SubagentInfo): SubagentInfo {
  return inner ? { ...inner, depth: inner.depth + 1, parent: nestSubagent(inner.parent, outer) } : outer;
}

type HookMethod = 'preToolCall' | 'postToolCall' | 'preGenerate' | 'postGenerate';
const HOOK_METHODS: readonly HookMethod[] = ['preToolCall', 'postToolCall', 'preGenerate', 'postGenerate'];
type AnyHookMethod = (ctx: HookContext, ...rest: unknown[]) => unknown;

/**
 * The parent's hooks, as seen by the child: each context gets `subagent`
 * set (once, however many hooks run on it), and an error a hook throws
 * halts the whole run - not just the sub-agent - like it does in the parent.
 */
function hooksForSubagent(hooks: HookRegistry, info: SubagentInfo): HookRegistry {
  const tagged = new WeakSet<HookContext>();
  const tag = (ctx: HookContext): HookContext => {
    if (!tagged.has(ctx)) {
      tagged.add(ctx);
      ctx.subagent = nestSubagent(ctx.subagent, info);
    }
    return ctx;
  };
  const child = new HookRegistry();
  for (const hook of hooks.list()) {
    child.register(decorateHook(hook, tag));
  }
  return child;
}

function decorateHook(hook: AgentHook, tag: (ctx: HookContext) => HookContext): AgentHook {
  const decorated: Partial<Record<HookMethod, AnyHookMethod>> = {};
  for (const method of HOOK_METHODS) {
    const fn = hook[method] as AnyHookMethod | undefined;
    if (fn) {
      decorated[method] = async (ctx, ...rest) => {
        try {
          // LOU-X3: the hook's outcome (deny / result / input) reaches the child's run.
          return await fn.call(hook, tag(ctx), ...rest);
        } catch (error) {
          markPropagating(error);
          throw error;
        }
      };
    }
  }
  return { name: hook.name, ...decorated } as AgentHook;
}
