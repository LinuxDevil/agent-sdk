import { describe, it, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { z as z4 } from 'zod/v4';
import { createAgent, type SimpleAgent } from '../createAgent';
import { mockModel } from '../testing';
import type { StandardSchemaV1 } from '../utils/zodCompat';
import type { AgentSession } from './AgentSession';

describe('output schemas of either zod major and sessions (LOU-V4.2)', () => {
  it('infers result.object from a zod 4 schema (zod/v4) and a Standard Schema', () => {
    const v4 = createAgent({ provider: mockModel([]), output: z4.object({ city: z4.string(), tempC: z4.number() }) });
    expectTypeOf(v4).toEqualTypeOf<SimpleAgent<{ city: string; tempC: number }>>();

    const standard: StandardSchemaV1<unknown, { ok: boolean }> = z.object({ ok: z.boolean() });
    const viaStandard = createAgent({ provider: mockModel([]), output: standard });
    expectTypeOf(viaStandard).toEqualTypeOf<SimpleAgent<{ ok: boolean }>>();
  });

  it('infers result.object from a zod 3 schema', () => {
    const agent = createAgent({ provider: mockModel([]), output: z.object({ n: z.number() }) });
    expectTypeOf(agent).toEqualTypeOf<SimpleAgent<{ n: number }>>();
  });

  it('types session.send() and session.stream() results from the output schema', () => {
    const agent = createAgent({ provider: mockModel([]), output: z.object({ city: z.string() }) });
    const session = agent.session();
    expectTypeOf(session).toEqualTypeOf<AgentSession<{ city: string }>>();
    expectTypeOf(session.send).returns.resolves.toHaveProperty('object').toEqualTypeOf<{ city: string } | undefined>();
    expectTypeOf(session.stream).returns.toHaveProperty('result');
    expectTypeOf(createAgent({ provider: mockModel([]) }).session()).toEqualTypeOf<AgentSession>();
  });
});
