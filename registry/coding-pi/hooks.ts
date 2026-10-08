import type { AgentHook, Message } from '@lousho/build-ai-agent';

/**
 * The kit's hooks (pointed at by `agent.json`'s `hooks`): a loop guard that
 * denies a tool call the model already made twice with the same arguments,
 * then an output cap that keeps long tool results from flooding the context.
 * Ported from examples/coding-harness/index.ts.
 */

/** Test runs are expected to repeat (before and after every change), so the loop guard lets them through. */
const TEST_COMMAND = /^\s*node --test\b/;

/**
 * Deny a tool call the model already made `maxRepeats` times with the same
 * arguments in the same run. Counts are kept per run (keyed by the run's
 * message list), so separate runs and separately loaded agents never share
 * them; test commands and the post-approval re-fire of a paused call are not
 * counted.
 */
export function loopGuard(maxRepeats = 2): AgentHook {
  const runs = new WeakMap<Message[], Map<string, number>>();
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      if (ctx.resumedAfterApproval) return undefined;
      if (ctx.toolName === 'shell' && TEST_COMMAND.test(String(ctx.args.command ?? ''))) return undefined;
      let seen = runs.get(ctx.messages);
      if (!seen) runs.set(ctx.messages, (seen = new Map()));
      const key = `${ctx.toolName}:${JSON.stringify(ctx.args)}`;
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
