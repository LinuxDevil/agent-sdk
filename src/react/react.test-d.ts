/**
 * LOU-D15: the public types of `@loushy/build-ai-agent/react`.
 */
import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { AgentInput } from '../providers/content';
import type { AgentEvent, AgentEventError, AgentEventUsage } from '../execution/agentEvents';
import {
  initialAgentUIState,
  parseEventStream,
  reduceAgentEvents,
  useLoushyAgent,
  type AgentUIAction,
  type AgentUIState,
  type AgentUIStatus,
  type LoushyAgentSource,
  type UIMessage,
  type UIPendingApproval,
  type UIToolCallStatus,
  type UseLoushyAgentResult,
} from './index';

describe('@loushy/build-ai-agent/react types', () => {
  it('accepts an in-process agent or a URL as the source', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ url: '/api/agent', headers: { Authorization: 'Bearer t' } }).toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushyAgentSource>();
    expectTypeOf(useLoushyAgent).parameter(1).toEqualTypeOf<{ approvalsUrl?: string } | undefined>();
  });

  it('returns typed state and commands', () => {
    expectTypeOf(useLoushyAgent).returns.toEqualTypeOf<UseLoushyAgentResult>();
    expectTypeOf<UseLoushyAgentResult['messages']>().toEqualTypeOf<UIMessage[]>();
    expectTypeOf<UseLoushyAgentResult['status']>().toEqualTypeOf<'idle' | 'streaming' | 'awaiting-approval' | 'error'>();
    expectTypeOf<AgentUIStatus>().toEqualTypeOf<UseLoushyAgentResult['status']>();
    expectTypeOf<UseLoushyAgentResult['pendingApproval']>().toEqualTypeOf<UIPendingApproval | null>();
    expectTypeOf<UseLoushyAgentResult['error']>().toEqualTypeOf<AgentEventError | null>();
    expectTypeOf<UseLoushyAgentResult['usage']>().toEqualTypeOf<AgentEventUsage | null>();
    expectTypeOf<UseLoushyAgentResult['lastEvent']>().toEqualTypeOf<AgentEvent | null>();
    expectTypeOf<UseLoushyAgentResult['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<UseLoushyAgentResult['approve']>().toEqualTypeOf<(note?: string) => Promise<void>>();
    expectTypeOf<UseLoushyAgentResult['stop']>().toEqualTypeOf<() => void>();
    expectTypeOf<UIMessage['role']>().toEqualTypeOf<'user' | 'assistant'>();
    expectTypeOf<UIMessage['toolCalls'][number]['status']>().toEqualTypeOf<UIToolCallStatus>();
  });

  it('exposes the reducer and parser framework-free', () => {
    expectTypeOf(initialAgentUIState).toEqualTypeOf<AgentUIState>();
    expectTypeOf(reduceAgentEvents).parameter(1).toEqualTypeOf<AgentEvent | AgentUIAction>();
    expectTypeOf(reduceAgentEvents).returns.toEqualTypeOf<AgentUIState>();
    expectTypeOf(parseEventStream).parameter(0).toMatchTypeOf<{ body: ReadableStream<Uint8Array> | null }>();
    expectTypeOf(parseEventStream).returns.toEqualTypeOf<AsyncGenerator<AgentEvent>>();
    // @ts-expect-error - only known actions and events are accepted
    reduceAgentEvents(initialAgentUIState, { type: 'ui.unknown' });
  });
});
