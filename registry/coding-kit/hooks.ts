import type { AgentHook } from '@lousho/build-ai-agent';

/**
 * The kit's hooks (pointed at by `agent.json`'s `hooks`): a loop guard that
 * denies a tool call the model already made twice with the same arguments,
 * then an output cap that keeps long tool results from flooding the context.
 * Ported from examples/coding-harness/index.ts.
 */

/** Deny a tool call the model already made `maxRepeats` times with the same arguments. */
export function loopGuard(maxRepeats = 2): AgentHook {
  const seen = new Map<string, number>();
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      const key = `${ctx.sessionId ?? ''}:${ctx.toolName}:${JSON.stringify(ctx.args)}`;
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      if (count > maxRepeats) {
        return { deny: `You already called ${ctx.toolName} with these arguments ${maxRepeats} times. Try something else.` };
      }
      return undefined;
    },
  };
}

/** Cut long tool results so they do not flood the context. */
export function outputCap(maxChars = 4_000): AgentHook {
  return {
    name: 'output-cap',
    postToolCall(_ctx, result) {
      const text = typeof result.result === 'string' ? result.result : JSON.stringify(result.result ?? '');
      if (text.length <= maxChars) return undefined;
      return { result: `${text.slice(0, maxChars)}\n[output cut at ${maxChars} of ${text.length} chars]` };
    },
  };
}

export default [loopGuard(), outputCap()];
