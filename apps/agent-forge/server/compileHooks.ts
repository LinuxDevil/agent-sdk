/**
 * Compiles the hooks serialized onto an `AgentSpec` (via `spec.policy.hooks`
 * - see src/graph/graphToSpec.ts's doc comment for why they live there) into
 * a real SDK `HookRegistry` (src/execution/hooks.ts in the core SDK), ready
 * to pass as `AgentExecutor.execute()`'s new `hooks` option (LOU-Q1).
 *
 * Each compiled `AgentHook` delegates its actual work to
 * `sandboxRunHook()` (hookSandbox.ts) rather than running the user's code
 * in this server process - see that file's doc comment for why.
 */
import { HookRegistry, type AgentHook } from '@loushy/build-ai-agent';
import type { SandboxAdapter, GenerateOptions, Message } from '@loushy/build-ai-agent';
import { sandboxRunHook } from './hookSandbox';

/** Shape graphToSpec.ts serializes each hook as, under `spec.policy.hooks`. */
export interface SerializedHook {
  nodeKey: string;
  id: string;
  name: string;
  phase: 'pre' | 'post';
  point: 'toolCall' | 'generate';
  code: string;
}

export function isSerializedHookList(value: unknown): value is SerializedHook[] {
  return (
    Array.isArray(value) &&
    value.every(
      (h) =>
        h &&
        typeof h === 'object' &&
        typeof (h as SerializedHook).id === 'string' &&
        typeof (h as SerializedHook).code === 'string' &&
        (h.phase === 'pre' || h.phase === 'post') &&
        (h.point === 'toolCall' || h.point === 'generate')
    )
  );
}

function toolCallHook(hook: SerializedHook, sandbox: SandboxAdapter, timeoutMs?: number): AgentHook {
  const run = async (
    ctx: { toolName: string; args: Record<string, unknown> },
    extra: { result?: unknown; error?: string } = {}
  ) => {
    const outcome = await sandboxRunHook(
      sandbox,
      hook.code,
      {
        toolName: ctx.toolName,
        args: ctx.args,
        ...extra,
      },
      { timeoutMs }
    );
    if (outcome && typeof outcome === 'object' && outcome.args && typeof outcome.args === 'object') {
      // Mutate the LIVE args object in place - this is what makes a
      // preToolCall/postToolCall hook (e.g. redact-pii) actually change
      // what the tool is invoked with / what the caller sees, matching the
      // SDK's HookContext contract (ctx.args is a live, mutable reference -
      // see src/execution/hooks.ts's file header).
      for (const key of Object.keys(ctx.args)) delete ctx.args[key];
      Object.assign(ctx.args, outcome.args as Record<string, unknown>);
    }
    return outcome;
  };

  if (hook.phase === 'pre') {
    return {
      name: hook.id,
      preToolCall: async (ctx) => {
        await run(ctx);
      },
    };
  }
  return {
    name: hook.id,
    postToolCall: async (ctx, result) => {
      const outcome = await run(ctx, { result: result.result, error: result.error });
      if (outcome && typeof outcome === 'object') {
        if ('result' in outcome) result.result = (outcome as { result: unknown }).result;
        if ('error' in outcome) result.error = (outcome as { error?: string }).error;
      }
    },
  };
}

function generateHook(hook: SerializedHook, sandbox: SandboxAdapter, timeoutMs?: number): AgentHook {
  const run = async (messages: Message[], model: string) => {
    const outcome = await sandboxRunHook(sandbox, hook.code, { messages, model }, { timeoutMs });
    if (outcome && Array.isArray((outcome as { messages?: unknown }).messages)) {
      messages.length = 0;
      messages.push(...((outcome as { messages: Message[] }).messages));
    }
  };

  if (hook.phase === 'pre') {
    return {
      name: hook.id,
      preGenerate: async (ctx) => {
        await run(ctx.request.messages, ctx.request.model);
      },
    };
  }
  return {
    name: hook.id,
    postGenerate: async (ctx: { request: GenerateOptions }) => {
      await run(ctx.request.messages, ctx.request.model);
    },
  };
}

/**
 * Builds a `HookRegistry` from every `SerializedHook` under
 * `spec.policy.hooks` (already filtered to enabled-only by
 * graphToSpec.ts), in the order they appear - preserving the "hooks run in
 * registration order" contract `HookRegistry` documents. Returns
 * `undefined` when there are none, so callers can spread
 * `hooks ? { hooks } : {}` into `AgentExecutor.execute()`'s options without
 * passing an empty-but-truthy registry.
 */
export function compileHooksFromSpecPolicy(
  policyHooks: unknown,
  sandbox: SandboxAdapter,
  /** LOU-R3: configurable hook timeout (defaults to hookSandbox.ts's own 5s default when omitted - see settingsStore.ts's `SettingsProfile.hookTimeoutMs`). */
  timeoutMs?: number
): HookRegistry | undefined {
  if (!isSerializedHookList(policyHooks) || policyHooks.length === 0) return undefined;

  const registry = new HookRegistry();
  for (const hook of policyHooks) {
    registry.register(
      hook.point === 'toolCall' ? toolCallHook(hook, sandbox, timeoutMs) : generateHook(hook, sandbox, timeoutMs)
    );
  }
  return registry;
}
