/**
 * LOU-P2: the public types of `@lousho/build-ai-agent/vue`.
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
  useLoushoAgent,
  type AgentUIAction,
  type AgentUIState,
  type LoushoAgentSource,
  type UIMessage,
  type UseLoushoAgentResult,
} from './index';

describe('@lousho/build-ai-agent/vue types', () => {
  it('accepts an in-process agent or a URL as the source, plain or as a ref', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ url: '/api/agent' }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf(useLoushoAgent).parameter(0).toMatchTypeOf<LoushoAgentSource | { value: LoushoAgentSource }>();
  });

  it('returns the React hook state as refs, and the same commands', () => {
    expectTypeOf(useLoushoAgent).returns.toEqualTypeOf<UseLoushoAgentResult>();
    type Unwrapped = { [K in keyof AgentUIState]: UseLoushoAgentResult[K]['value'] };
    expectTypeOf<Unwrapped>().toEqualTypeOf<AgentUIState>();
    expectTypeOf<UseLoushoAgentResult['messages']>().toEqualTypeOf<ComputedRef<UIMessage[]>>();
    expectTypeOf<UseLoushoAgentResult['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<UseLoushoAgentResult['approve']>().toEqualTypeOf<(note?: string) => Promise<void>>();
    expectTypeOf<UseLoushoAgentResult['answer']>().toEqualTypeOf<(text: string) => Promise<void>>();
    expectTypeOf<UseLoushoAgentResult['stop']>().toEqualTypeOf<() => void>();
    expectTypeOf<UseLoushoAgentResult['reset']>().toEqualTypeOf<() => void>();
  });

  it('exposes the reducer framework-free', () => {
    expectTypeOf(initialAgentUIState).toEqualTypeOf<AgentUIState>();
    expectTypeOf(reduceAgentEvents).parameter(1).toEqualTypeOf<AgentEvent | AgentUIAction>();
  });
});
