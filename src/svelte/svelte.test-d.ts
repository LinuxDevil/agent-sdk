/**
 * LOU-P3: the public types of `@lousho/build-ai-agent/svelte`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { AgentInput } from '../providers/content';
import { loushoAgent, loushoTodos, type TodoView, type AgentUIState, type LoushoAgentSource, type LoushoAgentStore } from './index';

describe('@lousho/build-ai-agent/svelte types', () => {
  it('takes an in-process agent or a URL as the source', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf(loushoAgent).returns.toEqualTypeOf<LoushoAgentStore>();
  });

  it('is a readable store of the shared UI state, with the commands', () => {
    expectTypeOf<LoushoAgentStore['subscribe']>().toEqualTypeOf<(run: (state: AgentUIState) => void) => () => void>();
    expectTypeOf<LoushoAgentStore['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<LoushoAgentStore['stop']>().toEqualTypeOf<() => void>();
    expectTypeOf<LoushoAgentStore['reset']>().toEqualTypeOf<() => void>();
  });

  it('loushoTodos derives a readable store of a TodoView from the agent store', () => {
    expectTypeOf(loushoTodos).parameter(0).toEqualTypeOf<LoushoAgentStore>();
    expectTypeOf(loushoTodos).returns.toEqualTypeOf<{ subscribe(run: (view: TodoView) => void): () => void }>();
    expectTypeOf<AgentUIState['todos']>().toEqualTypeOf<TodoView['todos']>();
  });
});
