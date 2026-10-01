import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { createAgent, type SimpleAgent } from '../createAgent';
import type { ExecutionResult } from './AgentExecutor';
import { mockModel } from '../testing';

describe('createAgent({ output }) types (LOU-V4)', () => {
  it('types result.object as z.output of the schema', () => {
    const output = z.object({ city: z.string(), tempC: z.number().default(0), at: z.string().transform((s) => new Date(s)) });
    const agent = createAgent({ provider: mockModel([]), output });
    expectTypeOf(agent).toEqualTypeOf<SimpleAgent<{ city: string; tempC: number; at: Date }>>();

    type Sent = Awaited<ReturnType<typeof agent.send>>;
    expectTypeOf<Sent['object']>().toEqualTypeOf<{ city: string; tempC: number; at: Date } | undefined>();
    type Streamed = Awaited<ReturnType<typeof agent.stream>['result']>;
    expectTypeOf<Streamed['object']>().toEqualTypeOf<z.output<typeof output> | undefined>();
    expectTypeOf<Sent>().toMatchTypeOf<ExecutionResult>();
  });

  it('types result.object as unknown without output', () => {
    const agent = createAgent({ provider: mockModel([]) });
    expectTypeOf(agent).toEqualTypeOf<SimpleAgent>();
    expectTypeOf<Awaited<ReturnType<typeof agent.send>>['object']>().toEqualTypeOf<unknown>();
  });
});
