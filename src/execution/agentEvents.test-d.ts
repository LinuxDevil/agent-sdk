import { describe, it, expectTypeOf } from 'vitest';
import { createAgent } from '../createAgent';
import { createMockProvider } from '../providers/mock';
import type { ExecuteOptions, ExecutionResult } from './AgentExecutor';
import type { Todo } from '../tools/built-in/todo';
import type { AgentRun } from './agentRun';
import type { CompactedProviderErrorCategory } from './errors';
import type { GuardrailTripInfo, ModerationCategory, PiiType } from './ioGuardrails';
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
    if (event.type === 'tool.resume') expectTypeOf(event.args).toEqualTypeOf<Record<string, unknown>>();
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

  it('narrows permission.decision on event.type (LOU-X2)', () => {
    if (event.type === 'permission.decision') {
      expectTypeOf(event.decision).toEqualTypeOf<'allow' | 'deny' | 'ask' | 'default'>();
      expectTypeOf(event.rule).toEqualTypeOf<{ index: number; reason?: string } | undefined>();
      expectTypeOf(event.at).toBeString();
    }
  });

  it('narrows compaction events on event.type (LOU-W3.2)', () => {
    if (event.type === 'compaction.start') expectTypeOf(event.thresholdTokens).toBeNumber();
    if (event.type === 'compaction.done') {
      expectTypeOf(event.prunedToolCallIds).toEqualTypeOf<string[]>();
      expectTypeOf(event.summary).toEqualTypeOf<boolean | undefined>();
      expectTypeOf(event.error).toEqualTypeOf<{ message: string } | undefined>();
    }
  });

  it('narrows budget.exceeded on event.type (LOU-V6)', () => {
    if (event.type === 'budget.exceeded') {
      expectTypeOf(event.limit).toEqualTypeOf<
        'maxTokens' | 'maxInputTokens' | 'maxOutputTokens' | 'maxCostUsd' | 'maxDurationMs' | 'maxSteps'
      >();
      expectTypeOf(event.scope).toEqualTypeOf<'run' | 'session'>();
    }
  });

  it('narrows input events on event.type (LOU-V9)', () => {
    if (event.type === 'input.queued') expectTypeOf(event.text).toBeString();
    if (event.type === 'input.applied') expectTypeOf(event.step).toBeNumber();
    if (event.type === 'input.steered') expectTypeOf(event.mode).toEqualTypeOf<'immediate' | 'queued'>();
  });

  it('narrows agent.drift on event.type (LOU-W9.2)', () => {
    if (event.type === 'agent.drift') {
      expectTypeOf(event.toolsAdded).toEqualTypeOf<string[]>();
      expectTypeOf(event.instructions).toBeBoolean();
    }
  });

  it('narrows guardrail events on event.type (LOU-X4)', () => {
    if (event.type === 'guardrail.tripped' || event.type === 'guardrail.rewrote') {
      expectTypeOf(event.kind).toEqualTypeOf<'input' | 'output' | 'tool'>();
      expectTypeOf(event.toolName).toEqualTypeOf<string | undefined>();
      expectTypeOf(event.info).toEqualTypeOf<GuardrailTripInfo | undefined>();
    }
  });

  it('narrows a guardrail trip info on its category (N5a)', () => {
    type Info<C extends GuardrailTripInfo['category']> = Extract<GuardrailTripInfo, { category: C }>;
    expectTypeOf<Info<'pii'>['matches'][number]>().toEqualTypeOf<{ type: PiiType; start: number; end: number }>();
    expectTypeOf<Info<'secret'>['matches'][number]>().toEqualTypeOf<{ label: string; start: number; end: number }>();
    expectTypeOf<Info<'prompt-injection'>['source']>().toEqualTypeOf<'heuristic' | 'model'>();
    expectTypeOf<Info<'moderation'>['categories']>().toEqualTypeOf<ModerationCategory[]>();
    expectTypeOf<Info<'custom'>['anything']>().toBeUnknown();
  });

  it('narrows handoff on event.type (N6)', () => {
    if (event.type === 'handoff') {
      expectTypeOf(event.from).toBeString();
      expectTypeOf(event.to).toBeString();
      expectTypeOf(event.toolCallId).toBeString();
    }
  });

  it('narrows todo.updated on event.type (N12)', () => {
    if (event.type === 'todo.updated') {
      expectTypeOf(event.todos).toEqualTypeOf<Todo[]>();
      expectTypeOf(event.counts.total).toBeNumber();
      expectTypeOf(event.toolCallId).toBeString();
    }
  });

  it('covers every event type', () => {
    expectTypeOf<AgentEventType>().toEqualTypeOf<
      | 'run.start'
      | 'step.start'
      | 'text.delta'
      | 'text.done'
      | 'reasoning.start'
      | 'reasoning.delta'
      | 'reasoning.done'
      | 'tool.start'
      | 'tool.resume'
      | 'tool.partial'
      | 'tool.done'
      | 'todo.updated'
      | 'tool.error'
      | 'approval.requested'
      | 'permission.decision'
      | 'step.done'
      | 'error'
      | 'provider.retry'
      | 'provider.fallback'
      | 'compaction.start'
      | 'compaction.done'
      | 'context.cleared'
      | 'budget.exceeded'
      | 'input.queued'
      | 'input.steered'
      | 'input.applied'
      | 'guardrail.tripped'
      | 'guardrail.rewrote'
      | 'agent.drift'
      | 'handoff'
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
      expectTypeOf(event.type).toEqualTypeOf<'tool.start' | 'tool.resume' | 'tool.partial' | 'tool.done' | 'tool.error'>();
    }
  });

  it('agent.stream() returns an AgentRun: async iterable of events plus result', () => {
    const agent = createAgent({ provider: createMockProvider() });
    const run = agent.stream('hi', { signal: AbortSignal.timeout(1000) });
    expectTypeOf(run).toEqualTypeOf<AgentRun>();
    expectTypeOf(run).toMatchTypeOf<AsyncIterable<AgentEvent>>();
    expectTypeOf(run.result).toEqualTypeOf<Promise<ExecutionResult>>();
  });

  it('LOU-V13: narrows reasoning events; the reasoning option takes an effort or settings', () => {
    if (event.type === 'reasoning.delta') expectTypeOf(event.text).toBeString();
    if (event.type === 'reasoning.done') expectTypeOf(event.tokens).toEqualTypeOf<number | undefined>();
    if (event.type === 'reasoning.start') {
      // @ts-expect-error - reasoning.start carries no text
      void event.text;
    }
    expectTypeOf<ExecutionResult['reasoning']>().toEqualTypeOf<string | undefined>();

    const agent = createAgent({ provider: createMockProvider(), reasoning: 'high' });
    void agent.send('hi', { reasoning: { effort: 'low', budgetTokens: 2048, summary: 'auto', force: true } });
    // @ts-expect-error - not an effort
    createAgent({ provider: createMockProvider(), reasoning: 'max' });
    // @ts-expect-error - summary is 'auto' or 'none'
    void agent.send('hi', { reasoning: { summary: 'detailed' } });
  });
});

describe('event listener options (LOU-D41)', () => {
  it('types createAgent({ onEvent }) and ExecuteOptions.onAgentEvent with AgentEvent', () => {
    createAgent({ provider: createMockProvider(), onEvent: (e) => expectTypeOf(e).toEqualTypeOf<AgentEvent>() });
    expectTypeOf<NonNullable<ExecuteOptions['onAgentEvent']>>().parameter(0).toEqualTypeOf<AgentEvent>();
  });

  it('has no ExecuteOptions.onEvent (removed in A2b)', () => {
    expectTypeOf<ExecuteOptions>().not.toHaveProperty('onEvent');
  });
});
