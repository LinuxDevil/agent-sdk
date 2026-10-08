import type { AgentHook, Message } from '@lousho/build-ai-agent';

/**
 * The kit's hooks (pointed at by `agent.json`'s `hooks`): a loop guard that
 * denies a tool call the model already made twice with the same arguments,
 * then an output cap that keeps long tool results from flooding the context.
 * Ported from examples/coding-harness/index.ts.
 */

/** Test runs are expected to repeat (before and after every change), so the loop guard lets them through. */
const TEST_COMMAND = /^\s*node --test\b/;

function canonical(value: unknown): string {
  const record = (value ?? {}) as Record<string, unknown>;
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b))));
}

/** How many earlier calls in the current turn (since the last user message) match this one. */
function earlierCalls(messages: readonly Message[], toolCallId: string, toolName: string, args: unknown): number {
  const key = canonical(args);
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && messages[i].role !== 'user'; i--) {
    for (const call of messages[i].toolCalls ?? []) {
      if (call.id === toolCallId || call.function.name !== toolName) continue;
      try {
        if (canonical(JSON.parse(call.function.arguments || '{}')) === key) count++;
      } catch {
        // unparseable arguments never match
      }
    }
  }
  return count;
}

/**
 * Deny a tool call the model already made `maxRepeats` times with the same
 * arguments in the current turn. The count is read from the conversation
 * itself, so separate runs and separately loaded agents never share it and a
 * pause for approval does not reset it; test commands and the post-approval
 * re-fire of a paused call are let through.
 */
export function loopGuard(maxRepeats = 2): AgentHook {
  return {
    name: 'loop-guard',
    preToolCall(ctx) {
      if (ctx.resumedAfterApproval) return undefined;
      if (ctx.toolName === 'shell' && TEST_COMMAND.test(String(ctx.args.command ?? ''))) return undefined;
      if (earlierCalls(ctx.messages, ctx.toolCallId, ctx.toolName, ctx.args) >= maxRepeats) {
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
