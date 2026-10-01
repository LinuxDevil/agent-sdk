import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import { z as z4 } from 'zod/v4';
import { tool as aiTool } from 'ai';
import type { Message } from '../providers/llm';
import { defineTool, type DefinedTool, type ToolInput, type ToolOutput } from './defineTool';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import { ToolRegistry } from './ToolRegistry';
import type { ApprovalCheckContext, ApprovalOutcome, ToolDescriptor, ToolExecutionContext } from '../types';
import { always, never, once } from './approvalPolicies';

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
    expectTypeOf(ctx).toEqualTypeOf<ToolExecutionContext>();
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
    expectTypeOf(t.execute).parameter(1).toEqualTypeOf<ToolExecutionContext>();
    expectTypeOf(t.execute).returns.toEqualTypeOf<Promise<{ ok: boolean }>>();
    // @ts-expect-error - `count` must be a number
    void t.execute({ to: 'a@b.c', count: 'x' }, {} as ToolExecutionContext);
  });

  it('types ctx as our ToolExecutionContext, not ai\'s options (LOU-D23)', () => {
    defineTool({
      name: 'ctx_probe',
      description: 'd',
      input: z.object({ q: z.string() }),
      execute: async ({ q }, ctx) => {
        expectTypeOf(q).toBeString();
        expectTypeOf(ctx).toEqualTypeOf<ToolExecutionContext>();
        expectTypeOf(ctx.toolCallId).toBeString();
        expectTypeOf(ctx.messages).toEqualTypeOf<readonly Message[]>();
        expectTypeOf(ctx.abortSignal).toEqualTypeOf<AbortSignal | undefined>();
        expectTypeOf(ctx.sessionId).toEqualTypeOf<string | undefined>();
        return q;
      },
    });
    expectTypeOf<ToolDescriptor['execute']>().parameter(1).toEqualTypeOf<ToolExecutionContext>();
    expectTypeOf<NonNullable<ToolDescriptor['sandboxExecute']>>()
      .parameter(2)
      .toEqualTypeOf<ToolExecutionContext | undefined>();
  });

  it('still registers a legacy ai tool() descriptor', () => {
    const legacy: ToolDescriptor = {
      displayName: 'legacy',
      tool: aiTool({ description: 'd', parameters: z.object({ a: z.string() }), execute: async ({ a }) => a }),
    };
    new ToolRegistry().register('legacy', legacy);
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

describe('defineTool annotations (LOU-Z5.2)', () => {
  it('accepts MCP annotations and rejects unknown hints', () => {
    defineTool({ name: 'ro', description: 'd', input: z.object({}), annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: 'T' }, execute: () => 1 });
    defineTool({
      name: 'bad',
      description: 'd',
      input: z.object({}),
      // @ts-expect-error - readOnlyHint is a boolean
      annotations: { readOnlyHint: 'yes' },
      execute: () => 1,
    });
  });
});

describe('needsApproval outcomes (LOU-X8)', () => {
  const input = z.object({ to: z.string() });
  it('accepts booleans, outcomes, async outcomes and the helpers', () => {
    defineTool({ name: 'b', description: 'd', input, needsApproval: (args) => args.to === 'x', execute: () => 1 });
    defineTool({ name: 'o', description: 'd', input, needsApproval: ({ to }) => (to ? 'ask' : { deny: 'no recipient' }), execute: () => 1 });
    defineTool({ name: 'a', description: 'd', input, needsApproval: async (_args, ctx) => (ctx.messages.length > 0 ? 'approve' : 'deny'), execute: () => 1 });
    defineTool({ name: 'h1', description: 'd', input, needsApproval: once({ per: 'args' }), execute: () => 1 });
    defineTool({ name: 'h2', description: 'd', input, needsApproval: always(), execute: () => 1 });
    defineTool({ name: 'h3', description: 'd', input, needsApproval: never(), execute: () => 1 });
    const legacy: ToolDescriptor['needsApproval'] = (args: { to: string }) => Promise.resolve(args.to === 'x');
    expectTypeOf(legacy).not.toBeUndefined();
  });

  it('types the context and rejects other return values', () => {
    defineTool({
      name: 'c',
      description: 'd',
      input,
      needsApproval: (_args, ctx) => {
        expectTypeOf(ctx).toEqualTypeOf<ApprovalCheckContext>();
        expectTypeOf(ctx.messages).toEqualTypeOf<readonly Message[]>();
        return 'ask';
      },
      execute: () => 1,
    });
    // @ts-expect-error - 'maybe' is not an ApprovalOutcome
    defineTool({ name: 'bad', description: 'd', input, needsApproval: () => 'maybe', execute: () => 1 });
    // @ts-expect-error - the deny reason is a string
    defineTool({ name: 'bad2', description: 'd', input, needsApproval: () => ({ deny: 1 }), execute: () => 1 });
    expectTypeOf<ApprovalOutcome>().toEqualTypeOf<boolean | 'approve' | 'deny' | 'ask' | { deny: string }>();
  });
});

describe('either zod major (LOU-D29)', () => {
  // `zod/v3` and `zod/v4` exist in both zod@^3.25 and zod@4, whichever is installed.
  it('infers execute args from a zod 3 schema', () => {
    const t = defineTool({
      name: 'v3',
      description: 'd',
      input: z3.object({ q: z3.string(), n: z3.number().default(1) }),
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ q: string; n: number }>();
        return args.n;
      },
    });
    expectTypeOf(t.execute).parameter(0).toEqualTypeOf<{ q: string; n: number }>();
  });

  it('infers execute args from a zod 4 schema', () => {
    const t = defineTool({
      name: 'v4',
      description: 'd',
      input: z4.object({ q: z4.string(), n: z4.number().default(1) }),
      needsApproval: ({ q }) => q === 'x',
      execute: (args) => {
        expectTypeOf(args).toEqualTypeOf<{ q: string; n: number }>();
        // @ts-expect-error - `nope` is not an argument of this tool
        void args.nope;
        return args.q;
      },
    });
    expectTypeOf<ToolInput<typeof t>>().toEqualTypeOf<{ q: string; n: number }>();
    expectTypeOf<ToolOutput<typeof t>>().toEqualTypeOf<string>();
    new ToolRegistry().register(t);
  });
});
