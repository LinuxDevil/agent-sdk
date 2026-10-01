/**
 * Agent Hooks (LOU-Q1)
 *
 * User-authored extension points that run at well-defined points inside
 * AgentExecutor's execution loop: immediately before/after each
 * `provider.generate()` call, and immediately before/after each tool
 * invocation. They are a DIFFERENT, complementary concept to the
 * `onLLMRequest`/`onLLMResponse`/`onToolCall`/`onToolResult` callbacks on
 * `ExecuteOptions` (LOU-E2/O): those are single, internal instrumentation
 * callbacks wired up by apps/agent-forge's debugController.ts for the
 * step-through debugger. `AgentHook`s are a registered, ordered LIST of
 * independent, named, user-authored plugins (redact-pii, rate-limit,
 * audit-log, inject-context, ...) - the kind of thing a HookRegistry
 * manages, mirroring ToolRegistry's design (see src/tools/ToolRegistry.ts).
 *
 * Design notes on `ctx` shape: each hook receives the SAME live objects
 * AgentExecutor is about to act on (the in-flight `GenerateOptions.messages`
 * array, the parsed tool-call `args` object, etc.) rather than a snapshot
 * copy. This is deliberate - it's what lets a hook actually DO its job
 * instead of merely observing:
 *   - `inject-context`: pushes an extra message onto `ctx.request.messages`
 *     from `preGenerate`, so it's present in the very call about to be made.
 *   - `redact-pii`: mutates `ctx.args` in `preToolCall` (or
 *     `result.result`/`result.error` in `postToolCall`) in place, so the
 *     redacted value is what actually gets executed/returned.
 *   - `rate-limit`: throws from `preToolCall` to abort the step (see below).
 *   - `audit-log`: reads `ctx` fields (agentId, sessionId, toolName, args)
 *     without mutating anything.
 *
 * Outcomes (LOU-X3): a `preToolCall` hook may also RETURN `{ deny: reason }`,
 * `{ result: value }` or `{ input: newArgs }`, and a `postToolCall` hook
 * `{ result: value }`; see {@link PreToolCallOutcome}.
 *
 * Error handling: hooks run in REGISTRATION ORDER, and a hook that throws
 * (or rejects) aborts the current step - the error propagates out of
 * `HookRegistry.runXxx()`, out of AgentExecutor.execute() (or
 * resumeAfterApproval()), as a rejected promise. This mirrors how
 * `executeToolWithSandboxGuard()` errors propagate (see sandboxGuard.ts):
 * nothing here catches a hook's error and silently converts it into a
 * conversational `{error}` tool-result the way a *tool's own* thrown error
 * is handled in AgentExecutor.doExecuteToolCall(). A hook is trusted,
 * user-authored control-plane code (e.g. a rate limiter that means to
 * HALT the run) - swallowing its errors would silently defeat its purpose.
 */

import { GenerateOptions, GenerateResult, Message, ToolCall } from '../providers';
import type { AgentEventPayload } from './agentEvents';
import { instanceOfBranded } from '../utils/brand';

const HOOK_REGISTRY_BRAND = Symbol.for('loushy.HookRegistry');

/**
 * Fields common to every hook invocation.
 */
export interface HookContext {
  /** The agent's configured id, if any. */
  agentId?: string;
  /** The agent's display name. */
  agentName?: string;
  /** The durable-execution session id, if this run is using one. */
  sessionId?: string;
  /**
   * Live reference to the conversation history at the moment the hook
   * fires. Mutating this array (e.g. `inject-context` pushing a message)
   * affects the actual run.
   */
  messages: Message[];
  /** Free-form bag for hook-to-hook or hook-to-caller data passing. */
  metadata?: Record<string, unknown>;
  /**
   * LOU-Y1: set when the hook fires inside a sub-agent (a child run started
   * by the `task` tool or a `createDelegateTool()` tool). A parent run's
   * hooks apply to its sub-agents' model calls and tool calls too; a hook
   * that should only see the top-level run can return early on it.
   *
   * @example
   * ```ts
   * const audit: AgentHook = {
   *   name: 'audit',
   *   preToolCall(ctx) {
   *     if (ctx.subagent) return; // top-level calls only
   *     console.log(ctx.toolName);
   *   },
   * };
   * ```
   */
  subagent?: SubagentInfo;
}

/**
 * Which sub-agent a hook call or an execution event comes from (LOU-Y1).
 */
export interface SubagentInfo {
  /** The sub-agent's name: the `task` tool's `agent`, or the delegated agent's name. */
  name: string;
  /** 1 for a sub-agent of the top-level run, 2 for a sub-agent of that sub-agent, and so on. */
  depth: number;
  /** The parent run's tool call that started this sub-agent. */
  toolCallId: string;
  /** The `task` call's short `description` label, when there is one. */
  description?: string;
  /** The sub-agent that started this one, when it is nested deeper than depth 1. */
  parent?: SubagentInfo;
}

/** Context passed to `AgentHook.preToolCall` / `postToolCall`. */
export interface ToolCallHookContext extends HookContext {
  toolCallId: string;
  toolName: string;
  /**
   * Live reference to the parsed tool-call arguments. Mutating this object
   * in `preToolCall` changes what the tool is actually invoked with.
   */
  args: Record<string, unknown>;
  /** The raw ToolCall as returned by the LLM provider. */
  toolCall: ToolCall;
}

/** Result payload passed (mutable) to `AgentHook.postToolCall`. */
export interface ToolCallHookResult {
  result: unknown;
  error?: string;
  requiresApproval?: boolean;
}

/**
 * What a `preToolCall` hook may return (LOU-X3). Returning nothing continues
 * with the call unchanged.
 * - `{ deny: reason }`: the call does not run; the model gets a `kind: 'denied'`
 *   tool error with `reason`. Later pre-hooks do not run.
 * - `{ result: value }`: the call does not run; `value` is its result. Later
 *   pre-hooks do not run.
 * - `{ input: args }`: the call runs with `args` instead (later hooks see them
 *   as `ctx.args`); they are validated against the tool's input schema again.
 */
export type PreToolCallOutcome = { deny: string } | { result: unknown } | { input: Record<string, unknown> };

/** What a `postToolCall` hook may return (LOU-X3): `{ result }` replaces the result the model sees. */
export interface PostToolCallOutcome {
  result: unknown;
}

/** What {@link HookRegistry.runPreToolCall} decided for one call. */
export interface PreToolCallDecision {
  /** The hook that denied the call or supplied its result. */
  stop?: { hook: string } & ({ deny: string } | { result: unknown });
  /** The hooks that returned `{ input }`, in order; `ctx.args` holds the last input. */
  inputBy: string[];
}

type MaybePromise<T> = T | Promise<T>;

/** The outcome key `value` carries, if it is an object with one of `keys`. */
function outcomeKey<K extends string>(value: unknown, keys: readonly K[]): K | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return keys.find((key) => key in value);
}

/** The stream events a hook may emit with `GenerateHookContext.emit` (LOU-W3.2). */
export type HookEventPayload = Extract<AgentEventPayload, { type: 'compaction.start' | 'compaction.done' }>;

/** Context passed to `AgentHook.preGenerate` / `postGenerate`. */
export interface GenerateHookContext extends HookContext {
  /**
   * Adds an event to the run's stream, inside the current step (LOU-W3.2).
   * Set only when the run is streamed (`agent.stream()`, `session.stream()`,
   * `AgentExecutor.stream()`); `ctx.emit?.(...)` is a no-op otherwise. The run
   * fills in `runId`, `seq`, `timestamp` and `v`, and tags a sub-agent's events.
   */
  emit?: (event: HookEventPayload) => void;
  /**
   * Live reference to the request about to be sent to
   * `provider.generate()`. Mutating it (e.g. appending a message, changing
   * `temperature`) changes the actual call `preGenerate` fires before.
   */
  request: GenerateOptions;
}

/**
 * A user-authored extension point invoked at well-defined points in
 * AgentExecutor's execution loop. Every method is optional - a hook only
 * needs to implement the point(s) it cares about.
 */
export interface AgentHook {
  /** Unique name, used for registration/lookup/unregister and for error messages. */
  name: string;
  /**
   * Invoked immediately before a tool is executed (and before the permission
   * rules, tool guardrails and approval check). May return a {@link PreToolCallOutcome}.
   */
  preToolCall?(ctx: ToolCallHookContext): MaybePromise<PreToolCallOutcome | void>;
  /**
   * Invoked immediately after a tool call settles (success, tool-level error,
   * or approval-required). May return `{ result }` to replace the result the model sees.
   */
  postToolCall?(ctx: ToolCallHookContext, result: ToolCallHookResult): MaybePromise<PostToolCallOutcome | void>;
  /** Invoked immediately before each `provider.generate()` call. */
  preGenerate?(ctx: GenerateHookContext): void | Promise<void>;
  /** Invoked immediately after each `provider.generate()` call resolves. */
  postGenerate?(ctx: GenerateHookContext, result: GenerateResult): void | Promise<void>;
}

/**
 * Ordered collection of `AgentHook`s, mirroring `ToolRegistry`'s API shape
 * (register/registerMany/get/has/list/unregister/clear/size) so both
 * registries feel the same to consumers of this SDK.
 *
 * `runPreToolCall`/`runPostToolCall`/`runPreGenerate`/`runPostGenerate` run
 * every registered hook's corresponding method IN REGISTRATION ORDER,
 * sequentially (each hook is awaited before the next runs, so a later hook
 * sees any mutation an earlier one made). The first hook to throw aborts
 * the sequence immediately - subsequent hooks do NOT run - and the error
 * propagates to the caller (see the file-level doc comment above).
 */
export class HookRegistry {
  /** `instanceof HookRegistry` also holds for registries from another loaded copy of the SDK (LOU-D42). */
  static [Symbol.hasInstance](value: unknown): boolean {
    return instanceOfBranded(this, HookRegistry, HOOK_REGISTRY_BRAND, value);
  }

  get [HOOK_REGISTRY_BRAND](): true {
    return true;
  }

  private hooks: AgentHook[] = [];

  /** Register a hook. Registering a second hook with the same `name` replaces the first (a warning is logged). */
  public register(hook: AgentHook): void {
    const existingIndex = this.hooks.findIndex((h) => h.name === hook.name);
    if (existingIndex !== -1) {
      console.warn(`Hook '${hook.name}' is already registered. Overwriting.`);
      this.hooks[existingIndex] = hook;
      return;
    }
    this.hooks.push(hook);
  }

  /** Register multiple hooks at once, in the order given. */
  public registerMany(hooks: AgentHook[]): void {
    for (const hook of hooks) {
      this.register(hook);
    }
  }

  /** Look up a hook by name. */
  public get(name: string): AgentHook | undefined {
    return this.hooks.find((h) => h.name === name);
  }

  /** Whether a hook with this name is registered. */
  public has(name: string): boolean {
    return this.hooks.some((h) => h.name === name);
  }

  /** All registered hooks, in registration order. */
  public list(): AgentHook[] {
    return [...this.hooks];
  }

  /** Remove a hook by name. Returns whether one was found and removed. */
  public unregister(name: string): boolean {
    const index = this.hooks.findIndex((h) => h.name === name);
    if (index === -1) return false;
    this.hooks.splice(index, 1);
    return true;
  }

  /** Remove every registered hook. */
  public clear(): void {
    this.hooks = [];
  }

  /** Number of registered hooks. */
  public size(): number {
    return this.hooks.length;
  }

  /**
   * Run every registered `preToolCall`, in order. Throws (aborting the step)
   * if any hook throws. The first `{ deny }` or `{ result }` stops the
   * sequence; an `{ input }` replaces `ctx.args` for the hooks after it.
   */
  public async runPreToolCall(ctx: ToolCallHookContext): Promise<PreToolCallDecision> {
    const inputBy: string[] = [];
    for (const hook of this.hooks) {
      const outcome = await hook.preToolCall?.(ctx);
      const key = outcomeKey(outcome, ['deny', 'result', 'input'] as const);
      if (key === 'input') {
        ctx.args = (outcome as { input: Record<string, unknown> }).input;
        inputBy.push(hook.name);
      } else if (key) {
        return { stop: { hook: hook.name, ...(outcome as { deny: string } | { result: unknown }) }, inputBy };
      }
    }
    return { inputBy };
  }

  /**
   * Run every registered `postToolCall`, in order. Throws (aborting the step)
   * if any hook throws. A returned `{ result }` is written to `result.result`,
   * which later hooks see. Returns the name of the last hook that replaced it.
   */
  public async runPostToolCall(ctx: ToolCallHookContext, result: ToolCallHookResult): Promise<string | undefined> {
    let replacedBy: string | undefined;
    for (const hook of this.hooks) {
      const outcome = await hook.postToolCall?.(ctx, result);
      if (outcomeKey(outcome, ['result'] as const)) {
        result.result = (outcome as PostToolCallOutcome).result;
        replacedBy = hook.name;
      }
    }
    return replacedBy;
  }

  /** Run every registered `preGenerate`, in order. Throws (aborting the step) if any hook throws. */
  public async runPreGenerate(ctx: GenerateHookContext): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.preGenerate) {
        await hook.preGenerate(ctx);
      }
    }
  }

  /** Run every registered `postGenerate`, in order. Throws (aborting the step) if any hook throws. */
  public async runPostGenerate(ctx: GenerateHookContext, result: GenerateResult): Promise<void> {
    for (const hook of this.hooks) {
      if (hook.postGenerate) {
        await hook.postGenerate(ctx, result);
      }
    }
  }
}
