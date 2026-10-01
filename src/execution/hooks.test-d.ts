/**
 * LOU-X3: hook handler return types. Existing hooks that return nothing still
 * type-check; outcomes are typed.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { AgentHook, PostToolCallOutcome, PreToolCallOutcome } from './hooks';

describe('AgentHook return types (LOU-X3)', () => {
  it('accepts hooks that return nothing, sync or async', () => {
    const hooks: AgentHook[] = [
      { name: 'sync', preToolCall: () => {}, postToolCall: () => {} },
      { name: 'async', preToolCall: async () => {}, postToolCall: async () => {} },
      { name: 'log', preToolCall: (ctx) => console.log(ctx.toolName) },
    ];
    expectTypeOf(hooks).toEqualTypeOf<AgentHook[]>();
  });

  it('accepts the outcomes, sync or async', () => {
    const hook: AgentHook = {
      name: 'policy',
      preToolCall: async (ctx) => {
        if (ctx.toolName === 'shell') return { deny: 'No shell' };
        if (ctx.toolName === 'cached') return { result: 'hit' };
        return { input: { ...ctx.args, limit: 10 } };
      },
      postToolCall: (_ctx, result) => ({ result: String(result.result).slice(0, 100) }),
    };
    expectTypeOf(hook.name).toBeString();
    expectTypeOf<{ deny: string }>().toMatchTypeOf<PreToolCallOutcome>();
    expectTypeOf<{ input: Record<string, unknown> }>().toMatchTypeOf<PreToolCallOutcome>();
    expectTypeOf<{ result: number }>().toMatchTypeOf<PostToolCallOutcome>();
  });

  it('rejects an outcome of the wrong shape', () => {
    // @ts-expect-error - `deny` takes the reason as a string
    const bad: AgentHook = { name: 'bad', preToolCall: () => ({ deny: true }) };
    expectTypeOf(bad).toEqualTypeOf<AgentHook>();
  });
});
