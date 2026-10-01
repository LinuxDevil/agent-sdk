import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import type { ToolExecutionOptions } from 'ai';
import { defineTool, type DefinedTool, type ToolInput, type ToolOutput } from './defineTool';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from './ToolRegistry';

const sendEmail = defineTool({
  name: 'send_email',
  description: 'Send an email',
  input: z.object({ to: z.string().email(), count: z.number().default(1) }),
  needsApproval: (args) => {
    expectTypeOf(args).toEqualTypeOf<{ to: string; count: number }>();
    // @ts-expect-error - `nope` is not an argument of this tool
    void args.nope;
    return !args.to.endsWith('@mycompany.com');
  },
  async execute(args, ctx) {
    expectTypeOf(args.to).toBeString();
    expectTypeOf(args.count).toBeNumber();
    expectTypeOf(ctx).toEqualTypeOf<ToolExecutionOptions>();
    // @ts-expect-error - `nope` is not an argument of this tool
    void args.nope;
    return { messageId: 'x', sent: args.count };
  },
});

describe('defineTool types', () => {
  it('infers input and output', () => {
    expectTypeOf<ToolInput<typeof sendEmail>>().toEqualTypeOf<{ to: string; count: number }>();
    expectTypeOf<ToolOutput<typeof sendEmail>>().toEqualTypeOf<{ messageId: string; sent: number }>();
    expectTypeOf(sendEmail).toMatchTypeOf<DefinedTool>();
  });

  it('awaits async results and preserves sync ones', () => {
    const sync = defineTool({ name: 's', description: 'd', input: z.object({}), execute: () => 42 });
    expectTypeOf<ToolOutput<typeof sync>>().toEqualTypeOf<number>();
  });

  it('is accepted everywhere tools are', () => {
    createAgent({ prompt: 'p', provider: createMockProvider({ responses: ['x'] }), tools: [sendEmail] });
    new ToolRegistry().register(sendEmail);
  });

  it('carries the canonical inputSchema and execute (LOU-D22)', () => {
    const input = z.object({ to: z.string().email(), count: z.number().default(1) });
    const t = defineTool({ name: 't', description: 'd', input, execute: async () => ({ ok: true }) });
    expectTypeOf(t.inputSchema).toEqualTypeOf<typeof input>();
    expectTypeOf(t.execute).parameter(0).toEqualTypeOf<{ to: string; count: number }>();
    expectTypeOf(t.execute).parameter(1).toEqualTypeOf<ToolExecutionOptions>();
    expectTypeOf(t.execute).returns.toEqualTypeOf<Promise<{ ok: boolean }>>();
    // @ts-expect-error - `count` must be a number
    void t.execute({ to: 'a@b.c', count: 'x' }, {} as ToolExecutionOptions);
  });

  it('rejects execute args that do not match the schema', () => {
    defineTool({
      name: 'bad',
      description: 'd',
      input: z.object({ a: z.string() }),
      // @ts-expect-error - `a` is a string, not a number
      execute: ({ a }: { a: number }) => a,
    });
  });
});
