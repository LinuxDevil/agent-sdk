import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { ExecutionResult } from './AgentExecutor';
import type { AgentRun } from './agentRun';
import type { CompactedProviderErrorCategory } from './errors';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  isToolEvent,
  type AgentEvent,
  type AgentEventError,
  type AgentEventOf,
  type AgentEventType,
  type AgentEventUsage,
} from './agentEvents';

const event = {
  type: 'text.delta',
  text: 'hi',
  runId: 'r1',
  seq: 0,
  timestamp: new Date(0).toISOString(),
  v: AGENT_EVENT_SCHEMA_VERSION,
} as AgentEvent;

describe('AgentEvent types', () => {
  it('narrows text events on event.type', () => {
    if (event.type === 'text.delta') expectTypeOf(event.text).toBeString();
    if (event.type === 'text.done') expectTypeOf(event.text).toBeString();
  });

  it('narrows step events on event.type', () => {
    if (event.type === 'step.start') {
      expectTypeOf(event.step).toBeNumber();
      // @ts-expect-error - step.start has no finishReason
      void event.finishReason;
    }
    if (event.type === 'step.done') expectTypeOf(event.usage).toEqualTypeOf<AgentEventUsage | undefined>();
  });

  it('narrows tool events on event.type', () => {
    if (event.type === 'tool.start') expectTypeOf(event.args).toEqualTypeOf<Record<string, unknown>>();
    if (event.type === 'tool.done') expectTypeOf(event.durationMs).toBeNumber();
    if (event.type === 'tool.error') expectTypeOf(event.error).toEqualTypeOf<AgentEventError>();
  });

  it('narrows tool results and approvals on event.type', () => {
    if (event.type === 'tool.done') expectTypeOf(event.result).toBeUnknown();
    if (event.type === 'approval.requested') expectTypeOf(event.approvalId).toBeString();
  });

  it('narrows run and error events on event.type', () => {
    if (event.type === 'run.start') expectTypeOf(event.agentName).toBeString();
    if (event.type === 'error') expectTypeOf(event.error).toEqualTypeOf<AgentEventError>();
    if (event.type === 'run.done') {
      expectTypeOf(event.text).toBeString();
      expectTypeOf(event.finishReason).toEqualTypeOf<ExecutionResult['finishReason']>();
    }
  });

  it('narrows provider retry/fallback events on event.type (LOU-V7.2)', () => {
    if (event.type === 'provider.retry') {
      expectTypeOf(event.attempt).toBeNumber();
      expectTypeOf(event.error.category).toEqualTypeOf<CompactedProviderErrorCategory | undefined>();
    }
    if (event.type === 'provider.fallback') expectTypeOf(event.error).toEqualTypeOf<{ message: string }>();
  });

  it('covers every event type', () => {
    expectTypeOf<AgentEventType>().toEqualTypeOf<
      | 'run.start'
      | 'step.start'
      | 'text.delta'
      | 'text.done'
      | 'tool.start'
      | 'tool.done'
      | 'tool.error'
      | 'approval.requested'
      | 'step.done'
      | 'error'
      | 'provider.retry'
      | 'provider.fallback'
      | 'run.done'
    >();
  });

  it('carries the common fields on every event', () => {
    expectTypeOf(event.seq).toBeNumber();
    expectTypeOf(event.runId).toBeString();
    expectTypeOf(event.timestamp).toBeString();
    expectTypeOf(event.v).toEqualTypeOf<typeof AGENT_EVENT_SCHEMA_VERSION>();
    expectTypeOf(event.v).toEqualTypeOf<1>();
  });

  it('resolves AgentEventOf and the family guards', () => {
    expectTypeOf<AgentEventOf<'tool.done'>['toolName']>().toBeString();
    if (isToolEvent(event)) {
      expectTypeOf(event.type).toEqualTypeOf<'tool.start' | 'tool.done' | 'tool.error'>();
    }
  });

  it('agent.stream() returns an AgentRun: async iterable of events plus result', () => {
    const agent = createAgent({ provider: createMockProvider() });
    const run = agent.stream('hi', { signal: AbortSignal.timeout(1000) });
    expectTypeOf(run).toEqualTypeOf<AgentRun>();
    expectTypeOf(run).toMatchTypeOf<AsyncIterable<AgentEvent>>();
    expectTypeOf(run.result).toEqualTypeOf<Promise<ExecutionResult>>();
  });
});
