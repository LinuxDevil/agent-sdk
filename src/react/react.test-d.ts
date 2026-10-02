/**
 * LOU-D15: the public types of `@lousho/build-ai-agent/react`.
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
  useLoushoAgent,
  type AgentUIAction,
  type AgentUIState,
  type AgentUIStatus,
  type LoushoAgentSource,
  type UIMessage,
  type UIPendingApproval,
  type UIToolCallStatus,
  type UseLoushoAgentResult,
} from './index';

describe('@lousho/build-ai-agent/react types', () => {
  it('accepts an in-process agent or a URL as the source', () => {
    const agent = createAgent({ provider: createMockProvider() });
    expectTypeOf({ agent }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ agent, sessionId: 'chat-1' }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ url: '/api/agent', headers: { Authorization: 'Bearer t' } }).toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf({ sessionId: 'x' }).not.toMatchTypeOf<LoushoAgentSource>();
    expectTypeOf(useLoushoAgent).parameter(1).toEqualTypeOf<{ approvalsUrl?: string } | undefined>();
  });

  it('returns typed state and commands', () => {
    expectTypeOf(useLoushoAgent).returns.toEqualTypeOf<UseLoushoAgentResult>();
    expectTypeOf<UseLoushoAgentResult['messages']>().toEqualTypeOf<UIMessage[]>();
    expectTypeOf<UseLoushoAgentResult['status']>().toEqualTypeOf<'idle' | 'streaming' | 'awaiting-approval' | 'error'>();
    expectTypeOf<AgentUIStatus>().toEqualTypeOf<UseLoushoAgentResult['status']>();
    expectTypeOf<UseLoushoAgentResult['pendingApproval']>().toEqualTypeOf<UIPendingApproval | null>();
    expectTypeOf<UseLoushoAgentResult['error']>().toEqualTypeOf<AgentEventError | null>();
    expectTypeOf<UseLoushoAgentResult['usage']>().toEqualTypeOf<AgentEventUsage | null>();
    expectTypeOf<UseLoushoAgentResult['lastEvent']>().toEqualTypeOf<AgentEvent | null>();
    expectTypeOf<UseLoushoAgentResult['send']>().toEqualTypeOf<(input: AgentInput) => Promise<void>>();
    expectTypeOf<UseLoushoAgentResult['approve']>().toEqualTypeOf<(note?: string) => Promise<void>>();
    expectTypeOf<UseLoushoAgentResult['stop']>().toEqualTypeOf<() => void>();
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
