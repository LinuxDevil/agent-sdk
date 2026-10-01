/**
 * LOU-P3: the public types of `@loushy/build-ai-agent/svelte`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { AgentInput } from '../providers/content';
import { loushyAgent, type AgentUIState, type LoushyAgentSource, type LoushyAgentStore } from './index';

describe('@loushy/build-ai-agent/svelte types', () => {
  it('takes an in-process agent or a URL as the source', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf(loushyAgent).returns.toEqualTypeOf<LoushyAgentStore>();
  });

  it('is a readable store of the shared UI state, with the commands', () => {
    expectTypeOf<LoushyAgentStore['subscribe']>().toEqualTypeOf<(run: (state: AgentUIState) => void) => () => void>();
    expectTypeOf<LoushyAgentStore['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<LoushyAgentStore['stop']>().toEqualTypeOf<() => void>();
    expectTypeOf<LoushyAgentStore['reset']>().toEqualTypeOf<() => void>();
  });
});
