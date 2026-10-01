import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { createAgent, type CreateAgentConfig, type PerRun, type RunConfigContext } from './createAgent';
import { defineTool } from './tools/defineTool';
import { createMockProvider } from './providers/mock';
import type { AgentInput } from './providers/content';

const provider = createMockProvider();
const lookup = defineTool({ name: 'lookup', description: 'Looks up', input: z.object({ q: z.string() }), execute: async ({ q }) => q });

describe('createAgent dynamic config types (LOU-V15)', () => {
  it('accepts model, instructions, prompt and tools as functions of the run', () => {
    createAgent({
      model: ({ metadata }) => (metadata?.plan === 'pro' ? 'openai/gpt-4o' : 'openai/gpt-4o-mini'),
      instructions: async ({ sessionId }) => `Tenant ${sessionId ?? 'none'}`,
      tools: ({ input }) => (typeof input === 'string' ? [lookup] : {}),
    });
    createAgent({ provider, model: async () => 'gpt-4o-mini', prompt: () => 'Be brief.' });
  });

  it('gives the functions the run context', () => {
    createAgent({
      provider,
      instructions: (ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<RunConfigContext>();
        expectTypeOf(ctx.input).toEqualTypeOf<AgentInput>();
        expectTypeOf(ctx.sessionId).toEqualTypeOf<string | undefined>();
        expectTypeOf(ctx.metadata).toEqualTypeOf<Record<string, unknown> | undefined>();
        return 'ok';
      },
    });
  });

  it('keeps the static forms and rejects wrong return types', () => {
    expectTypeOf<CreateAgentConfig['instructions']>().toEqualTypeOf<PerRun<string> | undefined>();
    createAgent({ provider, model: 'gpt-4o', instructions: 'static', tools: [lookup] });
    // Type-only: never called.
    void (() => {
      // @ts-expect-error - a model function returns a model string
      createAgent({ provider, model: () => 42 });
      // @ts-expect-error - instructions and prompt are still exclusive
      createAgent({ provider, instructions: () => 'a', prompt: () => 'b' });
      // @ts-expect-error - tools functions return tools
      createAgent({ provider, tools: () => 'lookup' });
    });
  });

  it('takes metadata on session send and stream', () => {
    const session = createAgent({ provider }).session();
    void session.send('hi', { metadata: { plan: 'pro' } });
    void session.stream('hi', { metadata: { plan: 'pro' } });
  });
});
