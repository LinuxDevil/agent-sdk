/**
 * LOU-P2: the public types of `@loushy/build-ai-agent/vue`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { ComputedRef } from 'vue';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { AgentInput } from '../providers/content';
import type { AgentEvent } from '../execution/agentEvents';
import {
  initialAgentUIState,
  reduceAgentEvents,
  useLoushyAgent,
  type AgentUIAction,
  type AgentUIState,
  type LoushyAgentSource,
  type UIMessage,
  type UseLoushyAgentResult,
} from './index';

describe('@loushy/build-ai-agent/vue types', () => {
  it('accepts an in-process agent or a URL as the source, plain or as a ref', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ url: '/api/agent' }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf(useLoushyAgent).parameter(0).toMatchTypeOf<LoushyAgentSource | { value: LoushyAgentSource }>();
  });

  it('returns the React hook state as refs, and the same commands', () => {
    expectTypeOf(useLoushyAgent).returns.toEqualTypeOf<UseLoushyAgentResult>();
    type Unwrapped = { [K in keyof AgentUIState]: UseLoushyAgentResult[K]['value'] };
    expectTypeOf<Unwrapped>().toEqualTypeOf<AgentUIState>();
    expectTypeOf<UseLoushyAgentResult['messages']>().toEqualTypeOf<ComputedRef<UIMessage[]>>();
    expectTypeOf<UseLoushyAgentResult['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<UseLoushyAgentResult['approve']>().toEqualTypeOf<(note?: string) => Promise<void>>();
    expectTypeOf<UseLoushyAgentResult['answer']>().toEqualTypeOf<(text: string) => Promise<void>>();
    expectTypeOf<UseLoushyAgentResult['stop']>().toEqualTypeOf<() => void>();
    expectTypeOf<UseLoushyAgentResult['reset']>().toEqualTypeOf<() => void>();
  });

  it('exposes the reducer framework-free', () => {
    expectTypeOf(initialAgentUIState).toEqualTypeOf<AgentUIState>();
    expectTypeOf(reduceAgentEvents).parameter(1).toEqualTypeOf<AgentEvent | AgentUIAction>();
  });
});
