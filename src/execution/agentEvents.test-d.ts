import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { ExecutionResult } from './AgentExecutor';
import type { AgentRun } from './agentRun';
import {
  AGENT_EVENT_SCHEMA_VERSION,
  isToolEvent,
  type AgentEvent,
  type AgentEventError,
  type AgentEventOf,
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
  it('narrows the payload on event.type', () => {
    switch (event.type) {
      case 'text.delta':
      case 'text.done':
        expectTypeOf(event.text).toBeString();
        break;
      case 'step.start':
        expectTypeOf(event.step).toBeNumber();
        // @ts-expect-error - step.start has no finishReason
        void event.finishReason;
        break;
      case 'tool.start':
        expectTypeOf(event.args).toEqualTypeOf<Record<string, unknown>>();
        expectTypeOf(event.toolCallId).toBeString();
        break;
      case 'tool.done':
        expectTypeOf(event.result).toBeUnknown();
        expectTypeOf(event.durationMs).toBeNumber();
        break;
      case 'tool.error':
      case 'error':
        expectTypeOf(event.error).toEqualTypeOf<AgentEventError>();
        break;
      case 'approval.requested':
        expectTypeOf(event.approvalId).toBeString();
        break;
      case 'step.done':
        expectTypeOf(event.usage).toEqualTypeOf<AgentEventUsage | undefined>();
        break;
      case 'run.done':
        expectTypeOf(event.text).toBeString();
        expectTypeOf(event.finishReason).toEqualTypeOf<ExecutionResult['finishReason']>();
        break;
      case 'run.start':
        expectTypeOf(event.agentName).toBeString();
        break;
      default:
        expectTypeOf(event).toBeNever();
    }
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
